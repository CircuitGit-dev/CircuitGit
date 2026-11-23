#!/usr/bin/env python3
"""Loopback-only workbench HTTP v1. Installed code executes; repository scripts never do."""
import argparse, concurrent.futures, json, mimetypes, os, re, secrets, threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,parse_qs,unquote
import ic_sim as core
from runner import Runner,atomic
from workspace import Workspace,Conflict,VersionControlError
from publisher import Publisher
from waveforms import WaveformService, WaveformError, dispatch as waveform_dispatch
from geometry import Geometry,InvalidGeometry
from supervision import Supervision, execution_target

class Application:
    def __init__(self,cfg,web_root):
        self.cfg=cfg;self.web=Path(web_root).resolve();runtime=Path(cfg['runtime_root']).resolve();runtime.mkdir(parents=True,exist_ok=True)
        keyfile=runtime/'signing.key'
        if not keyfile.exists():keyfile.write_bytes(secrets.token_bytes(32));os.chmod(keyfile,0o600)
        self.site=core.site_load(Path(cfg['site_file']));self.workspace=Workspace(cfg,self.site,keyfile.read_bytes());self.runner=Runner(cfg.get('runs_root',runtime/'runs'),self.site,self.workspace.frozen,keyfile.read_bytes());self.publisher=Publisher(cfg,self.workspace,self.runner)
        self.resource_pool=None
        if cfg.get('spiceowl_pool_file'):
            from spiceowl_pool import ResourcePool
            self.resource_pool=ResourcePool(cfg['spiceowl_pool_file'],runtime,keyfile.read_bytes())
            self.runner.resource_recheck=self.resource_pool.recheck
        self.geometry=Geometry(self.workspace)
        self.supervision=Supervision(self.runner,self.workspace.projects)
        self.waveforms=WaveformService(self.runner,cfg.get('waveform_bindings',{}),cfg.get('waveform_derivatives',{}),source_reader=self.geometry.blob)
        self.ai=None
        if cfg.get('ai_client_config'):
            import sys
            sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ai'))
            from icwb.host import AiRoutes
            from icwb.service import Service,load_config
            self.ai=AiRoutes(Service(load_config(cfg['ai_client_config'])))
        self.token=secrets.token_urlsafe(32);self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=2);self.operations={};self.mutex=threading.Lock()
    def publication_view(self,r):
        p=r.get('publication')
        return {**p,'status':'published','verification_status':'complete'} if p and p.get('status')=='complete' else p
    def public_job(self,r):
        state=r['state']
        if (r.get('publication') or {}).get('status')=='complete':state='archived'
        elif r.get('operation') in ['collecting','archiving']:state=r['operation']
        elif r.get('collection_phase')=='complete':state='collected'
        associated=r['plan'].get('design_id');associated=associated if associated in self.workspace.projects else None
        target=execution_target(r)
        return {k:r.get(k) for k in ['job_id','run_id','source_commit','project_id','created_at','updated_at','submitted_at','remote_state','simulator_exit_code','error','status_error','operation_error']}|{k:r[k] for k in ('library_id','cell_id') if k in r}|({'execution_target':target} if target is not None else {})|{'associated_project_id':associated,'association_basis':'recorded plan.design_id; original project_id preserved','state':state,'configuration':r.get('configuration_id'),'receipt':r['run_id']+'/run.json','collection':self.results(r)['collection'],'publication':self.publication_view(r)}
    def results(self,r):
        c=r.get('collection');rid=r['run_id'];artifacts=[]
        for name in ['full-results.tar.gz','result-summary.json','archive-files.json','latest-status.log','waveforms.csv','waveforms.json','waveforms.png']:
            p=self.runner.path(rid)/name
            if p.exists():artifacts.append({'name':name,'bytes':p.stat().st_size,'url':'/api/jobs/'+rid+'/artifacts/'+name,'sha256':c['sha256'] if name=='full-results.tar.gz' and c else None})
        summary=c.get('summary',{}) if c else {}
        wavefile=self.runner.path(rid)/'waveforms.json';waves=json.loads(wavefile.read_text()).get('waveforms',[]) if wavefile.exists() else []
        metrics=list(r.get('scientific_metrics',[]))
        if r.get('simulator_exit_code') is not None:metrics.append({'name':'simulator_exit_code','value':r['simulator_exit_code'],'unit':'code','scope':'execution'})
        return {'job_id':rid,'state':'collected' if c else 'not_collected','collection':{k:v for k,v in c.items() if k!='archive'} if c else None,'metrics':metrics,'summary':summary,'waveforms':waves,'waveform_status':'actual OCEAN export from this run PSFXL' if waves else r.get('postprocess_error','native PSFXL retained; export not yet complete'),'artifacts':artifacts,'publication':self.publication_view(r)}
    def collect_with_postprocess(self,rid):
        r=self.runner.status(rid)
        if r.get('remote_state')=='simulator_complete_pending_measurements':
            try:self.runner.postprocess(rid)
            except Exception as e:
                r=self.runner.read(rid);r['postprocess_error']=str(e);self.runner.save(r)
        return self.runner.collect(rid)
    def async_operation(self,rid,operation,fn):
        with self.mutex:
            if rid in self.operations and not self.operations[rid].done():raise Conflict('job operation already in progress')
            r=self.runner.read(rid);r['operation']=operation;self.runner.save(r)
            def work():
                try:fn()
                except Exception as e:
                    current=self.runner.read(rid);current['operation_error']=str(e);self.runner.save(current)
                finally:
                    current=self.runner.read(rid);current['operation']=None;self.runner.save(current)
            self.operations[rid]=self.pool.submit(work)
        return self.public_job(self.runner.read(rid))
    def identity(self,body):
        for k in ['project_id','configuration','source_commit']:
            if not isinstance(body.get(k),str):raise ValueError(k+' must be a string')
        bundle=self.workspace.materialize(body['project_id'],body['configuration'],body['source_commit']);return bundle

