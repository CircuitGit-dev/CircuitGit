"""Pure selection of scopes from this intake's retained PDK observation.

SpiceOwl owns scope enumeration and projection. This adapter binds its private
receipt to the current source, observed host and discovery without remote I/O.
"""
import copy
import hashlib
from pathlib import Path
import re
import secrets

from spiceowl_pool import canonical, read_json, MAX_RECORD_BYTES


HASH = re.compile(r'[a-f0-9]{64}\Z')
PROBE = re.compile(r'probe_[a-f0-9]{32}\Z')
MAX_PUBLIC_BYTES = 2*1024*1024-128*1024
MAX_SELECTION_BYTES = 16*1024*1024
CONTEXT_SCHEMA = 'ic.onboarding.pdk-scope-context.v1'


def digest(value):return hashlib.sha256(canonical(value)).hexdigest()


def identifier(value,label):
    if not isinstance(value,str) or not HASH.fullmatch(value):
        raise ValueError('Select an exact returned '+label+' identity')
    return value


def page_number(value,default,maximum,label,minimum=0):
    if value is None:return default
    if isinstance(value,str) and re.fullmatch(r'0|[1-9][0-9]{0,6}',value):value=int(value)
    if type(value) is not int or not minimum<=value<=maximum:
        raise ValueError('Invalid bounded '+label)
    return value


def private_path(folder,*parts):
    folder=Path(folder)
    target=folder.joinpath(*parts)
    for path in (target,*target.parents):
        if path.is_symlink():raise ValueError('A retained scope observation cannot redirect through a symlink')
        if path==folder:break
    if not target.is_relative_to(folder):raise ValueError('Invalid private scope observation location')
    return target


def library_observation_binding(capture,probe_id,library,source_sha256):
    """Freeze the observed library/host association during explicit discovery."""
    from spiceowl.onboarding.pdk_discovery import validate_pdk_library
    from onboarding_lut import _scope
    validate_pdk_library(library)
    if not isinstance(probe_id,str) or not PROBE.fullmatch(probe_id):
        raise ValueError('Use an exact current probe for the library observation')
    identifier(source_sha256,'source')
    identity,_,gaps=_scope(capture,library.get('roots'))
    if gaps:raise ValueError('The library observation has no complete observed server identity')
    return {'schema':'ic.onboarding.pdk-library-binding.v1','source_sha256':source_sha256,
        'probe_id':probe_id,'capture_sha256':digest(capture),'server_identity_sha256':digest(identity),
        'library_id':library['library_id'],'library_sha256':digest(library),
        'roots':copy.deepcopy(library['roots'])}


def load_library_context(folder,state,probe_id,library_id):
    """Require a retained current-probe library, never another intake/cache path."""
    if Path(folder).name!=state.get('intake_id'):
        raise ValueError('The retained scope directory belongs to another intake')
    if not isinstance(probe_id,str) or not PROBE.fullmatch(probe_id):
        raise ValueError('Select an exact current probe identity')
    identifier(library_id,'library')
    probes=[row for row in state.get('probes',[]) if row.get('probe_id')==probe_id]
    if len(probes)!=1:raise ValueError('The selected probe is not current for this intake')
    discovery_id=(state.get('discovery') or {}).get('discovery_id')
    if not isinstance(discovery_id,str) or not re.fullmatch(r'discovery_[a-f0-9]{32}',discovery_id):
        raise ValueError('A current retained library discovery is required')
    saved=read_json(private_path(folder,'discoveries',discovery_id+'.json'))
    if saved.get('source_sha256')!=state['source_sha256']:
        raise ValueError('The retained library discovery belongs to another source')
    rows=[row for row in saved.get('rows',[]) if row.get('probe_id')==probe_id]
    public_rows=[row for row in (state.get('discovery') or {}).get('lut',[]) if row.get('probe_id')==probe_id]
    if len(rows)!=1 or len(public_rows)!=1:raise ValueError('Select a library observed on this current probe')
    for lut in (rows[0].get('lut') or {},public_rows[0]):
        effective=lut.get('projection') or lut
        if effective.get('library_id')!=library_id:
            raise ValueError('The library is not the current observation for this probe')
    from spiceowl.onboarding.pdk_discovery import MAX_LIBRARY_RESULT_BYTES,validate_pdk_library
    library=read_json(private_path(folder,'libraries',library_id+'.json'),limit=MAX_LIBRARY_RESULT_BYTES)
    validate_pdk_library(library)
    if library.get('library_id')!=library_id:raise ValueError('Retained library content identity differs')
    capture=read_json(private_path(folder,'probes',probe_id+'.json'))
    observed_binding=rows[0].get('library_binding')
    if observed_binding is None:
        raise ValueError('This retained library needs explicit cache-only rebinding to its current probe; catalog reads do not repair old observation proofs or start a scan')
    if observed_binding!=library_observation_binding(capture,probe_id,library,state['source_sha256']):
        raise ValueError('The retained library source, probe, host or content binding changed')
    from onboarding_lut import _scope
    server_identity,_,gaps=_scope(capture,library.get('roots'))
    if gaps:raise ValueError('The retained probe has no complete server identity for scope selection')
    from onboarding_testbench import source_inputs
    source_inputs(folder,state)
    requirements=state['source']['requirements']
    if requirements.get('source_sha256')!=state['source_sha256']:
        raise ValueError('Current model requirements belong to another source')
    binding={'connection_id':state['connection_id'],'intake_id':state['intake_id'],
        'source_sha256':state['source_sha256'],'requirements_sha256':digest(requirements),
        'probe_id':probe_id,'ssh_target':probes[0]['ssh_target'],'capture_sha256':digest(capture),
        'server_identity_sha256':digest(server_identity),'discovery_id':discovery_id,
        'discovery_sha256':digest(saved),'library_id':library_id,'library_sha256':digest(library)}
    return {'library':library,'capture':capture,'server_identity':server_identity,
            'requirements':requirements,'roots':copy.deepcopy(library['roots']),'binding':binding}


