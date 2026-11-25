// Strict client-side schematic-to-remote-waveform probe binding.
// Never guesses across mismatched hashes, dirty buffers, or ambiguous names.
const HASH_RE = /^[a-f0-9]{64}$/;
const SIMPLE_NET_RE = /^[A-Za-z0-9_$.\\/<>\[\]-]{1,180}$/;
const SIMPLE_CURRENT_RE = /^([A-Za-z0-9_$.\\/<>\[\]-]{1,160}):([A-Za-z0-9_.-]{1,40})$/;

function isHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

/** Prove exact cryptographic match between the displayed schematic and the remote simulation's original source. */
export function verifyOnboardingSchematicMatch(scope, hostContext) {
  if (!isHash(scope?.source_sha256)) {
    return { ok: false, reason: '远端实验缺少可核验的原始源码 SHA-256。' };
  }
  const file = hostContext?.file;
  const geom = hostContext?.geometry;
  if (!file || typeof file.path !== 'string' || !file.path) {
    return { ok: false, reason: '当前画布未绑定可核验的电路源文件。' };
  }
  if (file.dirty === true) {
    return { ok: false, reason: '当前画布源码有未保存修改；已禁用原理图点选探针。' };
  }
  if (!isHash(file.currentTextSha256)) {
    return { ok: false, reason: '当前画布尚未完成源码哈希核验；已禁用原理图点选探针。' };
  }
  if (file.currentTextSha256 !== scope.source_sha256) {
    return { ok: false, reason: '当前画布电路与远端仿真源版本不一致；已禁用原理图点选探针，仍可从信号列表查看历史曲线。' };
  }
  if (hostContext?.loadState === 'error' || geom?.state === 'stale' || geom?.sourceMatch === false) {
    return { ok: false, reason: '当前原理图几何状态已过期或加载失败；已禁用原理图点选探针。' };
  }
  const bundleCommit = geom?.bundleCommit ?? null;
  const manifestSha256 = isHash(geom?.manifestSha256) ? geom.manifestSha256 : scope.source_sha256;
  const bundleSha256 = isHash(geom?.bundleSha256) ? geom.bundleSha256 : null;
  const entryId = (typeof geom?.entry === 'string' && geom.entry)
    || (typeof geom?.entryId === 'string' && geom.entryId)
    || 'onboarding-verified';
  return {
    ok: true,
    sourcePath: file.path,
    sourceSha256: scope.source_sha256,
    bundleCommit,
    manifestSha256,
    bundleSha256,
    entryId,
  };
}

/** Parse an exported PSF signal name strictly into a net voltage or instance:terminal current target. */
export function parseSignalTarget(signal) {
  if (!signal || signal.status !== 'available') return null;
  const raw = String(signal.psf_name || signal.label || '').trim();
  if (!raw) return null;
  const quantity = signal.quantity || (signal.unit === 'A' ? 'current' : signal.unit === 'V' ? 'voltage' : null);
  if (quantity === 'current') {
    const inner = /^[Ii]\(([^()]+)\)$/.test(raw) ? raw.slice(2, -1).trim() : raw;
    const match = SIMPLE_CURRENT_RE.exec(inner);
    if (!match) return null;
    return { kind: 'terminal', instance: match[1], terminal: match[2] };
  }
  if (quantity === 'voltage') {
    const inner = /^[Vv]\(([^()]+)\)$/.test(raw) ? raw.slice(2, -1).trim() : raw;
    if (!SIMPLE_NET_RE.test(inner) || inner.includes(':')) return null;
    return { kind: 'net', net: inner };
  }
  return null;
}

function splitHierarchicalPrefix(token, prefix) {
  if (!prefix) return null;
  for (const sep of ['.', '/']) {
    const head = prefix + sep;
    if (token.startsWith(head) && token.length > head.length) {
      return token.slice(head.length);
    }
    if (token.toLowerCase().startsWith(head.toLowerCase()) && token.length > head.length) {
      return token.slice(head.length);
    }
  }
  return null;
}

