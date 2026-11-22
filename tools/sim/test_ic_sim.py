"""Exercises real shell/control flow with synthetic files; never calls Spectre/SSH."""
import json, os, shutil, subprocess, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
import ic_sim as m

class RunnerTests(unittest.TestCase):
    def setUp(self):
        parent=m.HERE/'test-scratch';parent.mkdir(exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=parent);self.root=Path(self.tmp.name)
        self.site={'remote_runs_root':str(self.root/'ic_on_github_runs'),'cadence_cshrc':str(self.root/'setup.csh'),'spectre_bin':str(self.root/'fake-spectre'),'external_files':{}}
        Path(self.site['cadence_cshrc']).write_text('# synthetic setup\n')
    def tearDown(self):self.tmp.cleanup()
    def bundle(self,text='simulator lang=spectre\n'):
        f=self.root/'input.scs';f.write_text(text)
        b={'schema':'ic.sim.bundle.v1','test_id':'fixture','source_root':'.','entrypoint':'netlist/input.scs','files':[{'source':'input.scs','destination':'netlist/input.scs','sha256':m.sha(f.read_bytes())}]}
        p=self.root/'bundle.json';m.write(p,b);return p
    def test_prepare_no_network(self):
        with patch.object(m,'ssh',side_effect=AssertionError('network attempted')):
            _,payload,proof=m.prepare(self.bundle(),self.site)
        self.assertIn('netlist/input.scs',payload);self.assertEqual(proof['files'][0]['source_sha256'],proof['files'][0]['staged_sha256'])
    def test_hash_mismatch(self):
        p=self.bundle();(self.root/'input.scs').write_text('changed')
        with self.assertRaisesRegex(ValueError,'hash mismatch'):m.prepare(p,self.site)
    def test_missing_include(self):
        with self.assertRaisesRegex(ValueError,'Unstaged include'):m.prepare(self.bundle('include "missing.scs"\n'),self.site)
    def test_unmapped_absolute(self):
        with self.assertRaisesRegex(ValueError,'Unmapped absolute'):m.prepare(self.bundle('include "/unreviewed/model"\n'),self.site)
    def test_external_alias(self):
        self.site['external_files']={'PDK':'/server/PDK+v1/model.scs'}
        _,p,_=m.prepare(self.bundle('include "@EXTERNAL_PDK@" section=tt\n'),self.site)
        self.assertIn(b'/server/PDK+v1/model.scs',p['netlist/input.scs'])
    def test_path_escape(self):
        for p in ['../escape','/absolute','a/../../escape','x;pwd']:
            with self.assertRaises(ValueError):m.relpath(p)
    def stage(self,name='run'):
        remote=str(Path(self.site['remote_runs_root'])/name)
        result=subprocess.run(['/bin/sh','-c',m.stage_command(self.site,remote)],input=m.archive({'a.txt':b'fixture'}),capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr);return Path(remote)
    def test_stage_atomic_and_tar_failure(self):
        d=self.stage();self.assertEqual((d/'state').read_text().strip(),'staged')
        p=subprocess.run(['/bin/sh','-c',m.stage_command(self.site,str(d))],input=b'',capture_output=True);self.assertEqual(p.returncode,75)
        bad=Path(self.site['remote_runs_root'])/'bad'
        p=subprocess.run(['/bin/sh','-c',m.stage_command(self.site,str(bad))],input=b'bad archive',capture_output=True)
        self.assertEqual(p.returncode,71);self.assertEqual((bad/'state').read_text().strip(),'staging_failed')
    @unittest.skipUnless(Path('/bin/csh').exists(),'local csh unavailable; real server preflight tested separately')
    def test_job_success_failure_and_missing_footer(self):
        for n,(rc,footer,expected) in enumerate([(0,True,'simulator_complete_pending_measurements'),(9,True,'simulator_failed'),(0,False,'simulator_failed')]):
            fake=Path(self.site['spectre_bin']);fake.write_text('#!/bin/sh\n'+('echo "spectre completes with 0 errors, 0 warnings, and 0 notices." > ../psf/spectre.out\n' if footer else '')+f'exit {rc}\n');fake.chmod(0o700)
            d=self.root/f'job{n}';d.mkdir();(d/'netlist').mkdir();(d/'netlist/input.scs').write_text('synthetic\n')
            files=m.scripts(self.site,'netlist/input.scs')
            for name,raw in files.items():(d/name).write_bytes(raw)
            (d/'payload.sha256').write_text(m.sha((d/'netlist/input.scs').read_bytes())+'  netlist/input.scs\n')
            p=subprocess.run(['/bin/sh',str(d/'job.sh')],capture_output=True)
            self.assertEqual((d/'state').read_text().strip(),expected,p.stderr);self.assertEqual(int((d/'exit_code').read_text()),rc)
    def test_job_hash_and_setup_errors_terminal(self):
        for n,bad_hash in enumerate([True,False]):
            d=self.root/f'failure{n}';d.mkdir();(d/'netlist').mkdir();(d/'netlist/input.scs').write_text('fixture')
            for name,raw in m.scripts(self.site,'netlist/input.scs').items():(d/name).write_bytes(raw)
            (d/'payload.sha256').write_text(('0'*64 if bad_hash else m.sha(b'fixture'))+'  netlist/input.scs\n')
            if not bad_hash:(d/'psf').write_text('blocks mkdir')
            p=subprocess.run(['/bin/sh',str(d/'job.sh')],capture_output=True)
            self.assertEqual(p.returncode,71 if bad_hash else 70);self.assertEqual((d/'state').read_text().strip(),'input_hash_failure' if bad_hash else 'job_setup_failed')
    def test_single_launch_claim(self):
        d=self.root/'launch';d.mkdir();(d/'job.sh').write_text('#!/bin/sh\ncd "$(dirname "$0")"\nprintf x >> count\n')
        one=subprocess.run(['/bin/sh','-c',m.launch_command(str(d))],capture_output=True)
        two=subprocess.run(['/bin/sh','-c',m.launch_command(str(d))],capture_output=True)
        for _ in range(20):
            if (d/'count').exists():break
            time.sleep(.02)
        self.assertEqual(one.returncode,0);self.assertEqual(two.returncode,75);self.assertEqual((d/'count').read_text(),'x')
    def test_transport_command_single_line_stdin_preserved(self):
        import base64, shlex
        data=b'tar bytes';script="printf 'line1\\n'\nprintf 'line2\\n'\n"
        with patch.object(m.subprocess,'run') as run:
            m.ssh({'ssh_target':'cadence-server'},script,data=data)
        argv=run.call_args.args[0];self.assertNotIn('\n',argv[-1]);self.assertEqual(run.call_args.kwargs['input'],data)
        outer=shlex.split(argv[-1]);p=subprocess.run(outer,capture_output=True)
        self.assertEqual(p.stdout,b'line1\nline2\n')
    def test_profiles_and_external_hash_interface(self):
        self.assertEqual(m.simulator_config({})['args'],['-64'])
        self.assertIn('+mt=2',m.simulator_config({'simulator':{'profile':'nov6-aps2'}})['args'])
        self.assertEqual(m.simulator_config({'simulator':{'args':['-64','+mt=4']}})['args'],['-64','+mt=4'])
        self.site['external_files']={'ULVT':'/server/ulvt.scs'};h='a'*64;b={'external_sha256':{'ULVT':h}}
        self.assertEqual(m.check_external(b,self.site,{'dependency_sha256':{'ULVT':h}}),{'ULVT':h})
        with self.assertRaisesRegex(ValueError,'hash mismatch'):m.check_external(b,self.site,{'dependency_sha256':{'ULVT':'b'*64}})
        b['external_dependencies']=[{'alias':'ULVT','sha256':'c'*64}]
        with self.assertRaisesRegex(ValueError,'Conflicting'):m.external_pins(b)

if __name__=='__main__':unittest.main(verbosity=2)