def library_catalog(folder,state,args):
    required={'intake_id','probe_id','library_id'}
    if not required<=set(args) or set(args)-required-{'entry_id','offset','limit'}:
        raise ValueError('Select this intake, current probe and saved library, with optional bounded entry pagination')
    entry_id=args.get('entry_id')
    if 'entry_id' in args:identifier(entry_id,'entry')
    if any(key in args and args[key] is None for key in ('offset','limit')):
        raise ValueError('Catalog pagination must use explicit bounded integers')
    offset=page_number(args.get('offset'),0,16384,'catalog offset')
    limit=page_number(args.get('limit'),64,128,'catalog limit',minimum=1)
    context=load_library_context(folder,state,args['probe_id'],args['library_id'])
    from spiceowl.onboarding.pdk_scope import library_scope_catalog
    catalog=library_scope_catalog(context['library'],entry_id=entry_id,offset=offset,limit=limit)
    if (not isinstance(catalog,dict) or catalog.get('schema')!='spiceowl.pdk-scope-catalog.v1'
            or catalog.get('library_id')!=args['library_id'] or catalog.get('entry_id')!=entry_id
            or catalog.get('kind')!=('entries' if entry_id is None else 'sections')
            or catalog.get('ready_to_run') is not False or catalog.get('status') not in ('blocked','available')
            or not isinstance(catalog.get('items'),list) or len(catalog['items'])>limit
            or type(catalog.get('total')) is not int or catalog['total']<0
            or catalog.get('next_offset')!=(offset+len(catalog['items']) if offset+len(catalog['items'])<catalog['total'] else None)):
        raise ValueError('The scope catalog does not match this exact observed page')
    if len(canonical(catalog))>MAX_PUBLIC_BYTES:
        raise ValueError('The scope catalog exceeds its bounded public response')
    return {'schema':'ic.onboarding.pdk-scopes.v1','connection_id':state['connection_id'],
        'intake_id':state['intake_id'],'revision':state['revision'],'probe_id':args['probe_id'],'catalog':catalog}


def project_selection(folder,state,args):
    required={'intake_id','revision','probe_id','library_id','entry_id','section_ids'}
    if not required<=set(args) or set(args)-required-{'tmi_option_id'}:
        raise ValueError('Select exact saved library, entry, sections and optional observed TMI identity')
    identifier(args['entry_id'],'entry')
    sections=args['section_ids']
    if (type(sections) is not list or not 1<=len(sections)<=64
            or any(not isinstance(item,str) or not HASH.fullmatch(item) for item in sections)
            or len(set(sections))!=len(sections)):
        raise ValueError('Select one to 64 distinct observed scope identities')
    tmi=args.get('tmi_option_id')
    if 'tmi_option_id' in args:identifier(tmi,'TMI option')
    context=load_library_context(folder,state,args['probe_id'],args['library_id'])
    from spiceowl.onboarding.pdk_scope import project_library_scopes
    selection=project_library_scopes(context['library'],requirements=context['requirements'],
        server_identity=context['server_identity'],entry_id=args['entry_id'],section_ids=sections,tmi_option_id=tmi)
    validate_projection(selection,context)
    public=selection['public']
    if (public.get('entry_id')!=args['entry_id'] or public.get('section_ids')!=sections
            or public.get('selected_tmi_option_id')!=tmi):
        raise ValueError('The scope projection differs from the explicit selection')
    return context,selection


