// Compatibility for saved Studio URLs. Plain RNL and its embedded API keep their own entry.
if (new URLSearchParams(location.search).get('studio') === '1' && !new URLSearchParams(location.search).has('embed')) {
  const target = new URL('./index.html', document.currentScript.src);
  target.search = location.search;
  target.searchParams.set('layout', 'dockview');
  target.hash = location.hash;
  location.replace(target);
}
