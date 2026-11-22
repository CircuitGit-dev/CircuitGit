"""Bounded line-delimited official app-server transport, no credential handling."""
import json
import queue
import subprocess
import threading
from .service import Failure, canonical


class Rpc:
    def __init__(self, executable, cwd, callback, timeout=30):
        self.callback, self.timeout = callback, timeout
        self.pending, self.sequence = {}, 0
        self.lock = threading.RLock(); self.closed = False
        self.process = subprocess.Popen([executable, 'app-server', '--listen', 'stdio://'], cwd=cwd,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True); self.reader.start()
        self.info = self.call('initialize', {'clientInfo': {'name': 'ic_workbench', 'title': 'IC Workbench', 'version': '0.1.0'},
                                          'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized', 'params': {}})

    def send(self, value):
        with self.lock:
            if self.closed: raise Failure('app_server_disconnected', 'Codex app-server disconnected; no replay', 75)
            try:
                self.process.stdin.write(canonical(value) + '\n'); self.process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as e:
                raise Failure('app_server_disconnected', 'Codex app-server write failed; no replay', 75) from e

    def call(self, method, params):
        with self.lock:
            self.sequence += 1; rid = 'icwb-' + str(self.sequence); q = queue.Queue(maxsize=1); self.pending[rid] = q
        try:
            self.send({'id': rid, 'method': method, 'params': params})
            try: reply = q.get(timeout=self.timeout)
            except queue.Empty: raise Failure('app_server_timeout', 'Codex request timed out: ' + method + '; no replay', 75)
            if 'error' in reply:
                e = reply['error']
                raise Failure('app_server_error', e.get('message', 'Codex request failed'), 75 if e.get('code') == -32000 else 4,
                              {'method': method, 'rpc_code': e.get('code')})
            return reply.get('result', {})
        finally:
            with self.lock: self.pending.pop(rid, None)

    def _read(self):
        try:
            while True:
                line = self.process.stdout.readline(8 * 1024 * 1024 + 1)
                if not line: break
                if len(line) > 8 * 1024 * 1024: break
                try: msg = json.loads(line)
                except ValueError: break
                if 'method' not in msg and 'id' in msg:
                    with self.lock: q = self.pending.get(msg['id'])
                    if q: q.put(msg)
                else:
                    self.callback(msg)
        finally:
            with self.lock:
                self.closed = True
                for q in self.pending.values():
                    if q.empty(): q.put({'error': {'code': -32000, 'message': 'Codex disconnected; request outcome unknown'}})
            self.callback({'method': 'transport/disconnected', 'params': {'reason': 'app-server stream closed'}})

    def close(self):
        with self.lock:
            self.closed = True
            if self.process.poll() is None: self.process.terminate()
        try: self.process.wait(timeout=5)
        except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        self.process.stdin.close(); self.process.stdout.close()
