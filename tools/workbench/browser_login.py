"""Explicit official app-server login; never reads or returns credential files."""
import threading
from pathlib import Path
from urllib.parse import urlsplit

from icwb.connection_metadata import MetadataRpc, discover_runtime, project_account
from icwb.service import Failure


class LocalLogin:
    def __init__(self, config, rpc_factory=MetadataRpc):
        self.config, self.factory = config, rpc_factory
        self.rpc = None
        self.lock = threading.Lock()
        self.events_lock = threading.Lock()
        self.login_id, self.login_result = None, {}

    def event(self, message):
        if message.get('method') == 'account/login/completed':
            params = message.get('params', {})
            with self.events_lock:
                if isinstance(params.get('loginId'), str):
                    self.login_result[params['loginId']] = params.get('success') is True

    def runtime(self):
        if self.rpc is None or self.rpc.closed:
            _, executable = discover_runtime(self.config)
            if not executable:
                raise Failure('codex_missing', '未找到 Codex。请先安装并打开官方 Codex 应用。', 4)
            self.rpc = self.factory(executable, str(Path(self.config['state_dir'])), self.event)
        return self.rpc

    def call(self, rpc, method, params):
        try:
            return rpc.call(method, params)
        except Exception as error:
            raise Failure('codex_login_unavailable', 'Codex 登录接口未返回有效结果。请在 Codex 应用中核对；未自动重试。', 75) from error

    def status(self):
        with self.lock:
            account = project_account(self.call(self.runtime(), 'account/read', {'refreshToken': False}))
            with self.events_lock:
                result = self.login_result.get(self.login_id)
            return {'account': account, 'login_id': self.login_id,
                    'login_state': 'complete' if result is True else 'failed' if result is False else 'pending' if self.login_id else 'idle',
                    'can_login': account['login_status'] == 'signed_out' and account['requires_openai_auth'] is True,
                    'credentials_returned': False}

    def start(self):
        with self.lock:
            rpc = self.runtime()
            account = project_account(self.call(rpc, 'account/read', {'refreshToken': False}))
            if account['login_status'] != 'signed_out' or account['requires_openai_auth'] is not True:
                raise Failure('login_not_needed', '本机已登录或使用了自己的模型服务；未切换账号。', 4)
            if self.login_id:
                with self.events_lock:
                    if self.login_id not in self.login_result:
                        raise Failure('login_pending', '已有登录请求等待完成，请在原官方登录页继续。', 4)
            self.login_id = 'unknown'
            data = self.call(rpc, 'account/login/start', {'type': 'chatgpt', 'useHostedLoginSuccessPage': True, 'appBrand': 'codex'})
            # Treat a malformed or unknown login result as unresolved, never auto-replay it.
            self.login_id = data.get('loginId') or 'unknown'
            u = urlsplit(data.get('authUrl', ''))
            if (data.get('type') != 'chatgpt' or self.login_id == 'unknown' or u.scheme != 'https'
                    or u.hostname not in ('auth.openai.com', 'chatgpt.com') or u.username or u.password
                    or u.port not in (None, 443)):
                raise Failure('login_unavailable', 'Codex 未返回可验证的官方登录页面，请在 Codex 应用中登录。', 4)
            return {'login_id': self.login_id, 'auth_url': data['authUrl']}

    def close(self):
        if self.rpc:
            self.rpc.close()
