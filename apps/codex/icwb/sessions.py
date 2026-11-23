"""Explicit, bounded AI session namespaces; no mutable global active-session selector."""
import copy
import json
import threading
import time
import uuid
from .ai import AiSession
from .service import Failure, Service, atom, check


class SessionRegistry:
    MAX_SESSIONS = 8

    def __init__(self, service, session_factory=AiSession):
        self.service = service; self.factory = session_factory; self.lock = threading.RLock(); self.instances = {}; self.closed = False
        self.path = service.state / 'ai-sessions.json'
        if self.path.exists():
            # A registry, including an empty one or a default tombstone, is
            # authoritative. Retained legacy files never resurrect deleted rows.
            saved = json.loads(self.path.read_text())
        elif (service.state / 'ai-session.json').exists():
            # Pre-registry installations may have actual default history. Keep
            # it discoverable until the owner explicitly deletes that chat.
            legacy = json.loads((service.state / 'ai-session.json').read_text())
            check(isinstance(legacy, dict) and legacy.get('session_id') == 'default', 'Invalid legacy session identity')
            saved = {'sessions': [{'session_id': 'default', 'name': '默认会话',
                                   'updated_at_ms': legacy.get('updated_at_ms', round(time.time()*1000))}]}
        else:
            saved = {'sessions': []}
        self.rows = saved['sessions']; self.deleted = saved.get('deleted_sessions', {})
        check(isinstance(self.rows, list) and isinstance(self.deleted, dict), 'Invalid session registry')
        ids = [r.get('session_id') for r in self.rows if isinstance(r, dict)]
        check(len(ids) == len(self.rows) <= self.MAX_SESSIONS and all(isinstance(sid, str) for sid in ids)
              and len(ids) == len(set(ids)) and not set(ids).intersection(self.deleted)
              and all(isinstance(sid, str) and isinstance(row, dict) and row.get('session_id') == sid
                      for sid, row in self.deleted.items()), 'Invalid session registry')

    def _save(self, rows, deleted=None):
        atom(self.path, {'sessions': rows, 'deleted_sessions': self.deleted if deleted is None else deleted})

    @staticmethod
    def _delete_reason(sid, state, pending, metadata_busy=False, active_calls=0, closing=False):
        if state in ('starting', 'running'): return 'active_turn'
        if metadata_busy: return 'metadata_busy'
        if any(p.get('status') != 'resolved' for p in pending): return 'unresolved_approval'
        if active_calls: return 'session_busy'
        if closing: return 'session_closing'
        if state not in ('idle', 'complete', 'suspended'): return 'session_unavailable'
        return None

    def _saved_session(self, sid):
        state_dir = self.service.state if sid == 'default' else self.service.state / 'sessions' / sid
        path = state_dir / 'ai-session.json'
        saved = json.loads(path.read_text()) if path.exists() else {}
        check(isinstance(saved, dict) and isinstance(saved.get('pending', []), list)
              and all(isinstance(p, dict) for p in saved.get('pending', [])), 'Invalid saved session')
        return saved

    def _name(self, name):
        check(isinstance(name, str) and 1 <= len(name.strip()) <= 64 and not any(ord(c) < 32 for c in name), 'Session name must contain 1..64 printable characters')
        return name.strip()

    def _row(self, sid):
        check(isinstance(sid, str), 'Session id must be a string')
        check(sid not in self.deleted, 'Unknown AI session', 'not_found', 4)
        row = next((r for r in self.rows if r['session_id'] == sid), None)
        check(row is not None, 'Unknown AI session', 'not_found', 4)
        return row

    def get(self, sid='default'):
        with self.lock:
            check(not self.closed, 'AI sessions are shutting down', 'conflict', 3)
            self._row(sid)
            if sid not in self.instances:
                service = self.service if sid == 'default' else Service({**self.service.config, 'state_dir': str(self.service.state / 'sessions' / sid)})
                self.instances[sid] = self.factory(service, session_id=sid)
            return self.instances[sid]

    def info(self, sid):
        with self.lock:
            row = self._row(sid); session = self.instances.get(sid)
            if session:
                with session.lock:
                    reason = self._delete_reason(sid, session.state, session.pending.values(), session.metadata_busy,
                                                 session.active_calls, session.closing)
                    return {**row, 'state': session.state, 'pending_approval_count': sum(p['status'] in ('pending', 'resolving') for p in session.pending.values()),
                            'suspended_approval_count': sum(p['status'] == 'suspended' for p in session.pending.values()),
                            'model': session.last_model, 'updated_at_ms': max(row['updated_at_ms'], session.updated_at_ms), 'restored': session.restored,
                            'can_delete': reason is None, 'delete_block_reason': reason}
            saved = self._saved_session(sid)
            pending = [p for p in saved.get('pending', []) if p.get('status') != 'resolved']
            reason = self._delete_reason(sid, saved.get('state', 'idle'), pending, saved.get('metadata_busy', False))
            return {**row, 'state': 'suspended' if saved.get('state') in ('starting', 'running', 'suspended') else saved.get('state', 'idle'),
                    'pending_approval_count': 0, 'suspended_approval_count': len(pending),
                    'model': saved.get('model'), 'updated_at_ms': max(row['updated_at_ms'], saved.get('updated_at_ms', 0)), 'restored': bool(saved),
                    'can_delete': reason is None, 'delete_block_reason': reason}

    def list(self):
        with self.lock: return {'sessions': [self.info(row['session_id']) for row in self.rows], 'max_sessions': self.MAX_SESSIONS}

    def create(self, name='新会话'):
        with self.lock:
            check(not self.closed, 'AI sessions are shutting down', 'conflict', 3)
            check(len(self.rows) < self.MAX_SESSIONS, 'AI session limit reached (8); existing history is retained', 'session_limit', 4)
            row = {'session_id': 's_' + uuid.uuid4().hex[:24], 'name': self._name(name), 'updated_at_ms': round(time.time()*1000)}
            check(row['session_id'] not in self.deleted and all(r['session_id'] != row['session_id'] for r in self.rows),
                  'Generated session identity already exists', 'conflict', 3)
            rows = [*self.rows, row]; self._save(rows); self.rows = rows
            return self.info(row['session_id'])

    def rename(self, sid, name):
        with self.lock:
            check(not self.closed, 'AI sessions are shutting down', 'conflict', 3)
            self._row(sid); rows = copy.deepcopy(self.rows)
            row = next(r for r in rows if r['session_id'] == sid)
            row['name'] = self._name(name); row['updated_at_ms'] = round(time.time()*1000)
            self._save(rows); self.rows = rows
            return self.info(sid)

    def delete(self, sid):
        result = {'session_id': sid, 'deleted': True, 'history_retained': True}
        with self.lock:
            check(not self.closed, 'AI sessions are shutting down', 'conflict', 3)
            check(isinstance(sid, str), 'Session id must be a string')
            if sid in self.deleted:
                return result
            self._row(sid); session = self.instances.get(sid)

            def commit(reason):
                if reason is not None:
                    raise Failure('conflict', 'Session cannot be deleted: ' + reason, 3, {'delete_block_reason': reason})
                rows = [r for r in self.rows if r['session_id'] != sid]
                deleted = {**self.deleted, sid: {'session_id': sid, 'deleted_at_ms': round(time.time()*1000)}}
                self._save(rows, deleted)
                self.rows, self.deleted = rows, deleted
                if session is not None:
                    # The session lock also guards entry to every RPC/approval operation.
                    session.deleted = True; session.closing = True
                self.instances.pop(sid, None)

            if session is None:
                saved = self._saved_session(sid)
                commit(self._delete_reason(sid, saved.get('state', 'idle'), saved.get('pending', []), saved.get('metadata_busy', False)))
            else:
                with session.lock:
                    reason = self._delete_reason(sid, session.state, session.pending.values(), session.metadata_busy,
                                                 session.active_calls, session.closing)
                    if reason is None:
                        session._persist(force=True)
                    commit(reason)
        # Do not hold the registry lock while closing only this session's transport.
        if session is not None:
            session.close()
        return result

    def close(self):
        with self.lock:
            self.closed = True; sessions = list(self.instances.values())
        for session in sessions: session.close()
