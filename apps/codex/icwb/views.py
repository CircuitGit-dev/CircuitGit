"""Finite MCP window state and gateway reads. No model engine or implicit approval."""
import base64
import contextlib
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import uuid
from urllib.parse import urlencode
from ic_gateway.platform_compat import file_lock
from .service import Failure, atom, canonical, check, digest
from .view_contracts import SCHEMAS, RESOURCES, MIME, VID, COMMIT, HASH, validate

MAX_BYTES = 32 * 1024 * 1024
MAX_LAYOUT_BYTES = 128 * 1024
MAX_SNAPSHOT_BYTES = 1024 * 1024
CHILD_KINDS = ('schematic', 'waveforms', 'simulation')


def ui_state_json(text, maximum, label):
    """UI state is distinct from a validated electrical/configuration draft."""
    def pairs(items):
        value = {}
        for key, item in items:
            check(key not in value, label + ' contains duplicate JSON keys')
            value[key] = item
        return value
    try:
        check(len(text.encode('utf-8')) <= maximum, label + ' exceeds byte limit')
        value = json.loads(text, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        check(isinstance(value, dict), label + ' must be a JSON object')
        # Also rejects overflowed exponent values (1e999) and invalid Unicode.
        canonical(value).encode('utf-8')
    except (ValueError, RecursionError, UnicodeError):
        raise Failure('invalid_input', label + ' must be a finite UTF-8 JSON object')
    return value


def workbench_layout(text, workspace, parent):
    """Validate a layout without reading electrical sources or changing children."""
    layout = ui_state_json(text, MAX_LAYOUT_BYTES, 'Workbench layout')
    check(set(layout) == {'version', 'panels', 'tree', 'maximized'}, 'Layout has missing/unsupported fields')
    check(type(layout['version']) is int and layout['version'] == 1, 'Unsupported layout version')
    panels = layout['panels']
    check(isinstance(panels, list) and len(panels) <= 16, 'Layout allows at most 16 panels')
    declared = {}
    for panel in panels:
        check(isinstance(panel, dict) and set(panel) == {'id', 'kind', 'title'}, 'Invalid layout panel fields')
        validate(VID, panel['id'], 'panel.id')
        check(panel['id'] not in declared, 'Duplicate panel ID')
        check(isinstance(panel['title'], str) and 1 <= len(panel['title']) <= 256, 'Panel title exceeds bounds')
        check(panel['kind'] in CHILD_KINDS, 'Unsupported panel kind')
        child = workspace['views'].get(panel['id'])
        check(child is not None and child['workspace_id'] == parent['workspace_id']
              and child['identity']['project_id'] == parent['identity']['project_id'],
              'Panel must belong to the parent workspace and project', 'forbidden', 4)
        check(child['kind'] == panel['kind'], 'Panel kind does not match saved child view')
        declared[panel['id']] = panel
    node_ids, visible = set(), set()
    groups = 0

    def node(value, depth):
        nonlocal groups
        check(depth <= 8, 'Layout tree exceeds depth 8')
        check(isinstance(value, dict), 'Layout tree node must be an object')
        node_id = value.get('id')
        check(isinstance(node_id, str) and 1 <= len(node_id) <= 180, 'Layout node ID exceeds bounds')
        check(node_id not in node_ids, 'Duplicate layout node ID')
        node_ids.add(node_id)
        if value.get('type') == 'group':
            check(set(value) == {'type', 'id', 'tabs', 'active'}, 'Invalid group fields')
            groups += 1
            check(groups <= 16, 'Layout allows at most 16 groups')
            tabs = value['tabs']
            check(isinstance(tabs, list) and 1 <= len(tabs) <= 16, 'Group needs 1..16 tabs')
            for tab in tabs:
                validate(VID, tab, 'group.tabs[]')
                check(tab in declared, 'Visible tab has no declared panel')
                check(tab not in visible, 'Visible panel occurs more than once in the layout')
                visible.add(tab)
            validate(VID, value['active'], 'group.active')
            check(value['active'] in tabs, 'Active tab is not in its group')
        elif value.get('type') == 'split':
            check(set(value) == {'type', 'id', 'axis', 'ratio', 'first', 'second'}, 'Invalid split fields')
            check(value['axis'] in ('horizontal', 'vertical'), 'Unsupported split axis')
            ratio = value['ratio']
            check(type(ratio) in (int, float) and 0.15 <= ratio <= 0.85, 'Split ratio must be between 0.15 and 0.85')
            node(value['first'], depth + 1)
            node(value['second'], depth + 1)
        else:
            raise Failure('invalid_input', 'Unsupported layout node type')

    if layout['tree'] is not None:
        node(layout['tree'], 1)
    maximized = layout['maximized']
    if maximized is not None:
        validate(VID, maximized, 'layout.maximized')
        check(maximized in visible, 'Maximized panel must occur in the visible tree')
    check(sum(declared[vid]['kind'] == 'schematic' for vid in visible) <= 1,
          'This workbench supports one visible schematic instance')
    return layout


def configuration_json(text):
    check(len(text.encode()) <= 1024 * 1024, 'Configuration draft exceeds 1 MiB')
    def pairs(items):
        result={}
        for key,value in items:
            check(key not in result,'Duplicate configuration key');result[key]=value
        return result
    try:
        value=json.loads(text,object_pairs_hook=pairs,parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError,RecursionError): raise Failure('invalid_input','Configuration must be finite JSON')
    check(isinstance(value,dict),'Configuration must be a JSON object')
    return value


class ViewService:
    def __init__(self, service, resource_root=None):
        self.service=service
        self.root=service.state/'mcp-views';self.root.mkdir(parents=True,exist_ok=True)
        self.resource_root=Path(resource_root or os.environ.get('IC_WORKBENCH_UI_ROOT') or Path(__file__).resolve().parents[1]/'ui').resolve()

    @contextlib.contextmanager
    def lock(self):
        with file_lock(self.root/'views.lock'):
            yield

    def resources(self):
        return [{'uri':uri,'name':'ic-'+kind,'description':'Independent '+kind+' MCP App; rendering is host controlled.',
                 'mimeType':MIME,'_meta':{'ui':{'prefersBorder':False,
                     'csp':{'connectDomains':[],'resourceDomains':['blob:','data:']}}}}
                for kind,uri in RESOURCES.items()]

    def read_resource(self,uri):
        kind=next((k for k,v in RESOURCES.items() if v==uri),None)
        check(kind is not None,'Unknown UI resource','not_found',4)
        path=self.resource_root/(kind+'.html')
        check(path.is_file() and path.resolve().parent==self.resource_root and not path.is_symlink(),
              'UI bundle is unavailable; build/install the matching UI package','resource_unavailable',4)
        with path.open('rb') as f:raw=f.read(MAX_BYTES+1)
        check(len(raw)<=MAX_BYTES,'UI bundle exceeds 32 MiB')
        try:text=raw.decode('utf-8')
        except UnicodeError:raise Failure('invalid_resource','UI bundle must be UTF-8 HTML')
        return {'contents':[{'uri':uri,'mimeType':MIME,'text':text,'_meta':self.resources()[list(RESOURCES).index(kind)]['_meta']}]}

    def _load(self,wid):
        path=self.root/(wid+'.json')
        check(path.is_file(),'Unknown workspace','not_found',4)
        check(path.stat().st_size<=16*1024*1024,'Workspace state exceeds limit')
        value=json.loads(path.read_text());check(value['workspace_id']==wid,'Workspace identity mismatch')
        return value

    def _save(self,workspace):
        check(len(canonical(workspace).encode())<=16*1024*1024,'Workspace state quota exceeded; existing state retained','state_limit',4)
        atom(self.root/(workspace['workspace_id']+'.json'),workspace)

    def _ref(self,args,expected=None):
        w=self._load(args['workspace_id']);v=w['views'].get(args['view_id'])
        check(v is not None and v['workspace_id']==args['workspace_id'],'View does not belong to workspace','not_found',4)
        if expected is not None:check(v['revision']==expected,'View revision changed; read the current descriptor','conflict',3)
        return w,v

    def _bump(self,w,v):
        v['revision']+=1;w['revision']+=1;self._save(w)

    def _summary(self,request):
        return {k:request.get(k) for k in ('request_id','operation','state','fingerprint')}

    def _descriptor(self,w,v):
        d={k:copy.deepcopy(value) for k,value in v.items() if not k.startswith('_')}
        d['workspace_revision']=w['revision'];d['ui']['available']=(self.resource_root/(v['kind']+'.html')).is_file()
        d['requests']=[self._summary(self.service.call('request_status',{'request_id':rid})) for rid in v['_requests']]
        return d

    def _source(self,v):
        i=v['identity'];data=self.service.call('read',{'project_id':i['project_id'],'path':i['path']})
        check(data['file']['base_commit']==i['source_commit'] and data['file']['sha256']==i['source_sha256'],
              'Pinned source changed; open a new view after reviewing the new version','conflict',3)
        return data

    def _jobs(self,pid):
        jobs=self.service.gateway.request('/api/jobs').get('jobs',[])
        check(isinstance(jobs,list) and len(jobs)<=2000,'Persisted job catalog exceeds bounds')
        return [j for j in jobs if (j.get('associated_project_id') or j.get('project_id'))==pid]

    def _run(self,v):
        i=v['identity'];check(i['run_id'],'This view has no bound run')
        row=next((j for j in self._jobs(i['project_id']) if (j.get('run_id') or j.get('job_id'))==i['run_id']),None)
        check(row is not None and row.get('source_commit')==i['source_commit'],'Run/source identity changed','conflict',3)
        if i['configuration'] is not None:check(row.get('configuration')==i['configuration'],'Run configuration identity changed','conflict',3)
        return row

    def _signals(self,v):
        self._run(v);i=v['identity'];data=self.service.gateway.request('/api/jobs/'+i['run_id']+'/signals')
        check(data.get('run_id')==i['run_id'] and data.get('source_commit')==i['source_commit'],'Saved signal identity mismatch','conflict',3)
        return data

    def _configuration(self,v):
        check(v['kind']=='simulation','Configuration operations require a simulation view')
        i=v['identity'];data=self.service.gateway.request('/api/configuration?'+urlencode({k:i[k] for k in ('project_id','configuration','source_commit')}))
        check(data.get('project_id')==i['project_id'] and data.get('source_commit')==i['source_commit'] and data.get('configuration')==i['configuration'],
              'Configuration descriptor identity mismatch','conflict',3)
        configuration_json(data['configuration_text'])
        if v.get('_config_sha'):check(data['configuration_sha256']==v['_config_sha'],'Configuration hash changed','conflict',3)
        return data

    def _native(self,v):
        check(v['kind']=='schematic','Geometry operations require a schematic view')
        data=self._source(v)['geometry'];g=data.get('geometry',{})
        check(g.get('available') and g.get('bundle_commit') and g.get('manifest_sha256'),'Pinned native geometry unavailable','geometry_unavailable',4)
        return data,g

    def _geometry_bytes(self,endpoint,query):
        # Geometry endpoints return raw data, not the normal gateway {ok,data} envelope.
        check(endpoint in ('file','viewer-manifest'),'Unsupported pinned geometry endpoint')
        conn=http.client.HTTPConnection('127.0.0.1',self.service.gateway.port,timeout=self.service.gateway.timeout)
        try:
            conn.request('GET','/api/geometry/'+endpoint+'?'+urlencode(query),headers={'Origin':self.service.gateway.origin})
            response=conn.getresponse();raw=response.read(MAX_BYTES+1)
            check(response.status==200,'Pinned geometry read failed','geometry_unavailable',3 if response.status==409 else 4)
            check(len(raw)<=MAX_BYTES,'Geometry response exceeds 32 MiB')
            return raw,response.getheader('Content-Type','application/octet-stream')
        except (OSError,http.client.HTTPException):raise Failure('transport_unknown','Pinned geometry response unavailable',75)
        finally:conn.close()

    def _raw_geometry(self,v,path,expected_hash):
        raw,mime=self._geometry_bytes('file',{**v['_native_pin'],'path':path})
        check(hashlib.sha256(raw).hexdigest()==expected_hash,'Geometry content hash mismatch','conflict',3)
        return raw,mime

    def _open(self,kind,args):
        if kind == 'workbench' and args.get('workbench_id'):
            check(args.get('workspace_id'), 'Explicit workbench reopen requires workspace_id')
            w, v = self._ref({'workspace_id': args['workspace_id'], 'view_id': args['workbench_id']})
            check(v['kind'] == 'workbench' and v['identity']['project_id'] == args['project_id'],
                  'Workbench does not match the requested project', 'forbidden', 4)
            if 'configuration' in args:
                check(args['configuration'] == v['identity']['configuration'], 'Reopen configuration does not match workbench', 'conflict', 3)
            if 'run_id' in args:
                check(args['run_id'] == v.get('workbench_run_id'), 'Reopen run does not match workbench', 'conflict', 3)
            return self._descriptor(w, v), None
        catalog,project=self.service.project(args['project_id'])
        if kind=='schematic' and args.get('path'):check(args['path']==project['source_path'],'Schematic path must be the registered canonical project source')
        identity={'project_id':args['project_id'],'source_commit':None,'source_sha256':None,'path':None,'configuration':None,'run_id':None}
        extra={}
        if kind == 'workbench':
            if 'configuration' in args:
                check(args['configuration'] in {c['id'] for c in project['configurations']}, 'Unknown project configuration')
            identity['configuration'] = args.get('configuration')
            extra.update(workbench_run_id=args.get('run_id'), _layout=None)
        run=None
        if args.get('run_id'):
            run=next((j for j in self._jobs(args['project_id']) if (j.get('run_id') or j.get('job_id'))==args['run_id']),None)
            check(run is not None,'Run is not associated with the explicit project','not_found',4)
            if kind=='simulation':check(run.get('configuration')==args['configuration'],'Run is not bound to the requested configuration','conflict',3)
            if kind != 'workbench':
                identity.update(run_id=args['run_id'],source_commit=run['source_commit'],configuration=run.get('configuration'))
        historical=kind != 'workbench' and run is not None and run['source_commit']!=catalog['source_commit']
        if kind!='waveforms' and not historical:
            source=self.service.call('read',{'project_id':args['project_id'],**({'path':args['path']} if args.get('path') else {})})
            identity.update(path=source['file']['path'],source_commit=source['file']['base_commit'],source_sha256=source['file']['sha256'])
            if kind == 'workbench':
                validate(COMMIT, identity['source_commit'], 'workbench.source_commit')
                validate(HASH, identity['source_sha256'], 'workbench.source_sha256')
                check(identity['source_commit'] == catalog['source_commit'], 'Current project source changed during workbench open', 'conflict', 3)
            if kind=='simulation':
                check(args['configuration'] in {c['id'] for c in project['configurations']},'Unknown project configuration')
                identity['configuration']=args['configuration']
        if run is not None and kind != 'workbench':check(identity['source_commit']==run['source_commit'],'Run/source changed during open','conflict',3)
        if args.get('source_commit'):check(args['source_commit']==identity['source_commit'],'Requested source commit does not match actual identity','conflict',3)
        if args.get('workspace_id'):w=self._load(args['workspace_id'])
        else:
            check(len(list(self.root.glob('w_*.json')))<16,'Workspace limit reached; nothing evicted','state_limit',4)
            w={'schema':'ic.workspace.v1','workspace_id':'w_'+uuid.uuid4().hex,'revision':1,'views':{},'selection':None}
        check(len(w['views'])<32,'Workspace view limit reached; nothing evicted','state_limit',4)
        v={'schema':'ic.view.v1','view_id':'v_'+uuid.uuid4().hex,'workspace_id':w['workspace_id'],'kind':kind,'revision':1,
           'identity':identity,'visible':True,'display_mode':'inline','readiness':{'state':'requested','basis':'server-request','message':None},
           'ui':{'resource_uri':RESOURCES[kind],'available':False,'mounted':None},'selection':None,'draft_dirty':False,'review_id':None,'plan_ready':False,
           'requests':[],'_requests':[],'_files':{},**extra}
        if kind=='simulation' and not historical:
            config=self._configuration(v);v.update(_draft=config['configuration_text'],_base_text=config['configuration_text'],
                _config_path=config['configuration_path'],_config_sha=config['configuration_sha256'])
        w['views'][v['view_id']]=v;w['revision']+=1;self._save(w)
        return self._descriptor(w,v),None

    def _data(self,w,v,query):
        kind=query['kind'];i=v['identity']
        if v['kind'] == 'workbench':
            check(kind in ('project', 'runs', 'layout'), 'Unsupported workbench data section')
        if kind=='project':payload=self.service.call('projects',{})
        elif kind=='layout':
            check(v['kind'] == 'workbench', 'Layout belongs to a workbench view')
            payload={'text':v.get('_layout'),'views':[self._descriptor(w, child) for child in w['views'].values()
                     if child['kind'] in CHILD_KINDS and child['workspace_id'] == v['workspace_id']
                     and child['identity']['project_id'] == i['project_id']]}
        elif kind=='snapshot':
            check(v['kind'] in CHILD_KINDS, 'Snapshots belong to child views')
            payload={'text':v.get('_snapshot')}
        elif kind=='source':check(i['path'],'This view has no pinned editable source path');payload=self._source(v)
        elif kind=='runs':payload={'jobs':self._jobs(i['project_id'])}
        elif kind=='configuration':payload=self._configuration(v)
        elif kind=='draft':check(v['kind']=='simulation' and '_draft' in v,'Historical run view has no editable current configuration draft','configuration_unavailable',4);payload={'text':v['_draft'],'dirty':v['draft_dirty'],'base_sha256':v['_config_sha']}
        elif kind=='schematic':check(v['kind']=='schematic','Not a schematic view');payload=self._source(v)['geometry']
        elif kind=='geometry_manifest':
            _,g=self._native(v);check(query['entry'] in {c['id'] for c in g.get('cells',[])},'Unknown pinned geometry entry')
            pin={'project_id':i['project_id'],'bundle_commit':g['bundle_commit'],'manifest_sha256':g['manifest_sha256']}
            raw,_=self._geometry_bytes('viewer-manifest',{**pin,'entry':query['entry']})
            try:payload=json.loads(raw)
            except (ValueError,UnicodeError):raise Failure('geometry_unavailable','Pinned manifest is not valid JSON',4)
            check(isinstance(payload.get('files'),list) and len(payload['files'])<=300,'Geometry file catalog exceeds bounds')
            if v.get('_native_pin')!=pin:v['_files']={}
            v['_native_pin']=pin
            for f in payload['files']:
                validate({'type':'string','pattern':r'[a-f0-9]{64}'},f['sha256'],'geometry.sha256');v['_files'][f['path']]=f['sha256']
            self._save(w)  # Derived allowlist cache only; view revision and selection do not change.
        elif kind=='geometry_file':
            check(v['kind']=='schematic' and query['path'] in v['_files'],'Geometry path was not enumerated by this pinned view')
            raw,mime=self._raw_geometry(v,query['path'],v['_files'][query['path']]);offset=query.get('offset',0);limit=query.get('limit',262144)
            check(offset<=len(raw),'Geometry offset exceeds file length')
            end=min(offset+limit,len(raw));payload={'path':query['path'],'mime_type':mime,'encoding':'base64','data':base64.b64encode(raw[offset:end]).decode(),
                'offset':offset,'total_bytes':len(raw),'next_offset':end if end<len(raw) else None,'sha256':v['_files'][query['path']]}
        elif kind=='signals':payload=self._signals(v)
        elif kind in ('waveform','mapping','results'):
            self._run(v)
            if kind=='results':payload=self.service.call('sim_results',{'run_id':i['run_id']})
            elif kind=='mapping':payload=self.service.gateway.request('/api/jobs/'+i['run_id']+'/waveform-map')
            else:
                catalog=self._signals(v);check(query['signal_id'] in {s['id'] for s in catalog['signals']},'Signal is not in this run catalog')
                payload=self.service.gateway.request('/api/jobs/'+i['run_id']+'/waveform?'+urlencode({k:value for k,value in query.items() if k!='kind'}))
        elif kind=='request':
            check(query['request_id'] in v['_requests'],'Request does not belong to this view','forbidden',4)
            payload=self.service.call('request_status',{'request_id':query['request_id']})
        else:raise Failure('invalid_input','Unsupported finite view data section')
        check(len(canonical(payload).encode())<=MAX_BYTES,'UI data exceeds 32 MiB')
        descriptor=self._descriptor(w,v)
        return {'view':descriptor,'kind':kind,'available':True},{'view':descriptor,'kind':kind,'payload':payload}

    def _selection(self,w,v,selection):
        if 'geometry' in selection:check(v['kind']=='schematic' and selection['kind'] in ('instance','net','terminal'),'Geometry selection is untrusted schematic metadata only')
        if selection['kind']=='none':v['selection']=None
        else:
            i=v['identity'];selection=copy.deepcopy(selection)
            if selection['kind']=='signals':
                check(selection.get('signal_ids'),'Signal selection requires signal_ids')
                catalog=self._signals(v);check(set(selection['signal_ids'])<={s['id'] for s in catalog['signals']},'Selected signals are outside this run')
                basis='saved-signal-catalog'
            else:
                check(v['kind']=='schematic','Instance/net/terminal selection requires a schematic view')
                self._source(v);basis='ui-metadata'
                if 'line_start' in selection or 'line_end' in selection:
                    check('line_start' in selection and 'line_end' in selection and selection['line_start']<=selection['line_end'],'Invalid source line range')
            v['selection']={**selection,'verification':basis,'source_commit':i['source_commit'],'run_id':i['run_id']}
        w['selection']={'view_id':v['view_id'],'view_revision':v['revision']+1,'selection':copy.deepcopy(v['selection'])}
        self._bump(w,v);return self._descriptor(w,v),None

    def _plan(self,w,v,action):
        config=self._configuration(v);i=v['identity']
        if action=='preview_draft':
            configuration_json(v['_draft'])
            result=self.service.call('diff',{'project_id':i['project_id'],'base_commit':i['source_commit'],
                'changes':[{'path':v['_config_path'],'sha256':v['_config_sha'],'content':v['_draft']}]})
            v['review_id']=result['review_id'];v['_review_text_hash']=digest(v['_draft']);v['plan_ready']=False
        else:
            check(not v['draft_dirty'],'Save/review the draft before planning committed source','conflict',3)
            result=self.service.call('sim_plan',{k:i[k] for k in ('project_id','configuration','source_commit')})
            check(result.get('source_commit')==i['source_commit'] and result.get('project_id')==i['project_id'] and result.get('configuration')==i['configuration'],
                  'Plan identity mismatch','conflict',3)
            check(not result.get('blockers'),'Plan contains blockers','conflict',3)
            v['plan_ready']=True;v['_plan_hash']=digest(result)
        self._bump(w,v);d=self._descriptor(w,v)
        return {'view':d,'action':action,'review_id':v['review_id'],'plan_ready':v['plan_ready']},{'view':d,'result':result}

    def _request(self,w,v,args):
        operation=args['operation'];i=v['identity'];key=args['idempotency_key']
        check(len(v['_requests'])<64,'View request history limit reached; nothing evicted','state_limit',4)
        if operation=='apply':
            self._configuration(v)
            check(v['review_id'] and v.get('_review_text_hash')==digest(v['_draft']),'Current draft has no frozen review','conflict',3)
            check(args.get('message'),'A commit message is required')
            body={'review_id':v['review_id'],'message':args['message'],'idempotency_key':key}
        elif operation=='sim_submit':
            self._configuration(v);check(not v['draft_dirty'] and v['plan_ready'],'Committed source and a current plan are required','conflict',3)
            body={**{k:i[k] for k in ('project_id','configuration','source_commit')},'idempotency_key':key}
        else:self._run(v);body={'run_id':i['run_id'],'idempotency_key':key}
        request=self.service.call(operation,body);rid=request['request_id'];owner_path=self.root/('request-'+rid+'.json')
        owner={'workspace_id':w['workspace_id'],'view_id':v['view_id']}
        if owner_path.exists():check(json.loads(owner_path.read_text())==owner,'Request belongs to a different view','forbidden',4)
        else:atom(owner_path,owner)
        if rid not in v['_requests']:v['_requests'].append(rid);self._bump(w,v)
        d=self._descriptor(w,v);human={'mode':'host-elicitation','automatic_approval':False,
             'instruction':'Review the frozen request with ic_request_review using its request id and fingerprint. Only the host human form may approve. Unsupported hosts leave the request pending.'}
        return {'view':d,'request':self._summary(request),'human_confirmation':human},{'view':d,'request':request,'human_confirmation':human}

    def _bind_run(self,w,v,request_id):
        check(v['kind']=='simulation','Run receipt binding requires a simulation view')
        check(request_id in v['_requests'],'Request does not belong to this view','forbidden',4)
        request=self.service.call('request_status',{'request_id':request_id})
        check(request.get('operation')=='sim_submit' and request.get('state')=='accepted','An accepted simulation submit receipt is required','conflict',3)
        result=request.get('result') or {};rid=result.get('run_id') or result.get('job_id')
        check(isinstance(rid,str) and rid,'Accepted receipt has no exact run identity','conflict',3)
        identity=v['identity'];original=request.get('arguments') or {}
        check(all(original.get(k)==identity[k] for k in ('project_id','configuration','source_commit')),'Request source/configuration no longer matches view','conflict',3)
        row=next((j for j in self._jobs(identity['project_id']) if (j.get('run_id') or j.get('job_id'))==rid),None)
        check(row is not None and row.get('source_commit')==identity['source_commit'] and row.get('configuration')==identity['configuration'],
              'Receipt run does not match pinned project/configuration/source','conflict',3)
        if identity['run_id']!=rid:identity['run_id']=rid;self._bump(w,v)
        return self._descriptor(w,v),None

    def call(self,name,args):
        check(name in SCHEMAS,'Unknown view operation');validate(SCHEMAS[name],args)
        with self.lock():
            if name.endswith('_open'):return self._open(name[3:-5],args)
            if name=='ic_workspace_get':
                w=self._load(args['workspace_id'])
                return {'schema':w['schema'],'workspace_id':w['workspace_id'],'revision':w['revision'],'selection':copy.deepcopy(w['selection']),
                        'views':[self._descriptor(w,v) for v in w['views'].values()]},None
            w,v=self._ref(args,args.get('expected_revision',args.get('revision')))
            if name=='ic_view_get':return self._descriptor(w,v),None
            if name=='ic_view_data':return self._data(w,v,args['query'])
            if name=='ic_workbench_layout':
                check(v['kind'] == 'workbench', 'Layout persistence requires a workbench view')
                workbench_layout(args['text'], w, v)
                v['_layout'] = args['text']
                self._bump(w, v)
                return self._descriptor(w, v), None
            if name=='ic_view_snapshot':
                check(v['kind'] in CHILD_KINDS, 'Snapshot persistence requires a child view')
                ui_state_json(args['text'], MAX_SNAPSHOT_BYTES, 'View snapshot')
                v['_snapshot'] = args['text']
                self._bump(w, v)
                return self._descriptor(w, v), None
            if name=='ic_view_select':return self._selection(w,v,args['selection'])
            if name=='ic_view_state':
                for key in ('visible','display_mode'):
                    if key in args:v[key]=args[key]
                if 'client_state' in args:v['readiness']={'state':args['client_state'],'basis':'client-report','message':args.get('message')}
                self._bump(w,v);return self._descriptor(w,v),None
            if name=='ic_view_draft':
                self._configuration(v);configuration_json(args['text']);v['_draft']=args['text'];v['draft_dirty']=args['text']!=v['_base_text'];v['review_id']=None;v['plan_ready']=False
                self._bump(w,v);return self._descriptor(w,v),None
            if name=='ic_view_plan':return self._plan(w,v,args['action'])
            if name=='ic_view_request':return self._request(w,v,args)
            if name=='ic_view_bind_run':return self._bind_run(w,v,args['request_id'])
        raise Failure('invalid_input','Unsupported view operation')
