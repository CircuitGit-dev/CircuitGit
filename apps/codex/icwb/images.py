"""Session-owned PNG/JPEG attachments. No URL fetch, arbitrary path input, or third-party codec."""
import base64
import binascii
import hashlib
import os
from pathlib import Path
import re
import stat
import struct
import zlib

from .service import Failure, check

MAX_IMAGES = 4
MAX_IMAGE_BYTES = 1024 * 1024
MAX_SIDE = 4096
MAX_PIXELS = 16 * 1024 * 1024
MIME_EXTENSIONS = {'image/png': '.png', 'image/jpeg': '.jpg'}
DESCRIPTOR_KEYS = {'image_id', 'name', 'mime_type', 'bytes', 'width', 'height'}


def _valid(condition, message='Invalid image container'):
    check(condition, message, 'invalid_image', 4)


def _dimensions(width, height):
    check(0 < width <= MAX_SIDE and 0 < height <= MAX_SIDE and width * height <= MAX_PIXELS,
          'Image dimensions exceed 4096 pixels per side or 16 Mi pixels', 'image_limit', 4)
    return width, height


def _name(value):
    _valid(isinstance(value, str) and 1 <= len(value) <= 160 and not any(ord(c) < 32 or ord(c) == 127 for c in value)
           and '/' not in value and '\\' not in value, 'Image name must be a short display filename')
    return value


