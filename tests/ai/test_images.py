"""Synthetic image validation/session/protocol tests. All model RPCs are fake."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/codex'))
from icwb.ai import AiSession
from icwb.host import AiRoutes
from icwb.images import MAX_IMAGE_BYTES, SessionImages, validate_images
from icwb.service import Failure, Service, digest


# Generated once from a synthetic solid-color 2x3 image; tests need no image library.
JPEG = base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCrRRRXhHwJ/9k=')
PROGRESSIVE_JPEG = base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/aAAwDAQACEAMQAAABkAQP/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAL/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=')


def chunk(kind, payload):
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)


def png(width=2, height=3, *, pixels=None, interlace=0, extra=b'', color=2, depth=8):
    header = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, color, 0, 0, interlace))
    raw = pixels if pixels is not None else (b'\0' + b'\x20\xa0\x40' * width) * height
    return b'\x89PNG\r\n\x1a\n' + header + extra + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def image(data=None, name='test.png', mime='image/png'):
    data = png() if data is None else data
    return {'name': name, 'mime_type': mime, 'data_url': 'data:' + mime + ';base64,' + base64.b64encode(data).decode('ascii')}


def context():
    return {'version': 1, 'revision': 1, 'mode': 'live', 'project': {'id': 'SYNTHETIC'}, 'file': {
        'path': 'projects/demo.scs', 'baseCommit': 'a' * 40, 'persistedSha256': 'b' * 64,
        'currentTextSha256': 'b' * 64, 'dirty': False}}


class FakeRpc:
    def __init__(self, executable, cwd, callback, timeout=30):
        self.callback = callback; self.sent = []; self.closed = False; self.info = {}; self.number = 0
        self.default = 'vision'; self.thread_default = None; self.provider = 'fixture'; self.thread_provider = None
        self.reviewer = 'user'; self.policy = 'on-request'
        self.entries = [
            {'id': 'vision-id', 'model': 'vision', 'displayName': 'Synthetic vision', 'inputModalities': ['text', 'image'], 'isDefault': True},
            {'id': 'text-id', 'model': 'text', 'displayName': 'Synthetic text', 'inputModalities': ['text'], 'isDefault': False}]

    def call(self, method, params):
        self.sent.append({'method': method, 'params': copy.deepcopy(params)})
        if method == 'config/read': return {'config': {'model': self.default, 'model_provider': self.provider,
                                                      'approvals_reviewer': self.reviewer, 'approval_policy': self.policy}}
        if method == 'model/list': return {'data': copy.deepcopy(self.entries), 'nextCursor': None}
        if method == 'thread/start': return {'thread': {'id': 'synthetic-thread'}, 'model': self.thread_default or self.default,
                                            'modelProvider': self.thread_provider or self.provider,
                                            'approvalsReviewer': self.reviewer, 'approvalPolicy': self.policy}
        if method == 'turn/start':
            self.number += 1
            return {'turn': {'id': 'synthetic-turn-' + str(self.number)}}
        if method == 'turn/interrupt': return {}
        raise AssertionError('Unexpected RPC ' + method)

    def send(self, value): self.sent.append(copy.deepcopy(value))
    def close(self): self.closed = True


class ValidationTests(unittest.TestCase):
    def rejected(self, item, code=None):
        with self.assertRaises(Failure) as caught: validate_images([item])
        if code: self.assertEqual(caught.exception.code, code)
        self.assertNotIn(item.get('data_url', 'NOT_PRESENT'), str(caught.exception))

    def test_png_and_real_baseline_progressive_jpeg(self):
        for data, mime in ((png(), 'image/png'), (JPEG, 'image/jpeg'), (PROGRESSIVE_JPEG, 'image/jpeg')):
            with self.subTest(mime=mime, size=len(data)):
                descriptor, raw = validate_images([image(data, mime=mime)])[0]
                self.assertEqual((descriptor['width'], descriptor['height']), (2, 3)); self.assertEqual(raw, data)
                self.assertEqual(descriptor['image_id'], hashlib.sha256(data).hexdigest()); self.assertEqual(descriptor['bytes'], len(data))

    def test_png_adam7_and_indexed_formats(self):
        one = png(1, 1, pixels=b'\0\x20\xa0\x40', interlace=1)
        self.assertEqual(validate_images([image(one)])[0][0]['width'], 1)
        palette = png(1, 1, pixels=b'\0\0', color=3, depth=1, extra=chunk(b'PLTE', b'\0\0\0\xff\xff\xff'))
        self.assertEqual(validate_images([image(palette)])[0][0]['height'], 1)
        rgba = png(color=6, pixels=(b'\0' + b'\x20\xa0\x40\xff' * 2) * 3)
        self.assertEqual(validate_images([image(rgba)])[0][0]['width'], 2)
        gray16 = png(1, 1, color=0, depth=16, pixels=b'\0\xff\xff')
        self.assertEqual(validate_images([image(gray16)])[0][0]['height'], 1)

    def test_png_rejects_crc_truncation_trailing_animation_and_unknown_critical(self):
        bad = bytearray(png()); bad[30] ^= 1
        for data in (bytes(bad), png()[:-5], png() + b'trailing', png(extra=chunk(b'acTL', b'\0' * 8)),
                     png(extra=chunk(b'ABCD', b'')), png(pixels=b'\xff' + b'\0' * 20), png(pixels=b'\0'),
                     png(pixels=b'\0' * 1000000)):
            with self.subTest(size=len(data)): self.rejected(image(data))

    def test_jpeg_rejects_truncation_trailing_segments_and_missing_scan(self):
        for data in (JPEG[:-2], JPEG + b'payload', b'\xff\xd8\xff\xd9', JPEG[:200], b'\xff\xd8\xff\xe0\xff\xff'):
            with self.subTest(size=len(data)): self.rejected(image(data, mime='image/jpeg'))

    def test_dimension_bounds_prevent_small_compression_bombs(self):
        for width, height in ((0, 1), (1, 0), (4097, 1), (1, 4097), (100000, 100000)):
            with self.subTest(width=width, height=height): self.rejected(image(png(width, height, pixels=b'\0')), 'image_limit')
        large_jpeg = bytearray(JPEG); start = JPEG.index(b'\xff\xc0')
        large_jpeg[start + 7:start + 9] = struct.pack('>H', 4097)
        self.rejected(image(bytes(large_jpeg), mime='image/jpeg'), 'image_limit')

    def test_strict_base64_matching_mime_and_no_remote_path(self):
        item = image()
        for url in ('https://example.com/picture.png', 'file:///tmp/picture.png', '/tmp/picture.png',
                    item['data_url'] + '\n', item['data_url'] + '=', 'data:image/jpeg;base64,' + item['data_url'].split(',')[1],
                    'data:image/png;base64,!!!!', 'data:image/png;base64,', 'data:image/png;base64,雪'):
            with self.subTest(url=url[:30]): self.rejected({**item, 'data_url': url}, 'invalid_image')
        self.rejected(image(JPEG), 'invalid_image')
        self.rejected(image(png(), mime='image/jpeg'), 'invalid_image')
        self.rejected(image(mime='image/webp'), 'unsupported_image')

    def test_only_bounded_display_name_and_fields(self):
        for name in ('', 'a' * 161, '../secret', '/tmp/file', 'C:\\file', 'bad\nname', 'bad\x7fname'):
            self.rejected(image(name=name), 'invalid_image')
        for key in ('path', 'url', 'image_id', 'fileId'):
            self.rejected({**image(), key: '/private/secret'}, 'invalid_image')

    def test_count_and_decoded_size_limits(self):
        with self.assertRaises(Failure) as error: validate_images([image()] * 5)
        self.assertEqual(error.exception.code, 'image_limit')
        self.rejected(image(b'a' * (MAX_IMAGE_BYTES + 1)), 'image_limit')
        padded = png(extra=chunk(b'tEXt', b'x' * 270000))
        with self.assertRaises(Failure) as error: validate_images([image(padded)] * 4)
        self.assertEqual(error.exception.code, 'image_limit')

    def test_exact_one_mib_and_four_attachments_are_accepted(self):
        base = png(); exact = png(extra=chunk(b'tEXt', b'x' * (MAX_IMAGE_BYTES - len(base) - 12)))
        self.assertEqual(len(exact), MAX_IMAGE_BYTES); self.assertEqual(validate_images([image(exact)])[0][0]['bytes'], MAX_IMAGE_BYTES)
        self.assertEqual(len(validate_images([image()] * 4)), 4)
        self.assertEqual(validate_images([]), [])


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name).resolve(); self.sessions = []

    def tearDown(self):
        for session in self.sessions: session.close()
        self.tmp.cleanup()

    def ai(self, sid='default'):
        service = Service({'gateway_url': 'http://127.0.0.1:1', 'state_dir': str(self.root / sid)})
        service.call = Mock(return_value={'project': {'id': 'SYNTHETIC'}, 'file': {
            'path': 'projects/demo.scs', 'base_commit': 'a' * 40, 'sha256': 'b' * 64, 'content': 'R0 a b r=1k'}, 'geometry': {}})
        session = AiSession(service, FakeRpc, session_id=sid); self.sessions.append(session)
        return session

    def done(self, session):
        session._receive({'method': 'turn/completed', 'params': {'threadId': session.thread_id,
                          'turn': {'id': session.turn_id, 'status': 'completed'}}})

    def turns(self, session):
        return [x for x in session.rpc.sent if x.get('method') == 'turn/start'] if session.rpc else []

    def test_native_local_image_input_not_base64_prompt(self):
        session = self.ai(); upload = image(); receipt = session.turn('解释图', context(), 'image-turn-001', images=[upload])
        inputs = self.turns(session)[0]['params']['input']; self.assertEqual([v['type'] for v in inputs], ['text', 'localImage'])
        path = Path(inputs[1]['path']); self.assertEqual(path.read_bytes(), png())
        self.assertEqual(path.parent, session.scratch / 'images'); self.assertEqual(path.stem, receipt['images'][0]['image_id'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600); self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('data:image', inputs[0]['text']); self.assertNotIn(upload['data_url'].split(',')[1], json.dumps(receipt))
        self.assertEqual(receipt['prompt']['image_count'], 1)
        saved = (session.service.state / 'ai-session.json').read_text()
        for payload in (saved, json.dumps(session.history()), json.dumps(session.events)):
            self.assertNotIn(upload['data_url'], payload); self.assertNotIn(str(path), payload)
        restored = session.image(receipt['images'][0]['image_id']); self.assertEqual(restored['data_url'], upload['data_url'])

    def test_image_only_message_and_empty_rejected(self):
        session = self.ai(); session.turn('', context(), 'image-only-001', images=[image()])
        self.assertEqual(session.messages[0]['text'], ''); self.assertEqual(len(self.turns(session)), 1)
        other = self.ai('other')
        for uploads in (None, []):
            with self.assertRaises(Failure): other.turn('', context(), 'empty-turn-001', images=uploads)
        self.assertIsNone(other.rpc)

    def test_text_fingerprint_and_old_history_shape_are_unchanged(self):
        session = self.ai(); result = session.turn('old text', context(), 'text-turn-001', images=[])
        self.assertEqual(result['fingerprint'], digest(['old text', context()])); self.assertNotIn('images', result)
        self.assertNotIn('images', session.messages[0]); self.assertFalse((session.scratch / 'images').exists())
        self.done(session); result = session.turn('selected text', context(), 'text-turn-002', model='text-id')
        self.assertEqual(result['fingerprint'], digest(['selected text', context(), 'text-id']))

    def test_identical_key_returns_receipt_without_rpc_or_storage_replay(self):
        session = self.ai(); result = session.turn('x', context(), 'image-key-001', images=[image()]); before = len(session.rpc.sent)
        with patch.object(SessionImages, 'store', side_effect=AssertionError('NO REPLAY')):
            repeated = session.turn('x', context(), 'image-key-001', images=[image()])
        self.assertEqual(repeated, result); self.assertEqual(len(session.rpc.sent), before)

    def test_same_key_changed_image_name_order_and_bytes_rejected(self):
        session = self.ai(); uploads = [image(), image(JPEG, 'second.jpg', 'image/jpeg')]
        session.turn('x', context(), 'same-key-001', images=uploads); before = len(session.rpc.sent)
        for changed in ([image(name='renamed.png'), uploads[1]], list(reversed(uploads)),
                        [image(png(pixels=b'\0' * 21)), uploads[1]], [], [uploads[0]]):
            with self.subTest(count=len(changed)), self.assertRaises(Failure):
                session.turn('x', context(), 'same-key-001', images=changed)
        self.assertEqual(len(session.rpc.sent), before)

    def test_fresh_catalog_rejects_text_only_and_never_switches(self):
        session = self.ai(); session.connect(); session.rpc.default = 'text'
        session.catalog = {'models': [{'id': 'text-id', 'model': 'text', 'inputModalities': ['text', 'image']}],
                           'provider': 'fixture', 'default_model': 'text'}
        with self.assertRaises(Failure) as error: session.turn('x', context(), 'text-only-001', images=[image()])
        self.assertEqual(error.exception.code, 'model_image_unsupported'); self.assertEqual(session.state, 'idle')
        self.assertEqual(self.turns(session), []); self.assertFalse((session.scratch / 'images').exists())
        self.assertTrue(any(c['method'] == 'model/list' for c in session.rpc.sent))

    def test_image_catalog_failure_is_explicitly_rejected_before_reservation(self):
        for method, state in (('config/read', 'idle'), ('model/list', 'complete')):
            session = self.ai(method.replace('/', '-')); session.connect(); session.state = state
            original = session.rpc.call
            def failing(actual_method, params):
                if actual_method == method:
                    session.rpc.sent.append({'method': actual_method, 'params': copy.deepcopy(params)})
                    raise Failure('app_server_error', 'Catalog unavailable; Bearer PRIVATE_SECRET', 75,
                                  {'method': actual_method, 'rpc_code': -32600, 'config': 'PRIVATE_CONFIG'})
                return original(actual_method, params)
            key = 'catalog-failure-001'
            with patch.object(session.rpc, 'call', side_effect=failing):
                with self.assertRaises(Failure) as error:
                    session.turn('x', context(), key, images=[image()])
            record = error.exception.record()
            self.assertEqual(record['code'], 'image_preflight_rejected'); self.assertEqual(record['exit_code'], 75)
            self.assertEqual(record['details'], {'method': method, 'rpc_code': -32600, 'cause_code': 'app_server_error'})
            self.assertIn('Catalog unavailable', record['message']); self.assertNotIn('PRIVATE', json.dumps(record))
            self.assertEqual(session.state, state); self.assertEqual(session.turns, {}); self.assertEqual(session.messages, [])
            self.assertFalse((session.service.state / 'ai-turns' / (digest(key) + '.json')).exists())
            self.assertFalse(any(c['method'] in ('thread/start', 'turn/start') for c in session.rpc.sent))
            self.assertFalse((session.scratch / 'images').exists()); session.service.call.assert_not_called()

    def test_unexpected_image_catalog_exception_is_safely_classified(self):
        session = self.ai()
        with patch.object(session, 'models', side_effect=RuntimeError('PRIVATE_PAYLOAD')) as models:
            with self.assertRaises(Failure) as error:
                session.turn('x', context(), 'unexpected-preflight-001', images=[image()])
        models.assert_called_once_with(refresh=True)
        self.assertEqual(error.exception.code, 'image_preflight_rejected')
        self.assertEqual(error.exception.details['cause_code'], 'internal_error')
        self.assertIn('RuntimeError', str(error.exception)); self.assertNotIn('PRIVATE_PAYLOAD', str(error.exception))
        self.assertEqual(session.turns, {}); self.assertEqual(session.state, 'idle'); self.assertIsNone(session.rpc)

    def test_preflight_transport_suspension_is_preserved(self):
        session = self.ai(); session.connect()
        def disconnect(**kwargs):
            session._receive({'method': 'transport/disconnected', 'params': {'reason': 'synthetic disconnect'}})
            raise Failure('app_server_disconnected', 'Synthetic connection lost', 75)
        with patch.object(session, 'models', side_effect=disconnect):
            with self.assertRaises(Failure) as error:
                session.turn('x', context(), 'disconnect-preflight-001', images=[image()])
        self.assertEqual(error.exception.code, 'image_preflight_rejected')
        self.assertEqual(session.state, 'suspended'); self.assertEqual(session.turns, {}); self.assertEqual(self.turns(session), [])
        self.assertEqual(session.events[-1]['method'], 'transport/disconnected')

    def test_non_image_catalog_failure_keeps_original_code(self):
        session = self.ai()
        with patch.object(session, 'models', side_effect=Failure('model_catalog_unavailable', 'Synthetic catalog failure', 4)):
            with self.assertRaises(Failure) as error:
                session.turn('text', context(), 'text-catalog-failure-001', model='vision-id')
        self.assertEqual(error.exception.code, 'model_catalog_unavailable'); self.assertEqual(session.turns, {})

    def test_thread_and_turn_start_errors_are_not_preflight_rejections(self):
        for method in ('thread/start', 'turn/start'):
            session = self.ai(method.replace('/', '-')); session.connect(); original = session.rpc.call
            def failing(actual_method, params):
                if actual_method == method:
                    session.rpc.sent.append({'method': actual_method, 'params': copy.deepcopy(params)})
                    raise Failure('app_server_error', 'Synthetic later failure', 4, {'method': method, 'rpc_code': -32602})
                return original(actual_method, params)
            key = 'later-failure-001'
            with patch.object(session.rpc, 'call', side_effect=failing):
                with self.assertRaises(Failure) as error:
                    session.turn('x', context(), key, images=[image()])
            self.assertEqual(error.exception.code, 'app_server_error'); self.assertEqual(error.exception.details['method'], method)
            self.assertEqual(session.state, 'suspended'); self.assertEqual(session.turns[key]['state'], 'suspended')
            self.assertTrue((session.service.state / 'ai-turns' / (digest(key) + '.json')).exists())

    def test_concurrent_same_key_reservation_is_not_reported_as_unreserved(self):
        for location in ('memory', 'disk', 'changed-input'):
            session = self.ai(location); key = 'concurrent-preflight-001'
            descriptors = [value for value, _ in validate_images([image()])]
            receipt = {'key': key, 'fingerprint': digest(['ic.ai.turn.images.v1', 'x', context(), None, descriptors]), 'state': 'starting'}
            if location == 'changed-input': receipt['fingerprint'] = 'different'
            def concurrent(**kwargs):
                if location == 'disk':
                    path = session.service.state / 'ai-turns' / (digest(key) + '.json')
                    path.parent.mkdir(exist_ok=True); path.write_text(json.dumps(receipt))
                else:
                    session.turns[key] = copy.deepcopy(receipt)
                session.state = 'starting'
                raise Failure('model_catalog_unavailable', 'Synthetic catalog failure', 4)
            with patch.object(session, 'models', side_effect=concurrent):
                if location == 'changed-input':
                    with self.assertRaises(Failure) as error: session.turn('x', context(), key, images=[image()])
                    self.assertEqual(error.exception.code, 'conflict')
                else:
                    self.assertEqual(session.turn('x', context(), key, images=[image()]), receipt)
            self.assertEqual(session.state, 'starting'); self.assertIsNone(session.rpc)

    def test_explicit_image_model_over_text_default_and_no_silent_reuse(self):
        session = self.ai(); session.connect(); session.rpc.default = 'text'
        session.turn('x', context(), 'selected-image-001', model='vision-id', images=[image()])
        self.assertEqual(self.turns(session)[0]['params']['model'], 'vision'); self.done(session)
        with self.assertRaises(Failure) as error: session.turn('default', context(), 'default-text-001', images=[image()])
        self.assertEqual(error.exception.code, 'model_image_unsupported'); self.assertEqual(len(self.turns(session)), 1)

    def test_image_default_restores_after_explicit_text_turn(self):
        session = self.ai(); session.turn('text', context(), 'select-text-001', model='text-id'); self.done(session)
        session.turn('image', context(), 'restore-vision-001', images=[image()])
        self.assertEqual(self.turns(session)[-1]['params']['model'], 'vision')

    def test_missing_capability_unresolved_default_and_ambiguous_models_fail_closed(self):
        for case in ('missing', 'null', 'unknown_default', 'ambiguous'):
            session = self.ai(case); session.connect()
            if case == 'missing': del session.rpc.entries[0]['inputModalities']
            if case == 'null': session.rpc.entries[0]['inputModalities'] = None
            if case == 'unknown_default': session.rpc.default = None
            if case == 'ambiguous': session.rpc.entries.append({**session.rpc.entries[0], 'id': 'vision-alias'})
            with self.subTest(case=case), self.assertRaises(Failure) as error:
                session.turn('x', context(), 'unknown-image-001', images=[image()])
            self.assertEqual(error.exception.code, 'model_image_capability_unknown'); self.assertEqual(self.turns(session), [])

    def test_actual_thread_model_and_provider_rechecked_before_image_storage(self):
        for kind in ('model', 'provider'):
            session = self.ai(kind); session.connect()
            if kind == 'model': session.rpc.thread_default = 'text'
            else: session.rpc.thread_provider = 'changed'
            with self.assertRaises(Failure): session.turn('x', context(), 'changed-image-001', images=[image()])
            self.assertEqual(self.turns(session), []); self.assertFalse((session.scratch / 'images').exists())

    def test_source_policy_metadata_and_session_guards(self):
        for mode in ('dirty', 'hash_pending', 'source_changed', 'auto_review', 'never', 'metadata_policy', 'suspended'):
            session = self.ai(mode); ctx = context()
            if mode == 'dirty': ctx['file']['dirty'] = True
            if mode == 'hash_pending': ctx['file']['hashPending'] = True
            if mode == 'source_changed': session.service.call.return_value['file']['sha256'] = 'c' * 64
            if mode in ('auto_review', 'never'):
                session.connect()
                if mode == 'auto_review': session.rpc.reviewer = 'auto_review'
                else: session.rpc.policy = 'never'
            if mode == 'metadata_policy': session.metadata_policy_blocked = True
            if mode == 'suspended': session.state = 'suspended'
            with self.subTest(mode=mode), self.assertRaises(Failure): session.turn('x', ctx, 'guard-image-001', images=[image()])
            self.assertEqual(self.turns(session), []); self.assertFalse((session.scratch / 'images').exists())

    def test_cross_session_missing_arbitrary_path_and_symlinks_rejected(self):
        a = self.ai('a'); b = self.ai('b'); receipt = a.turn('x', context(), 'a-image-001', images=[image()]); ident = receipt['images'][0]['image_id']
        with self.assertRaises(Failure) as error: b.image(ident)
        self.assertEqual(error.exception.code, 'image_not_found')
        for bad in ('../secret', '/etc/passwd', ident.upper(), ident + '.png'):
            with self.assertRaises(Failure): a.image(bad)
        path = Path(self.turns(a)[0]['params']['input'][1]['path']); original = path.read_bytes()
        path.unlink(); outside = self.root / 'outside'; outside.write_bytes(original); path.symlink_to(outside)
        with self.assertRaises(Failure) as error: a.image(ident)
        self.assertEqual(error.exception.code, 'image_integrity_error')

    def test_storage_directory_symlink_and_existing_hash_corruption_rejected(self):
        session = self.ai(); outside = self.root / 'outside'; outside.mkdir(); (session.scratch / 'images').symlink_to(outside)
        with self.assertRaises(Failure): session.turn('x', context(), 'symlink-dir-001', images=[image()])
        self.assertEqual(list(outside.iterdir()), []); self.assertEqual(self.turns(session), [])
        other = self.ai('other'); receipt = other.turn('x', context(), 'good-file-001', images=[image()]); self.done(other)
        path = Path(self.turns(other)[0]['params']['input'][1]['path']); path.write_bytes(b'x' * path.stat().st_size)
        with self.assertRaises(Failure): other.image(receipt['images'][0]['image_id'])
        with self.assertRaises(Failure): other.turn('retry new key', context(), 'bad-file-001', images=[image()])
        self.assertEqual(len(self.turns(other)), 1)

    def test_restore_retains_thumbnails_but_does_not_resend_old_pixels(self):
        session = self.ai(); receipt = session.turn('', context(), 'restore-image-001', images=[image()]); self.done(session); session.close()
        restored = self.ai(); self.assertIsNone(restored.rpc)
        self.assertEqual(restored.image(receipt['images'][0]['image_id'])['data_url'], image()['data_url'])
        restored.turn('continue', context(), 'after-restore-001')
        inputs = self.turns(restored)[0]['params']['input']
        self.assertEqual(len(inputs), 1); self.assertIn('Historical image attachments are omitted', inputs[0]['text'])
        self.assertNotIn('data:image', inputs[0]['text'])

    def test_restore_suspended_upload_never_replays(self):
        session = self.ai(); session.turn('x', context(), 'interrupted-image-001', images=[image()]); session.close()
        restored = self.ai(); self.assertEqual(restored.state, 'suspended')
        repeated = restored.turn('x', context(), 'interrupted-image-001', images=[image()])
        self.assertEqual(repeated['state'], 'suspended'); self.assertIsNone(restored.rpc)
        with self.assertRaises(Failure): restored.turn('x', context(), 'new-after-error-001', images=[image()])

    def test_get_requires_history_membership_even_if_hash_file_exists(self):
        session = self.ai(); prepared = validate_images([image()]); SessionImages(session.scratch).store(prepared)
        with self.assertRaises(Failure): session.image(prepared[0][0]['image_id'])

    def test_same_content_can_be_independently_uploaded_in_two_sessions(self):
        a = self.ai('a'); b = self.ai('b')
        ra = a.turn('x', context(), 'a-key-001', images=[image()]); rb = b.turn('x', context(), 'b-key-001', images=[image()])
        self.assertEqual(ra['images'], rb['images'])
        self.assertNotEqual(self.turns(a)[0]['params']['input'][1]['path'], self.turns(b)[0]['params']['input'][1]['path'])
        self.assertEqual(a.image(ra['images'][0]['image_id'])['session_id'], 'a')
        self.assertEqual(b.image(rb['images'][0]['image_id'])['session_id'], 'b')

    def test_routes_accept_images_but_require_explicit_session_for_image_get(self):
        session = self.ai(); routes = object.__new__(AiRoutes); routes.sessions = Mock(); routes.sessions.get.return_value = session
        body = {'session_id': 'default', 'message': '', 'context': context(), 'idempotency_key': 'route-image-001', 'images': [image()]}
        receipt = routes.post('/api/ai/turn', body); ident = receipt['images'][0]['image_id']
        result = routes.get('/api/ai/image', {'session_id': ['default'], 'image_id': [ident]})
        self.assertEqual(result['data_url'], image()['data_url'])
        for query in ({'image_id': [ident]}, {'session_id': ['default'], 'image_id': [ident, ident]},
                      {'session_id': ['default'], 'image_id': [ident], 'path': ['/etc/passwd']}):
            with self.assertRaises(Failure): routes.get('/api/ai/image', query)
        with self.assertRaises(Failure): routes.post('/api/ai/turn', {**body, 'images': None})

    def test_bad_image_fails_without_rpc_or_receipt(self):
        session = self.ai()
        with self.assertRaises(Failure): session.turn('x', context(), 'invalid-image-001', images=[image(b'NOT_PNG')])
        self.assertIsNone(session.rpc); self.assertEqual(session.turns, {}); self.assertEqual(session.messages, [])

    def test_get_missing_or_corrupt_file_is_a_bounded_error(self):
        session = self.ai(); receipt = session.turn('x', context(), 'missing-image-001', images=[image()])
        path = Path(self.turns(session)[0]['params']['input'][1]['path']); path.unlink()
        with self.assertRaises(Failure) as error: session.image(receipt['images'][0]['image_id'])
        self.assertEqual(error.exception.code, 'image_not_found'); self.assertNotIn(str(path), str(error.exception))

    def test_upstream_turn_snapshot_cannot_echo_raw_images_to_events(self):
        session = self.ai(); upload = image(); session.turn('x', context(), 'echo-image-001', images=[upload])
        path = self.turns(session)[0]['params']['input'][1]['path']
        snapshot = {'threadId': session.thread_id, 'turn': {'id': session.turn_id, 'status': 'completed', 'items': [{
            'type': 'userMessage', 'id': 'synthetic-user', 'content': [
                {'type': 'text', 'text': 'x'}, {'type': 'image', 'url': upload['data_url']},
                {'type': 'localImage', 'path': path}, {'type': 'input_image', 'image_url': upload['data_url']}]}]}}
        session._receive({'method': 'turn/completed', 'params': snapshot})
        self.assertEqual(session.state, 'complete'); self.assertNotIn(upload['data_url'], json.dumps(session.events))
        self.assertNotIn(path, json.dumps(session.events)); self.assertEqual(snapshot['turn']['items'][0]['content'][1]['url'], upload['data_url'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
