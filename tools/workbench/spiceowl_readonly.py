"""Finite passive reads of an explicitly configured existing SpiceOwl Store.

This adapter owns no Store, controller, model session, MCP server or executor.
It never infers the Store location from CircuitGit Runner or resource-pool paths.
"""
import json
import importlib.util
from pathlib import Path


OPERATIONS=frozenset({'spiceowl_status','spiceowl_list_runs','spiceowl_get_run',
    'spiceowl_list_connections','spiceowl_list_hosts','spiceowl_list_ic_gateways',
    'spiceowl_list_ic_runs','spiceowl_get_ic_run'})


def read_contracts():
    """Read the single executable contract in either source or built layout."""
    here=Path(__file__).resolve()
    paths=(here.parent.parent/'lib/ic_gateway/contracts.py',
           here.parents[2]/'modules/gateway_client/ic_gateway/contracts.py')
    path=next((path for path in paths if path.is_file()),None)
    if path is None:raise SpiceReadError('spiceowl_read_contract','The installed CircuitGit read contract is unavailable.')
    spec=importlib.util.spec_from_file_location('_circuitgit_spiceowl_read_contract',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.SPICEOWL_READS


def schema_identity(value):
    if isinstance(value,dict):
        return {key:sorted(item) if key=='required' and isinstance(item,list) and all(isinstance(x,str) for x in item)
                else schema_identity(item) for key,item in value.items()}
    if isinstance(value,list):return [schema_identity(item) for item in value]
    return value


def same_schema(left,right):
    try:
        encode=lambda value:json.dumps(schema_identity(value),sort_keys=True,separators=(',',':'),allow_nan=False)
        return encode(left)==encode(right)
    except (ValueError,TypeError,RecursionError):return False


class SpiceReadError(Exception):
    def __init__(self,code,message,status=503):
        super().__init__(message)
        self.code,self.status=code,status


class SpiceReadAdapter:
    def __init__(self,configuration=None):
        self.enabled=False
        self.directory=None
        if configuration is None:return
        if (not isinstance(configuration,dict) or type(configuration.get('enabled')) is not bool
                or set(configuration)-{'enabled','data_dir'}):
            raise ValueError('spiceowl_readonly requires an explicit enabled boolean and optional data_dir')
        self.enabled=configuration['enabled']
        if not self.enabled:return
        directory=configuration.get('data_dir')
        if (not isinstance(directory,str) or not directory or len(directory)>4096
                or any(ord(char)<32 or ord(char)==127 for char in directory)
                or not Path(directory).is_absolute()):
            raise ValueError('Enabled SpiceOwl reads require an explicit absolute existing data_dir')
        # No mkdir, migration, inference from another runtime, or SDK startup.
        self.directory=directory

    def read(self,operation,arguments):
        if operation not in OPERATIONS or not isinstance(arguments,dict):
            raise SpiceReadError('invalid_input','Unknown bounded SpiceOwl read operation.',400)
        if not self.enabled:
            raise SpiceReadError('spiceowl_read_unavailable','SpiceOwl stored reads are not configured on this gateway.',403)
        try:
            from spiceowl.embedded import read_tool_definitions,dispatch_read_tool
            from spiceowl.read_api import open_read_views
            from spiceowl.domain.common import DomainError
        except ImportError:
            raise SpiceReadError('spiceowl_read_unavailable','Install the pinned SpiceOwl package with its embedded read exports.') from None
        definitions=read_tool_definitions()
        contracts=read_contracts()
        expected={'readOnlyHint':True,'destructiveHint':False,'idempotentHint':True,'openWorldHint':False}
        if (set(contracts)!=OPERATIONS or not isinstance(definitions,list) or len(definitions)!=len(OPERATIONS)
                or any(not isinstance(row,dict) or row.get('name') not in OPERATIONS
                       or row.get('annotations')!=expected
                       or any(type(value) is not bool for value in row.get('annotations',{}).values())
                       or not same_schema(row.get('inputSchema'),contracts.get(row.get('name')))
                       for row in definitions)
                or {row['name'] for row in definitions}!=OPERATIONS):
            raise SpiceReadError('spiceowl_read_contract','SpiceOwl embedded read exports do not match the installed finite contract.')
        try:
            result=dispatch_read_tool(open_read_views(self.directory),operation,arguments)
        except DomainError as error:
            code=getattr(error,'code','storage_read')
            if code not in {'invalid_input','invalid_request','unknown_tool','invalid_tool_arguments','read_views_unavailable',
                    'not_found','storage_missing','storage_invalid','storage_mode','storage_version','storage_read','storage_record'}:
                code='storage_read'
            status=404 if code in {'not_found','storage_missing'} else 400 if code in {'invalid_input','invalid_request','unknown_tool','invalid_tool_arguments'} else 503
            raise SpiceReadError(code,'SpiceOwl could not read the explicitly selected stored evidence ('+code+').',status) from None
        except (OSError,ValueError,TypeError,KeyError):
            raise SpiceReadError('spiceowl_read_unavailable','SpiceOwl stored evidence could not be read; no active check or repair was performed.') from None
        try:
            valid=(isinstance(result,dict) and result.get('read_only') is True
                and result.get('source')=='stored_local_state' and result.get('data_trust')=='untrusted_evidence'
                and len(json.dumps(result,ensure_ascii=False,allow_nan=False).encode())<=2*1024*1024)
        except (ValueError,TypeError,OverflowError,UnicodeError,RecursionError):valid=False
        if not valid:raise SpiceReadError('spiceowl_read_contract','SpiceOwl returned an invalid or oversized read-only envelope.')
        return result