class Handler(BaseHTTPRequestHandler):
    server_version='ICWorkbench/1';protocol_version='HTTP/1.1'
    def log_message(self,*args):pass
    @property
    def app(self):return self.server.app
    def guard(self,mutation=False):
        expected='127.0.0.1:'+str(self.server.server_port)
        if self.headers.get('Host')!=expected:raise PermissionError('unexpected Host header')
        origin=self.headers.get('Origin');allowed='http://'+expected
        if origin is not None and origin!=allowed:raise PermissionError('cross-origin request rejected')
        if self.headers.get('Sec-Fetch-Site') in ['cross-site','same-site']:raise PermissionError('cross-site request rejected')
        if mutation:
            if origin!=allowed:raise PermissionError('same-origin Origin required for mutations')
            if not secrets.compare_digest(self.headers.get('X-Workbench-Token',''),self.app.token):raise PermissionError('invalid mutation token')
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('JSON Content-Type required')
    def send(self,status,data,ctype='application/json',headers=None):
        raw=data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False).encode() if ctype=='application/json' else data
        # A rejected POST may still have unread body bytes. Do not interpret them
        # as the next request after a token/Origin/size error.
        if status>=400:self.close_connection=True
        self.send_response(status);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'self'")
        for key,value in (headers or {}).items():self.send_header(key,value)
        self.end_headers();self.wfile.write(raw)
    def response(self,data,status=200):self.send(status,{'ok':True,'data':data})
    def error(self,e):
        if isinstance(e,VersionControlError):
            return self.send(e.status,{'ok':False,'error':{'code':e.code,'message':str(e),'details':{}}})
        if isinstance(e,WaveformError):
            return self.send(e.status,{'ok':False,'error':{'code':e.code,'message':str(e),'details':{}}})
        if getattr(self.app,'ai',None) is not None and hasattr(e,'record') and hasattr(e,'exit_code'):
            status=409 if e.exit_code==3 else 403 if e.exit_code==4 else 503 if e.exit_code==75 else 400
            return self.send(status,{'ok':False,'error':e.record()})
        if isinstance(e,InvalidGeometry):return self.send(422,{'ok':False,'error':{'code':'invalid_geometry','message':str(e),'details':{}}})
        status,code=(409,'conflict') if isinstance(e,Conflict) else (403,'forbidden') if isinstance(e,PermissionError) else (404,'not_found') if isinstance(e,FileNotFoundError) else (400,'invalid_input') if isinstance(e,(ValueError,KeyError,TypeError)) else (500,'backend_failure')
        self.send(status,{'ok':False,'error':{'code':code,'message':str(e),'details':{}}})
    def do_OPTIONS(self):self.send(403,{'ok':False,'error':{'code':'forbidden','message':'CORS is disabled','details':{}}})
    def do_GET(self):
        try:
            self.guard();u=urlsplit(self.path);path=unquote(u.path)
            qs={} if path in ('/api/version-control','/api/version-control/commit') else parse_qs(u.query)
            get=lambda k:qs.get(k,[''])[0]
            if path.startswith('/api/ai/'):
                if self.app.ai is None:raise FileNotFoundError('AI adapter is not configured')
                if path=='/api/ai/events' and 'text/event-stream' in self.headers.get('Accept',''):
                    after=max(int(get('after') or 0),int(self.headers.get('Last-Event-ID','0')))
                    return self.app.ai.stream(self,after,qs.get('session_id',['default'])[0])
                return self.response(self.app.ai.get(path,qs))
            if path=='/api/health':return self.response({'api_version':'1','mode':'live','mutation_token':self.app.token,
                'ai_activity':{'running_summaries':self.app.ai.commit_summary_activity()['running_count'] if self.app.ai else 0},
                'capabilities':{'git':True,'runner':True,'publish':True,'supervision':True,'submission_lookup':True,'viewer':(self.app.web/'viewer-adapter/index.js').exists()}})
            if path=='/api/project':
                data=self.app.workspace.describe();data['capabilities']['viewer']=(self.app.web/'viewer-adapter/index.js').exists();return self.response(data)
            if path=='/api/supervision':
                query=parse_qs(u.query,keep_blank_values=True,strict_parsing=True,max_num_fields=2,errors='strict')
                if set(query)!={'project_id'} or len(query['project_id'])!=1 or not query['project_id'][0]:raise ValueError('One explicit project_id is required')
                return self.response(self.app.supervision.snapshot(query['project_id'][0]))
            if path.startswith('/api/submissions/'):
                if u.query:raise ValueError('Submission lookup does not accept query parameters')
                return self.response(self.app.supervision.submission(path[len('/api/submissions/'):]))
            if path=='/api/changes/summary':
                if set(qs)!={'summary_id'} or len(qs['summary_id'])!=1:raise ValueError('exact summary identity required')
                if self.app.ai is None:raise FileNotFoundError('AI adapter is not configured')
                return self.response(self.app.ai.get_commit_summary(qs['summary_id'][0]))
            if path in ('/api/version-control','/api/version-control/commit'):
                if len(u.query)>2048 or re.search(r'%(?![a-fA-F0-9]{2})',u.query):raise ValueError('invalid version-control query')
                query=parse_qs(u.query,keep_blank_values=True,strict_parsing=True,max_num_fields=5,errors='strict')
                detail=path.endswith('/commit');required={'project_id','commit'} if detail else {'project_id'}
                allowed=required|{'scope'} if detail else required|{'limit','scope','include_cosmetic'}
                if not required.issubset(query) or not set(query).issubset(allowed) or any(len(v)!=1 or not v[0] for v in query.values()):
                    raise ValueError('exact version-control query parameters required')
                scope=query.get('scope',['all'])[0]
                if scope not in ('all','design'):raise ValueError('invalid version-control scope')
                if detail:return self.response(self.app.workspace.version_control_commit(query['project_id'][0],query['commit'][0],scope=scope))
                raw_limit=query.get('limit',['20'])[0]
                if not re.fullmatch(r'[1-9][0-9]?',raw_limit):raise ValueError('version history limit must be 1..50')
                cosmetic=query.get('include_cosmetic',['0'])[0]
                if cosmetic not in ('0','1'):raise ValueError('include_cosmetic must be 0 or 1')
                return self.response(self.app.workspace.version_control(query['project_id'][0],int(raw_limit),scope=scope,include_cosmetic=cosmetic=='1'))
            if path=='/api/configuration':
                required={'project_id','configuration','source_commit'}
                if set(qs)!=required or any(len(qs[k])!=1 or not get(k) for k in required):raise ValueError('exact configuration identity query parameters required')
                return self.response(self.app.workspace.configuration_description(get('project_id'),get('configuration'),get('source_commit')))
            if path=='/api/tree':return self.response(self.app.workspace.tree(get('project_id')))
            if path=='/api/file':return self.response(self.app.workspace.file(get('path')))
            if path=='/api/jobs':return self.response({'jobs':[self.app.public_job(r) for r in self.app.runner.list()]})
            if path=='/api/schematic':
                data=self.app.geometry.schematic(get('project_id'),get('path'),get('source_hash'),'http://127.0.0.1:'+str(self.server.server_port))
                data.update(adapter_url='/viewer-adapter/index.js' if (self.app.web/'viewer-adapter/index.js').exists() else None,version='RNL native geometry v1',limitations=['Integrity is checked by the gateway; fidelity requires committed owner validation.'])
                return self.response(data)
            if path in ['/api/geometry/file','/api/geometry/viewer-manifest']:
                required=['project_id','bundle_commit','manifest_sha256','path' if path.endswith('/file') else 'entry']
                if set(qs)!=set(required) or any(len(qs[k])!=1 or not get(k) for k in required):raise ValueError('exact pinned geometry query parameters required')
                args=[get('project_id'),get('bundle_commit'),get('manifest_sha256')]
                if path.endswith('/file'):
                    raw,mime,headers=self.app.geometry.file(*args,get('path'));return self.send(200,raw,mime,headers)
                return self.send(200,self.app.geometry.viewer_manifest(*args,get('entry'),'http://127.0.0.1:'+str(self.server.server_port)))
            wave=re.fullmatch(r'/api/jobs/([A-Za-z0-9_-]+)/(signals|waveform|waveform-map)',path)
            if wave:return self.response(waveform_dispatch(self.app.waveforms,wave[1],wave[2],parse_qs(u.query,keep_blank_values=True)))
            m=re.fullmatch(r'/api/jobs/([A-Za-z0-9_-]+)(/results|/artifacts/([A-Za-z0-9_.-]+))?',path)
            if m:
                r=self.app.runner.read(m[1])
                if m[3]:
                    if m[3] not in ['full-results.tar.gz','result-summary.json','archive-files.json','latest-status.log','waveforms.csv','waveforms.json','waveforms.png']:raise FileNotFoundError('unknown artifact')
                    p=self.app.runner.path(m[1])/m[3]
                    self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(p.stat().st_size));self.send_header('Content-Disposition','attachment; filename="'+p.name+'"');self.end_headers()
                    with p.open('rb') as f:
                        for chunk in iter(lambda:f.read(1024*1024),b''):self.wfile.write(chunk)
                    return
                if m[2]:return self.response(self.app.results(r))
                active=self.app.operations.get(m[1]);observed=r if active and not active.done() else self.app.runner.status(m[1])
                return self.response(self.app.public_job(observed))
            if path.startswith('/api/'):raise FileNotFoundError('unknown API route')
            relative='index.html' if path=='/' else path.lstrip('/');p=self.app.web/relative
            if any(x.startswith('.') or x=='..' for x in Path(relative).parts) or not p.resolve().is_relative_to(self.app.web) or p.is_symlink() or not p.is_file():raise FileNotFoundError('asset not found')
            for parent in p.parents:
                if parent==self.app.web:break
                if parent.is_symlink():raise PermissionError('symlink static path denied')
            return self.send(200,p.read_bytes(),mimetypes.guess_type(p.name)[0] or 'application/octet-stream')
        except (BrokenPipeError,ConnectionResetError):pass
        except Exception as e:self.error(e)
    def do_POST(self):
        try:
            self.guard(True);length=int(self.headers.get('Content-Length','0'))
            if length<0 or length>2*1024*1024:raise ValueError('request body too large')
            b=json.loads(self.rfile.read(length));path=urlsplit(self.path).path
            if not isinstance(b,dict):raise ValueError('JSON object required')
            if path.startswith('/api/ai/'):
                if self.app.ai is None:raise FileNotFoundError('AI adapter is not configured')
                return self.response(self.app.ai.post(path,b))
            if path=='/api/sync':return self.response(self.app.workspace.sync())
            if path=='/api/version-control/restore-preview':
                if set(b)!={'project_id','commit','base_commit'}:raise ValueError('exact restore preview identity required')
                return self.response(self.app.workspace.version_control_restore_preview(b['project_id'],b['commit'],b['base_commit']))
            if path=='/api/changes/summary':
                if set(b)!={'project_id','base_commit','review_id'}:raise ValueError('exact summary review identity required')
                if self.app.ai is None:raise FileNotFoundError('AI adapter is not configured')
                verified=self.app.workspace.commit_summary_input(b['project_id'],b['base_commit'],b['review_id'])
                return self.response(self.app.ai.start_commit_summary(verified))
            if path=='/api/changes/preview':return self.response(self.app.workspace.preview(b['base_commit'],b['changes']))
            if path=='/api/changes/commit':return self.response(self.app.workspace.commit(b['base_commit'],b['changes'],b.get('message','Update circuit configuration'),bool(b.get('push',False))))
            if path in ['/api/plan','/api/preflight','/api/jobs']:
                bundle=self.app.identity(b)
                if path=='/api/plan':
                    plan=self.app.runner.plan(bundle,b['source_commit']);return self.response({**plan,'project_id':b['project_id'],'configuration':b['configuration'],'source_commit':b['source_commit'],'state':'planned','inputs':plan['provenance']['files'],'settings':plan.get('configuration',{}),'execution_mode':'resource_pool' if self.app.resource_pool else 'fixed_site','resource_selection_required':self.app.resource_pool is not None})
                identity={k:b[k] for k in ('project_id','configuration','source_commit')}
                if path=='/api/preflight':
                    return self.response(self.app.resource_pool.prepare(self.app.runner,bundle,identity) if self.app.resource_pool else self.app.runner.preflight(bundle,b['source_commit']))
                execution=None
                if self.app.resource_pool:
                    if 'execution_plan_id' not in b:raise ValueError('Resource-pool submission requires the reviewed preflight execution_plan_id')
                    execution=self.app.resource_pool.resolve(b['execution_plan_id'],bundle,identity)
                elif 'execution_plan_id' in b:raise ValueError('Resource-pool submission is not configured')
                r,new=self.app.runner.reserve(bundle,b['idempotency_key'],b['source_commit'],b['project_id'],b['configuration'],execution_context=execution)
                if new:self.app.operations[r['run_id']]=self.app.pool.submit(self.app.runner.dispatch,r['run_id'])
                return self.response(self.app.public_job(r),202)
            m=re.fullmatch(r'/api/jobs/([A-Za-z0-9_-]+)/(collect|publish)',path)
            if m:
                rid=m[1];self.app.runner.read(rid)
                if m[2]=='collect':return self.response(self.app.async_operation(rid,'collecting',lambda:self.app.collect_with_postprocess(rid)),202)
                self.app.publisher.prepare(rid)
                return self.response(self.app.async_operation(rid,'archiving',lambda:self.app.publisher.publish(rid)),202)
            raise FileNotFoundError('unknown API route')
        except Exception as e:self.error(e)
class Server(ThreadingHTTPServer):
    daemon_threads=True
def main():
    p=argparse.ArgumentParser();p.add_argument('--config',required=True,type=Path);p.add_argument('--web-root',required=True,type=Path);p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=8766);a=p.parse_args()
    if a.host!='127.0.0.1':p.error('only 127.0.0.1 is supported; public bind is forbidden')
    app=Application(json.loads(a.config.read_text()),a.web_root);server=Server((a.host,a.port),Handler);server.app=app;atomic(Path(app.cfg['runtime_root'])/'gateway-process.json',{'pid':os.getpid(),'port':server.server_port,'host':a.host});print(json.dumps({'url':f'http://127.0.0.1:{server.server_port}','api':'v1','mode':'live','pid':os.getpid()}),flush=True)
    import signal
    def stop_server(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_server)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        server.server_close();app.pool.shutdown(wait=False)
        if app.ai is not None:app.ai.close()
if __name__=='__main__':main()
