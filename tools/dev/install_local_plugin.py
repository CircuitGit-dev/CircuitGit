#!/usr/bin/env python3
"""Install this repository's built plugin locally, preserving unrelated Codex settings.

Run only for an explicitly authorized local installation. Requires Python 3.11+
for TOML verification; the plugin runtime itself remains Python 3.9 compatible.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import tomllib

NAME='ic-workbench-local'
PLUGIN='ic-workbench@'+NAME


def run(command,cwd=None):
    result=subprocess.run(command,cwd=cwd,capture_output=True,text=True,timeout=90)
    if result.returncode:raise RuntimeError('Command failed: '+command[1]+' '+result.stderr[-1000:])
    return result.stdout


def table(name,value):
    lines=['['+name+']']
    for key,item in value.items():
        if isinstance(item,dict):continue
        if isinstance(item,bool):encoded='true' if item else 'false'
        elif isinstance(item,(str,int,float,list)):encoded=json.dumps(item,ensure_ascii=False)
        else:raise ValueError('Unsupported configuration value')
        lines.append(json.dumps(key)+' = '+encoded)
    text='\n'.join(lines)+'\n'
    for key,item in value.items():
        if isinstance(item,dict):text+='\n'+table(name+'.'+json.dumps(key),item)
    return text


def migrated_config(before_bytes,after_bytes,upgrade=False):
    """Keep original bytes, apart from the replaced server and new plugin tables."""
    before=tomllib.loads(before_bytes.decode());after=tomllib.loads(after_bytes.decode())
    market_cfg=after.get('marketplaces',{}).get(NAME)
    plugin_cfg=after.get('plugins',{}).get(PLUGIN)
    if not market_cfg or not plugin_cfg or plugin_cfg.get('enabled') is not True:
        raise RuntimeError('CLI did not report an enabled local plugin; connection migration suspended')
    normalized=copy.deepcopy(after)
    if not upgrade:
        normalized['marketplaces'].pop(NAME);normalized['plugins'].pop(PLUGIN)
        for key in ('marketplaces','plugins'):
            if not normalized.get(key) and key not in before:normalized.pop(key,None)
    def restore_empty(a,b):
        if isinstance(a,dict) and isinstance(b,dict):
            for key,value in a.items():
                if key not in b and value==[]:b[key]=[]
                elif key in b:restore_empty(value,b[key])
    restore_empty(before,normalized)
    if normalized!=before:raise RuntimeError('Unrelated Codex configuration changed; stop and inspect before replacing it')
    if upgrade:return before_bytes.decode()
    text=before_bytes.decode();expected=copy.deepcopy(before)
    old=before.get('mcp_servers',{}).get('ic-workbench')
    if old:
        pattern=r'(?m)^\[mcp_servers\.(?:ic-workbench|"ic-workbench")\][^\n]*\n[\s\S]*?(?=^\[|\Z)'
        text,count=re.subn(pattern,'',text)
        if count!=1:raise RuntimeError('Direct MCP table could not be isolated safely; retain it for inspection')
        expected['mcp_servers'].pop('ic-workbench')
    policy={k:v for k,v in (old or {}).items() if k not in ('command','args','cwd','env','enabled')}
    # Full PDK discovery has a 300s gateway request plus its health check.
    # This affects this plugin only; existing upgrade policy is preserved above.
    policy['tool_timeout_sec']=360
    plugin_cfg.setdefault('mcp_servers',{})['ic-workbench']=policy
    expected.setdefault('marketplaces',{})[NAME]=market_cfg
    expected.setdefault('plugins',{})[PLUGIN]=plugin_cfg
    text+='\n'+table('marketplaces.'+NAME,market_cfg)+'\n'+table('plugins.'+json.dumps(PLUGIN),plugin_cfg)
    final=tomllib.loads(text)
    if not expected.get('mcp_servers'):expected.pop('mcp_servers',None)
    if not final.get('mcp_servers'):final.pop('mcp_servers',None)
    if final!=expected:raise RuntimeError('Final configuration does not match intended plugin-only changes')
    return text


def configure_manifest(manifest,settings):
    manifest=copy.deepcopy(manifest)
    server=manifest['mcpServers']['ic-workbench']
    # Portable MCP rejects absolute executable paths, even when they run directly.
    # Keep the source's bare executable; the runtime requires only Python 3.9 stdlib.
    command=server['command']
    if not command or '/' in command or '\\' in command:
        raise ValueError('Expected a portable bare executable in the source MCP manifest')
    server['args']=['-B','${PLUGIN_ROOT}/plugin_entry.py','--settings',str(settings)]
    return manifest


def discovered_server(rows,installed_path):
    matches=[row for row in rows if row.get('name')=='ic-workbench']
    if len(matches)!=1 or not matches[0].get('enabled'):
        raise RuntimeError('Codex did not discover the enabled plugin MCP server; installation is incomplete')
    row=matches[0];transport=row['transport']
    if Path(transport.get('cwd','')).resolve()!=installed_path.resolve():
        raise RuntimeError('Codex discovered a different IC Workbench server; inspect the registration')
    return row


def install(repo,codex,upgrade=False):
    os.umask(0o077);repo=repo.resolve()
    cfg_path=Path.home()/'.codex/config.toml';before_bytes=cfg_path.read_bytes();before=tomllib.loads(before_bytes.decode())
    if upgrade:
        if before.get('marketplaces',{}).get(NAME)!={'source_type':'local','source':str(repo/'dist/codex-marketplace')} or not before.get('plugins',{}).get(PLUGIN,{}).get('enabled'):
            raise ValueError('Upgrade requires this repository\'s enabled local plugin installation')
    elif NAME in before.get('marketplaces',{}) or PLUGIN in before.get('plugins',{}):
        raise ValueError('Plugin is already configured; use an explicit upgrade instead of duplicate installation')
    old=before.get('mcp_servers',{}).get('ic-workbench')
    if old:
        args=old.get('args',[])
        if str(repo/'dist/ic-workbench/ic_workbench.py') not in args:
            raise ValueError('Existing ic-workbench server does not belong to this repository')
    backup=repo/'.local'/('plugin-install-'+str(time.time_ns()));backup.mkdir(parents=True)
    (backup/'codex-config.before.toml').write_bytes(before_bytes)
    settings=repo/'config/codex-plugin.local.json'
    if settings.exists() and not upgrade:raise ValueError('Existing plugin settings retained; inspect before changing')
    if upgrade and not settings.is_file():raise ValueError('Existing plugin settings missing; upgrade suspended')
    old_client_path=repo/'config/codex-mcp.local.json'
    old_client=json.loads(old_client_path.read_text()) if old_client_path.exists() else {}
    content={'schema':'ic.plugin.settings.v1','gateway_url':old_client.get('gateway_url','http://127.0.0.1:8766'),
      'state_dir':old_client.get('state_dir',str(repo/'.local/codex-mcp-state')),
      'workbench_config':str(repo/'config/workbench.local.json'),
      'disabled_operations':old_client.get('disabled_operations',[])}
    if not Path(content['workbench_config']).is_file():raise ValueError('Configure the local workbench project before installing')
    if not upgrade:settings.write_text(json.dumps(content,indent=2)+'\n')
    run([sys.executable,'-B','tools/dev/build.py','all'],repo)
    run([sys.executable,'-B','tools/dev/marketplace.py'],repo)
    market=repo/'dist/codex-marketplace';package=market/'plugins/ic-workbench'
    manifest_path=package/'mcp.json';manifest=configure_manifest(json.loads(manifest_path.read_text()),settings)
    manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
    marker=market/'.ic-marketplace-build.json';manifest_hash=json.loads(marker.read_text())
    manifest_hash['files']['mcp.json']=hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    manifest_hash['local_configuration_pointer']=True;marker.write_text(json.dumps(manifest_hash,indent=2)+'\n')
    outputs={}
    commands=[] if upgrade else [('marketplace',[codex,'plugin','marketplace','add',str(market),'--json'])]
    commands.append(('install',[codex,'plugin','add',PLUGIN,'--json']))
    for label,command in commands:
        outputs[label]=run(command,repo)
        (backup/(label+'.json')).write_text(outputs[label])
    after_bytes=cfg_path.read_bytes()
    (backup/'codex-config.after-cli.toml').write_bytes(after_bytes)
    text=migrated_config(before_bytes,after_bytes,upgrade)
    if cfg_path.read_bytes()!=after_bytes:raise RuntimeError('Concurrent config change; suspended')
    cfg_path.write_text(text)
    installed_path=Path(json.loads(outputs['install'])['installedPath'])
    row=discovered_server(json.loads(run([codex,'mcp','list','--json'],repo)),installed_path)
    (backup/'codex-discovered-server.json').write_text(json.dumps(row,indent=2)+'\n')
    transport=row['transport'];command=[transport['command']]+transport.get('args',[])
    requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{'elicitation':{'form':{}}}}},
      {'jsonrpc':'2.0','method':'notifications/initialized'},
      {'jsonrpc':'2.0','id':2,'method':'tools/list'},
      {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'ic_plugin_status','arguments':{}}},
      {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'ic_projects','arguments':{}}}]
    check=subprocess.run(command,cwd=transport['cwd'],env={**os.environ,**(transport.get('env') or {})},input=''.join(json.dumps(row)+'\n' for row in requests),capture_output=True,text=True,timeout=30)
    if check.returncode:raise RuntimeError('Installed plugin entry failed: '+check.stderr[-1000:])
    replies={row['id']:row for row in map(json.loads,check.stdout.splitlines())}
    tools=replies[2]['result']['tools'];names={t['name'] for t in tools}
    assert {'ic_plugin_status','ic_plugin_connect','ic_request_review','ic_schematic_open','ic_waveforms_open','ic_simulation_open','ic_workbench_open'}<=names
    for rid in (3,4):assert replies[rid]['result']['structuredContent']['ok'] is True,replies[rid]['result']
    status=replies[3]['result']['structuredContent']['data']
    report={'status':'upgraded' if upgrade else 'installed','plugin':PLUGIN,'tool_count':len(tools),'settings':str(settings),
      'codex_loader_verified':True,'installed_path':str(installed_path),
      'direct_mcp_removed':bool(old),'unrelated_config_preserved':True,'gateway_status':status['state'],
      'new_model_turns':0,'solver_jobs':0,'native_visible_mount':'not verified; host tool reload required'}
    (backup/'result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository',type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument('--codex',default=shutil.which('codex'))
    parser.add_argument('--upgrade',action='store_true',help='Update this repository\'s existing installation while preserving its exact settings')
    args=parser.parse_args()
    if not args.codex:parser.error('Codex desktop/CLI runtime is required')
    install(args.repository,args.codex,args.upgrade)
