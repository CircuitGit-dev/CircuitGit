
// ?debug=keys: a corner of the page lists the last keys and focus changes, what each key reached
// and why the page ran no command for it (window.rnlKeyNote, which the page's handlers call). The
// listeners are on window in the capture phase, before anything of the page or an extension in it.
if (new URLSearchParams(location.search).get("debug") === "keys") (function () {
  var keys = [], focus = [];
  var name = function (el) {
    if (!el) return "none";
    if (el === window) return "window";
    if (el === document) return "document";
    if (el.nodeType !== 1) return el.nodeName;
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + el.classList[0] : "") +
      (el.getAttribute("role") ? "[" + el.getAttribute("role") + "]" : "");
  };
  var panel = document.createElement("pre");
  panel.id = "key-debug";
  panel.setAttribute("style", "position:fixed;right:8px;bottom:8px;z-index:2147483647;max-width:min(720px,calc(100vw - 16px));" +
    "max-height:60vh;overflow:auto;margin:0;padding:8px 10px;font:11px/1.45 ui-monospace,Consolas,monospace;" +
    "white-space:pre-wrap;color:#111;background:rgba(255,255,230,.96);border:1px solid #aa8;border-radius:6px;");
  var show = function () {
    var lines = ["keys (newest first) - focus now: " + name(document.activeElement) + ", page has focus: " + document.hasFocus() +
      ", starting: " + document.body.classList.contains("starting")];
    keys.forEach(function (k) {
      lines.push(k.time + " key=" + JSON.stringify(k.key) + " code=" + k.code + (k.mods ? " " + k.mods : "") + (k.repeat ? " repeat" : "") +
        "\n    target=" + k.target + " active=" + k.active + " focus=" + k.focus + " prevented=" + k.prevented +
        "\n    " + (k.notes.length ? k.notes.join("; ") : "reached no handler of the page"));
    });
    lines.push("focus changes (newest first):");
    focus.forEach(function (f) { lines.push("  " + f); });
    panel.textContent = lines.join("\n");
  };
  var stamp = function () { return new Date().toISOString().slice(11, 23); };
  window.rnlKeyNote = function (event, what) {
    for (var i = 0; i < keys.length; i++) if (keys[i].event === event) { keys[i].notes.push(what); show(); return; }
  };
  window.addEventListener("keydown", function (e) {
    var k = { event: e, time: stamp(), key: e.key, code: e.code, repeat: e.repeat, target: name(e.target),
      active: name(document.activeElement), focus: document.hasFocus(), prevented: "?", notes: [],
      mods: ["ctrlKey", "metaKey", "altKey", "shiftKey"].filter(function (m) { return e[m]; }).map(function (m) { return m.slice(0, -3); }).join("+") };
    keys.unshift(k);
    keys.length = Math.min(keys.length, 10);
    setTimeout(function () { k.prevented = e.defaultPrevented; show(); });
    show();
  }, true);
  ["focus", "blur"].forEach(function (type) {
    window.addEventListener(type, function (e) {
      focus.unshift(stamp() + " " + type + " " + name(e.target));
      focus.length = Math.min(focus.length, 10);
      show();
    }, true);
  });
  document.body.append(panel);
  show();
})();
