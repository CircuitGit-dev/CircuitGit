"""Raw stdio validation before the SDK's typed JSON decoder can discard data.

This is an input gate, not a JSON-RPC dispatcher: valid lines pass unchanged to
the official stdio transport. It neither assigns IDs nor routes responses. A
rejected frame is discarded whole and reported without logging its contents.
"""
import json
import anyio

MAX_FRAME_BYTES = 2 * 1024 * 1024


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('duplicate_json_key')
        value[key] = item
    return value


def _constant(_):
    raise ValueError('nonfinite_json')


def validate_frame(raw):
    """Validate the original bytes and envelope; return the unchanged UTF-8 text."""
    if len(raw) > MAX_FRAME_BYTES:
        raise ValueError('frame_too_large')
    text = raw.decode('utf-8', errors='strict')
    value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
    # Exponent overflow (1e999) is accepted by json.loads as inf. Also reject
    # escaped lone surrogates before any downstream parser replaces them.
    json.dumps(value, allow_nan=False, ensure_ascii=False).encode('utf-8')
    if not isinstance(value, dict) or value.get('jsonrpc') != '2.0':
        raise ValueError('invalid_rpc_object')
    if 'id' in value and type(value['id']) not in (str, int):
        raise ValueError('invalid_rpc_id')
    if 'method' in value:
        if (set(value) - {'jsonrpc', 'id', 'method', 'params'}
                or not isinstance(value['method'], str) or not value['method']
                or ('params' in value and not isinstance(value['params'], dict))):
            raise ValueError('invalid_request_envelope')
    else:
        if ('id' not in value or set(value) - {'jsonrpc', 'id', 'result', 'error'}
                or ('result' in value) == ('error' in value)):
            raise ValueError('invalid_response_envelope')
        if 'error' in value:
            error = value['error']
            if (not isinstance(error, dict) or set(error) - {'code', 'message', 'data'}
                    or type(error.get('code')) is not int or not isinstance(error.get('message'), str)):
                raise ValueError('invalid_error_envelope')
    return text


class StrictInput:
    """Async line iterable accepted by stdio_server's public stdin parameter.

    The wrapped file is binary so byte limits and UTF-8 errors precede decoding.
    Read/drain bounded chunks; never pass a fragment of an oversized message to
    the SDK. The callback invalidates active review without trusting a bad ID.
    """
    def __init__(self, stream, reject):
        self.stream, self.reject = stream, reject

    async def _readline(self):
        # AsyncFile.readline has no size argument in the pinned AnyIO release.
        # Use its public thread helper around binary readline(size), preserving
        # a real byte limit without blocking the SDK event loop.
        return await anyio.to_thread.run_sync(self.stream.readline, MAX_FRAME_BYTES + 1)

    async def __aiter__(self):
        while True:
            raw = await self._readline()
            if not raw:
                return
            if len(raw) > MAX_FRAME_BYTES:
                self.reject('frame_too_large')
                while raw and not raw.endswith(b'\n'):
                    raw = await self._readline()
                continue
            try:
                text = validate_frame(raw)
            except (ValueError, RecursionError, UnicodeError):
                # No rejected payload, untrusted ID, project text or credentials
                # are copied to logs or manufactured into a response.
                self.reject('invalid_raw_json_or_envelope')
                continue
            yield text
