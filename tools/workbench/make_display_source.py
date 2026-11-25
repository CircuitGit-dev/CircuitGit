#!/usr/bin/env python3
"""Read one installed Git proof reference and emit a display_source fragment.

This does not change Git, a run, a service or its configuration. The gateway still
checks original run provenance and actual old/new source bytes before verified=True.
"""
import argparse,hashlib,json,os,pathlib,re,subprocess

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--repo',type=pathlib.Path,required=True)
 p.add_argument('--proof-commit',required=True)
 p.add_argument('--proof-path',required=True)
 p.add_argument('--proof-sha256',required=True)
 p.add_argument('--output',type=pathlib.Path,required=True)
 a=p.parse_args()
 def fullcommit(v):
  if not isinstance(v,str) or not re.fullmatch(r'[0-9a-f]{40}',v):p.error('full40hex commit required')
  return v
 def relative(v):
  if not isinstance(v,str) or not v or v.startswith(('/','-')) or '\\' in v or ':' in v or any(ord(c)<32 for c in v) or any(s in ('','.','..','.git') for s in v.split('/')):p.error('safe relative path required')
  return v
 fullcommit(a.proof_commit);relative(a.proof_path)
 if not re.fullmatch(r'[0-9a-f]{64}',a.proof_sha256):p.error('proof SHA256 required')
 def git(*argv):
  return subprocess.check_output(['git','-c','core.hooksPath='+os.devnull,'-c','core.fsmonitor=false','-C',str(a.repo),*argv],env=dict(os.environ,GIT_NO_REPLACE_OBJECTS='1',GIT_OPTIONAL_LOCKS='0'))
 if git('cat-file','-t',a.proof_commit).strip()!=b'commit':p.error('proof reference is not a commit')
 rows=[r for r in git('ls-tree','-z',a.proof_commit,'--',':(literal)'+a.proof_path).split(b'\0') if r]
 if len(rows)!=1:p.error('proof must be one committed file')
 meta,name=rows[0].split(b'\t',1);mode,kind,oid=meta.decode().split()
 if kind!='blob' or mode not in ('100644','100755') or name.decode()!=a.proof_path:p.error('proof must be a regular Git blob')
 size=int(git('cat-file','-s',oid))
 if size>64*1024:p.error('proof exceeds64KiB')
 raw=git('cat-file','blob',oid)
 if len(raw)!=size or hashlib.sha256(raw).hexdigest()!=a.proof_sha256:p.error('proof bytes/hash mismatch')
 proof=json.loads(raw)
 if proof.get('schema')!='ic.exact-comment-suffix-proof.v1':p.error('unsupported proof schema')
 path=relative(proof['source_path']);base=fullcommit(proof['base']['commit']);view=fullcommit(proof['view']['commit'])
 if not re.fullmatch(r'[0-9a-f]{64}',proof['view']['sha256']):p.error('invalid view SHA256')
 display={'method':'exact-prefix-comment-append','path':path,'base_commit':base,'commit':view,'sha256':proof['view']['sha256'],'proof':{'commit':a.proof_commit,'path':a.proof_path,'sha256':a.proof_sha256}}
 with a.output.open('x') as f:json.dump({'display_source':display},f,indent=2);f.write('\n')
 print('Created unverified registration fragment; gateway validates the proof and source bytes against the actual run on read.')
if __name__=='__main__':main()
