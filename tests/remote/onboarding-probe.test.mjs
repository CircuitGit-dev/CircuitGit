import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOnboardingProbeManifest,
  normalizeOnboardingProbeContext,
  verifyOnboardingSchematicMatch,
} from '../../modules/waveforms/onboarding-probe.js';
import { freshness, resolveSelection } from '../../modules/waveforms/mapping.js';
import { onboardingWaveformScope, scopedOnboardingWaveformAPI } from '../../apps/web/remote/onboarding-waveforms.js';

const commit = 'a'.repeat(40);
const plan = 'b'.repeat(64);
const digest = 'c'.repeat(64);
const otherDigest = 'd'.repeat(64);

const intake = {
  schema: 'ic.onboarding.session.v1',
  intake_id: 'intake_probe_1',
  source_sha256: digest,
  source_commit: commit,
  source: {
    file_name: 'circuit.scs',
    requirements: {
      interfaces: [{ name: 'OPEN_CMOS_INVERTER', ports: ['IN', 'OUT', 'VDD', 'VSS'] }],
      instances: [
        { name: 'MN0', scope: 'OPEN_CMOS_INVERTER', master: 'nch_open', ordered_nets: ['OUT', 'IN', 'VSS', 'VSS'] },
        { name: 'MP0', scope: 'OPEN_CMOS_INVERTER', master: 'pch_open', ordered_nets: ['OUT', 'IN', 'VDD', 'VDD'] },
      ],
    },
  },
  agent_tb: {
    testbench: {
      interface: {
        subckt: 'OPEN_CMOS_INVERTER',
        instance: 'XDUT',
        port_bindings: { IN: 'vin', OUT: 'vout', VDD: 'vdd', VSS: '0' },
      },
    },
  },
  prepared: {
    schema: 'ic.experiment.plan.v1',
    state: 'prepared',
    plan_id: plan,
    source_commit: commit,
    project_id: 'open-cmos-inverter',
    recipe_id: 'agent-tb',
  },
};

const job = {
  schema: 'ic.experiment.job.v1',
  plan_id: plan,
  source_commit: commit,
  project_id: 'open-cmos-inverter',
  configuration: 'agent-tb',
  run_id: 'run-remote-1',
  job_id: 'run-remote-1',
};

const signals = [
  { id: 's_vin', label: 'V(vin)', psf_name: 'vin', unit: 'V', quantity: 'voltage', analysis: 'tran', status: 'available' },
  { id: 's_vout', label: 'V(vout)', psf_name: 'vout', unit: 'V', quantity: 'voltage', analysis: 'tran', status: 'available' },
  { id: 's_mn0_d', label: 'I(XDUT.MN0:d)', psf_name: 'XDUT.MN0:d', unit: 'A', quantity: 'current', analysis: 'tran', status: 'available', polarity: 'into_terminal' },
  { id: 's_mn0_s', label: 'I(XDUT.MN0:s)', psf_name: 'XDUT.MN0:s', unit: 'A', quantity: 'current', analysis: 'tran', status: 'available', polarity: 'into_terminal' },
];

const matchingHostContext = {
  loadState: 'ready',
  file: { path: 'projects/open-cmos-inverter/circuit.scs', currentTextSha256: digest, dirty: false },
  geometry: { bundleCommit: null, manifestSha256: digest, entry: 'live-open-cmos-inverter', sourceMatch: true, state: 'ready' },
};

test('verifies exact SHA-256 schematic match and resolves DUT voltage & terminal current probes', () => {
  const scope = onboardingWaveformScope(intake, job);
  const manifest = buildOnboardingProbeManifest({ scope, catalog: { signals }, hostContext: matchingHostContext, intake });
  assert.equal(manifest.status, 'verified_binding');
  assert.ok(manifest.objects.length >= 4);

  const probeCtx = normalizeOnboardingProbeContext(scope, matchingHostContext);
  assert.equal(freshness(manifest, probeCtx).ok, true);

  // Clicking subckt net OUT resolves via frozen testbench port_bindings (OUT -> vout).
  const netClick = resolveSelection(
    manifest,
    {
      ...probeCtx,
      selection: {
        kind: 'net',
        name: 'OUT',
        scope: 'OPEN_CMOS_INVERTER',
        viewerSourcePath: matchingHostContext.file.path,
        nativeEntryId: 'live-open-cmos-inverter',
        occurrencePath: [],
      },
    },
    { signals },
  );
  assert.equal(netClick.status, 'resolved');
  assert.equal(netClick.signal.id, 's_vout');

  // Clicking device MN0 requires explicit terminal choice (d vs s), then resolves cleanly.
  const instClick = resolveSelection(
    manifest,
    {
      ...probeCtx,
      selection: {
        kind: 'instance',
        name: 'MN0',
        scope: 'OPEN_CMOS_INVERTER',
        viewerSourcePath: matchingHostContext.file.path,
        nativeEntryId: 'live-open-cmos-inverter',
        occurrencePath: [],
      },
    },
    { signals },
  );
  assert.equal(instClick.status, 'terminal_required');
  assert.equal(instClick.choices.length, 2);

  const termClick = resolveSelection(
    manifest,
    {
      ...probeCtx,
      selection: {
        kind: 'terminal',
        name: 'MN0',
        terminalName: 'd',
        scope: 'OPEN_CMOS_INVERTER',
        viewerSourcePath: matchingHostContext.file.path,
        nativeEntryId: 'live-open-cmos-inverter',
        occurrencePath: [],
      },
    },
    { signals },
  );
  assert.equal(termClick.status, 'resolved');
  assert.equal(termClick.signal.id, 's_mn0_d');
});

test('fails closed when schematic is dirty, switched, or stale while preserving catalog viewing', async () => {
  const scope = onboardingWaveformScope(intake, job);
  assert.equal(verifyOnboardingSchematicMatch(scope, { ...matchingHostContext, file: { ...matchingHostContext.file, dirty: true } }).ok, false);
  assert.equal(verifyOnboardingSchematicMatch(scope, { ...matchingHostContext, file: { ...matchingHostContext.file, currentTextSha256: otherDigest } }).ok, false);
  assert.equal(verifyOnboardingSchematicMatch(scope, { ...matchingHostContext, geometry: { ...matchingHostContext.geometry, state: 'stale' } }).ok, false);

  const identity = {
    run_id: job.run_id,
    source_commit: commit,
    archive_sha256: digest,
    raw_signature: digest,
    effective_config_sha256: digest,
    csv_sha256: digest,
  };
  let currentCtx = structuredClone(matchingHostContext);
  const provider = {
    catalog: async () => ({ ...identity, signals }),
    mapping: async () => ({ ...identity, status: 'unmapped', objects: [] }),
    waveform: async (_run, id) => ({ ...identity, signal: signals.find(s => s.id === id), points: [[0, 0], [1e-9, 1.8]] }),
  };
  const api = scopedOnboardingWaveformAPI(scope, provider, { getSchematicContext: () => currentCtx, intake });
  assert.equal((await api.catalog(job.run_id)).signals.length, 4);
  assert.equal((await api.mapping(job.run_id)).status, 'verified_binding');

  // Switch canvas to a different circuit: mapping fails closed to unmapped, catalog/waveform still work.
  currentCtx = { ...matchingHostContext, file: { ...matchingHostContext.file, currentTextSha256: otherDigest } };
  const unmapped = await api.mapping(job.run_id);
  assert.equal(unmapped.status, 'unmapped');
  assert.deepEqual(unmapped.objects, []);
  assert.equal((await api.waveform(job.run_id, 's_vout')).points.length, 2);
});
