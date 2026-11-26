import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  buildCircuitHierarchyTree,
  buildProjectExplorerSummary,
  clampSidebarWidth,
  computeWideSidebarWidth,
  filterHierarchyTree,
} from '../../apps/web/studio/sidebar-model.js';

test('sidebar width clamping stays draggable and protects schematic canvas room', () => {
  assert.equal(clampSidebarWidth(120, 1000), SIDEBAR_MIN_WIDTH);
  assert.equal(clampSidebarWidth(480, 1000), 480);
  // Bounded to at most 75% of container and leaves at least 220px for schematic
  assert.equal(clampSidebarWidth(900, 1000), 750);
  assert.equal(clampSidebarWidth(500, 600), 380);
  assert.equal(clampSidebarWidth(NaN, 1000), SIDEBAR_DEFAULT_WIDTH);

  const wideDesktop = computeWideSidebarWidth(1000);
  assert.equal(wideDesktop, 520);
  const wideCompact = computeWideSidebarWidth(700);
  assert.equal(wideCompact, 380);
  const wideTiny = computeWideSidebarWidth(500);
  assert.equal(wideTiny, 280);
});

test('buildCircuitHierarchyTree preserves nested breadcrumbs, Verilog-A leaves, cycles, and uncalled roots', () => {
  const doc = {
    levels: [
      {
        title: 'TB_PIPE_RS9_N06',
        children: [
          { instance: 'XDUT', master: 'PIPE_TOP_F4_RS9_N06', level: 1 },
          { instance: 'XSRC', master: 'ideal_dac_va', level: null },
          { instance: 'XEXT', master: 'pdk_nmos', level: null },
        ],
      },
      {
        title: 'PIPE_TOP_F4_RS9_N06',
        children: [
          { instance: 'XSAR_A', master: 'PIPE_SAR9_Real_N06', level: 2 },
        ],
      },
      {
        title: 'PIPE_SAR9_Real_N06',
        children: [
          // Self-cycle guard
          { instance: 'XSELF', master: 'PIPE_SAR9_Real_N06', level: 2 },
        ],
      },
      {
        title: 'UNUSED_HELPER',
        children: [],
      },
    ],
  };

  const tree = buildCircuitHierarchyTree(doc, {
    uncalled: [3],
    resolveVerilogA: master => (master === 'ideal_dac_va' ? { moduleName: 'ideal_dac_va', path: 'lib/a/ideal_dac_va.va' } : null),
  });

  assert.equal(tree.totalLevels, 4);
  assert.equal(tree.totalInstances, 5);
  assert.equal(tree.root.title, 'TB_PIPE_RS9_N06');
  assert.equal(tree.root.kind, 'top');
  assert.equal(tree.root.children.length, 3);

  const xdut = tree.root.children[0];
  assert.equal(xdut.pathKey, '0/0');
  assert.equal(xdut.instance, 'XDUT');
  assert.deepEqual(xdut.steps, [
    { level: 0, via: null },
    { level: 1, via: 'XDUT' },
  ]);

  const xsar = xdut.children[0];
  assert.equal(xsar.pathKey, '0/0/0');
  assert.deepEqual(xsar.steps, [
    { level: 0, via: null },
    { level: 1, via: 'XDUT' },
    { level: 2, via: 'XSAR_A' },
  ]);
  // Recursive child is flagged and stops recursing
  assert.equal(xsar.children[0].cycle, true);
  assert.deepEqual(xsar.children[0].children, []);

  // Verilog-A leaf vs undefined external leaf
  const xsrc = tree.root.children[1];
  assert.equal(xsrc.kind, 'veriloga');
  assert.equal(xsrc.veriloga.moduleName, 'ideal_dac_va');
  const xext = tree.root.children[2];
  assert.equal(xext.kind, 'undefined');

  // Uncalled root preserved separately
  assert.equal(tree.uncalled.length, 1);
  assert.equal(tree.uncalled[0].pathKey, 'r3');
  assert.equal(tree.uncalled[0].title, 'UNUSED_HELPER');

  // Substring filter retains ancestor chain to deep match
  const filtered = filterHierarchyTree(tree.root, 'sar9');
  assert.ok(filtered);
  assert.equal(filtered.children.length, 1);
  assert.equal(filtered.children[0].instance, 'XDUT');
  assert.equal(filtered.children[0].children[0].instance, 'XSAR_A');
  assert.equal(filterHierarchyTree(tree.root, 'nonexistent_xyz'), null);
});

test('buildProjectExplorerSummary formats library, imported, and RC reference projects', () => {
  const lib = {
    id: 'pipetisar-real',
    name: 'PIPE-TI-SAR real SAR snapshot',
    cells: [
      {
        id: 'TB_PIPE_RS9_N06',
        name: 'TB_PIPE_RS9_N06',
        kind: 'testbench',
        directory: 'lib/pipetisar-real/TB_PIPE_RS9_N06',
        project_id: 'pipetisar-real',
        views: [{ id: 'schematic', kind: 'rnl', entry: 'lib/pipetisar-real/TB_PIPE_RS9_N06/tb.scs', files: ['lib/pipetisar-real/TB_PIPE_RS9_N06/tb.scs', 'lib/pipetisar-real/PIPE_TOP/top.scs'] }],
      },
      {
        id: 'PIPE_TOP',
        name: 'PIPE_TOP',
        kind: 'circuit',
        directory: 'lib/pipetisar-real/PIPE_TOP',
        project_id: null,
        views: [{ id: 'schematic', kind: 'rnl', entry: 'lib/pipetisar-real/PIPE_TOP/top.scs', files: ['lib/pipetisar-real/PIPE_TOP/top.scs'] }],
      },
    ],
  };

  const libSummary = buildProjectExplorerSummary({
    activeLibrary: { library: lib, cell: lib.cells[0], origin: 'public' },
  });
  assert.equal(libSummary.kind, 'library');
  assert.equal(libSummary.title, '1G 12-bit PIPE–TI–SAR ADC');
  assert.equal(libSummary.activeCellId, 'TB_PIPE_RS9_N06');
  assert.equal(libSummary.topLevel.length, 2);

  const sshSummary = buildProjectExplorerSummary({
    importedProject: { origin: 'ssh', name: 'amp_top', fileName: 'amp_top.scs', supportCount: 3 },
  });
  assert.equal(sshSummary.kind, 'imported');
  assert.equal(sshSummary.badge, 'SSH 导入');
  assert.equal(sshSummary.supportCount, 3);

  const rcSummary = buildProjectExplorerSummary({
    isReference: true,
    doc: { path: '/circuitgit-demo.scs' },
  });
  assert.equal(rcSummary.kind, 'reference');
  assert.match(rcSummary.title, /RC/);
});
