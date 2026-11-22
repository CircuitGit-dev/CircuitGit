"""MCP window v1 schemas. Separate from the unchanged shared CLI/core-tool contracts."""
import copy
import math
import re
from .service import Failure

VERSION = 'ic.views.v1'
MIME = 'text/html;profile=mcp-app'
RESOURCES = {kind: 'ui://ic-workbench/' + kind + '.html' for kind in ('schematic', 'waveforms', 'simulation', 'workbench')}

def obj(properties, required=()):
    return {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False}
def string(maximum=180): return {'type': 'string', 'minLength': 1, 'maxLength': maximum}
def integer(minimum, maximum): return {'type': 'integer', 'minimum': minimum, 'maximum': maximum}
def enum(*values): return {'type': 'string', 'enum': list(values)}
WID = {'type':'string','pattern':r'w_[a-f0-9]{32}'}
VID = {'type':'string','pattern':r'v_[a-f0-9]{32}'}
COMMIT = {'type':'string','pattern':r'[a-f0-9]{40}'}
HASH = {'type':'string','pattern':r'[a-f0-9]{64}'}
REF = {'workspace_id':WID,'view_id':VID}
CAS = {**REF,'expected_revision':integer(1,2147483647)}
NUM = {'type':'number'}
QUERY = {'oneOf':[
    obj({'kind':enum('project','source','schematic','configuration','draft','runs','signals','mapping','results','layout','snapshot')},['kind']),
    obj({'kind':enum('geometry_manifest'),'entry':string(1024)},['kind','entry']),
    obj({'kind':enum('geometry_file'),'path':string(1024),'offset':integer(0,33554432),'limit':integer(1,524288)},['kind','path']),
    obj({'kind':enum('waveform'),'signal_id':string(),'analysis':enum('tran'),'start':NUM,'end':NUM,'limit':integer(16,10000),'cursor_a':NUM,'cursor_b':NUM},['kind','signal_id']),
    obj({'kind':enum('request'),'request_id':HASH},['kind','request_id']),
]}
GEOMETRY_SELECTION = obj({'viewer_source_path':string(1024),'native_entry_id':string(1024),
    'bundle_commit':COMMIT,'manifest_sha256':HASH,'source_match':{'type':'boolean'},
    'canonical_mapping_enabled':{'type':'boolean'},'snapshot_only':{'type':'boolean'}})
SELECTION = obj({'kind':enum('none','instance','net','terminal','signals'),'name':string(1024),'source_path':string(1024),
    'line_start':integer(1,1000000),'line_end':integer(1,1000000),'scope':string(1024),
    'occurrence_path':{'type':'array','items':string(512),'maxItems':64},'terminal':string(256),
    'signal_ids':{'type':'array','items':string(),'maxItems':32},'geometry':GEOMETRY_SELECTION},['kind'])
OPEN = {'project_id':string(),'workspace_id':WID,'source_commit':COMMIT}
SCHEMAS = {
 'ic_workbench_open':obj({'project_id':string(),'configuration':string(),'run_id':string(),'workspace_id':WID,'workbench_id':VID},['project_id']),
 'ic_schematic_open':obj({**OPEN,'path':string(1024)},['project_id']),
 'ic_waveforms_open':obj({**OPEN,'run_id':string()},['project_id','run_id']),
 'ic_simulation_open':obj({**OPEN,'configuration':string(),'run_id':string()},['project_id','configuration']),
 'ic_workspace_get':obj({'workspace_id':WID},['workspace_id']),
 'ic_view_get':obj(REF,REF),
 'ic_view_data':obj({**REF,'revision':integer(1,2147483647),'query':QUERY},[*REF,'revision','query']),
 'ic_view_select':obj({**CAS,'selection':SELECTION},[*CAS,'selection']),
 'ic_view_state':obj({**CAS,'visible':{'type':'boolean'},'display_mode':enum('inline','fullscreen','pip'),'client_state':enum('loaded','error'),'message':{'type':'string','maxLength':2000}},CAS),
 'ic_view_draft':obj({**CAS,'text':{'type':'string','maxLength':1048576}},[*CAS,'text']),
 'ic_workbench_layout':obj({**CAS,'text':{'type':'string','maxLength':131072}},[*CAS,'text']),
 'ic_view_snapshot':obj({**CAS,'text':{'type':'string','maxLength':1048576}},[*CAS,'text']),
 'ic_view_plan':obj({**CAS,'action':enum('preview_draft','plan')},[*CAS,'action']),
 'ic_view_bind_run':obj({**CAS,'request_id':HASH},[*CAS,'request_id']),
 'ic_view_request':obj({**CAS,'operation':enum('apply','sim_submit','sim_collect','sim_archive'),'idempotency_key':{'type':'string','minLength':8,'maxLength':160},'message':string(300)},[*CAS,'operation','idempotency_key']),
}
DESCRIPTIONS = {
 'ic_workbench_open':'Open or explicitly reopen a project workbench containing arrangeable child views. Parent keeps its current-source identity; a supplied saved run is separate. No child views or simulations are created automatically.',
 'ic_schematic_open':'Request an independent schematic UI for an explicit project/source. Does not prove host mounting or change geometry.',
 'ic_waveforms_open':'Request a saved-waveform UI for one explicit project/run; current schematic staleness does not block historical catalog reads.',
 'ic_simulation_open':'Request a simulation configuration/review UI for one pinned project/configuration. No simulator execution.',
 'ic_workspace_get':'Read explicit workspace views and latest selection; there is no global active project/window.',
 'ic_view_get':'Read the current bounded view descriptor and revision.',
 'ic_view_data':'Read one finite UI data section at the exact view revision. Engineering payload is UI-only metadata; use existing ic_read for model text.',
 'ic_view_select':'Store explicitly sourced selection metadata. UI instance/net labels are untrusted, not proof of terminal/run mapping.',
 'ic_view_state':'Store visibility/display preference or client-reported loaded/error state. Never claims native mounting.',
 'ic_view_draft':'Store bounded configuration JSON draft only; no source write, commit, or simulation.',
 'ic_workbench_layout':'Save a bounded workbench panel/tab/split layout with exact parent revision and child project/workspace checks. Closing panels never changes engineering state or child visibility.',
 'ic_view_snapshot':'Save bounded finite JSON UI state at the exact child view revision. Preserves unfinished editor text inside strings; no source validation, request, approval or simulation.',
 'ic_view_plan':'Preview the saved configuration draft or materialize a plan for committed source. No source commit, remote check, or solver.',
 'ic_view_bind_run':'Bind only the run_id returned by this view’s own accepted sim_submit request; CAS plus project/config/source checks, never latest-run inference.',
 'ic_view_request':'Prepare a durable operation request for manual review; never dispatches it. Uses the existing gateway Service guards.',
}

