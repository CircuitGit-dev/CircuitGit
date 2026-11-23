"""Locally confirmed, grant-bound application development for the browser helper.

Saved choices only prefill the local owner form. Neither a saved file nor the
remote node's bearer key authorizes a browser to start a developer turn.
"""
import copy
import hashlib
import html
import json
import os
from pathlib import Path
import secrets
import stat
import threading
import time

from icwb.development import development_info
from icwb.service import Failure, digest


class LocalDevelopment:
    def __init__(self, state, routes, pairing, local_url, clock=time.monotonic, workspace_hint=None):
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.state.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise ValueError('Developer settings require an owner-only directory (mode 0700)')
        self.path = self.state / 'development.local.json'
        self.routes, self.pairing, self.local_url, self.clock = routes, pairing, local_url, clock
        self.lock = threading.RLock()
        self.requests, self.grants, self.bindings = {}, {}, {}
        self.inflight = {}
        self.saved = self._read()
        hint = development_info({'development_workspace': str(workspace_hint)}) if workspace_hint else {}
        self.workspace_hint = hint.get('workspace') if hint.get('available') else ''

    def _read(self):
        default = {'enabled': False, 'workspace': '', 'access': 'manual'}
        if not self.path.exists() and not self.path.is_symlink():
            return default
        info = self.path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 8192):
            raise ValueError('Developer settings must be an owner-only regular file (mode 0600)')
        value = json.loads(self.path.read_text())
        if (not isinstance(value, dict) or set(value) != {'schema', 'enabled', 'workspace', 'access'}
                or value['schema'] != 'circuitgit.local-development.v1'
                or type(value['enabled']) is not bool or not isinstance(value['workspace'], str)
                or value['access'] not in ('manual', 'full')):
            raise ValueError('Invalid local developer settings')
        return {k: value[k] for k in default}

    def _save(self, value):
        # Create a unique owner-only file; never follow an existing temporary link.
        tmp = self.state / ('.development-' + secrets.token_hex(16))
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as file:
                json.dump({'schema': 'circuitgit.local-development.v1', **value}, file)
                file.flush(); os.fsync(file.fileno())
            os.replace(tmp, self.path)
        finally:
            if tmp.exists(): tmp.unlink()

    @staticmethod
    def key(token, origin):
        return hashlib.sha256((origin + '\n' + token).encode()).hexdigest()

    def paired(self, token, origin):
        return self.pairing.accepts(token, origin)

    def _prune(self):
        self.requests = {k: v for k, v in self.requests.items() if v['expires'] > self.clock()}
        self.grants = {k: v for k, v in self.grants.items() if self.paired(v['token'], v['origin'])}

    def capability(self, token, origin, session_id=None):
        with self.lock:
            self._prune()
            if session_id is not None:
                self.routes.sessions.info(session_id)
            paired = self.paired(token, origin)
            row = self.grants.get(self.key(token, origin)) if paired else None
            profile = development_info(row['config'] if row else {})
            if not paired: profile['reason'] = 'local_pairing_required'
            binding = self.bindings.get(session_id)
            if binding and binding['grant'] != self.key(token, origin):
                profile = {**profile, 'available': False, 'workspace': None, 'reason': 'different_browser_grant'}
            elif session_id is not None and not binding and self._developer_history(session_id):
                profile = {**profile, 'available': False, 'workspace': None, 'reason': 'restored_developer_session'}
            return {**profile, 'can_configure': paired}

    def request(self, token, origin):
        with self.lock:
            self._prune()
            if not self.paired(token, origin):
                raise PermissionError('Developer settings require a confirmed local browser connection')
            if len(self.requests) >= 16:
                raise Failure('conflict', 'Too many local settings windows; wait for an old request to expire', 3)
            rid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.requests[rid] = {'token': token, 'origin': origin, 'csrf': csrf,
                                  'expires': self.clock() + 600}
            return {'url': self.local_url + '/development/settings?request=' + rid}

    def _request(self, rid):
        self._prune()
        row = self.requests.get(rid)
        if not row or not self.paired(row['token'], row['origin']):
            raise PermissionError('Local settings confirmation expired; open a new settings window')
        return row

    def form(self, rid, nonce):
        with self.lock:
            row = self._request(rid)
            grant = self.grants.get(self.key(row['token'], row['origin']))
            # A stored full choice never silently checks the enable checkbox for
            # a new browser grant or after restarting the helper.
            value = {**self.saved, 'workspace': self.saved['workspace'] or self.workspace_hint, 'enabled': bool(grant)}
            if grant:
                value.update(workspace=grant['config']['development_workspace'],
                             access=grant['config']['development_access'])
            return settings_html(row['origin'], rid, row['csrf'], value, nonce)

    @staticmethod
    def _safe(session):
        if (session.state not in ('idle', 'complete') or session.metadata_busy or session.active_calls
                or session.closing or session.deleted
                or any(p.get('status') != 'resolved' for p in session.pending.values())):
            raise Failure('conflict', 'Developer settings cannot change an active, suspended, unknown or pending-approval session; its state was preserved', 3)

    def _developer_history(self, sid):
        registry = self.routes.sessions
        with registry.lock:
            session = getattr(registry, 'instances', {}).get(sid)
            if session is not None:
                with session.lock:
                    return (getattr(session, 'thread_mode', None) == 'developer'
                            or any(t.get('permission_mode') == 'developer' for t in session.turns.values())
                            or any(p.get('development_workspace') or p.get('development_access') for p in session.pending.values()))
            # Reading a capability must not instantiate/restore a session.
            saved = registry._saved_session(sid)
            return (any(t.get('permission_mode') == 'developer' for t in saved.get('turns', []))
                    or any(p.get('development_workspace') or p.get('development_access') for p in saved.get('pending', [])))

    @staticmethod
    def _existing_receipt(session, key):
        if not isinstance(key, str) or not 8 <= len(key) <= 160: return False
        if key in session.turns: return True
        return (session.service.state / 'ai-turns' / (digest(key) + '.json')).is_file()

    def confirm(self, body):
        if (set(body) != {'request_id', 'csrf', 'enabled', 'workspace', 'access'}
                or type(body['enabled']) is not bool
                or not all(isinstance(body[k], str) for k in ('request_id', 'csrf', 'workspace', 'access'))
                or body['access'] not in ('manual', 'full') or len(body['workspace']) > 4096):
            raise ValueError('Invalid local developer confirmation')
        with self.lock:
            row = self._request(body['request_id'])
            if not secrets.compare_digest(row['csrf'], body['csrf']):
                raise PermissionError('Local settings CSRF confirmation did not match')
            key = self.key(row['token'], row['origin'])
            config = {'development_workspace': body['workspace'], 'development_access': body['access']}
            profile = development_info(config)
            if body['enabled'] and not profile['available']:
                raise Failure('development_unavailable', 'Choose a valid CircuitGit application checkout: ' + profile['reason'], 4)
            for sid, binding in self.bindings.items():
                if binding['grant'] != key: continue
                registry = self.routes.sessions
                with registry.lock:
                    if sid in registry.deleted: continue
                    if self.inflight.get(sid):
                        raise Failure('conflict', 'An AI request is in flight; local settings were not changed', 3)
                    session = registry.get(sid)
                    with session.lock: self._safe(session)
            value = {'enabled': body['enabled'], 'workspace': profile['workspace'] if body['enabled'] else '',
                     'access': body['access'] if body['enabled'] else 'manual'}
            self._save(value)
            self.saved = value
            if value['enabled']:
                self.grants[key] = {'token': row['token'], 'origin': row['origin'],
                                    'config': {'development_workspace': value['workspace'], 'development_access': value['access']}}
            else:
                self.grants.pop(key, None)
            del self.requests[body['request_id']]
            return {'saved': True, 'enabled': value['enabled'], 'access': value['access'],
                    'workspace': value['workspace'] or None, 'new_turn_required': True}

    def dispatch(self, path, body, token, origin):
        """Freeze local authorization before delegating to the unchanged AI API."""
        with self.lock:
            self._prune()
            sid = body.get('session_id', 'default')
            bound = self.bindings.get(sid) if isinstance(sid, str) else None
            if path in ('/api/ai/turn', '/api/ai/approval', '/api/ai/resume', '/api/ai/sessions/delete'):
                if bound and (bound['grant'] != self.key(token, origin) or not self.paired(token, origin)):
                    raise PermissionError('This developer conversation belongs to another local browser grant; open a new conversation')
            if path in ('/api/ai/turn', '/api/ai/approval', '/api/ai/resume') and not bound:
                self.routes.sessions.info(sid)
                if self._developer_history(sid):
                    raise PermissionError('A restored developer conversation has no current local browser authorization; open a new conversation')
            if path == '/api/ai/turn' and body.get('permission_mode') == 'developer':
                if not self.paired(token, origin):
                    raise PermissionError('Developer turns require confirmed local pairing')
                # Reject public configuration fields before obtaining or altering
                # any session. The existing AI API validates the remaining input.
                if set(body) - {'session_id', 'message', 'context', 'idempotency_key', 'model', 'images', 'reasoning_effort', 'permission_mode'}:
                    raise ValueError('Unexpected turn fields')
                session = self.routes.sessions.get(sid)
                with session.lock:
                    replay = bound and self._existing_receipt(session, body.get('idempotency_key'))
                    # The owner API validates an existing receipt's exact input
                    # fingerprint even while running/unknown. Keep its profile.
                    if not replay:
                        grant = self.grants.get(self.key(token, origin))
                        if not grant or not development_info(grant['config'])['available']:
                            raise PermissionError('Confirm this browser grant and workspace on the local developer settings page first')
                        self._safe(session)
                        # Default sessions share the registry's Service. Detach
                        # this configuration so ordinary sessions cannot inherit.
                        service = copy.copy(session.service)
                        service.config = {**session.service.config, **grant['config']}
                        session.service = service
                        self.bindings[sid] = {'grant': self.key(token, origin)}
            tracked = isinstance(sid, str) and path in ('/api/ai/turn', '/api/ai/approval', '/api/ai/resume', '/api/ai/connect', '/api/ai/doctor')
            if tracked: self.inflight[sid] = self.inflight.get(sid, 0) + 1
        # Native startup can take time. Do not hold the settings lock through RPC
        # I/O: an explicit interrupt must remain available during that interval.
        try:
            return self.routes.post(path, body)
        finally:
            if tracked:
                with self.lock:
                    self.inflight[sid] -= 1
                    if not self.inflight[sid]: del self.inflight[sid]


