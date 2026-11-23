"""Optional local AI host. Also import AiRoutes into the existing gateway Handler."""
import json
import mimetypes
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from .sessions import SessionRegistry
from .service import Failure, canonical, check
from .connections import describe_connection
from .ai_prompt import geometry_summary
from .connection_metadata import discover_runtime
from .commit_summary import CommitSummaries
from .development import development_info

WEB = Path(__file__).resolve().parents[1] / 'web'


class AiRoutes:
    """Integrators call get/post only AFTER the existing gateway guard/body limit."""
    def __init__(self, service):
        self.service = service
        self.sessions = SessionRegistry(service)
        self.commit_summaries = CommitSummaries(service)

    @property
    def session(self):
        return self.sessions.get('default')

    def close(self):
        try: self.commit_summaries.close()
        finally: self.sessions.close()

    def start_commit_summary(self, verified):
        """Only the Workspace's verified review adapter calls this internal bridge."""
        return self.commit_summaries.start(verified)

    def get_commit_summary(self, summary_id):
        return self.commit_summaries.get(summary_id)

    def commit_summary_activity(self):
        return self.commit_summaries.activity()

    def get(self, path, query):
        query = dict(query)
        if path == '/api/ai/development':
            check(set(query) <= {'session_id'}, 'Unexpected development availability query')
            if 'session_id' in query:
                check(isinstance(query['session_id'], list) and len(query['session_id']) == 1,
                      'Development availability requires one session identity')
                self.sessions.info(query['session_id'][0])
            return development_info(self.service.config)
        if path == '/api/ai/connection':
            check(not query, 'Connection description does not accept query fields')
            return describe_connection(self.service.config)
        if path == '/api/ai/discovery':
            check(not query, 'Runtime discovery does not accept query fields')
            return discover_runtime(self.service.config)[0]
        if path == '/api/ai/image':
            check(set(query) == {'session_id', 'image_id'} and all(isinstance(v, list) and len(v) == 1 for v in query.values()),
                  'Image read requires one explicit session_id and image_id')
            return self.sessions.get(query['session_id'][0]).image(query['image_id'][0])
        ids = query.pop('session_id', None)
        check(ids is None or isinstance(ids, list) and len(ids) == 1 and isinstance(ids[0], str), 'One explicit session_id required')
        if path == '/api/ai/sessions':
            check(not query, 'Unexpected sessions query'); return self.sessions.list()
        if path in ('/api/ai/catalog', '/api/ai/context'):
            # Connecting/selecting an engineering project precedes chat creation.
            # An explicit identity is still checked, including deletion tombstones.
            if ids is not None: self.sessions.info(ids[0])
            service = self.service
        if path == '/api/ai/catalog':
            check(not query, 'Unexpected project catalog query')
            return service.call('projects', {})
        if path == '/api/ai/context':
            r = service.call('read', {'project_id': query.get('project_id', [''])[0]})
            f = r['file']; p = r['project']
            return {'version': 1, 'revision': 1,
                'project': {'id': p['id'], 'repository': p['repository'], 'branch': p['branch'], 'sourceCommit': f['base_commit']},
                'file': {'path': f['path'], 'baseCommit': f['base_commit'], 'persistedSha256': f['sha256'],
                         'currentTextSha256': f['sha256'], 'dirty': False, 'editable': f['editable']},
                'selection': None, 'geometry': {'gatewayMetadata': geometry_summary(r['geometry']), 'state': 'unknown'}, 'run': None}
        # Omitting an identity is compatible only with an actual surviving legacy
        # default. SessionRegistry.get never creates one or chooses another chat.
        session = self.sessions.get(ids[0] if ids is not None else 'default')
        if path == '/api/ai/history':
            check(not query, 'Unexpected history query'); return session.history()
        if path == '/api/ai/models':
            check(not query, 'Model catalog does not accept provider overrides or query fields')
            return session.models()
        if path == '/api/ai/events': return session.poll(int(query.get('after', ['0'])[0]))
        raise Failure('not_found', 'Unknown AI endpoint')

    def post(self, path, body):
        if path == '/api/ai/sessions':
            check(set(body) <= {'name'}, 'Unexpected create fields'); return self.sessions.create(body.get('name', '新会话'))
        if path == '/api/ai/sessions/rename':
            check(set(body) == {'session_id', 'name'}, 'Unexpected rename fields'); return self.sessions.rename(body['session_id'], body['name'])
        if path == '/api/ai/sessions/delete':
            check(set(body) == {'session_id'}, 'Session deletion requires only an explicit session_id')
            return self.sessions.delete(body['session_id'])
        if path == '/api/ai/connect':
            check(set(body) == {'session_id'}, 'Connection check requires only an explicit session_id')
            return self.sessions.get(body['session_id']).connection()
        if path == '/api/ai/resume':
            check(set(body) == {'session_id', 'expected_turn_id'}, 'Input recovery requires explicit session_id and expected_turn_id')
            return self.sessions.get(body['session_id']).resume(body['expected_turn_id'])
        body = dict(body); session = self.sessions.get(body.pop('session_id', 'default'))
        if path == '/api/ai/turn':
            check({'message', 'context', 'idempotency_key'} <= set(body) <= {'message', 'context', 'idempotency_key', 'model', 'images', 'reasoning_effort', 'permission_mode'}, 'Unexpected turn fields')
            check('images' not in body or isinstance(body['images'], list), 'Images must be an array')
            settings = {name: body[name] for name in ('reasoning_effort', 'permission_mode') if name in body}
            return session.turn(body['message'], body['context'], body['idempotency_key'], body.get('model'), body.get('images'), **settings)
        if path == '/api/ai/approval':
            check(set(body) == {'approval_id', 'decision'}, 'Unexpected approval fields')
            return session.approve(body['approval_id'], body['decision'])
        if path == '/api/ai/interrupt':
            check(not body, 'Unexpected interrupt fields'); return session.interrupt()
        if path == '/api/ai/doctor':
            check(not body, 'Unexpected doctor fields'); return session.doctor()
        raise Failure('not_found', 'Unknown AI endpoint')

    def stream(self, handler, after, session_id='default'):
        session = self.sessions.get(session_id)
        handler.send_response(200)
        handler.send_header('Content-Type', 'text/event-stream')
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Connection', 'close')
        handler.end_headers(); handler.close_connection = True
        try:
            # Bounded stream connection. EventSource may reconnect; only events are replayed.
            for _ in range(25):
                try:
                    data = session.poll(after)
                except Failure as error:
                    with session.lock:
                        ended = (session.deleted and error.code == 'not_found') or (session.closing and error.code == 'conflict')
                    if ended:
                        return  # SSE headers are already sent; closure is not a second JSON response.
                    raise
                handler.wfile.write(('id: ' + str(data['cursor']) + '\ndata: ' + canonical(data) + '\n\n').encode())
                handler.wfile.flush(); after = data['cursor']; time.sleep(1)
        except (BrokenPipeError, ConnectionResetError):
            # Watchdog handles lost viewers without racing normal EventSource reconnects.
            pass


