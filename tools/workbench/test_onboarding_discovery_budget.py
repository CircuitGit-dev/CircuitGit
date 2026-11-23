"""Finite discovery budgets over real adapters and private synthetic fixtures."""
import contextlib
import copy
import io
import json
import shlex
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import onboarding_discovery
from test_onboarding_integration import _IntakeFixture, HOST


class DiscoveryBudgetTests(_IntakeFixture):
    def framed_transport(self,body,*,remote_elapsed):
        """Model only the SSH transport clock; run the real wrapper and parser."""
        observed=[]
        def transport(argv,command,*,timeout,max_output):
            self.assertEqual(argv[0],'/usr/bin/ssh')
            lines=[shlex.split(line) for line in command.splitlines()
                   if line.startswith(('printf ', '/usr/bin/timeout '))]
            begin,end=[row[-1] for row in lines if row[0]=='printf']
            wrapper=next(row for row in lines if row[0]=='/usr/bin/timeout')
            remote_limit=int(wrapper[1])
            observed.append({'remote_timeout':remote_limit,'transport_timeout':timeout,
                             'max_output':max_output})
            self.assertGreater(timeout,remote_limit)
            if remote_elapsed>=timeout:raise TimeoutError('synthetic transport deadline')
            if remote_elapsed>=remote_limit:
                return SimpleNamespace(returncode=124,stdout=(begin+'\n').encode(),stderr=b'')
            stdout=begin.encode()+b'\n'+body+b'\n'+end.encode()+b'\n'
            self.assertLess(len(stdout),max_output)
            return SimpleNamespace(returncode=0,stdout=stdout,stderr=b'')
        return transport,observed

    def library_bytes(self):
        from spiceowl.onboarding.pdk_discovery import build_pdk_library_script
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(build_pdk_library_script(roots=[str(self.models)]),{})
        return output.getvalue().encode()

    def call_remote(self,requirements,**kwargs):
        return onboarding_discovery.remote_discovery(HOST,self.home/'.ssh/config',
            self.capture,requirements,**kwargs)

    def test_full_library_succeeds_past_old_cutoff_with_real_validated_receipt(self):
        requirements=self.new_source()['source']['requirements'];body=self.library_bytes()
        transport,observed=self.framed_transport(body,remote_elapsed=120)
        with patch('onboarding_discovery._transport',side_effect=transport):
            result=self.call_remote(requirements,full_library=True)
        self.assertEqual(result['schema'],'spiceowl.pdk-library.v1')
        self.assertEqual(result['library_id'],json.loads(body)['library_id'])
        self.assertEqual(observed[0]['remote_timeout'],240)
        self.assertEqual(observed[0]['transport_timeout'],270)
        self.ssh.assert_not_called();self.process.assert_not_called()

    def test_filtered_adapter_retains_old_deadlines_and_source_binding(self):
        requirements=self.new_source()['source']['requirements']
        evidence=self.synthetic_discovery(requirements);body=json.dumps(evidence).encode()
        transport,observed=self.framed_transport(body,remote_elapsed=40)
        with patch('onboarding_discovery._transport',side_effect=transport):
            result=self.call_remote(requirements)
        self.assertEqual(result['source_sha256'],requirements['source_sha256'])
        self.assertEqual(result['required_masters'],requirements['required_masters'])
        self.assertEqual(observed[0]['remote_timeout'],50)
        self.assertEqual(observed[0]['transport_timeout'],60)
        timed_out,_=self.framed_transport(body,remote_elapsed=55)
        with patch('onboarding_discovery._transport',side_effect=timed_out):
            with self.assertRaisesRegex(ValueError,'did not complete.*exit=124'):
                self.call_remote(requirements)
        self.ssh.assert_not_called();self.process.assert_not_called()

    def test_full_library_remains_finite_at_remote_and_transport_boundaries(self):
        requirements=self.new_source()['source']['requirements'];body=self.library_bytes()
        for elapsed,error in ((240,ValueError),(270,TimeoutError)):
            with self.subTest(elapsed=elapsed):
                transport,_=self.framed_transport(body,remote_elapsed=elapsed)
                with patch('onboarding_discovery._transport',side_effect=transport):
                    with self.assertRaises(error):self.call_remote(requirements,full_library=True)

    def test_eight_host_probe_is_preserved_but_oversized_discovery_never_begins(self):
        state=self.probe(self.new_source(),['synthetic-host-'+str(i) for i in range(8)])
        self.assertEqual(len(state['probes']),8)
        folder=self.runtime._folder(state['intake_id']);before=(folder/'session.json').read_bytes()
        ids=[row['probe_id'] for row in state['probes']]
        with (patch('onboarding_lut.lookup_discovery') as lookup,
              patch('onboarding_discovery.remote_discovery') as remote,
              patch.object(self.runtime,'_begin',wraps=self.runtime._begin) as begin):
            for count in (3,8):
                with self.subTest(count=count),self.assertRaisesRegex(ValueError,'one or two'):
                    self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],
                        'revision':state['revision'],'probe_ids':ids[:count]},origin='test_harness')
            begin.assert_not_called();lookup.assert_not_called();remote.assert_not_called()
        self.assertEqual((folder/'session.json').read_bytes(),before)
        self.assertEqual(len(self.runtime.read('session',{'intake_id':state['intake_id']})['probes']),8)
        self.ssh.assert_not_called()

    def test_two_host_scan_uses_one_concurrent_batch_and_keeps_both_receipts(self):
        state=self.probe(self.new_source(),['synthetic-first','synthetic-second'])
        evidence=self.synthetic_discovery(state['source']['requirements']);gate=threading.Barrier(2)
        calls=[];mutex=threading.Lock()
        def scan(target,*args,full_library=False):
            with mutex:calls.append((target,full_library))
            gate.wait(timeout=5)
            return copy.deepcopy(evidence)
        with patch('onboarding_discovery.remote_discovery',side_effect=scan):
            result=self.runtime.write('discover-pdk',{'intake_id':state['intake_id'],
                'revision':state['revision'],'probe_ids':[row['probe_id'] for row in state['probes']]},
                origin='test_harness')
        self.assertEqual(sorted(calls),[('synthetic-first',True),('synthetic-second',True)])
        self.assertEqual(len(result['discovery']['coverage']),2)
        self.assertTrue(all(row['status']!='unavailable' for row in result['discovery']['coverage']))
        self.assertEqual(result['state'],'models_discovered');self.ssh.assert_not_called()

    def test_guidance_requires_explicit_two_host_batch_without_selecting_for_user(self):
        self.capture['public']['activation']={'selected_source_id':'1'*16}
        state=self.probe(self.new_source(),['synthetic-host-'+str(i) for i in range(3)])
        action=state['next_actions'][0]
        self.assertEqual(action['operation'],'discover-pdk');self.assertFalse(action['ready'])
        self.assertNotIn('probe_ids',action['arguments'])
        self.assertEqual(action['missing'][0]['field'],'probe_ids')
        self.assertEqual(action['missing'][0]['code'],'discovery_batch_selection_needed')
        self.assertEqual(len(state['probes']),3);self.ssh.assert_not_called()


if __name__=='__main__':unittest.main()
