// Pure Verilog-A indexing, source metadata parsing, instance master resolution,
// and safe line tokenization. No DOM or network side effects.

const VA_EXT = /\.(?:va|vams)$/i;

export function isVerilogAFile(path) {
  return typeof path === 'string' && VA_EXT.test(path.trim());
}

export function verilogaModuleBasename(path) {
  if (typeof path !== 'string') return '';
  const base = path.split('/').pop() || '';
  return base.replace(VA_EXT, '');
}

/** Strip block and line comments while keeping newlines so line numbers stay accurate. */
function stripCommentsPreserveLines(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
    } else if (ch === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
    } else if (ch === '"') {
      out += ch; i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { out += text[i] + text[i + 1]; i += 2; continue; }
        out += text[i]; i++;
      }
      if (i < n) { out += '"'; i++; }
    } else {
      out += ch; i++;
    }
  }
  return out;
}

function lineNumberAt(text, offset) {
  if (offset <= 0) return 1;
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/**
 * Parse a Verilog-A / Verilog-AMS source file for module name, port list,
 * parameter declarations, `include directives, and `analog` block location.
 */
export function parseVerilogAModule(text, fallbackName = '') {
  const source = typeof text === 'string' ? text : '';
  const clean = stripCommentsPreserveLines(source);
  const includes = [];
  for (const m of clean.matchAll(/`include\s+"([^"\n]+)"/g)) {
    if (!includes.includes(m[1])) includes.push(m[1]);
  }

  let moduleName = fallbackName || '';
  let moduleLine = 1;
  let headerPorts = [];
  const modMatch = /\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\s*(?:#\s*\([^)]*\)\s*)?(?:\(([\s\S]*?)\))?\s*;/m.exec(clean);
  if (modMatch) {
    moduleName = modMatch[1];
    moduleLine = lineNumberAt(clean, modMatch.index);
    const rawPorts = modMatch[2] || '';
    // Handle both ANSI (`inout electrical P, N`) and classic (`P, N, VDD, VSS`) port lists.
    headerPorts = rawPorts
      .split(',')
      .map(part => {
        const cleaned = part.replace(/\b(?:input|output|inout|electrical|voltage|current|wire|reg|real|integer|magnetic|thermal|kinematic|rotational)\b/g, ' ').replace(/\[[^\]]*\]/g, ' ').trim();
        const tokens = cleaned.split(/\s+/).filter(Boolean);
        return tokens[tokens.length - 1] || '';
      })
      .filter(Boolean);
  }

  const directions = new Map();
  const busRanges = new Map();
  for (const m of clean.matchAll(/\b(input|output|inout)\b([^;]*);/g)) {
    const dir = m[1];
    const body = m[2].replace(/\b(?:electrical|voltage|current|wire|reg|real|integer)\b/g, ' ');
    const rangeMatch = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(body);
    const range = rangeMatch ? [Number(rangeMatch[1]), Number(rangeMatch[2])] : null;
    const stripped = body.replace(/\[[^\]]*\]/g, ' ');
    for (const raw of stripped.split(',')) {
      const name = raw.trim().split(/\s+/).pop();
      if (name && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
        directions.set(name, dir);
        if (range) busRanges.set(name, range);
      }
    }
  }

  const disciplines = new Map();
  for (const m of clean.matchAll(/\b(electrical|voltage|current|magnetic|thermal|kinematic|rotational)\b([^;]*);/g)) {
    const disc = m[1];
    const rangeMatch = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(m[2]);
    const range = rangeMatch ? [Number(rangeMatch[1]), Number(rangeMatch[2])] : null;
    const body = m[2].replace(/\[[^\]]*\]/g, ' ');
    for (const raw of body.split(',')) {
      const name = raw.trim().split(/\s+/).pop();
      if (name && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
        disciplines.set(name, disc);
        if (range && !busRanges.has(name)) busRanges.set(name, range);
      }
    }
  }

  const ports = headerPorts.map(name => {
    const range = busRanges.get(name) || null;
    return {
      name,
      direction: directions.get(name) || null,
      discipline: disciplines.get(name) || null,
      range,
    };
  });

  // Expand bus ports (e.g. `D[14:0]`) in declaration order for exact positional net matching.
  const expandedPorts = [];
  for (const p of ports) {
    if (p.range) {
      const [hi, lo] = p.range;
      const step = hi >= lo ? -1 : 1;
      for (let idx = hi; step < 0 ? idx >= lo : idx <= lo; idx += step) {
        expandedPorts.push(`${p.name}[${idx}]`);
      }
    } else {
      expandedPorts.push(p.name);
    }
  }

  const parameters = [];
  for (const m of clean.matchAll(/\bparameter\s+(?:(real|integer|string)\s+)?([^;]+);/g)) {
    const type = m[1] || 'real';
    const declBody = m[2];
    const stmtLine = lineNumberAt(clean, m.index);
    // Split comma-separated declarations at top level (ignoring commas inside `()`/`[]`/`{}`/`""`).
    const parts = splitTopLevelCommas(declBody);
    for (const part of parts) {
      const assign = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/.exec(part);
      if (!assign) continue;
      const name = assign[1];
      const rhs = assign[2].trim();
      const fromIdx = rhs.search(/\b(?:from|exclude)\b/);
      const defaultValue = (fromIdx >= 0 ? rhs.slice(0, fromIdx) : rhs).trim();
      const range = fromIdx >= 0 ? rhs.slice(fromIdx).trim().replace(/\s+/g, ' ') : null;
      parameters.push({
        type,
        name,
        defaultValue,
        range,
        line: stmtLine,
      });
    }
  }

  const analogMatch = /\banalog\b(?!\s+function\b)/m.exec(clean);
  const analogLine = analogMatch ? lineNumberAt(clean, analogMatch.index) : null;

  return {
    moduleName,
    moduleLine,
    includes,
    ports,
    expandedPorts,
    parameters,
    analogLine,
    lineCount: source ? source.split(/\r?\n/).length : 0,
  };
}

function splitTopLevelCommas(text) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = '';
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
      cur += ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      cur += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Extract `ahdl_include "..."` (Spectre) or `.hdl "..."` (SPICE) file references. */
export function extractAhdlIncludes(netlistText) {
  const source = typeof netlistText === 'string' ? netlistText : '';
  const out = [];
  for (const m of source.matchAll(/^\s*(?:ahdl_include|\.hdl)\s+["']?([^"'\s\r\n]+)["']?/gim)) {
    const ref = m[1].trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * Deduplicate and index all `.va` / `.vams` files declared across loaded library manifests.
 * Files from `preferredLibraryId` take precedence over sibling libraries.
 */
export function indexLibraryVerilogAFiles(libraries, preferredLibraryId = null) {
  const list = Array.isArray(libraries) ? libraries : [];
  const ordered = preferredLibraryId
    ? [...list.filter(l => l?.id === preferredLibraryId), ...list.filter(l => l?.id !== preferredLibraryId)]
    : list;

  const byKey = new Map();
  for (const library of ordered) {
    if (!library || !Array.isArray(library.cells)) continue;
    for (const cell of library.cells) {
      for (const view of cell?.views || []) {
        for (const path of view?.files || []) {
          if (!isVerilogAFile(path)) continue;
          const moduleName = verilogaModuleBasename(path);
          if (!moduleName) continue;
          const key = moduleName.toLowerCase();
          const existing = byKey.get(key);
          if (!existing) {
            byKey.set(key, {
              moduleName,
              key,
              path,
              libraryId: library.id,
              libraryName: library.name || library.id,
              cellId: cell.id,
              allPaths: [path],
            });
          } else if (!existing.allPaths.includes(path)) {
            existing.allPaths.push(path);
          }
        }
      }
    }
  }
  const entries = [...byKey.values()].sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  return { byKey, list: entries };
}

/**
 * Index `.va` / `.vams` files from an in-memory path->text snapshot (local/SSH imports or doc.files).
 * Matches both by parsed `module <Name>` declaration and by filename stem.
 */
export function indexSnapshotVerilogAFiles(snapshotMap, { origin = 'imported' } = {}) {
  const byKey = new Map();
  const seenPath = new Set();
  const list = [];
  if (!snapshotMap || typeof snapshotMap !== 'object') return { byKey, list };

  const entries = snapshotMap instanceof Map ? [...snapshotMap.entries()] : Object.entries(snapshotMap);
  for (const [rawPath, text] of entries) {
    if (!isVerilogAFile(rawPath) || typeof text !== 'string') continue;
    const path = rawPath.replace(/^\/+/, '');
    if (seenPath.has(path)) continue;
    seenPath.add(path);
    const stem = verilogaModuleBasename(path);
    const parsed = parseVerilogAModule(text, stem);
    const moduleName = parsed.moduleName || stem;
    const item = { moduleName, path, text, origin, parsed };
    list.push(item);
    for (const alias of [moduleName, stem]) {
      const k = String(alias || '').toLowerCase();
      if (k && !byKey.has(k)) byKey.set(k, item);
    }
  }
  list.sort((a, b) => a.moduleName.localeCompare(b.moduleName) || a.path.localeCompare(b.path));
  return { byKey, list };
}

/**
 * Parse a joined Spectre or SPICE instance statement to recover master name,
 * ordered port nets, and key=value parameter overrides.
 */
export function parseInstanceStatement(statementText, instanceName = '') {
  const raw = String(statementText || '').trim();
  if (!raw) return { masterName: null, ports: [], params: [] };

  // Strip trailing // comments on each line, join Spectre `\` and SPICE `+` continuations.
  const lines = raw.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '').trimEnd());
  let joined = '';
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('*')) continue;
    if (i > 0 && line.startsWith('+')) line = line.slice(1).trim();
    if (joined.endsWith('\\')) joined = joined.slice(0, -1).trimEnd() + ' ' + line;
    else joined = joined ? joined + ' ' + line : line;
  }
  joined = joined.replace(/\s+/g, ' ').trim();
  if (!joined) return { masterName: null, ports: [], params: [] };

  // Pattern 1: Spectre parenthesized port list: `INST (net1 net2 ...) MASTER param1=v1 ...`
  const spectreMatch = /^([^\s(]+)\s*\(([^)]*)\)\s+([^\s=]+)(.*)$/.exec(joined);
  if (spectreMatch) {
    const ports = spectreMatch[2].trim() ? spectreMatch[2].trim().split(/\s+/) : [];
    const masterName = spectreMatch[3];
    const params = parseParamPairs(spectreMatch[4] || '');
    return { masterName, ports, params };
  }

  // Pattern 2: Unparenthesized Spectre / SPICE: `XINST net1 net2 ... MASTER param1=v1 ...`
  const tokens = tokenizeShellLike(joined);
  if (tokens.length >= 2) {
    let body = tokens.slice(1);
    if (instanceName && tokens[0].toLowerCase() !== instanceName.toLowerCase()) {
      const idx = tokens.findIndex(t => t.toLowerCase() === instanceName.toLowerCase());
      if (idx >= 0) body = tokens.slice(idx + 1);
    }
    const firstParamIdx = body.findIndex(t => t.includes('=') || /^params:?$/i.test(t));
    const head = firstParamIdx >= 0 ? body.slice(0, firstParamIdx) : body;
    const tail = firstParamIdx >= 0 ? body.slice(firstParamIdx).filter(t => !/^params:?$/i.test(t)) : [];
    if (head.length >= 1) {
      const masterName = head[head.length - 1];
      const ports = head.slice(0, -1);
      const params = parseParamPairs(tail.join(' '));
      return { masterName, ports, params };
    }
  }
  return { masterName: null, ports: [], params: [] };
}

function tokenizeShellLike(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = '';
    } else if (ch === '"' || ch === '\'') {
      quote = ch;
      cur += ch;
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseParamPairs(tail) {
  const params = [];
  const tokens = tokenizeShellLike(tail.trim());
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const eq = tok.indexOf('=');
    if (eq > 0) {
      const name = tok.slice(0, eq).trim();
      let value = tok.slice(eq + 1).trim();
      if (!value && i + 1 < tokens.length) value = tokens[++i];
      if (name) params.push({ name, value });
    }
  }
  return params;
}

/**
 * Inspect an RNL document object (`doc.objects[objIndex]`) and extract its
 * instance name, master/model name, connected nets, parameter overrides, and source location.
 */
export function extractInstanceMaster(doc, levelIndex, objIndex) {
  const obj = doc && objIndex !== null && objIndex !== undefined ? doc.objects?.[objIndex] : null;
  if (!obj || obj.kind !== 'instance') return null;

  const lv = doc.levels?.[levelIndex] || doc.levels?.find(l => l.host === obj.level) || null;
  const child = lv?.children?.find(c => c.instance === obj.name) || null;

  let statement = '';
  let file = null;
  let line = null;
  if (Array.isArray(obj.lines) && obj.lines.length >= 3) {
    const [fileIdx, startLine, endLine] = obj.lines;
    const srcFile = doc.files?.[fileIdx];
    file = srcFile?.name || srcFile?.path || null;
    line = startLine;
    if (typeof srcFile?.text === 'string') {
      const allLines = srcFile.text.split(/\r?\n/);
      statement = allLines.slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join('\n');
    }
  }

  const parsed = parseInstanceStatement(statement, obj.name);
  const masterName = child?.master || parsed.masterName || null;

  return {
    instanceName: obj.name,
    masterName,
    opens: obj.opens !== null && obj.opens !== undefined ? obj.opens : null,
    ports: parsed.ports,
    params: parsed.params,
    statement,
    file,
    line,
  };
}

/**
 * Resolve a Verilog-A master/module name across imported files, open RNL doc files,
 * and loaded library catalogs. Returns a descriptor ready to open in the Verilog-A viewer.
 */
export function resolveVerilogAModel({
  masterName,
  importedProject = null,
  doc = null,
  libraries = [],
  activeLibraryId = null,
} = {}) {
  const key = String(masterName || '').trim().toLowerCase();
  if (!key) return null;

  // 1. User-imported local / SSH project files (highest priority for user's own project).
  if (importedProject) {
    const snapshot = Object.create(null);
    if (importedProject.rnlSnapshot && typeof importedProject.rnlSnapshot === 'object') {
      Object.assign(snapshot, importedProject.rnlSnapshot);
    }
    if (importedProject.supportFiles && typeof importedProject.supportFiles === 'object') {
      for (const [k, v] of Object.entries(importedProject.supportFiles)) {
        if (!Object.hasOwn(snapshot, k) && !Object.hasOwn(snapshot, '/' + k)) snapshot[k] = v;
      }
    }
    if (importedProject.fileName && isVerilogAFile(importedProject.fileName) && typeof importedProject.text === 'string') {
      snapshot[importedProject.fileName] = importedProject.text;
    }
    const idx = indexSnapshotVerilogAFiles(snapshot, { origin: importedProject.origin || 'local' });
    const hit = idx.byKey.get(key);
    if (hit) {
      return {
        sourceType: 'inline',
        moduleName: hit.moduleName,
        path: hit.path,
        text: hit.text,
        origin: importedProject.origin === 'ssh' ? `SSH · ${importedProject.sshTarget || ''}` : '本地导入',
        siblings: idx.list,
      };
    }
  }

  // 2. Files already loaded inside the active RNL document.
  if (doc && Array.isArray(doc.files)) {
    const docSnap = Object.create(null);
    for (const f of doc.files) {
      if (f?.path && typeof f.text === 'string' && isVerilogAFile(f.path)) {
        docSnap[f.path] = f.text;
      }
    }
    const idx = indexSnapshotVerilogAFiles(docSnap, { origin: 'document' });
    const hit = idx.byKey.get(key);
    if (hit) {
      return {
        sourceType: 'inline',
        moduleName: hit.moduleName,
        path: hit.path,
        text: hit.text,
        origin: '当前文档',
        siblings: idx.list,
      };
    }
  }

  // 3. Indexed library manifests (preferring the currently active library).
  if (Array.isArray(libraries) && libraries.length) {
    const idx = indexLibraryVerilogAFiles(libraries, activeLibraryId);
    const hit = idx.byKey.get(key);
    if (hit) {
      // Collect sibling `.va` models from the same library (or active library) for quick switching.
      const libSiblings = idx.list.filter(item => item.libraryId === (activeLibraryId || hit.libraryId));
      return {
        sourceType: 'library',
        moduleName: hit.moduleName,
        path: hit.path,
        libraryId: hit.libraryId,
        libraryName: hit.libraryName,
        cellId: hit.cellId,
        origin: hit.libraryName,
        siblings: libSiblings.length ? libSiblings : idx.list,
      };
    }
  }

  return null;
}

const VA_KEYWORDS = new Set([
  'module', 'endmodule', 'input', 'output', 'inout', 'electrical', 'voltage', 'current',
  'magnetic', 'thermal', 'kinematic', 'rotational', 'parameter', 'localparam', 'real',
  'integer', 'string', 'genvar', 'from', 'exclude', 'inf', 'analog', 'begin', 'end',
  'function', 'endfunction', 'if', 'else', 'for', 'while', 'case', 'endcase', 'default',
  'generate', 'endgenerate', 'branch', 'discipline', 'enddiscipline', 'nature', 'endnature',
  'ground', 'aliasparam',
]);

const VA_BUILTINS = new Set([
  'V', 'I', 'ddt', 'idt', 'idtmod', 'transition', 'slew', 'absdelay', 'laplace_nd',
  'laplace_np', 'laplace_zd', 'laplace_zp', 'zi_nd', 'zi_np', 'zi_zd', 'zi_zp',
  'cross', 'above', 'timer', 'initial_step', 'final_step', 'analysis', 'ac_stim',
  'white_noise', 'flicker_noise', 'noise_table', 'abs', 'exp', 'ln', 'log', 'sqrt',
  'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'max', 'min', 'hypot', 'floor', 'ceil', 'limexp', 'bound_step', 'discontinuity',
  'last_crossing',
]);

/**
 * Tokenize a single Verilog-A source line into safe typed spans (no HTML escaping needed
 * when callers render via `textContent`). Tracks multi-line block comments across calls.
 */
export function tokenizeVerilogALine(line, inBlockComment = false) {
  const tokens = [];
  const src = String(line ?? '');
  let i = 0;
  const n = src.length;
  let block = Boolean(inBlockComment);

  const push = (type, text) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === type) prev.text += text;
    else tokens.push({ type, text });
  };

  while (i < n) {
    if (block) {
      const end = src.indexOf('*/', i);
      if (end < 0) {
        push('comment', src.slice(i));
        return { tokens, inBlockComment: true };
      }
      push('comment', src.slice(i, end + 2));
      i = end + 2;
      block = false;
      continue;
    }

    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      push('comment', src.slice(i));
      break;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) {
        push('comment', src.slice(i));
        block = true;
        break;
      }
      push('comment', src.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) j += 2;
        else j++;
      }
      if (j < n) j++;
      push('string', src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '<' && next === '+') {
      push('operator', '<+');
      i += 2;
      continue;
    }
    if (ch === '`') {
      const m = /^`[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m) { push('directive', m[0]); i += m[0].length; continue; }
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m) { push('builtin', m[0]); i += m[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i));
      const word = m[0];
      if (VA_KEYWORDS.has(word)) push('keyword', word);
      else if (VA_BUILTINS.has(word)) push('builtin', word);
      else push('plain', word);
      i += word.length;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:[TGMKkmunpfa](?![A-Za-z0-9_]))?/.exec(src.slice(i));
      if (m) { push('number', m[0]); i += m[0].length; continue; }
    }
    push('plain', ch);
    i++;
  }

  return { tokens, inBlockComment: block };
}
