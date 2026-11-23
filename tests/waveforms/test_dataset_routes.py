"""Ordinary waveform HTTP/CLI dispatch keeps exact native dataset identity."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
from urllib.parse import parse_qs

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
from waveforms import dispatch,WaveformError

DATASET='ds_'+'a'*32
SIGNAL='s_'+'b'*32


class DatasetRoutes(unittest.TestCase):
    def test_catalog_mapping_and_window_forward_the_same_explicit_dataset(self):
        for operation,method in [('signals','catalog'),('waveform-map','mapping'),('waveform','waveform')]:
            with self.subTest(operation=operation):
                service=Mock();args='dataset_id='+DATASET
                if operation=='waveform':args+='&signal_id='+SIGNAL+'&start=0&end=1000000&limit=1600'
                result=dispatch(service,'original-run',operation,parse_qs(args,keep_blank_values=True))
                expected={'dataset_id':DATASET}
                if operation=='waveform':expected.update(start='0',end='1000000',limit='1600')
                getattr(service,method).assert_called_once_with('original-run',*([SIGNAL] if operation=='waveform' else []),**expected)
                self.assertIs(result,getattr(service,method).return_value)
                self.assertNotIn('analysis',getattr(service,method).call_args.kwargs)

    def test_legacy_catalog_and_transient_window_keep_their_call_shape(self):
        service=Mock()
        dispatch(service,'original-run','signals',{})
        service.catalog.assert_called_once_with('original-run')
        dispatch(service,'original-run','waveform',{'signal_id':[SIGNAL]})
        service.waveform.assert_called_once_with('original-run',SIGNAL)

    def test_invalid_dataset_query_never_reads_an_artifact(self):
        for query in ['dataset_id=','dataset_id=../../data.json','dataset_id='+DATASET+'&dataset_id='+DATASET,
                      'dataset_id=ds_'+'a'*31,'dataset_id='+DATASET+'&path=source.json']:
            for operation in ('signals','waveform-map','waveform'):
                with self.subTest(operation=operation,query=query):
                    service=Mock()
                    with self.assertRaises(WaveformError):dispatch(service,'original-run',operation,parse_qs(query,keep_blank_values=True))
                    self.assertEqual(service.mock_calls,[])


if __name__=='__main__':unittest.main()
