"""Finite authored-testbench manifest validation; no runtime or external imports."""
import copy
import json
import math
import re

MANIFEST_SCHEMA='ic.agent_testbench.v1'
FIELDS={'schema','text','interface','analyses','stimuli','objectives','criteria','postprocess'}
NAME=re.compile(r'[A-Za-z_][A-Za-z0-9_.$:+<>\[\]-]{0,159}')
HELPER_NAME=re.compile(r'[A-Za-z0-9_.-]{1,128}')


def helper_files(value):
    """Return authored helper bytes with portable, nonoverlapping identities."""
    helpers=value.get('helper_files',{})
    if type(helpers) is not dict or len(helpers)>48:
        raise ValueError('Provide at most 48 explicit testbench helper files')
    seen={'dut.scs','tb.scs','pdk.scs','agent-testbench.json'}
    result={}
    for name,text in helpers.items():
        if (not isinstance(name,str) or not 1<=len(name)<=240
                or any(part in ('.','..') or not HELPER_NAME.fullmatch(part) for part in name.split('/'))
                or name.lower() in seen or name.split('/')[-1].lower() in ('constants.vams','disciplines.vams')
                or not isinstance(text,str) or not 0<len(text.encode('utf-8'))<=512*1024
                or any(ord(c)<32 and c not in '\t\n\r' or ord(c)==127 for c in text)):
            raise ValueError('Helpers need distinct relative names and bounded literal text; standard headers require observed external bindings')
        lowered=name.lower()
        if any(lowered.startswith(other+'/') or other.startswith(lowered+'/') for other in seen):
            raise ValueError('A helper cannot also be a directory')
        seen.add(lowered);result[name]=text.encode('utf-8')
    return result


def _finite(value,depth=0):
    if depth>16:raise ValueError('Authored manifest nesting exceeds its bound')
    if value is None or type(value) in (str,bool,int):return
    if type(value) is float and math.isfinite(value):return
    if type(value) is list:
        for item in value:_finite(item,depth+1)
        return
    if type(value) is dict and all(type(k) is str for k in value):
        for item in value.values():_finite(item,depth+1)
        return
    raise ValueError('Authored manifest must contain finite JSON values')


def validate_manifest(value):
    if type(value) is not dict or not FIELDS<=set(value) or set(value)-FIELDS-{'helper_files'} or value.get('schema')!=MANIFEST_SCHEMA:
        raise ValueError('Provide the complete ic.agent_testbench.v1 authored draft')
    _finite(value)
    helper_files(value)
    if not isinstance(value['text'],str) or not 0<len(value['text'].encode('utf-8'))<=512*1024:
        raise ValueError('Provide bounded literal Spectre testbench text')
    interface=value['interface']
    if type(interface) is not dict or set(interface)!={'subckt','instance','port_bindings'}:
        raise ValueError('Declare the DUT subcircuit, instance and exact port bindings')
    if any(not isinstance(interface[k],str) or not NAME.fullmatch(interface[k]) for k in ('subckt','instance')):
        raise ValueError('Use explicit supported DUT and instance identifiers')
    bindings=interface['port_bindings']
    if type(bindings) is not dict or not 1<=len(bindings)<=128 or any(not NAME.fullmatch(k) or not isinstance(v,str) or (v!='0' and not NAME.fullmatch(v)) for k,v in bindings.items()):
        raise ValueError('Map every DUT port to an explicit testbench node')
    for field in ('analyses','stimuli','objectives','criteria'):
        if type(value[field]) is not list or len(value[field])>128 or any(type(v) not in (dict,str) or not v for v in value[field]):
            raise ValueError(field+' must be a bounded list of authored objects or descriptions')
    if not value['analyses'] or not value['objectives'] or type(value['postprocess']) is not dict:
        raise ValueError('Declare analyses, scientific objectives and postprocessing explicitly')
    names=set()
    for analysis in value['analyses']:
        if (type(analysis) is not dict or set(analysis)!={'name','kind','parameters'}
                or not isinstance(analysis['name'],str) or not NAME.fullmatch(analysis['name'])
                or analysis['name'] in names or analysis['kind'] not in ('tran','ac','dc')
                or type(analysis['parameters']) is not dict):
            raise ValueError('Declare unique analysis names, supported kinds and parameters')
        names.add(analysis['name'])
    if len(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode())>768*1024:
        raise ValueError('Authored testbench manifest exceeds its byte limit')
    return copy.deepcopy(value)
