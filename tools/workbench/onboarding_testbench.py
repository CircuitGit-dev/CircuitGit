"""Literal agent-authored testbench drafts and explicit source/PDK bindings."""
import copy
import hashlib
import re

from spiceowl_pool import canonical

from agent_testbench_manifest import MANIFEST_SCHEMA, NAME, validate_manifest, helper_files

SELECTION_FIELDS={'discovery_id','candidate_id','sections','tmi_candidate_id','model_contracts','host_ids'}


def digest(value):return hashlib.sha256(canonical(value)).hexdigest()


def validate_selection(value):
    if value is None or value=={}:return None
    if type(value) is not dict or not SELECTION_FIELDS<=set(value) or set(value)-SELECTION_FIELDS-{'veriloga_header_id'}:raise ValueError('Select exact PDK, sections, contracts and host IDs')
    if 'veriloga_header_id' in value and (not isinstance(value['veriloga_header_id'],str) or not re.fullmatch(r'headers_[a-f0-9]{64}',value['veriloga_header_id'])):
        raise ValueError('Select an exact observed Verilog-A header identity')
    for field in ('discovery_id','candidate_id'):
        if not isinstance(value[field],str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,180}',value[field]):raise ValueError('Invalid PDK selection identity')
    if type(value['sections']) is not list or not 1<=len(value['sections'])<=64 or any(s is not None and (not isinstance(s,str) or not NAME.fullmatch(s)) for s in value['sections']) or len(set(value['sections']))!=len(value['sections']):
        raise ValueError('Select distinct observed PDK sections or explicit global scope')
    if type(value['host_ids']) is not list or not 1<=len(value['host_ids'])<=8 or any(not isinstance(h,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}',h) for h in value['host_ids']) or len(set(value['host_ids']))!=len(value['host_ids']):
        raise ValueError('Select one to eight distinct observed SSH host aliases')
    if type(value['model_contracts']) is not dict or len(value['model_contracts'])>256:
        raise ValueError('Model contracts must be an explicit bounded object')
    if value['tmi_candidate_id'] is not None and (not isinstance(value['tmi_candidate_id'],str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,180}',value['tmi_candidate_id'])):
        raise ValueError('Select an observed TMI identity')
    return copy.deepcopy(value)


def source_inputs(folder,state):
    path=folder/'source.scs'
    if path.is_symlink() or not path.is_file():
        raise ValueError('Original intake source bytes changed')
    source=path.read_bytes()
    if hashlib.sha256(source).hexdigest()!=state['source_sha256']:raise ValueError('Original intake source bytes changed')
    supports={}
    for name,row in state.get('support_files',{}).items():
        if (not isinstance(name,str) or len(name)>240 or any(part in ('.','..') or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',part) for part in name.split('/'))
                or not isinstance(row,dict) or not isinstance(row.get('sha256'),str) or not re.fullmatch('[a-f0-9]{64}',row['sha256'])):
            raise ValueError('Supporting source identity changed')
        target=folder/'support'/name
        if any(parent.is_symlink() for parent in [target,*target.parents] if parent.is_relative_to(folder)) or not target.is_file():
            raise ValueError('Original supporting source bytes changed')
        raw=target.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=row['sha256']:raise ValueError('Original supporting source bytes changed')
        supports[name]=raw
    return source,supports


def draft_record(folder,state,manifest,selection):
    manifest=validate_manifest(manifest);selection=validate_selection(selection)
    source,support=source_inputs(folder,state)
    helpers=helper_files(manifest)
    combined_support(support,helpers)
    binding={'source_sha256':state['source_sha256'],'support_sha256':{name:hashlib.sha256(raw).hexdigest() for name,raw in support.items()},
             'testbench':manifest,'selection':selection}
    if helpers:binding['helper_sha256']={name:hashlib.sha256(raw).hexdigest() for name,raw in helpers.items()}
    return {'schema':'ic.onboarding.agent-tb.v1','draft_id':digest(binding),'revision':state['revision'],
        'source_sha256':state['source_sha256'],'testbench_sha256':hashlib.sha256(manifest['text'].encode()).hexdigest(),
        'manifest_sha256':digest(manifest),'status':'draft','testbench':manifest,'selection':selection,
        'support_sha256':binding['support_sha256'],**({'helper_sha256':binding['helper_sha256']} if helpers else {}),
        'requires_human_review':True}


def combined_support(support,helpers):
    """Preserve the source/TB distinction while checking their shared namespace."""
    names={name.lower() for name in support}
    for name in helpers:
        name=name.lower()
        if any(name==other or name.startswith(other+'/') or other.startswith(name+'/') for other in names):
            raise ValueError('Testbench helper conflicts with original supporting source')
        names.add(name)
    return {**support,**helpers}


def validate_authored_testbench(*, source, testbench_manifest, support_files=None, pdk_binding):
    """Pure source/manifest binding checks shared by onboarding and registered CI."""
    from spiceowl.onboarding.agent_tb import validate_agent_tb
    manifest=validate_manifest(testbench_manifest)
    support=combined_support(support_files or {},helper_files(manifest))
    validation=validate_agent_tb(source=source,testbench=manifest['text'],support_files=support,
        criteria=manifest,pdk_binding=pdk_binding)
    missing=validation['missing']
    requirements=validation['requirements'];interface=manifest['interface']
    tops=[r for r in requirements['interfaces'] if r['name']==interface['subckt'] and not r.get('scope')]
    instances=[r for r in requirements['instances'] if r['path']=='tb.scs' and not r.get('scope') and r['name']==interface['instance']]
    if len(tops)!=1 or set(interface['port_bindings'])!=set(tops[0]['ports']) or len(instances)!=1 or instances[0]['master']!=interface['subckt'] or instances[0]['ordered_nets']!=[interface['port_bindings'][port] for port in tops[0]['ports']]:
        missing.append({'field':'interface','code':'dut_binding_mismatch','message':'The declared DUT and all port bindings must match the literal testbench instance.'})
    declared=[(a.get('name'),a.get('kind')) for a in manifest['analyses'] if isinstance(a,dict)]
    actual=[(a['name'],a['kind']) for a in validation['analyses']]
    if declared!=actual:missing.append({'field':'analyses','code':'analysis_manifest_mismatch','message':'Authored analysis names/kinds must match the literal testbench analyses.'})
    validation['status']='blocked' if missing else 'static_ready'
    return validation


def compile_agent_selection(folder,state,saved):
    from onboarding_prepare import selected_candidate
    from spiceowl.onboarding.pdk_discovery import audit_config_for_candidate
    from spiceowl.experiments.recipes import validate_model_profile
    draft=state['agent_tb'];manifest=validate_manifest(draft['testbench']);args=validate_selection(draft['selection'])
    if args is None:return {'missing':[{'field':'selection','code':'pdk_selection_missing','message':'Select this intake PDK and allowed hosts before preparation.'}]}
    row,candidate=selected_candidate(saved,args['candidate_id']);data=row['result']
    if data['source_sha256']!=state['source_sha256']:raise ValueError('Discovery belongs to another source')
    source,support=source_inputs(folder,state)
    if draft_record(folder,state,manifest,args)['draft_id']!=draft['draft_id']:raise ValueError('Saved testbench draft binding changed')
    platforms={digest({'candidate_id':candidate['candidate_id'],'relative_library':p['relative_library']}):p['relative_library']
        for item in candidate.get('tmi_candidates',[]) for p in item.get('platform_candidates',[])}
    tmi=args['tmi_candidate_id']
    if tmi is not None and tmi not in platforms:raise ValueError('TMI is not part of the selected model candidate')
    missing=[]
    if platforms and tmi is None:missing.append({'field':'tmi_candidate_id','code':'tmi_selection_missing','message':'Select an observed TMI platform.'})
    pdk=('simulator lang=spectre\n'+''.join('include "@EXTERNAL_PDK_MAIN@"'+(' section='+section if section else '')+'\n' for section in args['sections'])).encode()
    model_names=list(state['source']['requirements']['required_masters'])
    binding={'discovery_id':args['discovery_id'],'candidate_id':args['candidate_id'],'sections':args['sections'],
        'model_names':model_names,'pdk_sha256':hashlib.sha256(pdk).hexdigest(),'entry_sha256':candidate['entry_sha256'],'tmi_candidate_id':tmi}
    validation=validate_authored_testbench(source=source,testbench_manifest=manifest,support_files=support,pdk_binding=binding)
    required_headers={edge['reference'] for edge in validation['requirements'].get('veriloga_external_dependencies',[])}
    header_profile=None
    if args.get('veriloga_header_id'):
        from onboarding_veriloga import verify_record,header_binding
        from spiceowl_pool import read_json
        header_id=args['veriloga_header_id']
        if not any(item['id']==header_id and item['probe_id']==row['probe_id'] for item in state.get('veriloga_headers',[])):
            raise ValueError('Select headers observed on the same current host as this PDK')
        record=read_json(folder/'veriloga-headers'/(header_id+'.json'))
        observation=verify_record(record,header_id,row['probe_id'])
        selected_headers,aliases=header_binding(observation,required_headers)
        binding.update(selected_headers)
        if required_headers:
            header_profile={'observation':observation,'binding':selected_headers,'aliases':aliases,
                'spectre':record['spectre']}
        validation=validate_authored_testbench(source=source,testbench_manifest=manifest,support_files=support,pdk_binding=binding)
    missing.extend(validation['missing'])
    requirements=validation['requirements']
    models=copy.deepcopy(args['model_contracts'])
    for name in requirements['required_masters']:
        if name in models:continue
        counts={r['port_count'] for r in requirements['instances'] if r['master']==name}
        if len(counts)!=1 or not next(iter(counts),0):
            missing.append({'field':'model_contracts.'+name,'code':'terminal_count_ambiguous','message':'Supply an explicit positional terminal contract.'});continue
        models[name]={'kind':'external','terminals':['terminal'+str(i) for i in range(next(iter(counts)))]}
    profile={'schema':'spiceowl.experiment-model-profile.v1','id':'agent-intake-model','models':models,
        'corners':{'selected':[{'alias':'PDK_MAIN','section':section} for section in args['sections']]}}
    validate_model_profile(profile)
    base='projects/'+state['intake_id']+'/'
    documents={base+'dut.scs':source,base+'tb.scs':manifest['text'].encode(),base+'pdk.scs':pdk,base+'agent-testbench.json':canonical(manifest)}
    documents.update({base+'support/'+name:raw for name,raw in support.items()})
    helpers=helper_files(manifest)
    documents.update({base+'helpers/'+name:raw for name,raw in helpers.items()})
    selection={'mode':'agent-tb','source_id':base+'dut.scs','testbench_id':base+'tb.scs','pdk_id':base+'pdk.scs',
        'support_files':{**{name:base+'support/'+name for name in support},**{name:base+'helpers/'+name for name in helpers}},
        'manifest_id':base+'agent-testbench.json'}
    compiled={'recipe_id':'agent-testbench','documents':documents,'selection':selection,
        'spec':{'schema':'spiceowl.experiment-spec.v1','recipe':'agent-testbench','corner':'selected','criteria':manifest,'pdk_binding':binding},
        'electrical':profile,'source':{'source_id':base+'dut.scs','text':source.decode(),'sha256':state['source_sha256'],'original_sha256':state['source_sha256']},
        'wrapper':{'added':False,'transformation':'none','original_bytes_preserved':True},'validation':validation,'missing':missing}
    if missing:return {'missing':missing,'compiled':compiled,'probe_id':row['probe_id']}
    audit=audit_config_for_candidate(data,candidate['candidate_id'],sections=args['sections'],tmi_relative_library=platforms.get(tmi))
    return {'missing':[],'compiled':compiled,'probe_id':row['probe_id'],'candidate':candidate,'audit':audit,
        **({'veriloga_headers':header_profile} if header_profile else {})}
