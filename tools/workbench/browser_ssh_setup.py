"""Thin loopback session/CSRF adapter mounting SpiceOwl's SSH Setup Wizard on CircuitGit."""
from pathlib import Path
import secrets
import threading
import time


class LocalSshSetup:
    """Gate SpiceOwl's local graphical SSH & jump-host wizard behind a paired browser grant."""

    def __init__(self, ssh_dir, pairing, local_url, clock=time.monotonic):
        self.ssh_dir = Path(ssh_dir).expanduser().resolve()
        self.pairing = pairing
        self.local_url = local_url.rstrip('/')
        self.clock = clock
        self.lock = threading.RLock()
        self.requests = {}

    def _prune(self):
        now = self.clock()
        self.requests = {k: v for k, v in self.requests.items() if v['expires'] > now}

    def request(self, token, origin):
        with self.lock:
            self._prune()
            if not self.pairing.accepts(token, origin):
                raise PermissionError('SSH 配置向导需要已确认的本机浏览器连接')
            if len(self.requests) >= 16:
                raise ValueError('打开的本机 SSH 配置窗口过多，请关闭旧窗口后重试')
            rid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.requests[rid] = {
                'token': token,
                'origin': origin,
                'csrf': csrf,
                'expires': self.clock() + 1800,
            }
            return {'url': self.local_url + '/ssh/setup?request=' + rid}

    def _require_request(self, rid, csrf=None):
        with self.lock:
            self._prune()
            row = self.requests.get(rid)
            if not row or not self.pairing.accepts(row['token'], row['origin']):
                raise PermissionError('本机 SSH 配置会话已过期，请返回网页重新打开')
            if csrf is not None and not secrets.compare_digest(row['csrf'], str(csrf)):
                raise PermissionError('CSRF 校验失败，请重新打开配置窗口')
            return dict(row)

    def form(self, rid, nonce):
        from spiceowl.onboarding.ssh_setup_ui import build_ssh_setup_state, ssh_setup_csp, ssh_setup_html
        row = self._require_request(rid)
        state = build_ssh_setup_state(self.ssh_dir)
        raw = ssh_setup_html(
            row['origin'],
            rid,
            row['csrf'],
            state,
            nonce,
            brand='CircuitGit · SpiceOwl',
            action_path='/ssh/setup/action',
            post_message_type='spiceowl.ssh.updated',
        )
        return raw.decode('utf-8'), ssh_setup_csp(nonce)

    def action(self, body):
        from spiceowl.domain.common import DomainError
        from spiceowl.onboarding.ssh_setup_ui import dispatch_ssh_setup_action
        if not isinstance(body, dict) or not isinstance(body.get('action'), str):
            raise ValueError('Invalid SSH setup action')
        self._require_request(body.get('request_id'), body.get('csrf'))
        try:
            return dispatch_ssh_setup_action(self.ssh_dir, body['action'], body.get('payload'))
        except DomainError as exc:
            raise ValueError(str(exc)) from None
