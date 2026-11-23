#!/usr/bin/env python3
"""Single-owner, opt-in browser node. Keep the engineering gateway loopback-only."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/codex'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from icwb.host import AiRoutes
from icwb.service import Service, Failure, load_config
from browser_pairing import Pairing, confirmation_html
from browser_login import LocalLogin

MAX_BODY = 16 * 1024 * 1024
GET_ROUTES = {'catalog', 'context', 'history', 'events', 'models', 'sessions',
              'image', 'development', 'discovery', 'connection', 'auth/status'}
POST_ROUTES = {'sessions', 'sessions/rename', 'sessions/delete', 'connect',
               'resume', 'turn', 'approval', 'interrupt', 'doctor', 'auth/login'}

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
    if key.is_symlink() or not key.is_file() or stat.S_IMODE(key.stat().st_mode) & 0o077:
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

    def info(self):
        return {'schema': 'circuitgit.remote-node.v1', 'node_id': self.node_id,
                'name': self.label, 'single_owner': True,
                'auth': 'bearer', 'account_source': 'operator-configured Codex runtime',
                'capabilities': {'chat': True, 'projects': True, 'approvals': True,
                                 'developer': False, 'hosted_subscription_oauth': False,
                                 'local_login': self.login is not None and self.public_origin.startswith('http://127.0.0.1:') and not self.prefix},
                'automatic_model_start': False}

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
        if write and self.headers.get('Origin') != 'http://' + expected:
            raise PermissionError('Confirm on the local connection page')

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
        raw = confirmation_html(target, state, rid, csrf, self.node.url, nonce).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header('Connection', 'close'); self.close_connection = True
        self.end_headers(); self.wfile.write(raw)

    def send(self, status, data=None, preflight=False):
        raw = b'' if status == 204 else json.dumps(data, ensure_ascii=False).encode()
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
        if isinstance(error, PermissionError):
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
            if path != '/node/info' and not (path.startswith('/api/ai/') and path[8:] in GET_ROUTES | POST_ROUTES):
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
            self.guard()
            path, qs = self.route()
            if path == '/node/info' and not qs:
                data = self.node.info()
            elif path.startswith('/api/ai/') and path[8:] in GET_ROUTES:
                if path == '/api/ai/auth/status':
                    self.login_guard()
                    if qs: raise ValueError('Login status does not accept query fields')
                    data = self.node.login.status()
                elif path == '/api/ai/development':
                    data = {'available': False, 'reason': 'Remote browser nodes retain manual circuit approvals'}
                else:
                    data = self.node.routes.get(path, qs)
            else:
                raise ValueError('Unknown node read route')
            self.send(200, {'ok': True, 'data': data})
        except Exception as error:
            self.fail(error)

    def do_POST(self):
        try:
            if self.path == '/connect/confirm':
                self.local_guard(True)
                body = self.body(4096)
                if set(body) != {'request_id', 'csrf', 'allow'} or type(body['allow']) is not bool or not all(isinstance(body[k], str) for k in ('request_id', 'csrf')):
                    raise ValueError('Invalid connection confirmation')
                data = self.node.pairing.decide(body['request_id'], body['csrf'], body['allow'])
                self.send(200, {'ok': True, 'data': data}); return
            self.guard()
            path, qs = self.route()
            if qs or not path.startswith('/api/ai/') or path[8:] not in POST_ROUTES:
                raise ValueError('Unknown node write route')
            body = self.body()
            if path == '/api/ai/auth/login':
                self.login_guard()
                if body: raise ValueError('Login does not accept credentials or provider overrides')
                self.send(200, {'ok': True, 'data': self.node.login.start()}); return
            if path == '/api/ai/turn' and body.get('permission_mode') == 'developer':
                raise PermissionError('Developer mode is not exposed by this browser node')
            data = self.node.routes.post(path, body)
            self.send(200, {'ok': True, 'data': data})
        except Exception as error:
            self.fail(error)

class Server(ThreadingHTTPServer):
    daemon_threads = True

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
    with (state / 'remote-node.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            p.error('Another browser node owns this state directory')
        routes = AiRoutes(Service(config))
        try:
            node = Node(routes, token, args.allow_origin, node_id,
                        args.public_url or 'http://127.0.0.1:' + str(args.port), args.name)
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

if __name__ == '__main__':
    main()
