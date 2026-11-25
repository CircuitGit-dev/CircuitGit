/**
 * Web UI panel for inspecting and switching the local open-source SPICE backend
 * (ngspice / Xyce + builtin / SKY130 / GF180MCU / IHP SG13G2) with zero CLI.
 * Uses only the injected gateway API (no apps/ imports).
 */
export function mountLocalBackend(container, {gateway, notify = () => {}, onConfigured = async () => {}} = {}) {
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  let disposed = false, loading = false, saving = false, info = null, error = '', probe = null, expanded = false;
  let selectedEngine = 'ngspice', selectedPdk = 'builtin', selectedCorner = 'typical', pdkRoot = '';

  const supportsApi = () => typeof gateway?.simulationBackend === 'function' && typeof gateway?.configureSimulationBackend === 'function';

  function syncDraftFromInfo(data) {
    if (!data) return;
    const cur = data.current;
    if (cur?.transport === 'local') {
      selectedEngine = cur.engine || selectedEngine;
      if (cur.open_pdk?.pdk) {
        selectedPdk = cur.open_pdk.pdk;
        selectedCorner = cur.open_pdk.corner || data.open_pdk_profiles?.[selectedPdk]?.default_corner || 'typical';
      }
    } else {
      const avail = (data.detected_simulators || []).find(s => s.available);
      if (avail) selectedEngine = avail.engine;
    }
    const profile = data.open_pdk_profiles?.[selectedPdk];
    if (profile && !profile.corners.includes(selectedCorner)) {
      selectedCorner = profile.default_corner;
    }
  }

  async function refresh() {
    if (disposed || loading || !supportsApi()) return;
    loading = true;
    error = '';
    render();
    try {
      const data = await gateway.simulationBackend();
      if (disposed) return;
      info = data;
      syncDraftFromInfo(data);
    } catch (err) {
      if (!disposed) error = err?.message || String(err);
    } finally {
      if (!disposed) {
        loading = false;
        render();
      }
    }
  }

  async function applyLocal() {
    if (disposed || saving || !supportsApi()) return;
    saving = true;
    error = '';
    probe = null;
    render();
    try {
      const profile = info?.open_pdk_profiles?.[selectedPdk];
      const open_pdk = {pdk: selectedPdk, corner: selectedCorner};
      if (profile?.requires_root) {
        const trimmedRoot = pdkRoot.trim();
        if (!/^(?:\/|[A-Za-z]:[\\/])/.test(trimmedRoot)) {
          throw Error('请填写开源 PDK 根目录的绝对路径（如 /path/to/pdk/sky130A 或 C:\\pdk\\sky130A，或点击上方自动发现的 PDK）。');
        }
        open_pdk.root = trimmedRoot;
      }
      const result = await gateway.configureSimulationBackend({mode: 'local', engine: selectedEngine, open_pdk});
      if (disposed) return;
      probe = result.probe;
      if (info) info = {...info, current: result.backend};
      notify(`已切换至本地 ${selectedEngine}（PDK：${selectedPdk} / ${selectedCorner}）`);
      await onConfigured(result);
    } catch (err) {
      if (!disposed) {
        error = err?.message || String(err);
        notify(error, {kind: 'error'});
      }
    } finally {
      if (!disposed) {
        saving = false;
        render();
      }
    }
  }

  function render() {
    if (disposed) return;
    container.replaceChildren();
    if (!supportsApi()) return;

    const card = el('details', undefined, 'ic-sim-detail');
    card.dataset.role = 'local-open-sim-backend';
    const cur = info?.current;
    const isLocalActive = cur?.transport === 'local';
    card.open = expanded || isLocalActive;
    card.addEventListener('toggle', () => { expanded = card.open; });
    const summary = el('summary');
    summary.append(el('span', '备选：本地开源仿真器（ngspice / Xyce）'));
    const badgeText = !info
      ? (loading ? '检测中…' : '本地备选')
      : isLocalActive
        ? `本地 ${cur.engine}${cur.open_pdk ? ' · ' + cur.open_pdk.pdk : ''}`
        : '远端 Spectre 优先';
    summary.append(el('span', badgeText, 'ic-sim-status' + (isLocalActive ? ' active' : '')));
    card.append(summary);

    card.append(el('p', '日常推荐使用上方远端服务器仿真。无远端服务器或做开源快速验证时，可在此切换本机开源 SPICE 仿真器；商业 PDK 不会静默降级。', 'ic-sim-note'));

    if (error) card.append(el('p', error, 'ic-sim-error'));

    const detected = info?.detected_simulators || [];
    if (detected.length) {
      const chips = el('div', undefined, 'ic-sim-known-data');
      for (const sim of detected) {
        chips.append(el('span', `${sim.engine}：${sim.available ? '已安装' : '未检测到'}`, 'ic-sim-status' + (sim.available ? ' active' : '')));
      }
      card.append(chips);
    }

    const discovered = info?.discovered_open_pdks || [];
    if (discovered.length) {
      const box = el('div', undefined, 'ic-sim-toolbar');
      box.append(el('span', '已发现本机开源 PDK：', 'ic-sim-note'));
      for (const item of discovered) {
        const pick = el('button', `${item.pdk} (${item.default_corner})`, 'ic-sim-quiet');
        pick.type = 'button';
        pick.disabled = saving || loading;
        pick.addEventListener('click', () => {
          selectedPdk = item.pdk;
          selectedCorner = item.default_corner;
          pdkRoot = item.root;
          render();
        });
        box.append(pick);
      }
      card.append(box);
    }

    if (info?.can_configure_local) {
      const engRow = el('label', undefined, 'ic-sim-field');
      engRow.append(el('span', '仿真引擎'));
      const engSel = el('select');
      engSel.dataset.field = 'local-sim-engine';
      engSel.disabled = saving || loading;
      for (const sim of detected.length ? detected : [{engine: 'ngspice', available: true}, {engine: 'xyce', available: false}]) {
        const opt = el('option', `${sim.engine}${sim.available ? '' : '（本机未检测到）'}`);
        opt.value = sim.engine;
        engSel.append(opt);
      }
      engSel.value = selectedEngine;
      engSel.addEventListener('change', () => { selectedEngine = engSel.value; render(); });
      engRow.append(engSel);
      card.append(engRow);

      const profiles = info.open_pdk_profiles || {builtin: {label: '无 PDK 内置模型', requires_root: false, default_corner: 'typical', corners: ['typical']}};
      const pdkRow = el('label', undefined, 'ic-sim-field');
      pdkRow.append(el('span', '开源 PDK'));
      const pdkSel = el('select');
      pdkSel.dataset.field = 'local-sim-pdk';
      pdkSel.disabled = saving || loading;
      for (const [id, profile] of Object.entries(profiles)) {
        const opt = el('option', `${id} · ${profile.label}`);
        opt.value = id;
        pdkSel.append(opt);
      }
      pdkSel.value = selectedPdk;
      pdkSel.addEventListener('change', () => {
        selectedPdk = pdkSel.value;
        selectedCorner = profiles[selectedPdk]?.default_corner || 'typical';
        const auto = discovered.find(d => d.pdk === selectedPdk);
        if (auto) pdkRoot = auto.root;
        render();
      });
      pdkRow.append(pdkSel);
      card.append(pdkRow);

      const curProfile = profiles[selectedPdk];
      const cornerRow = el('label', undefined, 'ic-sim-field');
      cornerRow.append(el('span', '工艺角 Corner'));
      const cornerSel = el('select');
      cornerSel.dataset.field = 'local-sim-corner';
      cornerSel.disabled = saving || loading;
      for (const c of curProfile?.corners || ['typical']) {
        const opt = el('option', c);
        opt.value = c;
        cornerSel.append(opt);
      }
      cornerSel.value = selectedCorner;
      cornerSel.addEventListener('change', () => { selectedCorner = cornerSel.value; });
      cornerRow.append(cornerSel);
      card.append(cornerRow);

      if (curProfile?.requires_root) {
        const rootRow = el('label', undefined, 'ic-sim-field');
        rootRow.append(el('span', 'PDK 根目录'));
        const rootInput = el('input');
        rootInput.type = 'text';
        rootInput.dataset.field = 'local-sim-pdk-root';
        const isWin = /win/i.test(String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || globalThis.navigator?.userAgent || ''));
        const folderName = selectedPdk === 'sky130' ? 'sky130A' : selectedPdk === 'gf180mcu' ? 'gf180mcuD' : 'ihp-sg13g2';
        rootInput.placeholder = isWin ? `C:\\pdk\\${folderName}` : `/path/to/pdk/${folderName}`;
        rootInput.value = pdkRoot;
        rootInput.disabled = saving || loading;
        rootInput.addEventListener('input', () => { pdkRoot = rootInput.value; });
        rootRow.append(rootInput);
        card.append(rootRow);
      }

      const actions = el('div', undefined, 'ic-sim-toolbar');
      const applyBtn = el('button', saving ? '正在预检并应用…' : '预检并启用本地开源仿真');
      applyBtn.type = 'button';
      applyBtn.dataset.field = 'local-sim-apply';
      applyBtn.disabled = saving || loading;
      applyBtn.addEventListener('click', () => { void applyLocal(); });
      const refreshBtn = el('button', '重新检测本机环境', 'ic-sim-quiet');
      refreshBtn.type = 'button';
      refreshBtn.disabled = saving || loading;
      refreshBtn.addEventListener('click', () => { void refresh(); });
      actions.append(applyBtn, refreshBtn);
      card.append(actions);
    }

    if (probe) {
      card.append(el('p', `已就绪：${probe.version || probe.engine} · 许可：无需商业许可` + (probe.open_pdk ? ` · PDK ${probe.open_pdk.pdk}/${probe.open_pdk.corner}` : ''), 'ic-sim-effective'));
    }

    container.append(card);
  }

  render();
  if (supportsApi()) void refresh();
  return {
    refresh,
    destroy() {
      disposed = true;
      container.replaceChildren();
    },
  };
}
