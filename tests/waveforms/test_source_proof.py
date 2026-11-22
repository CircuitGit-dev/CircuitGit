"""Portable regression for immutable, data-driven historical source proof."""
import copy,hashlib,json,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/workbench'))
from waveforms import WaveformService,WaveformError
from geometry import Geometry
from types import SimpleNamespace
sha=lambda b:hashlib.sha256(b).hexdigest()
class ProofTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();subprocess.run(['git','init','-q',str(self.root)],check=True)
  self.path='projects/example/circuit.scs';self.old=b'simulator lang=spectre\nR0 (a b) resistor r=3k\n';self.suffix=b'\n// reviewed note for this separate project\n';self.new=self.old+self.suffix
  self.base=self.commit(self.path,self.old);self.view=self.commit(self.path,self.new);self.proof={'schema':'ic.exact-comment-suffix-proof.v1','source_path':self.path,'base':{'commit':self.base,'sha256':sha(self.old),'bytes':len(self.old)},'view':{'commit':self.view,'sha256':sha(self.new),'bytes':len(self.new)},'suffix':{'utf8':self.suffix.decode(),'bytes':len(self.suffix),'sha256':sha(self.suffix)}}
  self.proofpath='validation/proof.json';self.raw=json.dumps(self.proof).encode();self.proofcommit=self.commit(self.proofpath,self.raw)
  self.identity={'run_id':'synthetic-run','source_commit':self.base,'effective_config_sha256':'a'*64,'raw_signature':'b'*64,'source_hashes':{self.path:sha(self.old)},'signals':[]}
  self.mapping={'schema':'ic.waveform-map.v1',**{k:self.identity[k]for k in ('run_id','source_commit','effective_config_sha256','raw_signature')},'source':{'kind':'canonical','path':self.path,'sha256':sha(self.old)},'geometry':{'bundle_commit':self.proofcommit,'manifest_sha256':'c'*64,'entry_id':'TOP'},'objects':[],'display_source':{'method':'exact-prefix-comment-append','path':self.path,'base_commit':self.base,'commit':self.view,'sha256':sha(self.new),'proof':{'commit':self.proofcommit,'path':self.proofpath,'sha256':sha(self.raw)}}}
  self.reader=Geometry(SimpleNamespace(root=self.root)).blob
 def tearDown(self):self.tmp.cleanup()
 def commit(self,path,data):
  f=self.root/path;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(data);subprocess.run(['git','-C',str(self.root),'add',path],check=True)
  subprocess.run(['git','-C',str(self.root),'-c','user.name=Proof Test','-c','user.email=proof@invalid','commit','-qm','fixture'],check=True)
  return subprocess.check_output(['git','-C',str(self.root),'rev-parse','HEAD'],text=True).strip()
 def evaluate(self):
  f=self.root/'map.json';f.write_text(json.dumps(self.mapping));s=WaveformService(None,{'synthetic-run':str(f)},source_reader=self.reader);s.catalog=lambda rid:self.identity;return s.mapping('synthetic-run')
 def test_actual_git_proof_and_hashes(self):
  r=self.evaluate();self.assertTrue(r['display_source']['verified']);self.assertEqual(r['display_source']['proof_sha256'],sha(self.raw));self.assertEqual(r['source']['sha256'],sha(self.old));self.assertEqual(r['display_source']['suffix_bytes'],len(self.suffix))
 def test_unreviewed_third_comment_rejected(self):
  new=self.new+b'// new unreviewed\n';self.mapping['display_source'].update(commit=self.commit(self.path,new),sha256=sha(new))
  with self.assertRaises(WaveformError):self.evaluate()
 def test_client_verdict_cannot_replace_proof(self):
  self.mapping['display_source'].pop('proof');self.mapping['display_source']['verified']=True
  with self.assertRaises(WaveformError):self.evaluate()
 def test_tampered_proof_hash_rejected(self):
  self.mapping['display_source']['proof']['sha256']='0'*64
  with self.assertRaises(WaveformError):self.evaluate()
 def test_symbolic_ref_rejected(self):
  self.mapping['display_source']['proof']['commit']='HEAD'
  with self.assertRaises(WaveformError):self.evaluate()
 def test_electrical_change_rejected(self):
  new=self.new.replace(b'3k',b'4k');self.mapping['display_source'].update(commit=self.commit(self.path,new),sha256=sha(new))
  with self.assertRaises(WaveformError):self.evaluate()
if __name__=='__main__':unittest.main()