def serve(service, port):
    routes = AiRoutes(service); csrf = secrets.token_urlsafe(32)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def guard(self, write=False):
            expected = '127.0.0.1:' + str(self.server.server_port); origin = 'http://' + expected
            check(self.headers.get('Host') == expected and self.headers.get('Origin') in (None, origin), 'Origin/Host rejected', 'forbidden', 4)
            check(self.headers.get('Sec-Fetch-Site') not in ('cross-site', 'same-site'), 'Cross-site access rejected', 'forbidden', 4)
            if write:
                check(self.headers.get('Origin') == origin and secrets.compare_digest(self.headers.get('X-Workbench-Token', ''), csrf), 'Invalid same-origin CSRF token', 'forbidden', 4)
                check(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'JSON required')
        def send(self, status, data, content_type='application/json'):
            raw = data if isinstance(data, bytes) else canonical(data).encode()
            self.send_response(status); self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(raw))); self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; object-src 'none'")
            self.end_headers(); self.wfile.write(raw)
        def fail(self, e):
            error = e.record() if isinstance(e, Failure) else {'code': 'invalid_input', 'message': str(e)}
            self.close_connection = True
            self.send(403 if error['code'] == 'forbidden' else 409 if error['code'] == 'conflict' else 400, {'ok': False, 'error': error})
        def do_GET(self):
            try:
                self.guard(); url = urlsplit(self.path); q = parse_qs(url.query)
                if url.path == '/api/health': return self.send(200, {'ok': True, 'data': {'mutation_token': csrf, 'mode': 'live-ai-sidecar'}})
                if url.path == '/api/ai/events' and 'text/event-stream' in self.headers.get('Accept', ''):
                    return routes.stream(self, max(int(q.get('after', ['0'])[0]), int(self.headers.get('Last-Event-ID', '0'))), q.get('session_id', ['default'])[0])
                if url.path.startswith('/api/ai/'):
                    return self.send(200, {'ok': True, 'data': routes.get(url.path, q)})
                files = {'/': 'index.html', '/ai/ai-panel.js': 'ai-panel.js', '/ai/ai-panel.css': 'ai-panel.css', '/ai/standalone.js': 'standalone.js'}
                check(url.path in files, 'Asset not found', 'not_found')
                f = WEB / files[url.path]
                return self.send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or 'application/octet-stream')
            except (BrokenPipeError, ConnectionResetError): pass
            except Exception as e: self.fail(e)
        def do_POST(self):
            try:
                self.guard(True); size = int(self.headers.get('Content-Length', '0'))
                check(0 < size <= 2 * 1024 * 1024, 'Body size invalid')
                body = json.loads(self.rfile.read(size)); check(isinstance(body, dict), 'Object required')
                self.send(200, {'ok': True, 'data': routes.post(urlsplit(self.path).path, body)})
            except Exception as e: self.fail(e)
        def do_OPTIONS(self): self.send(403, {'ok': False, 'error': {'code': 'forbidden', 'message': 'CORS disabled'}})
    http = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    http.daemon_threads = True
    print(canonical({'url': 'http://127.0.0.1:' + str(http.server_port), 'gateway': service.gateway.origin,
                     'mode': 'real Codex adapter; no model claim until turn completion'}), flush=True)
    try: http.serve_forever()
    finally: http.server_close(); routes.close()