function buildScopeLookups(intake) {
  const req = intake?.source?.requirements;
  const tbIf = intake?.agent_tb?.testbench?.interface;
  const interfaces = Array.isArray(req?.interfaces) ? req.interfaces : [];
  const instances = Array.isArray(req?.instances) ? req.instances : [];
  const subcktPorts = new Map();
  for (const item of interfaces) {
    if (typeof item?.name === 'string' && item.name && Array.isArray(item.ports)) {
      subcktPorts.set(item.name, item.ports.filter(p => typeof p === 'string' && p));
    }
  }
  const scopeInstances = new Map();
  for (const inst of instances) {
    if (typeof inst?.name !== 'string' || !inst.name) continue;
    const scope = typeof inst.scope === 'string' && inst.scope ? inst.scope : '(top)';
    if (!scopeInstances.has(scope)) scopeInstances.set(scope, new Set());
    scopeInstances.get(scope).add(inst.name);
  }
  const dutSubckt = typeof tbIf?.subckt === 'string' && tbIf.subckt
    ? tbIf.subckt
    : (subcktPorts.size === 1 ? [...subcktPorts.keys()][0] : null);
  const dutInstance = typeof tbIf?.instance === 'string' && tbIf.instance ? tbIf.instance : null;
  const portBindings = (tbIf?.port_bindings && typeof tbIf.port_bindings === 'object' && !Array.isArray(tbIf.port_bindings))
    ? tbIf.port_bindings
    : null;
  return { subcktPorts, scopeInstances, dutSubckt, dutInstance, portBindings };
}

function matchExactOrUniqueCI(candidates, target) {
  if (!candidates || !candidates.length) return null;
  if (candidates.includes(target)) return target;
  const lower = target.toLowerCase();
  const ci = candidates.filter(name => name.toLowerCase() === lower);
  return ci.length === 1 ? ci[0] : null;
}

/**
 * Build a verified ic.waveform-map.v1 manifest for remote onboarding waveforms
 * when and only when the currently displayed schematic matches scope.source_sha256.
 */
