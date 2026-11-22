"""Raw validation must run before SDK model parsing normalizes incoming JSON."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'apps/mcp'))
from strict_input import MAX_FRAME_BYTES, validate_frame


class StrictInputTests(unittest.TestCase):
    def test_valid_frames_pass_without_reserialization(self):
        for raw in [b'{"jsonrpc":"2.0", "id":1, "method":"ping"}\n',
                    b'{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n',
                    b'{"jsonrpc":"2.0","id":"1","result":{"action":"accept","content":{"approve":false}}}\n',
                    b'{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"failed","data":{}}}\n']:
            self.assertEqual(validate_frame(raw).encode(),raw)

    def test_exact_byte_limit(self):
        raw=b'{"jsonrpc":"2.0","id":1,"result":{}}'
        padded=raw+b' '*(MAX_FRAME_BYTES-len(raw))
        self.assertEqual(len(validate_frame(padded)),MAX_FRAME_BYTES)
        with self.assertRaises(ValueError):validate_frame(padded+b' ')

    def test_malformed_response_envelopes_rejected(self):
        cases=[{},[],{'jsonrpc':'2.0'}, {'jsonrpc':'2.0','id':None,'result':{}},
               {'jsonrpc':'2.0','id':1,'error':None},
               {'jsonrpc':'2.0','id':1,'error':{'code':True,'message':'bad'}},
               {'jsonrpc':'2.0','id':1,'error':{'code':1,'message':'bad','extra':True}},
               {'jsonrpc':'2.0','id':1,'error':{'code':1,'message':7}},
               {'jsonrpc':'2.0','id':1,'method':'ping','params':[]},
               {'jsonrpc':'2.0','id':1,'result':{},'method':'ping'}]
        for value in cases:
            with self.subTest(value=value),self.assertRaises(ValueError):validate_frame(json.dumps(value).encode())


if __name__=='__main__':unittest.main(verbosity=2)
