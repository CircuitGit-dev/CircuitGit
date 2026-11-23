"""Local, human-confirmed pairing. No OpenAI credentials cross this boundary."""
import html
import json
import re
import secrets
import threading
import time


class Pairing:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.requests, self.grants = {}, {}

    def prune(self):
        now = self.clock()
        self.requests = {k: v for k, v in self.requests.items() if v['expires'] > now}
        self.grants = {k: v for k, v in self.grants.items() if v['expires'] > now}

    def create(self, origin, state):
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', state):
            raise ValueError('Invalid browser connection state')
        with self.lock:
            self.prune()
            if len(self.requests) >= 16 or len(self.grants) >= 16:
                raise ValueError('Too many connection requests; close old requests and retry later')
            rid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.requests[rid] = {'origin': origin, 'state': state, 'csrf': csrf, 'expires': self.clock() + 180}
            return rid, csrf

    def decide(self, rid, csrf, allow):
        with self.lock:
            self.prune()
            row = self.requests.get(rid)
            if not row or not secrets.compare_digest(row['csrf'], csrf):
                raise PermissionError('Connection confirmation expired or did not match')
            del self.requests[rid]
            result = {'origin': row['origin'], 'state': row['state'], 'allowed': allow}
            if allow:
                token = secrets.token_urlsafe(32)
                self.grants[token] = {'origin': row['origin'], 'expires': self.clock() + 8 * 3600}
                result['accessCode'] = token
            return result

    def accepts(self, token, origin):
        with self.lock:
            self.prune()
            row = self.grants.get(token)
            return bool(row and row['origin'] == origin)

    def revoke(self, token):
        with self.lock:
            self.grants.pop(token, None)


def confirmation_html(origin, state, rid, csrf, local_url, script_nonce, *, mode='codex'):
    # Only an actual click on this local, unframeable page grants browser access.
    # The mode describes this node's services; it does not change any grant.
    if mode not in ('codex', 'simulation-only'):
        raise ValueError('Unsupported local connection display mode')
    if mode == 'simulation-only':
        title = '授权 CircuitGit 连接本机仿真环境'
        heading = '连接本机仿真环境'
        introduction = '允许以下网站使用这台电脑上的 CircuitGit 仿真连接吗？'
        description = '连接后可读取你提供的独立网表，在你选中的仿真主机及授权范围内准备、运行仿真并查看结果。'
        note = '这是本机仿真连接确认，本次确认不会启动仿真。'
    else:
        title = '授权 CircuitGit 连接本机'
        heading = '连接本机 Codex'
        introduction = '允许以下网站使用这台电脑上的 CircuitGit 项目和 Codex 对话吗？'
        description = '授权后会检查本机 Codex 登录状态。需要登录时，由 Codex 打开官方登录页。账号凭据保留在本机，连接后可直接保存电路、记录检查点、恢复版本、提交 Git 和创建或更新 PR；远端仿真使用已配置的授权范围。'
        note = '这是本机连接确认，不会启动模型消息或仿真。'
    config = json.dumps({'origin': origin, 'state': state, 'requestId': rid, 'csrf': csrf, 'localUrl': local_url}).replace('<', '\\u003c')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>''' + title + '''</title><style nonce="''' + script_nonce + '''">
body{font:15px system-ui;max-width:470px;margin:40px auto;padding:24px;color:#244336;background:#f4f8f5}h1{font-size:23px}p{line-height:1.7}strong{overflow-wrap:anywhere}button{font:inherit;border:1px solid #b8cfc1;border-radius:8px;padding:12px 18px;cursor:pointer;margin:12px 8px 0 0}#allow{color:white;background:#177652}small{color:#647b6c}#status{min-height:40px}</style>
<h1>''' + heading + '''</h1><p>''' + introduction + '''</p><strong>''' + html.escape(origin) + '''</strong>
<p>''' + description + '''</p>
<button id="allow">允许并连接</button><button id="deny">取消</button><p id="status" role="status"></p><small>''' + note + '''</small>
<script nonce="''' + script_nonce + '''">
const c=''' + config + ''';
const status=document.querySelector('#status');
function post(type,extra={}){if(window.opener)window.opener.postMessage({type,state:c.state,...extra},c.origin);}
post('circuitgit.local.ready');
async function decide(allow){
  document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{const r=await fetch('/connect/confirm',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',cache:'no-store',body:JSON.stringify({request_id:c.requestId,csrf:c.csrf,allow})});
    const data=await r.json();if(!r.ok||!data.ok)throw Error('授权已过期或无法确认，请返回网页重新连接。');
    post('circuitgit.local.result',{allowed:data.data.allowed,accessCode:data.data.accessCode,endpoint:c.localUrl});
    status.textContent=allow?'已授权，请返回 CircuitGit 网页。':'已取消。';
  }catch(e){status.textContent=e.message;}
}
document.querySelector('#allow').onclick=()=>decide(true);document.querySelector('#deny').onclick=()=>decide(false);
</script></html>'''
