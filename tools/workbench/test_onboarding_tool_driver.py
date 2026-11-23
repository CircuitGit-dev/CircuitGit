"""No-LLM intake driver using returned tool arguments and local synthetic seams."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

import experiment_workflow
import runner
from spiceowl.onboarding.environment import public_environment
from test_onboarding_integration import _IntakeFixture, HOST, SECRET


class OnboardingToolDriverTests(_IntakeFixture):
    def setUp(self):
        super().setUp()
        setup = self.capture['private']['setup_candidates'][0]
        setup.update(source_id='source-' + hashlib.sha256(setup['path'].encode()).hexdigest()[:20], executed_by_probe=False,
                     basis='alias_source_reference')
        self.setup = copy.deepcopy(setup)
        self.capture['private'].pop('activation', None)
        self.capture['private']['scripts'] = [copy.deepcopy(setup)]
        # Use the actual allowlisted projection rather than a smaller hand-built
        # public shape that might accidentally skip the setup guidance step.
        self.capture['public'] = public_environment(HOST, self.capture['private'])
        self.activation = self.patch(patch(
            'spiceowl.onboarding.environment.activate_observed_environment',
            side_effect=self.activate_synthetic_setup))
        self.solver_launch = self.patch(patch.object(
            runner.core, 'launch_command', side_effect=AssertionError('No solver launch')))
        self.issued = []

    def activate_synthetic_setup(self, target, ssh_config, capture, selected_source_id):
        self.assertEqual(target, HOST)
        self.assertEqual(ssh_config, self.cfg['onboarding']['ssh_config'])
        self.assertIsNone(capture['public']['activation'])
        self.assertNotIn('activation', capture['private'])
        observed = capture['private']['setup_candidates']
        self.assertEqual(len(observed), 1)
        self.assertEqual(selected_source_id, observed[0]['source_id'])
        for field in ('source_id', 'path', 'sha256'):
            self.assertEqual(observed[0][field], self.setup[field])
        activated = copy.deepcopy(capture)
        activated['private']['activation'] = {
            'selected_source_id': selected_source_id,
            'selected_source_sha256': observed[0]['sha256'],
            'shell': '/bin/csh', 'source_method': 'verified_bytes_stdin'}
        activated['private']['setup_candidates'][0]['executed_by_probe'] = True
        activated['public'] = public_environment(target, activated['private'])
        return activated

    def invoke_returned(self, action):
        """Stop on missing input; never repair or supplement returned arguments."""
        if action.get('ready') is not True or action.get('missing'):
            return None
        arguments = copy.deepcopy(action['arguments'])
        self.issued.append(copy.deepcopy(action))
        method = self.runtime.read if action['kind'] == 'read' else self.runtime.write
        result = method(action['operation'], arguments, origin='test_harness')
        self.assertEqual(arguments, action['arguments'])
        return result

    def import_and_select_host(self):
        imported = self.new_source()
        self.assertEqual([a['operation'] for a in imported['next_actions']], ['ssh-hosts', 'probe'])
        inventory = self.invoke_returned(imported['next_actions'][0])
        self.assertEqual(inventory['network_operations'], 0)
        selected = [row['alias'] for row in inventory['hosts'] if row['alias'] == HOST]
        self.assertEqual(selected, [HOST])
        initial = imported['next_actions'][1]
        self.assertFalse(initial['ready'])
        self.assertEqual([row['field'] for row in initial['missing']], ['ssh_targets'])
        # The only caller-supplied choice after import is this explicit initial
        # host allowlist. Every later call copies the returned arguments whole.
        args = copy.deepcopy(initial['arguments'])
        args['ssh_targets'] = selected
        state = self.runtime.write(initial['operation'], args, origin='test_harness')
        self.assertIsNone(state['probes'][0]['environment']['activation'])
        choices = state['probes'][0]['environment']['setup_candidates']
        self.assertEqual(len(choices), 1)
        self.assertTrue(choices[0]['activation_supported'])
        self.assertEqual(choices[0]['source_id'], self.setup['source_id'])
        self.activation.assert_not_called()
        return state

    def drive(self, state):
        """Run at most one bounded setup-to-inspection chain, stopping on gaps."""
        snapshots = []
        for _ in range(6):
            action = copy.deepcopy(state['next_actions'][0])
            if action.get('ready') is not True or action.get('missing'):
                return state, snapshots, action
            if action['operation'] == 'run':
                self.enable_reservation(state)
            next_state = self.invoke_returned(action)
            self.assertIsNotNone(next_state)
            snapshots.append((action, next_state))
            state = next_state
            if action['operation'] == 'inspect':
                return state, snapshots, None
        self.fail('Returned guidance exceeded the bounded synthetic driver steps')

    def test_from_netlist_through_setup_discovery_prepare_reserve_and_original_inspection(self):
        state = self.import_and_select_host()
        self.assertEqual(state['next_actions'][0]['operation'], 'probe')
        self.assertEqual(state['next_actions'][0]['arguments']['overrides']['setup_source_ids'],
                         {HOST: self.setup['source_id']})

        def local_discovery(target, ssh_config, capture, requirements, search_paths, cds_lib_hint, *, full_library=False):
            self.assertTrue(full_library)
            self.assertEqual(target, HOST)
            self.assertEqual(ssh_config, self.cfg['onboarding']['ssh_config'])
            self.assertEqual(capture['private']['activation']['selected_source_id'], self.setup['source_id'])
            self.assertEqual(capture['private']['activation']['selected_source_sha256'], self.setup['sha256'])
            self.assertIsNone(search_paths)
            self.assertIsNone(cds_lib_hint)
            return self.synthetic_discovery(requirements)

        with patch('onboarding_discovery.remote_discovery', side_effect=local_discovery) as discovery, \
             patch.object(experiment_workflow.ExperimentWorkflow, '_audit', side_effect=self.local_audit) as audit:
            inspected, snapshots, stopped = self.drive(state)
        self.assertIsNone(stopped)
        self.assertEqual([a['operation'] for a, _ in snapshots],
                         ['probe', 'discover-pdk', 'prepare', 'run', 'inspect'])
        activated, discovered, prepared, submitted, _ = [s for _, s in snapshots]
        self.assertEqual(activated['probes'][0]['environment']['activation']['selected_source_id'], self.setup['source_id'])
        self.assertTrue(activated['probes'][0]['environment']['setup_candidates'][0]['executed_by_probe'])
        self.capture_call.assert_called_with(HOST, self.cfg['onboarding']['ssh_config'])
        self.assertEqual(self.capture_call.call_count, 2)
        self.activation.assert_called_once()
        discovery.assert_called_once()
        audit.assert_called_once()
        self.assertEqual(prepared['state'], 'prepared')
        self.assertIsNotNone(prepared['source_commit'])
        self.assertTrue(self.process.called, 'Real local Git/compiler materialization must run')
        self.assertTrue(all(call.args[0][0] == 'git' for call in self.process.call_args_list))
        chosen = discovered['recommended_selection']
        for field in ('discovery_id', 'candidate_id', 'sections', 'tmi_candidate_id', 'model_contracts', 'intent'):
            self.assertEqual(prepared['selection'][field], chosen[field])
        prepare_action = snapshots[2][0]
        self.assertNotIn('intent', prepare_action['arguments'])
        self.assertNotIn('model_contracts', prepare_action['arguments'])
        self.assertEqual(inspected['job']['job_id'], submitted['job']['job_id'])
        self.assertEqual(inspected['job']['inspection_state'], 'working')
        self.assertEqual(snapshots[-1][0]['arguments']['job_id'], submitted['job']['job_id'])
        self.assertEqual(self.reserve.call_count, 1)
        self.assertEqual(len(self.executor.calls), 1)
        stored = self.child_for(prepared).runner.read(submitted['job']['job_id'])
        self.assertEqual(stored['launch_attempts'], 0)
        self.dispatch.assert_not_called()
        self.ssh.assert_not_called()
        self.solver_launch.assert_not_called()
        public = json.dumps([state, *[s for _, s in snapshots]])
        self.assertNotIn(SECRET, public)
        self.assertNotIn(str(self.root), public)

if __name__ == '__main__':
    unittest.main()
