"""Actual tar collection fixtures with transport seams only; no SSH or solver."""
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import runner


COMMIT='a'*40


def archive(files,extra=()):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w:gz') as stream:
        for name,raw in files.items():
            member=tarfile.TarInfo(name);member.size=len(raw)
            stream.addfile(member,io.BytesIO(raw))
        for member in extra:stream.addfile(member)
    return output.getvalue()


class NativeCollectionTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name).resolve()
        self.site={'schema':'ic.sim.site.v1','ssh_target':'synthetic-only',
            'remote_runs_root':'/synthetic/ic_on_github_runs','cadence_cshrc':'/synthetic/setup.csh',
            'spectre_bin':'/synthetic/spectre','expected_host':'synthetic-only',
            'expected_user':'fixture','external_files':{}}
        self.runner=runner.Runner(self.root/'runs',self.site)
        self.counter=0;self.scripts=[];self.remote_state='simulator_complete_pending_measurements'
        self.blob=b''
        self.ssh=patch.object(runner.core,'ssh',side_effect=self.remote)
        self.transfer=patch.object(runner.subprocess,'run',side_effect=self.download)
        self.ssh_mock=self.ssh.start();self.addCleanup(self.ssh.stop)
        self.transfer_mock=self.transfer.start();self.addCleanup(self.transfer.stop)

    def remote(self,site,script,**kwargs):
        self.assertEqual(site,self.site)
        if "printf 'STATE '" in script:
            code=0 if self.remote_state=='simulator_complete_pending_measurements' else 1
            raw=f'STATE {self.remote_state}\nEXIT {code}\nALIVE no\n'.encode()
        else:
            self.assertIn('tar czf exports/full-results.tar.gz.part',script)
            self.scripts.append(script)
            raw=(hashlib.sha256(self.blob).hexdigest()+'  exports/full-results.tar.gz\n'+str(len(self.blob))+'\n').encode()
        return subprocess.CompletedProcess([],0,raw,b'')

    def download(self,argv,**kwargs):
        self.assertEqual(argv[:6],['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','synthetic-only'])
        kwargs['stdout'].write(self.blob)
        return subprocess.CompletedProcess(argv,0,b'',b'')

    def record(self,*,declared=None,headers=False):
        self.counter+=1;rid='synthetic-collection-'+str(self.counter)
        plan={'configuration':{'fixture':True},'provenance':{'files':[]},'external_sha256':{}}
        if declared is not None:plan['native_analyses']=declared
        if headers:plan['veriloga_header_staging_sha256']='b'*64
        record={'schema':'ic.sim.run.v2','run_id':rid,'job_id':rid,'state':'submitted','synthetic':True,
            'source_commit':COMMIT,'plan':plan,'collection':None,'publication':None,
            'ssh_target':self.site['ssh_target'],'remote_directory':self.site['remote_runs_root']+'/'+rid,
            'execution_site':self.site,'execution_site_sha256':runner.record_digest(self.site),
            'execution_context':None,'execution_context_sha256':None}
        self.runner.save(record)
        return rid

    def content(self,path):
        return {path:b'Original synthetic native artifact; numeric validity is not asserted.\n',
                './psf/spectre.out':b'spectre completes with 0 errors, 0 warnings.\n'}

    def assert_not_promoted(self,rid):
        folder=self.runner.path(rid)
        self.assertFalse((folder/'full-results.tar.gz').exists())
        self.assertFalse((folder/'full-results.tar.part').exists())
        self.assertFalse((folder/'archive-files.json').exists())
        saved=self.runner.read(rid)
        self.assertIsNone(saved['collection']);self.assertNotEqual(saved.get('collection_phase'),'complete')

    def test_pure_ac_and_dc_native_archives_collect_without_transient_and_without_scientific_pass(self):
        for kind in ('ac','dc'):
            with self.subTest(kind=kind):
                rid=self.record(declared=[{'name':'characterize','kind':kind}])
                self.blob=archive(self.content('./psf/characterize.'+kind))
                result=self.runner.collect(rid)
                self.assertEqual(result['collection_phase'],'complete')
                self.assertTrue(result['collection']['summary']['execution_success'])
                self.assertFalse(result['collection']['summary']['scientific_acceptance'])
                self.assertEqual(Path(result['collection']['archive']).read_bytes(),self.blob)
                inventory=json.loads((self.runner.path(rid)/'archive-files.json').read_text())
                self.assertTrue(any(row['path']=='./psf/characterize.'+kind for row in inventory))

    def test_legacy_native_suffixes_and_known_dcop_name_work_but_arbitrary_info_does_not(self):
        for path in ('./psf/ac1.ac','psf/dc1.dc','./psf/device.dcop','./psf/dcOpInfo.info','./psf/tran1.tran'):
            with self.subTest(path=path):
                rid=self.record();self.blob=archive(self.content(path))
                self.assertEqual(self.runner.collect(rid)['collection_phase'],'complete')
        for path in ('./psf/model.info','./psf/tran_fake.info','./psf/ac1.ac.log','./other/ac1.ac'):
            with self.subTest(path=path):
                rid=self.record();self.blob=archive(self.content(path))
                with self.assertRaisesRegex(ValueError,'no supported native'):self.runner.collect(rid)
                self.assert_not_promoted(rid)

    def test_declared_analysis_names_cannot_be_replaced_with_unrelated_native_artifacts(self):
        rid=self.record(declared=[{'name':'expected','kind':'ac'}])
        self.blob=archive(self.content('./psf/different.ac'))
        with self.assertRaisesRegex(ValueError,'declared native'):self.runner.collect(rid)
        self.assert_not_promoted(rid)

    def test_every_declared_analysis_requires_a_nonempty_native_artifact(self):
        declarations=[{'name':'gain','kind':'ac'},{'name':'bias','kind':'dc'}]
        for extra in ({},{'./psf/bias.dc':b''}):
            with self.subTest(extra=extra):
                rid=self.record(declared=declarations)
                self.blob=archive({**self.content('./psf/gain.ac'),**extra})
                with self.assertRaisesRegex(ValueError,'declared native'):self.runner.collect(rid)
                self.assert_not_promoted(rid)
        rid=self.record(declared=declarations)
        self.blob=archive({**self.content('./psf/gain.ac'),'./psf/bias.dc':b'Synthetic DC native bytes'})
        self.assertEqual(self.runner.collect(rid)['collection_phase'],'complete')

    def test_frozen_recipe_supplies_native_declarations_to_new_plans(self):
        folder=self.root/'frozen';folder.mkdir()
        files={'netlist/tb.scs':b'simulator lang=spectre\n',
               'experiment/recipe.json':json.dumps({'recipe':'agent-testbench','analyses':[
                   {'name':'gain','kind':'ac','parameters':{'start':'1','stop':'1G'}},
                   {'name':'bias','kind':'dc','parameters':{}}]}).encode()}
        for name,raw in files.items():
            path=folder/name;path.parent.mkdir(exist_ok=True);path.write_bytes(raw)
        bundle={'schema':'ic.sim.bundle.v1','source_root':'.','entrypoint':'netlist/tb.scs','reviewed_for_distribution':True,
                'files':[{'source':name,'destination':name,'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in files.items()]}
        path=folder/'bundle.json';path.write_text(json.dumps(bundle))
        def git(root,*args):return COMMIT if args[0]=='rev-parse' else ''
        with patch.object(runner.core,'git',side_effect=git):plan=self.runner.plan(path,COMMIT)
        self.assertEqual(plan['native_analyses'],[{'name':'gain','kind':'ac'},{'name':'bias','kind':'dc'}])
        self.ssh_mock.assert_not_called();self.transfer_mock.assert_not_called()

    def test_va_find_tar_and_receipt_use_identical_exclusion_directories(self):
        rid=self.record(headers=True);self.blob=archive(self.content('./psf/ac1.ac'))
        result=self.runner.collect(rid);script=self.scripts[-1]
        find=shlex.split(next(line for line in script.splitlines() if line.startswith('find ')))
        tar=shlex.split(next(line for line in script.splitlines() if line.lstrip().startswith('tar ')))
        find_paths={find[i+1] for i,word in enumerate(find) if word=='-path'}
        tar_paths={word.split('=',1)[1] for word in tar if word.startswith('--exclude=')}
        receipt_paths={'./'+path for path in result['collection']['excluded_paths']}
        self.assertEqual(tar_paths,receipt_paths)
        self.assertEqual(find_paths,receipt_paths|{path+'/*' for path in receipt_paths})
        self.assertIn('./netlist/__ic_va_headers__',receipt_paths)
        self.assertIn('Verilog-A standard header staging',result['collection']['excluded'])

    def test_staged_standard_header_members_are_rejected_before_final_archive_promotion(self):
        for name in ('./netlist/__ic_va_headers__/disciplines.vams',
                     'netlist//./__ic_va_headers__/types/electrical.vams',
                     './scratch/../netlist/__ic_va_headers__/constants.vams'):
            with self.subTest(name=name):
                rid=self.record(headers=True)
                self.blob=archive({**self.content('./psf/ac1.ac'),name:b'Never promote this synthetic header body.'})
                with self.assertRaisesRegex(ValueError,'excluded Verilog-A'):self.runner.collect(rid)
                self.assert_not_promoted(rid)
        for kind in (tarfile.DIRTYPE,tarfile.SYMTYPE,tarfile.LNKTYPE):
            with self.subTest(kind=kind):
                rid=self.record(headers=True)
                member=tarfile.TarInfo('./netlist/./__ic_va_headers__');member.type=kind;member.linkname='elsewhere'
                self.blob=archive(self.content('./psf/ac1.ac'),[member])
                with self.assertRaisesRegex(ValueError,'excluded Verilog-A'):self.runner.collect(rid)
                self.assert_not_promoted(rid)

    def test_rejected_new_transfer_preserves_existing_valid_archive_and_receipt(self):
        rid=self.record(headers=True);folder=self.runner.path(rid)
        self.blob=archive(self.content('./psf/ac1.ac'))
        first=self.runner.collect(rid);copy_collection=dict(first['collection']);old_bytes=self.blob
        changed=self.runner.read(rid);changed['postprocess_csv_sha256']='f'*64;self.runner.save(changed)
        self.blob=archive({**self.content('./psf/ac1.ac'),'./netlist/__ic_va_headers__/constants.vams':b'Synthetic forbidden bytes'})
        with self.assertRaisesRegex(ValueError,'excluded Verilog-A'):self.runner.collect(rid)
        self.assertEqual((folder/'full-results.tar.gz').read_bytes(),old_bytes)
        self.assertEqual(self.runner.read(rid)['collection'],copy_collection)
        self.assertFalse((folder/'full-results.tar.part').exists());self.assertFalse((folder/'archives').exists())

    def test_failed_solver_logs_can_be_collected_without_native_success_claim(self):
        self.remote_state='simulator_failed';rid=self.record()
        self.blob=archive({'./console.log':b'Synthetic solver error; no numerical data produced.\n'})
        result=self.runner.collect(rid)
        self.assertEqual(result['collection_phase'],'complete')
        self.assertFalse(result['collection']['summary']['execution_success'])
        self.assertFalse(result['collection']['summary']['scientific_acceptance'])


if __name__=='__main__':unittest.main()
