#!/usr/bin/env python3
"""Single-owner, opt-in browser node. Keep the engineering gateway loopback-only."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socketserver
from urllib.parse import parse_qs, urlsplit, urlencode

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/codex'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from icwb.host import AiRoutes
from icwb.service import Service, Failure, load_config
from ic_gateway.service import check_pdk_scope_response
from browser_pairing import Pairing, confirmation_html
from browser_login import LocalLogin
from library_workflow import WorkflowError
from platform_compat import is_owner_private_file, lock_file, unlock_file

MAX_BODY = 16 * 1024 * 1024
GET_ROUTES = {'catalog', 'context', 'history', 'events', 'models', 'sessions',
              'image', 'development', 'discovery', 'connection', 'auth/status'}
POST_ROUTES = {'sessions', 'sessions/rename', 'sessions/delete', 'connect',
               'resume', 'turn', 'approval', 'interrupt', 'doctor', 'auth/login', 'development/settings-request'}
LIBRARY_ROUTES = {'/api/library/read', '/api/library/prepare', '/api/library/review-request', '/api/library/execute'}
SIMULATION_ROUTE = '/api/simulation/execute'
ONBOARDING_PREFIX = '/api/simulation/onboarding/'
ONBOARDING_READS = {'ssh-hosts','session','submission','waveforms/catalog','waveforms/mapping','waveforms/window','agent-tb','source','agent-tb/review','pdk-scopes'}
ONBOARDING_WRITES = {'netlist','ssh-browse','ssh-import','ssh-setup-request','probe','discover-pdk','veriloga-headers','prepare','run','inspect','agent-tb/draft','agent-tb/prepare','analysis','select-pdk-scope'}

def onboarding_entry_origin(headers):
    # This header is provenance only. The bearer/pairing guards run first.
    values=headers.get_all('X-IC-Onboarding-Entry',[])
    if not values:return 'interactive_client'
    if values!=['native_agent']:raise ValueError('Unknown onboarding entry metadata')
    return 'native_agent'


class GatewayOnboarding:
    """Finite helper adapter to the configured loopback gateway, without retries."""
    def __init__(self,gateway):
        self.gateway=gateway
        self.enabled=False
        self.ssh_import_enabled=False
        self.connection_id=None

    def refresh(self):
        # Metadata reads must not remove otherwise available chat when an older
        # or temporarily unavailable gateway has no onboarding capability.
        try:
            health=self.gateway.request('/api/health')
            capabilities=health.get('capabilities',{})
            identity=health.get('connection_id')
            enabled=(health.get('api_version')=='1' and health.get('mode')=='live'
                and isinstance(capabilities,dict) and capabilities.get('simulation_onboarding') is True
                and capabilities.get('simulation_onboarding_api_version')=='1'
                and capabilities.get('simulation_onboarding_native_entry') is True
                and isinstance(identity,str) and re.fullmatch(r'[a-f0-9]{32}',identity) is not None)
            ssh_import=enabled and capabilities.get('simulation_onboarding_ssh_import') is True
        except (Failure,OSError,ValueError,TypeError,AttributeError):
            enabled=False;ssh_import=False;identity=None
        self.enabled=enabled
        self.ssh_import_enabled=ssh_import
        self.connection_id=identity if enabled else None

    def _request(self,operation,args,*,write,origin):
        allowed=ONBOARDING_WRITES if write else ONBOARDING_READS
        if operation not in allowed or not isinstance(args,dict):
            raise ValueError('Unknown bounded onboarding operation')
        if origin not in ('interactive_client','native_agent'):
            raise ValueError('Unknown onboarding entry metadata')
        if not self.enabled or not self.connection_id:
            raise PermissionError('Onboarding is unavailable on this connection')
        path=ONBOARDING_PREFIX+operation
        if not write and args:path+='?'+urlencode(args)
        timeout=320 if operation=='run' else 300 if operation in ('probe','discover-pdk','veriloga-headers','prepare','agent-tb/prepare') else 45 if operation=='inspect' else 35 if operation in ('ssh-browse','ssh-import') else 20
        data=self.gateway.request(path,args if write else None,
            onboarding_entry='native_agent' if origin=='native_agent' else None,
            onboarding_connection_id=self.connection_id,route_timeout=timeout)
        if not isinstance(data,dict):
            raise Failure('onboarding_response_mismatch','Onboarding response must be an object; do not replay mutations',75)
        if 'intake_id' in args and data.get('intake_id')!=args['intake_id']:
            raise Failure('onboarding_response_mismatch','Onboarding response belongs to another intake; do not replay mutations',75)
        if operation in ('pdk-scopes','select-pdk-scope'):
            check_pdk_scope_response(operation, data, args, self.connection_id)
        if operation in ('netlist','session','probe','discover-pdk','veriloga-headers','prepare','run','inspect','agent-tb','agent-tb/draft','agent-tb/prepare'):
            if data.get('schema')!='ic.onboarding.session.v1' or data.get('connection_id')!=self.connection_id:
                raise Failure('onboarding_response_mismatch','Onboarding response belongs to another connection; do not replay mutations',75)
        return data

    def read(self,operation,args,*,origin='interactive_client'):
        return self._request(operation,args,write=False,origin=origin)

    def write(self,operation,args,*,origin='interactive_client'):
        return self._request(operation,args,write=True,origin=origin)

def node_config(config_path=None, gateway_url='http://127.0.0.1:8766', state_dir=None, codex_bin=None):
    config = load_config(config_path) if config_path else {'gateway_url': gateway_url}
    # Never reuse an existing web host's session registry or approval state.
    state = state_dir or (Path(config['state_dir']) / 'browser-node' if config_path else ROOT / '.local/remote-node')
    config = {k: v for k, v in config.items() if not k.startswith('development_')}
    config['state_dir'] = str(Path(state).expanduser().resolve())
    if codex_bin:
        config['codex_bin'] = codex_bin
    return config

def origin(value):
    u = urlsplit(value)
    if (u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password
            or u.path not in ('', '/') or u.query or u.fragment
            or any(ord(c) < 33 for c in value)):
        raise ValueError('Use an exact http(s) origin without a path, wildcard or credentials')
    if u.scheme == 'http' and u.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Non-loopback browser origins require HTTPS')
    if '*' in u.netloc:
        raise ValueError('Wildcard origins are not allowed')
    return u.scheme + '://' + u.netloc.lower()

def public_endpoint(value):
    u = urlsplit(value)
    base = origin(u.scheme + '://' + u.netloc)
    if (u.query or u.fragment or '%' in u.path or '\\' in u.path
            or '..' in u.path.split('/') or not re.fullmatch(r'[A-Za-z0-9_/-]*', u.path)):
        raise ValueError('Public URL requires a plain path and no query or fragment')
    return base, u.path.rstrip('/')

def node_identity(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = state / 'browser-access.key'
    try:
        fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_urlsafe(32) + '\n')
    if not is_owner_private_file(key):
        raise ValueError('Access key must be an owner-only regular file (mode 0600)')
    token = key.read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', token):
        raise ValueError('Invalid node access key')
    identity = state / 'node-id'
    if not identity.exists():
        fd = os.open(identity, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_hex(16))
    return token, identity.read_text().strip(), key

class Node:
    def __init__(self, routes, token, origins, node_id, public_url, label='CircuitGit node'):
        self.routes = routes
        self.token = token
        self.origins = {origin(x) for x in origins}
        if not self.origins:
            raise ValueError('At least one explicitly trusted browser origin is required')
        self.node_id, self.label = node_id, label
        self.public_origin, self.prefix = public_endpoint(public_url)
        self.public_host = urlsplit(self.public_origin).netloc
        self.url = self.public_origin + self.prefix
        self.pairing = Pairing()
        self.login = None
        self.development = None
        self.ssh_setup = None
        self.library = None
        self.simulation = None
        self.onboarding = None
        self.onboarding_review_base = getattr(getattr(getattr(routes, 'service', None), 'gateway', None), 'origin', None)

    def onboarding_result(self, data):
        if not isinstance(data, dict) or data.get('schema') != 'ic.onboarding.session.v1':
            return data
        review = data.get('agent_tb_review')
        if not isinstance(review, dict) or not review.get('review_path') or not self.onboarding_review_base:
            return data
        target = urlsplit(self.onboarding_review_base)
        path = urlsplit(review['review_path'])
        if (target.scheme != 'http' or target.hostname != '127.0.0.1' or not target.port
                or target.path not in ('','/') or target.username or target.password
                or path.scheme or path.netloc or path.path != '/agent-tb/review' or path.fragment):
            raise ValueError('Invalid installed human-review address')
        query = parse_qs(path.query, strict_parsing=True)
        if (set(query) != {'intake_id','review_id'} or any(len(v) != 1 for v in query.values())
                or query['intake_id'][0] != data.get('intake_id') or query['review_id'][0] != review.get('review_id')):
            raise ValueError('Human-review link does not match this intake')
        return {**data, 'agent_tb_review': {**review, 'review_url': self.onboarding_review_base.rstrip('/') + review['review_path']}}

    def info(self):
        if isinstance(self.onboarding,GatewayOnboarding):self.onboarding.refresh()
        onboarding_enabled=self.onboarding is not None and self.onboarding.enabled
        return {'schema': 'circuitgit.remote-node.v1', 'node_id': self.node_id,
                'name': self.label, 'single_owner': True,
                'auth': 'bearer', 'account_source': 'operator-configured Codex runtime' if self.routes is not None else 'isolated simulation onboarding',
                'connection_id': self.onboarding.connection_id if onboarding_enabled else self.node_id,
                'capabilities': {'chat': self.routes is not None, 'projects': self.routes is not None, 'approvals': self.routes is not None,
                                 'developer': False, 'hosted_subscription_oauth': False,
                                 'local_developer_settings': self.development is not None,
                                 'library_workflow': self.library is not None,
                                 'simulation_workflow': self.simulation is not None,
                                 'simulation_onboarding': onboarding_enabled,
                                 'simulation_onboarding_api_version': '1' if onboarding_enabled else None,
                                 'simulation_onboarding_native_entry': onboarding_enabled,
                                 'simulation_onboarding_ssh_import': onboarding_enabled and getattr(self.onboarding, 'ssh_import_enabled', True),
                                 'local_ssh_setup': self.ssh_setup is not None and self.public_origin.startswith('http://127.0.0.1:') and not self.prefix,
                                 'local_login': self.login is not None and self.public_origin.startswith('http://127.0.0.1:') and not self.prefix},
                'automatic_model_start': False,
                'library_activity': self.library.activity() if self.library else {'running_actions': 0}}

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'CircuitGitNode/1'

    def log_message(self, *args):
        pass  # Credentials, prompts and query strings do not go into access logs.

    @property
    def node(self):
        return self.server.node

    def origin_allowed(self):
        hosts = {self.node.public_host, '127.0.0.1:' + str(self.server.server_port)}
        return self.headers.get('Host') in hosts and self.headers.get('Origin') in self.node.origins

    def guard(self, authenticate=True):
        if not self.origin_allowed():
            raise PermissionError('Origin or Host is not authorized for this node')
        if authenticate:
            header = self.headers.get('Authorization', '')
            if not header.startswith('Bearer ') or not (secrets.compare_digest(header[7:], self.node.token)
                    or self.node.pairing.accepts(header[7:], self.headers.get('Origin'))):
                raise PermissionError('Invalid node access code')

    def local_guard(self, write=False):
        expected = '127.0.0.1:' + str(self.server.server_port)
        if self.headers.get('Host') != expected or self.node.url != 'http://' + expected:
            raise PermissionError('Pairing is available only on the local connector')
        if write and (self.headers.get('Origin') != 'http://' + expected
                      or self.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site')):
            raise PermissionError('Confirm on the local connection page')

    def browser_identity(self):
        header = self.headers.get('Authorization', '')
        return (header[7:] if header.startswith('Bearer ') else ''), self.headers.get('Origin', '')

    def developer_guard(self):
        self.local_guard()
        if self.node.development is None:
            raise PermissionError('Local developer settings are not enabled on this connector')
        return self.node.development

    def ssh_setup_guard(self):
        self.local_guard()
        if self.node.ssh_setup is None:
            raise PermissionError('Local SSH setup wizard is not enabled on this connector')
        return self.node.ssh_setup

    def login_guard(self):
        self.local_guard()
        if (not self.node.login or not self.node.pairing.accepts(
                self.headers.get('Authorization', '')[7:], self.headers.get('Origin'))):
            raise PermissionError('Official login requires a confirmed local browser connection')

    def body(self, limit=MAX_BODY):
        if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
            raise ValueError('One Content-Length is required')
        length = int(self.headers['Content-Length'])
        if not 0 < length <= limit or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('A bounded JSON body is required')
        self.connection.settimeout(30)
        body = json.loads(self.rfile.read(length))
        if not isinstance(body, dict):
            raise ValueError('JSON object required')
        return body

    def connect_page(self):
        self.local_guard()
        path, query = self.route()
        if path != '/connect' or set(query) != {'origin', 'state'} or query['origin'][0] not in self.node.origins:
            raise PermissionError('This website is not configured for local pairing')
        target, state = query['origin'][0], query['state'][0]
        rid, csrf = self.node.pairing.create(target, state)
        nonce = secrets.token_urlsafe(24)
        self.send_page(confirmation_html(target, state, rid, csrf, self.node.url, nonce,
            mode='simulation-only' if self.node.routes is None else 'codex'), nonce)

    def development_page(self):
        settings = self.developer_guard()
        path, query = self.route()
        if path != '/development/settings' or set(query) != {'request'}:
            raise ValueError('An explicit local settings request is required')
        nonce = secrets.token_urlsafe(24)
        self.send_page(settings.form(query['request'][0], nonce), nonce)

    def ssh_setup_page(self):
        wizard = self.ssh_setup_guard()
        path, query = self.route()
        if path != '/ssh/setup' or set(query) != {'request'}:
            raise ValueError('An explicit local SSH setup request is required')
        nonce = secrets.token_urlsafe(24)
        html_doc, csp = wizard.form(query['request'][0], nonce)
        self.send_page(html_doc, nonce, csp=csp)

    def library_guard(self):
        self.local_guard()
        if self.node.library is None: raise PermissionError('This connector has no circuit repository')
        return self.node.library

    def library_page(self):
        workflow = self.library_guard()
        path, query = self.route()
        if path != '/library/review' or set(query) != {'ticket'}: raise ValueError('Exact review ticket required')
        nonce = secrets.token_urlsafe(24)
        self.send_page(workflow.form(query['ticket'][0], nonce), nonce)

    def send_page(self, html, nonce, *, csp=None):
        raw = html.encode() if isinstance(html, str) else html
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', csp or ("default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"))
        self.send_header('Connection', 'close'); self.close_connection = True
        self.end_headers(); self.wfile.write(raw)

    def send(self, status, data=None, preflight=False):
        raw = b'' if status == 204 else json.dumps(data, ensure_ascii=False).encode()
        if ONBOARDING_PREFIX in urlsplit(self.path).path and len(raw)>2*1024*1024:
            status=503;raw=json.dumps({'ok':False,'error':{'code':'response_size_limit','message':'Onboarding response exceeds its UTF-8 budget','details':{}}}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Vary', 'Origin')
        if self.origin_allowed():
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            if preflight:
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                self.send_header('Access-Control-Max-Age', '300')
                if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                    self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Connection', 'close')
        self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def fail(self, error):
        if isinstance(error, WorkflowError):
            status, record = error.status, {'code': error.code, 'message': str(error), 'details': error.details}
        elif isinstance(error, PermissionError):
            status, record = 403, {'code': 'forbidden', 'message': str(error)}
        elif isinstance(error, Failure):
            status = 409 if error.exit_code == 3 else 403 if error.exit_code == 4 else 503 if error.exit_code == 75 else 400
            record = error.record()
        elif isinstance(error, (ValueError, KeyError, TypeError)):
            status, record = 400, {'code': 'invalid_request', 'message': str(error)}
        else:
            status, record = 503, {'code': 'node_unavailable', 'message': 'Node request failed; no operation was automatically replayed'}
        self.send(status, {'ok': False, 'error': record})

    def route(self):
        if len(self.path) > 8192:
            raise ValueError('Request path too long')
        u = urlsplit(self.path)
        if u.scheme or u.netloc or u.fragment or '%' in u.path:
            raise ValueError('Invalid node route')
        prefix = self.node.prefix
        if prefix and not u.path.startswith(prefix + '/'):
            raise ValueError('Wrong node URL path')
        path = u.path[len(prefix):]
        qs = parse_qs(u.query, keep_blank_values=True, strict_parsing=True, max_num_fields=12) if u.query else {}
        if any(len(v) != 1 for v in qs.values()):
            raise ValueError('Duplicate query fields')
        return path, qs

    def do_OPTIONS(self):
        try:
            self.guard(False)
            path, _ = self.route()
            onboarding_route=path.startswith(ONBOARDING_PREFIX) and path[len(ONBOARDING_PREFIX):] in ONBOARDING_READS|ONBOARDING_WRITES
            if path not in ('/node/info', '/health') and path not in LIBRARY_ROUTES and path != SIMULATION_ROUTE and not onboarding_route and not (path.startswith('/api/ai/') and path[8:] in GET_ROUTES | POST_ROUTES):
                raise ValueError('Unknown preflight route')
            if self.headers.get('Access-Control-Request-Method') not in ('GET', 'POST'):
                raise PermissionError('Method is not allowed')
            headers = {x.strip().lower() for x in self.headers.get('Access-Control-Request-Headers', '').split(',') if x.strip()}
            if not headers <= {'authorization', 'content-type'}:
                raise PermissionError('Request headers are not allowed')
            self.send(204, preflight=True)
        except Exception as error:
            self.fail(error)

    def do_GET(self):
        try:
            if urlsplit(self.path).path == '/connect':
                self.connect_page(); return
            if urlsplit(self.path).path == '/development/settings':
                self.development_page(); return
            if urlsplit(self.path).path == '/ssh/setup':
                self.ssh_setup_page(); return
            if urlsplit(self.path).path == '/library/review':
                self.library_page(); return
            if urlsplit(self.path).path == (self.node.prefix + '/health'):
                self.guard(False)
                _, qs = self.route()
                if qs:
                    raise ValueError('Health route does not accept query fields')
                self.send(200, {'ok': True, 'data': {
                    'schema': 'circuitgit.local-connector.v1',
                    'ready': True,
                    'protocol': 'circuitgit',
                }})
                return
            self.guard()
            path, qs = self.route()
            if path == '/node/info' and not qs:
                data = self.node.info()
            elif path.startswith(ONBOARDING_PREFIX) and path[len(ONBOARDING_PREFIX):] in ONBOARDING_READS:
                if self.node.onboarding is None:raise PermissionError('Onboarding is unavailable on this connection')
                data=self.node.onboarding_result(self.node.onboarding.read(path[len(ONBOARDING_PREFIX):],{k:v[0] for k,v in qs.items()},origin=onboarding_entry_origin(self.headers)))
            elif path.startswith('/api/ai/') and path[8:] in GET_ROUTES:
                if self.node.routes is None:raise PermissionError('This connection has no chat or login service')
                if path == '/api/ai/auth/status':
                    self.login_guard()
                    if qs: raise ValueError('Login status does not accept query fields')
                    data = self.node.login.status()
                elif path == '/api/ai/development':
                    if set(qs) - {'session_id'}:
                        raise ValueError('Unexpected development availability query')
                    if self.node.development:
                        self.local_guard()
                        data = self.node.development.capability(*self.browser_identity(), session_id=qs.get('session_id', [None])[0])
                    else:
                        data = {'available': False, 'workspace': None, 'access': 'manual', 'can_configure': False,
                                'reason': 'local_owner_settings_unavailable'}
                else:
                    data = self.node.routes.get(path, qs)
                    if path == '/api/ai/models' and self.node.development and isinstance(data, dict) and 'development' in data:
                        data = {**data, 'development': self.node.development.capability(*self.browser_identity(), session_id=qs.get('session_id', ['default'])[0])}
            else:
                raise ValueError('Unknown node read route')
            self.send(200, {'ok': True, 'data': data})
        except Exception as error:
            self.fail(error)

    def do_POST(self):
        try:
            if self.path == '/library/review/confirm':
                self.local_guard(True)
                data = self.library_guard().confirm(self.body(8192))
                self.send(200, {'ok': True, 'data': data}); return
            if self.path == '/development/settings/confirm':
                self.local_guard(True)
                settings = self.developer_guard()
                data = settings.confirm(self.body(8192))
                self.send(200, {'ok': True, 'data': data}); return
            if self.path == '/ssh/setup/action':
                self.local_guard(True)
                wizard = self.ssh_setup_guard()
                data = wizard.action(self.body(65536))
                self.send(200, data); return
            if self.path == '/connect/confirm':
                self.local_guard(True)
                body = self.body(4096)
                if set(body) != {'request_id', 'csrf', 'allow'} or type(body['allow']) is not bool or not all(isinstance(body[k], str) for k in ('request_id', 'csrf')):
                    raise ValueError('Invalid connection confirmation')
                data = self.node.pairing.decide(body['request_id'], body['csrf'], body['allow'])
                self.send(200, {'ok': True, 'data': data}); return
            self.guard()
            path, qs = self.route()
            if path.startswith(ONBOARDING_PREFIX) and path[len(ONBOARDING_PREFIX):] in ONBOARDING_WRITES:
                token,browser_origin=self.browser_identity()
                if not self.node.pairing.accepts(token,browser_origin):raise PermissionError('Onboarding requires the confirmed local browser connection')
                if qs:raise ValueError('Onboarding writes have no query fields')
                if path == ONBOARDING_PREFIX + 'ssh-setup-request':
                    wizard = self.ssh_setup_guard()
                    if self.body(4096):
                        raise ValueError('SSH setup requests do not accept configuration overrides')
                    data = wizard.request(token, browser_origin)
                    self.send(200, {'ok': True, 'data': data}); return
                if self.node.onboarding is None:raise PermissionError('Onboarding is unavailable on this connection')
                entry_origin=onboarding_entry_origin(self.headers)
                data=self.node.onboarding_result(self.node.onboarding.write(path[len(ONBOARDING_PREFIX):],self.body(2*1024*1024),origin=entry_origin))
                self.send(200,{'ok':True,'data':data});return
            if path == SIMULATION_ROUTE:
                token, browser_origin = self.browser_identity()
                if not self.node.pairing.accepts(token, browser_origin):
                    raise PermissionError('Simulation requires a confirmed local browser connection')
                if self.node.simulation is None:
                    raise PermissionError('Configure the local simulation scope before submitting')
                body = self.body(65536)
                if (qs or set(body) - {'operation', 'arguments', 'idempotency_key'}
                        or body.get('operation') not in ('submit', 'status', 'collect', 'watch', 'unwatch', 'resources_scan', 'runtime', 'prepare', 'run', 'inspect')
                        or not isinstance(body.get('arguments'), dict)
                        or body.get('idempotency_key') is not None and not isinstance(body['idempotency_key'], str)):
                    raise ValueError('Finite simulation operation, arguments and optional stable key required')
                data = self.node.simulation(body['operation'], body['arguments'], body.get('idempotency_key'), caller_id='paired-helper')
                self.send(200, {'ok': True, 'data': data}); return
            if path in LIBRARY_ROUTES:
                if qs: raise ValueError('Library operations do not accept query fields')
                workflow = self.library_guard();body = self.body(2*1024*1024)
                if path.endswith('/execute'):
                    if set(body) != {'operation','args','idempotency_key'} or not isinstance(body['operation'], str) or not isinstance(body['args'], dict) or not isinstance(body['idempotency_key'], str):
                        raise ValueError('Finite operation, arguments and stable idempotency key required')
                    data = workflow.execute(body['operation'], body['args'], body['idempotency_key'], *self.browser_identity())
                elif path.endswith('/review-request'):
                    if set(body) != {'review_id'} or not isinstance(body['review_id'], str): raise ValueError('Exact review identity required')
                    data = workflow.request(body['review_id'], *self.browser_identity())
                else:
                    if set(body) != {'operation','args'} or not isinstance(body['operation'], str) or not isinstance(body['args'], dict): raise ValueError('Finite operation and arguments required')
                    method = workflow.read if path.endswith('/read') else workflow.prepare
                    data = method(body['operation'], body['args'], *self.browser_identity())
                self.send(200, {'ok': True, 'data': data}); return
            if qs or not path.startswith('/api/ai/') or path[8:] not in POST_ROUTES:
                raise ValueError('Unknown node write route')
            if self.node.routes is None:raise PermissionError('This connection has no chat or login service')
            body = self.body()
            if path == '/api/ai/development/settings-request':
                settings = self.developer_guard()
                if body: raise ValueError('Settings requests do not accept workspace or permission overrides')
                data = settings.request(*self.browser_identity())
                self.send(200, {'ok': True, 'data': data}); return
            if path == '/api/ai/auth/login':
                self.login_guard()
                if body: raise ValueError('Login does not accept credentials or provider overrides')
                self.send(200, {'ok': True, 'data': self.node.login.start()}); return
            if self.node.development:
                self.local_guard()
                data = self.node.development.dispatch(path, body, *self.browser_identity())
            else:
                if path == '/api/ai/turn' and body.get('permission_mode') == 'developer':
                    raise PermissionError('Developer mode requires locally confirmed owner settings')
                data = self.node.routes.post(path, body)
            self.send(200, {'ok': True, 'data': data})
        except Exception as error:
            self.fail(error)

class Server(ThreadingHTTPServer):
    daemon_threads = True
    def server_bind(self):
        # Avoid blocking reverse DNS lookups (socket.getfqdn) on loopback binds.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=Path, help='Existing local AI client configuration')
    p.add_argument('--gateway-url', default='http://127.0.0.1:8766')
    p.add_argument('--state-dir', type=Path, help='Dedicated browser-node state; defaults to a separate directory')
    p.add_argument('--codex-bin', help='Optional explicit Codex executable')
    p.add_argument('--allow-origin', action='append', required=True)
    p.add_argument('--port', type=int, default=8767)
    p.add_argument('--public-url', help='HTTPS reverse-proxy URL, optionally with a path prefix')
    p.add_argument('--name', default='My CircuitGit node')
    args = p.parse_args()
    config = node_config(args.config, args.gateway_url, args.state_dir, args.codex_bin)
    state = Path(config['state_dir']).resolve()
    token, node_id, keyfile = node_identity(state)
    with (state / 'remote-node.lock').open('a+b') as lock:
        try:
            lock_file(lock, nonblocking=True)
        except BlockingIOError:
            p.error('Another browser node owns this state directory')
        routes = AiRoutes(Service(config))
        try:
            node = Node(routes, token, args.allow_origin, node_id,
                        args.public_url or 'http://127.0.0.1:' + str(args.port), args.name)
            node.onboarding = GatewayOnboarding(routes.service.gateway)
            node.login = LocalLogin(config)
            server = Server(('127.0.0.1', args.port), Handler)
            server.node = node
            print(json.dumps({'url': node.url, 'access_code_file': str(keyfile), 'node_id': node_id,
                              'allowed_origins': sorted(node.origins), 'single_owner': True,
                              'model_started': False}), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
                node.login.close()
        finally:
            routes.close()
            unlock_file(lock)

if __name__ == '__main__':
    main()
