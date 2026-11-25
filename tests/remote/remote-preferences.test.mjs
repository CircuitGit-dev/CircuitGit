import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  normalizeRemoteSimPrefs,
  loadRemoteSimPrefs,
  saveRemoteSimPrefs,
  clearRemoteSimPrefs,
} from '../../modules/simulation/environment/preferences.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, val) => map.set(key, String(val)),
    removeItem: key => map.delete(key),
    _map: map,
  };
}

test('normalizeRemoteSimPrefs sanitizes targets, deduplicates, and caps limits', () => {
  const res = normalizeRemoteSimPrefs({
    targets: [' eda-01 ', 'eda-01', '-bad-flag', 'bad host', 'user@eda-02', '', 'a'.repeat(300)],
    search_paths: '  /opt/pdk/sky130\n/opt/pdk/gf180  ',
    cds_lib_hint: ' /proj/cds.lib ',
  });
  assert.equal(res.schema, 'circuitgit.remote-sim-prefs.v1');
  assert.deepEqual(res.targets, ['eda-01', 'user@eda-02']);
  assert.equal(res.search_paths, '/opt/pdk/sky130\n/opt/pdk/gf180');
  assert.equal(res.cds_lib_hint, '/proj/cds.lib');
});

test('normalizeRemoteSimPrefs returns null when empty or invalid', () => {
  assert.equal(normalizeRemoteSimPrefs(null), null);
  assert.equal(normalizeRemoteSimPrefs({targets: ['-invalid'], search_paths: '  ', cds_lib_hint: ''}), null);
});

test('save, load, and clear round-trip through storage and ignore malformed payloads', () => {
  const storage = memoryStorage();
  assert.equal(loadRemoteSimPrefs(storage), null);

  const saved = saveRemoteSimPrefs({targets: ['eda-prod'], search_paths: '/pdk/tsmc', cds_lib_hint: '/work/cds.lib'}, storage);
  assert.ok(saved);
  assert.ok(storage._map.has(STORAGE_KEY));

  const loaded = loadRemoteSimPrefs(storage);
  assert.deepEqual(loaded.targets, ['eda-prod']);
  assert.equal(loaded.search_paths, '/pdk/tsmc');
  assert.equal(loaded.cds_lib_hint, '/work/cds.lib');

  clearRemoteSimPrefs(storage);
  assert.equal(loadRemoteSimPrefs(storage), null);

  // Wrong schema or corrupt JSON is safely ignored.
  storage.setItem(STORAGE_KEY, '{"schema":"wrong","targets":["eda"]}');
  assert.equal(loadRemoteSimPrefs(storage), null);
  storage.setItem(STORAGE_KEY, '{not-json');
  assert.equal(loadRemoteSimPrefs(storage), null);
});