def _png(data):
    _valid(data.startswith(b'\x89PNG\r\n\x1a\n'), 'PNG signature does not match MIME type')
    pos, header, compressed, palette, idat_started, idat_ended = 8, None, [], None, False, False
    ended = False
    for index in range(4096):
        _valid(pos + 12 <= len(data), 'Truncated PNG chunk')
        size = struct.unpack_from('>I', data, pos)[0]; kind = data[pos + 4:pos + 8]
        _valid(re.fullmatch(b'[A-Za-z]{4}', kind) is not None and pos + 12 + size <= len(data), 'Invalid PNG chunk length/type')
        payload = data[pos + 8:pos + 8 + size]
        crc = struct.unpack_from('>I', data, pos + 8 + size)[0]
        _valid(zlib.crc32(kind + payload) & 0xffffffff == crc, 'PNG checksum mismatch')
        pos += size + 12
        if index == 0:
            _valid(kind == b'IHDR' and size == 13, 'PNG must begin with IHDR')
        if kind == b'IHDR':
            _valid(header is None and size == 13, 'Invalid duplicate PNG header')
            header = struct.unpack('>IIBBBBB', payload)
            width, height, depth, color, compression, filtering, interlace = header
            _dimensions(width, height)
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            _valid(color in depths and depth in depths[color] and compression == 0 and filtering == 0 and interlace in (0, 1),
                   'Unsupported or invalid PNG header')
        elif kind == b'PLTE':
            _valid(not idat_started and palette is None and 3 <= size <= 768 and size % 3 == 0, 'Invalid PNG palette')
            palette = size // 3
        elif kind == b'IDAT':
            _valid(not idat_ended, 'PNG image chunks must be consecutive')
            idat_started = True; compressed.append(payload)
        elif kind == b'IEND':
            _valid(size == 0 and pos == len(data) and idat_started, 'Invalid PNG end or trailing data')
            ended = True
            break
        else:
            check(kind not in (b'acTL', b'fcTL', b'fdAT'), 'Animated PNG is not supported', 'unsupported_image', 4)
            check(kind[0] & 32, 'Unsupported critical PNG chunk', 'unsupported_image', 4)
        if idat_started and kind != b'IDAT':
            idat_ended = True
    _valid(ended and header is not None, 'PNG is incomplete or has too many chunks')
    width, height, depth, color, _, _, interlace = header
    if color == 3:
        _valid(palette is not None and palette <= 2 ** depth, 'Indexed PNG requires a valid palette')
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if interlace == 0 else [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8),
                                                     (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    expected, filter_positions = 0, []
    for x, y, dx, dy in passes:
        pw = max(0, (width - x + dx - 1) // dx); ph = max(0, (height - y + dy - 1) // dy)
        if not pw or not ph:
            continue
        stride = 1 + (pw * channels * depth + 7) // 8
        filter_positions.extend(range(expected, expected + stride * ph, stride)); expected += stride * ph
    # Bound both inflated length and transient output; never inflate a compression bomb into one buffer.
    decoder = zlib.decompressobj(); pending = b''.join(compressed); total, filter_index = 0, 0
    try:
        while pending:
            block = decoder.decompress(pending, 65536); pending = decoder.unconsumed_tail
            _valid(total + len(block) <= expected and not decoder.unused_data, 'PNG inflated data exceeds its dimensions')
            while filter_index < len(filter_positions) and filter_positions[filter_index] < total + len(block):
                _valid(block[filter_positions[filter_index] - total] <= 4, 'Invalid PNG row filter')
                filter_index += 1
            total += len(block)
        _valid(decoder.eof and total == expected and filter_index == len(filter_positions), 'Truncated PNG image data')
    except zlib.error as error:
        raise Failure('invalid_image', 'Invalid PNG compressed data', 4) from error
    return width, height


def _jpeg(data):
    _valid(data.startswith(b'\xff\xd8'), 'JPEG signature does not match MIME type')
    pos, frame, scan, quantization, huffman = 2, None, False, False, False
    for _ in range(8192):
        _valid(pos < len(data) and data[pos] == 255, 'Invalid JPEG marker')
        while pos < len(data) and data[pos] == 255:
            pos += 1
        _valid(pos < len(data), 'Truncated JPEG marker')
        marker = data[pos]; pos += 1
        if marker == 0xd9:
            _valid(frame is not None and scan and quantization and huffman and pos == len(data), 'Invalid JPEG end or trailing data')
            return frame[0], frame[1]
        _valid(marker not in (0, 1, 0xd8) and not 0xd0 <= marker <= 0xd7 and pos + 2 <= len(data), 'Invalid JPEG segment')
        length = struct.unpack_from('>H', data, pos)[0]
        _valid(length >= 2 and pos + length <= len(data), 'Truncated JPEG segment')
        payload = data[pos + 2:pos + length]; pos += length
        if marker in (0xc0, 0xc2):
            _valid(frame is None and len(payload) >= 6, 'Invalid JPEG frame')
            precision, height, width, count = struct.unpack_from('>BHHB', payload)
            check(precision == 8, 'Only 8-bit JPEG is supported', 'unsupported_image', 4)
            _dimensions(width, height)
            _valid(count in (1, 3, 4) and len(payload) == 6 + 3 * count, 'Invalid JPEG components')
            ids = payload[6::3]
            _valid(len(set(ids)) == count and all(1 <= (v >> 4) <= 4 and 1 <= (v & 15) <= 4 for v in payload[7::3]),
                   'Invalid JPEG sampling')
            frame = width, height, count, set(ids), marker
        elif 0xc0 <= marker <= 0xcf and marker != 0xc4:
            raise Failure('unsupported_image', 'Only Huffman baseline/progressive JPEG is supported', 4)
        elif marker == 0xdb:
            offset = 0
            while offset < len(payload):
                spec = payload[offset]; offset += 1
                _valid(spec >> 4 in (0, 1) and (spec & 15) <= 3, 'Invalid JPEG quantization table')
                offset += 64 * (1 + (spec >> 4)); _valid(offset <= len(payload), 'Truncated JPEG quantization table')
            _valid(offset > 0); quantization = True
        elif marker == 0xc4:
            offset = 0
            while offset < len(payload):
                _valid(offset + 17 <= len(payload), 'Truncated JPEG Huffman table')
                spec = payload[offset]; counts = payload[offset + 1:offset + 17]
                _valid(spec >> 4 in (0, 1) and (spec & 15) <= 3 and 0 < sum(counts) <= 256, 'Invalid JPEG Huffman table')
                offset += 17 + sum(counts); _valid(offset <= len(payload), 'Truncated JPEG Huffman symbols')
            _valid(offset > 0); huffman = True
        elif marker == 0xdd:
            _valid(len(payload) == 2, 'Invalid JPEG restart interval')
        elif marker == 0xda:
            _valid(frame is not None and len(payload) >= 6, 'JPEG scan requires a frame')
            count = payload[0]
            _valid(1 <= count <= frame[2] and len(payload) == 4 + 2 * count
                   and len(set(payload[1:1 + 2 * count:2])) == count
                   and set(payload[1:1 + 2 * count:2]) <= frame[3], 'Invalid JPEG scan components')
            start, end, approximation = payload[-3:]
            _valid((start, end, approximation) == (0, 63, 0) if frame[4] == 0xc0 else
                   0 <= start <= end <= 63 and approximation >> 4 <= 13 and approximation & 15 <= 13, 'Invalid JPEG scan parameters')
            scan = True; entropy_start = pos
            while True:
                found = data.find(b'\xff', pos); _valid(found >= 0, 'JPEG has no end marker')
                nxt = found + 1
                while nxt < len(data) and data[nxt] == 255:
                    nxt += 1
                _valid(nxt < len(data), 'Truncated JPEG scan marker')
                if data[nxt] == 0 or 0xd0 <= data[nxt] <= 0xd7:
                    pos = nxt + 1
                    continue
                _valid(found > entropy_start, 'Empty JPEG scan')
                pos = found
                break
        elif not (0xe0 <= marker <= 0xef or marker == 0xfe):
            raise Failure('unsupported_image', 'Unsupported JPEG segment', 4)
    raise Failure('invalid_image', 'JPEG is incomplete or has too many segments', 4)


def validate_images(images):
    if images is None:
        return []
    _valid(isinstance(images, list), 'Images must be an array')
    check(len(images) <= MAX_IMAGES, 'At most four images may be sent', 'image_limit', 4)
    prepared, total = [], 0
    for item in images:
        _valid(isinstance(item, dict) and set(item) == {'name', 'mime_type', 'data_url'}, 'Invalid image fields')
        name = _name(item['name']); mime = item['mime_type']
        check(isinstance(mime, str) and mime in MIME_EXTENSIONS, 'Only PNG and JPEG images are supported', 'unsupported_image', 4)
        url = item['data_url']; prefix = 'data:' + mime + ';base64,'
        _valid(isinstance(url, str) and url.startswith(prefix), 'An inline data URL with matching MIME is required')
        encoded = url[len(prefix):]
        check(len(encoded) <= 4 * ((MAX_IMAGE_BYTES + 2) // 3), 'Image exceeds one MiB', 'image_limit', 4)
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise Failure('invalid_image', 'Invalid image base64', 4) from error
        _valid(data and base64.b64encode(data).decode('ascii') == encoded, 'Image base64 must be canonical')
        total += len(data)
        check(total <= MAX_IMAGE_BYTES, 'Images exceed one MiB in total', 'image_limit', 4)
        width, height = _png(data) if mime == 'image/png' else _jpeg(data)
        descriptor = {'image_id': hashlib.sha256(data).hexdigest(), 'name': name, 'mime_type': mime,
                      'bytes': len(data), 'width': width, 'height': height}
        prepared.append((descriptor, data))
    return prepared


def validate_descriptor(value):
    _valid(isinstance(value, dict) and set(value) == DESCRIPTOR_KEYS, 'Invalid saved image descriptor')
    _valid(isinstance(value['image_id'], str) and re.fullmatch(r'[0-9a-f]{64}', value['image_id']) is not None, 'Invalid image ID')
    _name(value['name'])
    _valid(isinstance(value['mime_type'], str) and value['mime_type'] in MIME_EXTENSIONS, 'Invalid saved image MIME')
    _valid(type(value['bytes']) is int and 0 < value['bytes'] <= MAX_IMAGE_BYTES, 'Invalid saved image length')
    _valid(type(value['width']) is int and type(value['height']) is int, 'Invalid saved image dimensions')
    _dimensions(value['width'], value['height'])
    return value


def require_image_model(catalog, model_slug, model_id=None):
    matches = [m for m in catalog.get('models', []) if m.get('model') == model_slug
               and (model_id is None or m.get('id') == model_id)]
    check(isinstance(model_slug, str) and model_slug and len(matches) == 1,
          'Image capability for the effective model is unknown', 'model_image_capability_unknown', 4)
    modalities = matches[0].get('inputModalities')
    check(isinstance(modalities, list) and all(isinstance(v, str) for v in modalities),
          'Model did not explicitly report image capabilities', 'model_image_capability_unknown', 4)
    check('image' in modalities, 'The selected model does not support image input', 'model_image_unsupported', 4)


def omit_native_image_payloads(value):
    """Turn snapshots can echo user inputs; keep image bytes/paths out of ordinary event history."""
    if isinstance(value, dict):
        if value.get('type') in ('image', 'localImage', 'input_image'):
            return {'type': value['type'], 'omitted': True}
        return {key: omit_native_image_payloads(item) for key, item in value.items()}
    if isinstance(value, list):
        return [omit_native_image_payloads(item) for item in value]
    return value


class SessionImages:
    def __init__(self, scratch):
        self.directory = Path(scratch) / 'images'

    @staticmethod
    def _supports_dir_fd():
        return (
            os.name != 'nt'
            and hasattr(os, 'O_DIRECTORY')
            and hasattr(os, 'O_NOFOLLOW')
            and os.open in os.supports_dir_fd
        )

    def _directory_fd(self, create=False):
        if create:
            self.directory.mkdir(mode=0o700, exist_ok=True)
        if not self._supports_dir_fd():
            if not self.directory.exists() and not self.directory.is_symlink():
                raise FileNotFoundError(str(self.directory))
            if self.directory.is_symlink() or not self.directory.is_dir():
                raise OSError('Private image directory is not a regular local directory')
            return None
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if create:
            os.fchmod(fd, 0o700)
        return fd

    def _filename(self, descriptor):
        validate_descriptor(descriptor)
        return descriptor['image_id'] + MIME_EXTENSIONS[descriptor['mime_type']]

    def _safe_file_path(self, filename):
        target = self.directory / filename
        if target.is_symlink():
            raise OSError('Refusing to follow image symlink')
        resolved_dir = self.directory.resolve()
        if target.resolve(strict=False).parent != resolved_dir:
            raise OSError('Image path escapes private directory')
        return target

    def _read(self, directory_fd, descriptor):
        filename = self._filename(descriptor)
        if directory_fd is not None:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        else:
            from ic_gateway.platform_compat import open_nofollow
            fd = open_nofollow(self._safe_file_path(filename), os.O_RDONLY)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == descriptor['bytes'],
                  'Saved image integrity check failed', 'image_integrity_error', 4)
            data = stream.read(MAX_IMAGE_BYTES + 1)
        check(len(data) == descriptor['bytes'] and hashlib.sha256(data).hexdigest() == descriptor['image_id'],
              'Saved image integrity check failed', 'image_integrity_error', 4)
        return data

    def store(self, prepared):
        if not prepared:
            return []
        directory_fd = None
        try:
            directory_fd = self._directory_fd(create=True)
            inputs = []
            for descriptor, data in prepared:
                filename = self._filename(descriptor)
                check(len(data) == descriptor['bytes'] and hashlib.sha256(data).hexdigest() == descriptor['image_id'],
                      'Prepared image integrity check failed', 'image_integrity_error', 4)
                try:
                    if directory_fd is not None:
                        fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
                    else:
                        from ic_gateway.platform_compat import open_nofollow
                        fd = open_nofollow(self._safe_file_path(filename), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    self._read(directory_fd, descriptor)
                else:
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(data); stream.flush(); os.fsync(stream.fileno())
                inputs.append({'type': 'localImage', 'path': str(self.directory.absolute() / filename)})
            return inputs
        except OSError as error:
            raise Failure('image_integrity_error', 'Private image storage is unavailable', 4) from error
        finally:
            if directory_fd is not None:
                os.close(directory_fd)

    def get(self, image_id, messages, session_id):
        _valid(isinstance(image_id, str) and re.fullmatch(r'[0-9a-f]{64}', image_id) is not None, 'Invalid image ID')
        descriptor = None
        for message in reversed(messages):
            images = message.get('images')
            if message.get('role') != 'user' or not isinstance(images, list) or len(images) > MAX_IMAGES:
                continue
            descriptor = next((image for image in images if isinstance(image, dict) and image.get('image_id') == image_id), None)
            if descriptor is not None:
                break
        check(descriptor is not None, 'Image is not in this session history', 'image_not_found', 4)
        descriptor = validate_descriptor(descriptor)
        directory_fd = None
        try:
            directory_fd = self._directory_fd()
            data = self._read(directory_fd, descriptor)
        except FileNotFoundError as error:
            raise Failure('image_not_found', 'Saved image is unavailable', 4) from error
        except OSError as error:
            raise Failure('image_integrity_error', 'Private image storage is unavailable', 4) from error
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
        return {'session_id': session_id, **descriptor,
                'data_url': 'data:' + descriptor['mime_type'] + ';base64,' + base64.b64encode(data).decode('ascii')}