def validate_projection(selection,context):
    from spiceowl.onboarding.pdk_scope import validate_scope_selection
    validate_scope_selection(selection)
    if type(selection) is not dict or selection.get('schema')!='spiceowl.pdk-scope-selection.v1':
        raise ValueError('The installed scope projector returned an unsupported receipt')
    public=selection.get('public');private=selection.get('private')
    if (type(public) is not dict or type(private) is not dict
            or public.get('status') not in ('blocked','requires_audit')
            or public.get('library_id')!=context['binding']['library_id']
            or public.get('source_sha256')!=context['binding']['source_sha256']
            or public.get('fresh_audit_required') is not True or public.get('ready_to_run') is not False
            or private.get('server_identity')!=context['server_identity']
            or private.get('requirements')!=context['requirements']
            or private.get('roots')!=context['roots']):
        raise ValueError('The scope projection lacks its exact source, library or observed server binding')
    identifier(public.get('selection_id'),'scope selection')
    if len(canonical(public))>MAX_PUBLIC_BYTES or len(canonical(selection))>MAX_SELECTION_BYTES:
        raise ValueError('The projected scope exceeds its finite receipt budget')


def _immutable_json(path,value,limit):
    if path.exists():
        if read_json(path,limit=limit)!=value:raise ValueError('The saved scope receipt identity already has different evidence')
        return
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    raw=canonical(value)+b'\n'
    if len(raw)>limit:raise ValueError('Scope receipt exceeds its private storage budget')
    temporary=path.with_name(path.name+'.'+secrets.token_hex(8)+'.tmp')
    try:
        with temporary.open('xb') as stream:
            temporary.chmod(0o600);stream.write(raw)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def save_scope_selection(folder,context,selection):
    """Caller holds the intake operation lock and has passed its revision CAS."""
    validate_projection(selection,context)
    selection_id=selection['public']['selection_id']
    receipt=private_path(folder,'scope-selections',selection_id+'.json')
    _immutable_json(receipt,selection,MAX_SELECTION_BYTES)
    binding={**context['binding'],'selection_id':selection_id,'selection_sha256':digest(selection)}
    record={'schema':CONTEXT_SCHEMA,'binding':binding,'context_sha256':digest(binding)}
    proof=private_path(folder,'scope-selections','bindings',record['context_sha256']+'.json')
    _immutable_json(proof,record,MAX_RECORD_BYTES)
    return {**copy.deepcopy(selection['public']),'probe_id':context['binding']['probe_id']}


def load_scope_selection(folder,state,selection_id):
    """Return owner public/private evidence only after current-context verification."""
    identifier(selection_id,'scope selection')
    current=state.get('pdk_scope_selection') or {}
    if current.get('selection_id')!=selection_id:
        raise ValueError('Select the current saved PDK scope and resave the testbench binding')
    context=load_library_context(folder,state,current.get('probe_id'),current.get('library_id'))
    selection=read_json(private_path(folder,'scope-selections',selection_id+'.json'),limit=MAX_SELECTION_BYTES)
    validate_projection(selection,context)
    if current!={**selection['public'],'probe_id':context['binding']['probe_id']}:
        raise ValueError('The current scope selection differs from its retained receipt')
    binding={**context['binding'],'selection_id':selection_id,'selection_sha256':digest(selection)}
    context_hash=digest(binding)
    expected={'schema':CONTEXT_SCHEMA,'binding':binding,'context_sha256':context_hash}
    proof=read_json(private_path(folder,'scope-selections','bindings',context_hash+'.json'))
    if proof!=expected:raise ValueError('The scope selection has no matching current source/probe observation proof')
    from spiceowl.onboarding.pdk_scope import project_library_scopes
    public=selection['public']
    replayed=project_library_scopes(context['library'],requirements=context['requirements'],
        server_identity=context['server_identity'],entry_id=public['entry_id'],
        section_ids=public['section_ids'],tmi_option_id=public.get('selected_tmi_option_id'))
    if replayed!=selection:raise ValueError('Saved scope projection no longer matches its exact retained observation')
    return copy.deepcopy(selection)