def settings_html(origin, rid, csrf, value, nonce):
    config = json.dumps({'requestId': rid, 'csrf': csrf}).replace('<', '\\u003c')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CircuitGit 本机开发设置</title><style nonce="''' + nonce + '''">
body{font:15px system-ui;max-width:520px;margin:36px auto;padding:24px;background:#f7f9f8;color:#243c32}h1{font-size:23px}p{line-height:1.7}label{display:block;margin:20px 0}input[type=text],select{box-sizing:border-box;width:100%;font:inherit;padding:10px;margin-top:8px;border:1px solid #c2cfc8;border-radius:6px}button{font:inherit;padding:11px 18px;background:#177652;color:white;border:0;border-radius:6px;cursor:pointer}small{color:#586d61}strong{overflow-wrap:anywhere}#status{min-height:2em}</style>
<h1>本机开发设置</h1><p>仅为当前已配对的网站连接配置应用开发权限：</p><strong>''' + html.escape(origin) + '''</strong>
<form id="settings"><label><input id="enabled" type="checkbox"''' + (' checked' if value['enabled'] else '') + '''> 允许此连接使用开发模式</label>
<label>应用代码工作区<input id="workspace" type="text" autocomplete="off" spellcheck="false" placeholder="CircuitGit 的绝对目录" value="''' + html.escape(value['workspace'], quote=True) + '''"></label>
<label>应用开发权限<select id="access"><option value="manual"''' + (' selected' if value['access'] == 'manual' else '') + '''>手动批准（默认）</option><option value="full"''' + (' selected' if value['access'] == 'full' else '') + '''>完全访问（无需逐项批准）</option></select></label>
<p id="scope">完全访问允许当前开发线程使用本机文件和命令工具，无需逐项批准。电路修改、仿真与发布等受控工程操作仍按原审批流程执行。</p>
<button type="submit">保存并确认</button><button id="done" type="button" hidden>完成，返回网页</button><p id="status" role="status"></p><small>更改不会发送消息或恢复旧任务。返回网页重新打开设置即可刷新；助手重启或重新配对后，需要再次在这里确认开发权限。</small></form>
<script nonce="''' + nonce + '''">const c=''' + config + ''';
const form=document.querySelector('#settings'),status=document.querySelector('#status');
document.querySelector('#done').onclick=()=>window.close();
form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;
try{const response=await fetch('/development/settings/confirm',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',cache:'no-store',body:JSON.stringify({request_id:c.requestId,csrf:c.csrf,enabled:document.querySelector('#enabled').checked,workspace:document.querySelector('#workspace').value.trim(),access:document.querySelector('#access').value})});
const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.message||'保存失败，请重新打开本机设置。');status.textContent='已保存。请返回网页重新打开 AI 设置，并在新任务中选择所需权限。';form.querySelectorAll('input,select').forEach(x=>x.disabled=true);document.querySelector('#done').hidden=false;
}catch(error){status.textContent=error.message;button.disabled=false;}};
</script></html>'''