export function buildOnboardingProbeManifest({ scope, catalog, hostContext, intake } = {}) {
  const match = verifyOnboardingSchematicMatch(scope, hostContext);
  if (!match.ok) {
    return {
      schema: 'ic.waveform-map.v1',
      status: 'unmapped',
      objects: [],
      reason: match.reason,
    };
  }
  const signals = Array.isArray(catalog?.signals) ? catalog.signals : [];
  const { subcktPorts, scopeInstances, dutSubckt, dutInstance, portBindings } = buildScopeLookups(intake);

  // Collect candidate (selectorKey -> entries[]) to reject any ambiguous collision.
  const buckets = new Map();
  const addMapping = (selector, signal) => {
    const key = JSON.stringify([selector.scope, selector.kind, selector.name, selector.terminal_name]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      selector: {
        name: selector.name,
        kind: selector.kind,
        scope: selector.scope,
        viewer_source_path: match.sourcePath,
        native_entry_id: match.entryId,
        occurrence_path: [],
        terminal_name: selector.terminal_name ?? null,
      },
      status: 'available',
      signal_id: signal.id,
      psf_name: signal.psf_name,
      unit: signal.unit,
      analysis: signal.analysis,
      polarity: signal.polarity || null,
    });
  };

  const dutPorts = dutSubckt ? (subcktPorts.get(dutSubckt) || []) : [];
  const dutInstances = dutSubckt ? [...(scopeInstances.get(dutSubckt) || [])] : [];
  const topInstances = [...(scopeInstances.get('(top)') || [])];

  for (const signal of signals) {
    const parsed = parseSignalTarget(signal);
    if (!parsed) continue;
    if (parsed.kind === 'net') {
      const token = parsed.net;
      // 1. Direct hierarchical DUT net via explicit testbench instance (e.g. XDUT.OUT -> scope OPEN_CMOS_INVERTER, net OUT).
      const innerNet = splitHierarchicalPrefix(token, dutInstance);
      if (dutSubckt && innerNet && !innerNet.includes('.') && !innerNet.includes('/')) {
        const canonicalPort = matchExactOrUniqueCI(dutPorts, innerNet) || innerNet;
        addMapping({ scope: dutSubckt, kind: 'net', name: canonicalPort, terminal_name: null }, signal);
      }
      // 2. Explicit testbench port binding (e.g. port_bindings = { OUT: "vout" } and PSF signal is "vout").
      if (dutSubckt && portBindings) {
        for (const [portName, boundNet] of Object.entries(portBindings)) {
          if (typeof boundNet === 'string' && boundNet && (boundNet === token || boundNet.toLowerCase() === token.toLowerCase())) {
            const canonicalPort = matchExactOrUniqueCI(dutPorts, portName) || portName;
            addMapping({ scope: dutSubckt, kind: 'net', name: canonicalPort, terminal_name: null }, signal);
          }
        }
      }
      // 3. Single-subckt direct port match when no conflicting port_bindings override exists.
      if (dutSubckt && !token.includes('.') && !token.includes('/')) {
        const directPort = matchExactOrUniqueCI(dutPorts, token);
        if (directPort && (!portBindings || !Object.hasOwn(portBindings, directPort))) {
          addMapping({ scope: dutSubckt, kind: 'net', name: directPort, terminal_name: null }, signal);
        }
      }
      // 4. Flat / top-level netlist match (scope '(top)').
      if (!token.includes('.') && !token.includes('/')) {
        addMapping({ scope: '(top)', kind: 'net', name: token, terminal_name: null }, signal);
      }
    } else if (parsed.kind === 'terminal') {
      const instToken = parsed.instance;
      const term = parsed.terminal;
      // 1. Hierarchical DUT device current via explicit testbench instance (e.g. XDUT.MN0:d).
      const innerInst = splitHierarchicalPrefix(instToken, dutInstance);
      if (dutSubckt && innerInst && !innerInst.includes('.') && !innerInst.includes('/')) {
        const canonicalInst = matchExactOrUniqueCI(dutInstances, innerInst) || innerInst;
        addMapping({ scope: dutSubckt, kind: 'terminal', name: canonicalInst, terminal_name: term }, signal);
      }
      // 2. Direct subckt device match when unambiguous.
      if (dutSubckt && !instToken.includes('.') && !instToken.includes('/')) {
        const directInst = matchExactOrUniqueCI(dutInstances, instToken);
        if (directInst) {
          addMapping({ scope: dutSubckt, kind: 'terminal', name: directInst, terminal_name: term }, signal);
        }
      }
      // 3. Top-level device current (e.g. R0:1).
      if (!instToken.includes('.') && !instToken.includes('/')) {
        const canonicalTop = matchExactOrUniqueCI(topInstances, instToken) || instToken;
        addMapping({ scope: '(top)', kind: 'terminal', name: canonicalTop, terminal_name: term }, signal);
      }
    }
  }

  // Keep only strictly unambiguous mappings (exactly 1 unique signal per selector).
  const objects = [];
  for (const entries of buckets.values()) {
    const distinctSignalIds = new Set(entries.map(item => item.signal_id));
    if (distinctSignalIds.size === 1) {
      objects.push(entries[0]);
    }
  }

  if (!objects.length) {
    return {
      schema: 'ic.waveform-map.v1',
      status: 'unmapped',
      objects: [],
      reason: '当前原理图与远端仿真源一致，但本次已导出信号尚未包含可映射节点；请从信号列表查看。',
    };
  }

  return {
    schema: 'ic.waveform-map.v1',
    status: 'verified_binding',
    run_id: scope.run_id,
    source_commit: scope.source_commit,
    source: {
      path: match.sourcePath,
      canonical_path: match.sourcePath,
      sha256: scope.source_sha256,
    },
    geometry: {
      kind: match.bundleCommit === null ? 'local_export_snapshot' : 'native',
      bundle_commit: match.bundleCommit,
      manifest_sha256: match.manifestSha256,
      ...(match.bundleSha256 ? { bundle_sha256: match.bundleSha256 } : {}),
      entry_id: match.entryId,
    },
    objects,
  };
}

/** Produce a normalized waveform-panel context bound to scope + live schematic freshness. */
export function normalizeOnboardingProbeContext(scope, hostContext) {
  const match = verifyOnboardingSchematicMatch(scope, hostContext);
  return {
    version: 1,
    mode: 'live',
    project: { id: scope.project_id, sourceCommit: scope.source_commit },
    run: { runId: scope.run_id },
    selection: hostContext?.selection || null,
    file: hostContext?.file ? { ...hostContext.file } : null,
    geometry: match.ok
      ? {
          bundleCommit: match.bundleCommit,
          manifestSha256: match.manifestSha256,
          ...(match.bundleSha256 ? { bundleSha256: match.bundleSha256 } : {}),
          entryId: match.entryId,
          sourceMatch: true,
          state: 'ready',
        }
      : (hostContext?.geometry ? { ...hostContext.geometry } : null),
  };
}
