
// Panel number keys pressed before startup.js runs, which on a slow network can take seconds: it
// adopts them (startup.js), and the last usable one runs once the viewer has started.
window.rnlEarlyKeys = [];
window.rnlEarlyKeyListener = function (event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !/^[1-7]$/.test(event.key)) return;
  if (!(event.target instanceof Element) || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog')) return;
  window.rnlEarlyKeys.push(event.key);
  event.preventDefault();
  if (window.rnlKeyNote) window.rnlKeyNote(event, "kept before startup.js ran");
};
if (new URLSearchParams(location.search).get("embed") !== "1") document.addEventListener("keydown", window.rnlEarlyKeyListener);