# Payload shape varies by operation; nested exact view/data schemas are documented in VIEW-CONTRACT.md.
ENVELOPE = {'type':'object','properties':{'ok':{'type':'boolean'},'data':{'type':'object'},'error':{'type':'object'}},'required':['ok'],'additionalProperties':False}

def tools():
    result=[]
    for name,schema in SCHEMAS.items():
        meta={'ui':{'visibility':['model','app']}}
        if name.endswith('_open'):meta['ui']['resourceUri']=RESOURCES[name[3:-5]]
        elif name in ('ic_view_data','ic_view_state','ic_view_draft','ic_view_plan','ic_workbench_layout','ic_view_snapshot'):meta['ui']['visibility']=['app']
        result.append({'name':name,'description':DESCRIPTIONS[name],'inputSchema':copy.deepcopy(schema),'outputSchema':copy.deepcopy(ENVELOPE),
            '_meta':meta,'annotations':{'readOnlyHint':name in ('ic_workspace_get','ic_view_get','ic_view_data'),
             'destructiveHint':False,'idempotentHint':not name.endswith('_open'),'openWorldHint':False}})
    return result

def validate(schema,value,path='arguments'):
    if 'oneOf' in schema:
        matches=0
        for option in schema['oneOf']:
            try:validate(option,value,path);matches+=1
            except Failure:pass
        if matches!=1:raise Failure('invalid_input',path+' must match exactly one query schema')
        return
    typ=schema.get('type')
    valid={'object':isinstance(value,dict),'array':isinstance(value,list),'string':isinstance(value,str),
           'integer':isinstance(value,int) and not isinstance(value,bool),'number':isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value),
           'boolean':isinstance(value,bool)}
    if typ and not valid[typ]:raise Failure('invalid_input',path+' has incorrect type')
    if 'enum' in schema and value not in schema['enum']:raise Failure('invalid_input',path+' is outside the finite enum')
    if typ=='object':
        if not set(schema.get('required',[]))<=set(value) or set(value)-set(schema['properties']):raise Failure('invalid_input',path+' has missing/unsupported fields')
        for key,item in value.items():validate(schema['properties'][key],item,path+'.'+key)
    elif typ=='array':
        if not schema.get('minItems',0)<=len(value)<=schema.get('maxItems',1000):raise Failure('invalid_input',path+' exceeds array bounds')
        for item in value:validate(schema['items'],item,path+'[]')
    elif typ=='string':
        if not schema.get('minLength',0)<=len(value)<=schema.get('maxLength',2097152):raise Failure('invalid_input',path+' exceeds text bounds')
        if 'pattern' in schema and not re.fullmatch(schema['pattern'],value):raise Failure('invalid_input',path+' has invalid syntax')
    elif typ in ('integer','number'):
        if not schema.get('minimum',-math.inf)<=value<=schema.get('maximum',math.inf):raise Failure('invalid_input',path+' is outside bounds')
