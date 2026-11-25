"""Lazy, local gateway startup from an explicitly installed site configuration.

Never starts a model or solver, changes approvals, kills an existing server, or
executes scripts from the engineering workspace. The gateway code is bundled.
"""
import contextlib
import errno
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
from ic_gateway.platform_compat import detached_popen_kwargs, lock_file, unlock_file
from .service import Service,Failure,check,atom,SCHEMAS
from .library import CONFIG_KEYS as LIBRARY_CONFIG_KEYS

SETTINGS_KEYS={'schema','gateway_url','state_dir','workbench_config','disabled_operations'} | LIBRARY_CONFIG_KEYS
TOOL_NAMES={'ic_plugin_status','ic_plugin_connect'}


class PluginRuntime:
    tool_names=TOOL_NAMES

    def __init__(self,settings_path):
        self.settings_path=Path(settings_path).expanduser().resolve()
        self.settings=None;self.setup_error=None;self.last=None;self._owned_process=None
        try:
            check(self.settings_path.is_file(),'Plugin needs its installed project settings','setup_required',4)
            settings=json.loads(self.settings_path.read_text())
            check(isinstance(settings,dict) and not set(settings)-SETTINGS_KEYS,'Unsupported plugin settings')
            check(settings.get('schema')=='ic.plugin.settings.v1','Unsupported plugin settings version')
            url=urlsplit(settings['gateway_url'])
            check(url.scheme=='http' and url.hostname=='127.0.0.1' and url.port and url.path in ('','/') and not url.query and not url.fragment and not url.username,'Plugin gateway must be an explicit loopback port')
            check(Path(settings['state_dir']).is_absolute() and Path(settings['workbench_config']).is_absolute(),'Plugin settings require absolute local paths')
            disabled=settings.get('disabled_operations',[])
            check(isinstance(disabled,list) and all(isinstance(op,str) and op in SCHEMAS for op in disabled),'Invalid installed operation restrictions')
            self.settings=settings;self.port=url.port
        except (TypeError,ValueError,KeyError,OSError,Failure) as error:
            self.setup_error=str(error)
        cfg={'gateway_url':self.settings['gateway_url'] if self.settings else 'http://127.0.0.1:8766',
             'state_dir':self.settings['state_dir'] if self.settings else str(self.settings_path.parent/'state'),
             'timeout_seconds':30,'disabled_operations':self.settings.get('disabled_operations',[]) if self.settings else []}
        if self.settings: cfg.update({key: self.settings[key] for key in LIBRARY_CONFIG_KEYS if key in self.settings})
        self.service=Service(cfg)
        self.control=self.service.state/'plugin-runtime';self.control.mkdir(parents=True,exist_ok=True)

    def tools(self):
        return [{'name':'ic_plugin_status','description':'Read IC Workbench plugin setup and local connection status. Does not start a model, gateway, simulation or remote check.',
          'inputSchema':{'type':'object','properties':{},'additionalProperties':False},
          'annotations':{'readOnlyHint':True,'destructiveHint':False,'openWorldHint':False}},
         {'name':'ic_plugin_connect','description':'Connect to the installed IC project. Reuses its local gateway or starts the bundled gateway once when absent. No model, solver, remote check or approval-policy change.',
          'inputSchema':{'type':'object','properties':{},'additionalProperties':False},
          'annotations':{'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True,'openWorldHint':False}}]

    def call(self,name,args):
        check(name in self.tool_names and args=={},'Plugin tools accept no arbitrary commands, paths or options')
        return self.status() if name=='ic_plugin_status' else self.ensure()

    def installed_config(self):
        check(self.settings is not None,self.setup_error or 'Plugin setup required','setup_required',4)
        try:
            path=Path(self.settings['workbench_config']);cfg=json.loads(path.read_text())
            check(isinstance(cfg,dict),'Invalid workbench configuration')
            if cfg.get('onboarding_only') is True:
                check(set(cfg)=={'local_only','onboarding_only','github_repo','runtime_root','projects','onboarding'}
                      and cfg.get('local_only') is True and cfg.get('github_repo') is None and cfg.get('projects')==[],
                      'Fresh onboarding configuration cannot contain legacy project or site settings')
                entry=cfg.get('onboarding')
                check(isinstance(entry,dict) and set(entry)=={'enabled','state_root','connection_id','ssh_config'}
                      and entry.get('enabled') is True,'Invalid fresh onboarding configuration')
                check(isinstance(entry.get('connection_id'),str) and len(entry['connection_id'])==32
                      and all(c in '0123456789abcdef' for c in entry['connection_id']), 'Invalid onboarding connection identity')
                for value in (cfg.get('runtime_root'),entry.get('state_root'),entry.get('ssh_config')):
                    check(isinstance(value,str) and Path(value).is_absolute() and '..' not in Path(value).parts
                          and all(ord(c)>=32 and ord(c)!=127 for c in value),'Fresh onboarding paths must be explicit local absolute paths')
                runtime,store=Path(cfg['runtime_root']),Path(entry['state_root'])
                check(runtime.name=='gateway' and store.name=='intake-store' and runtime.parent==store.parent,
                      'Fresh onboarding storage must belong to one explicitly configured intake root')
                return cfg
            for key in ['runtime_root','seed_repo','site_file']:
                check(isinstance(cfg.get(key),str) and Path(cfg[key]).is_absolute(),'Missing absolute '+key)
            check(Path(cfg['site_file']).is_file(),'Configured Cadence site file is missing','setup_required',4)
            check(isinstance(cfg.get('github_repo'),str) and isinstance(cfg.get('projects'),list) and cfg['projects'],'Missing registered project configuration')
            return cfg
        except (OSError,ValueError,KeyError) as error:raise Failure('setup_required','Installed project configuration cannot be read: '+str(error),4)

    def probe(self,cfg):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        try:
            onboarding=cfg.get('onboarding_only') is True
            conn.request('GET','/api/health' if onboarding else '/api/project')
            response=conn.getresponse();raw=response.read(2*1024*1024+1)
            check(response.status==200 and len(raw)<=2*1024*1024,'The configured port is occupied by an incompatible service','gateway_conflict',4)
            body=json.loads(raw);data=body.get('data')
            check(body.get('ok') is True and isinstance(data,dict),'Incompatible gateway response','gateway_conflict',4)
            if onboarding:
                caps=data.get('capabilities',{})
                check(data.get('api_version')=='1' and data.get('mode')=='live'
                      and data.get('connection_id')==cfg['onboarding']['connection_id']
                      and isinstance(caps,dict) and caps.get('simulation_onboarding') is True
                      and caps.get('simulation_onboarding_native_entry') is True
                      and caps.get('simulation_onboarding_api_version')=='1',
                      'The configured port belongs to another or incompatible onboarding connection','gateway_conflict',4)
                # Health contains a process mutation token; never return it in
                # lifecycle status or use an old project catalogue as intake data.
                return {'connection_id':data['connection_id'],'projects':[],'source_commit':None}
            check(data.get('repo')==cfg['github_repo'] and data.get('branch')==cfg.get('runtime_branch','codex/gateway-session'),
                  'The running gateway belongs to a different project/branch','gateway_conflict',4)
            expected={(p['id'],p['source_path']) for p in cfg['projects']}
            actual={(p['id'],p['source_path']) for p in data.get('projects',[])}
            check(actual==expected,'The running gateway project catalog differs from installed configuration','gateway_conflict',4)
            return data
        except ConnectionRefusedError:return None
        except OSError as error:
            refused = {errno.ECONNREFUSED, getattr(errno, 'WSAECONNREFUSED', None)}
            if error.errno in refused or getattr(error, 'winerror', None) == 10061:return None
            raise Failure('gateway_unavailable','Local gateway cannot be reached; startup was not retried',75)
        except (http.client.HTTPException,ValueError,KeyError):raise Failure('gateway_conflict','The configured port did not return a compatible project registry',4)
        finally:conn.close()

    def status(self):
        base={'schema':'ic.plugin.status.v1','terminal_required':False,'model_process_started':False,
              'approval_mode':'host-confirmation-required','settings_file':str(self.settings_path)}
        try:
            cfg=self.installed_config();project=self.probe(cfg)
            attempts=self.control/'startup.json'
            if not project and attempts.exists():
                record=json.loads(attempts.read_text())
                if record.get('state') in ('starting','failed'):
                    return {**base,'state':'suspended','startup_state':record['state'],
                      'message':'Previous startup did not finish; inspect gateway.log before another launch.',
                      'diagnostic_file':str(self.control/'gateway.log')}
            return {**base,'state':'connected' if project else 'ready_to_start','repository':cfg['github_repo'],
              'projects':project.get('projects',[]) if project else [{'id':p['id'],'name':p.get('name',p['id'])} for p in cfg['projects']],
              'source_commit':project.get('source_commit') if project else None,
              **({'connection_id':cfg['onboarding']['connection_id'],'onboarding_only':True} if cfg.get('onboarding_only') else {}),
              'message':'Ready in Codex' if project else 'The plugin will start the local gateway when a workbench tool is used.'}
        except Failure as error:return {**base,'state':'setup_required' if error.code=='setup_required' else 'suspended','error':error.record()}
        except (OSError,ValueError):return {**base,'state':'suspended','message':'Local startup state cannot be read; inspect it before continuing.'}

    @contextlib.contextmanager
    def startup_lock(self):
        with (self.control/'startup.lock').open('a+b') as file:
            deadline=time.monotonic()+8
            while True:
                try:lock_file(file,nonblocking=True);break
                except BlockingIOError:
                    if time.monotonic()>deadline:raise Failure('startup_pending','Another plugin connection is starting the gateway; check status',75)
                    time.sleep(.05)
            try:yield
            finally:unlock_file(file)

    def gateway_root(self):
        plugin=Path(__file__).resolve().parents[1]
        packaged=plugin/'gateway'
        if packaged.is_dir():return packaged
        source=plugin.parents[1]/'tools/workbench'
        check((source/'server.py').is_file(),'Bundled gateway is unavailable; reinstall the plugin','setup_required',4)
        return source

    def _bind_review_authority(self, cfg):
        # Trusted installed configuration, never tool arguments or /api/health.
        # The gateway owns creation and permissions of this separate key.
        entry = cfg.get('onboarding') or {}
        store = entry.get('state_root')
        if not store:
            store = str(Path(cfg['runtime_root']) / 'onboarding' / 'intake-store')
        self.service.config['onboarding_review_authority_key_file'] = str(Path(store) / 'review-authority.key')

    def ensure(self):
        cfg=self.installed_config()
        with self.startup_lock():
            project=self.probe(cfg)
            if project:
                self._bind_review_authority(cfg);self.last='reused';return {**self.status(),'startup':'reused','gateway_started':False}
            # A partial/non-HTTP listener is not ours. Never try another port or kill it.
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                try:sock.bind(('127.0.0.1',self.port))
                except OSError:raise Failure('gateway_conflict','Configured gateway port is occupied; leave it intact and inspect',4)
            attempts=self.control/'startup.json'
            if attempts.exists():
                record=json.loads(attempts.read_text())
                if record.get('state') in ('starting','failed'):
                    raise Failure('startup_suspended','The previous gateway startup did not finish. Inspect plugin status; no automatic repeated process launch.',75)
            gateway=self.gateway_root()
            # Preserve engineering/site files; the optional web-model bridge is unnecessary here.
            launch_cfg={k:v for k,v in cfg.items() if k!='ai_client_config'}
            config_path=self.control/'gateway.local.json';atom(config_path,launch_cfg)
            web=Path(__file__).resolve().parents[1]/'gateway-web' if cfg.get('onboarding_only') else Path(cfg['seed_repo'])/'web'
            if not web.is_dir():web=Path(__file__).resolve().parents[1]/'gateway-web'
            check(web.is_dir(),'Packaged web assets are unavailable','setup_required',4)
            record={'schema':'ic.plugin.gateway-process.v1','state':'starting','port':self.port,
                'gateway_code_sha256':hashlib.sha256((gateway/'server.py').read_bytes()).hexdigest()}
            atom(attempts,record)
            process=None
            try:
                with (self.control/'gateway.log').open('ab') as log:
                    process=subprocess.Popen([sys.executable,'-B',str(gateway/'server.py'),'--config',str(config_path),
                         '--web-root',str(web),'--port',str(self.port)],cwd=gateway,stdout=log,stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL,**detached_popen_kwargs())
                self._owned_process=process
                record['pid']=process.pid;atom(attempts,record)
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    if process.poll() is not None:raise Failure('startup_failed','Bundled gateway stopped during startup; inspect plugin diagnostics',4)
                    project=self.probe(cfg)
                    if project:
                        record['state']='ready';atom(attempts,record);self._bind_review_authority(cfg);self.last='started'
                        return {**self.status(),'startup':'started','gateway_started':True}
                    time.sleep(.1)
                raise Failure('startup_pending','Gateway startup is still pending; check plugin status before trying more work',75)
            except (OSError,Failure) as error:
                record['state']='failed' if process is None or process.poll() is not None else 'starting';atom(attempts,record)
                if isinstance(error,Failure):raise
                raise Failure('startup_failed','Gateway process could not start: '+type(error).__name__,4)
