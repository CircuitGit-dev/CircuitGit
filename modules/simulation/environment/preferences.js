// Non-secret user preferences for remote simulation hosts and PDK search hints.
// Never stores credentials, tokens, keys, or private model contents.
export const STORAGE_KEY = 'circuitgit.remote-sim-prefs.v1';

const validTarget = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 240 &&
  value.trim() === value &&
  !/[\s\0]/.test(value) &&
  !value.startsWith('-');

const cleanText = (value, max) =>
  typeof value === 'string' && !value.includes('\0') ? value.trim().slice(0, max) : '';

export function normalizeRemoteSimPrefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const targets = Array.isArray(raw.targets)
    ? [...new Set(raw.targets.map(v => (typeof v === 'string' ? v.trim() : '')).filter(validTarget))].slice(0, 8)
    : [];
  const search_paths = cleanText(raw.search_paths, 4000);
  const cds_lib_hint = cleanText(raw.cds_lib_hint, 1000);
  if (!targets.length && !search_paths && !cds_lib_hint) return null;
  return {
    schema: 'circuitgit.remote-sim-prefs.v1',
    targets,
    search_paths,
    cds_lib_hint,
    saved_at: typeof raw.saved_at === 'string' ? raw.saved_at.slice(0, 64) : new Date().toISOString(),
  };
}

function defaultStorage() {
  try {
    return typeof globalThis !== 'undefined' ? globalThis.localStorage ?? null : null;
  } catch {
    return null;
  }
}

export function loadRemoteSimPrefs(storage = defaultStorage()) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 16384) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== 'circuitgit.remote-sim-prefs.v1') return null;
    return normalizeRemoteSimPrefs(parsed);
  } catch {
    return null;
  }
}

export function saveRemoteSimPrefs(prefs, storage = defaultStorage()) {
  const normalized = normalizeRemoteSimPrefs(prefs);
  if (!normalized || !storage || typeof storage.setItem !== 'function') return null;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return null;
  }
}

export function clearRemoteSimPrefs(storage = defaultStorage()) {
  if (!storage || typeof storage.removeItem !== 'function') return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {}
}
