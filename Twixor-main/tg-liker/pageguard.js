// TG LIKER pageguard — X page er MAIN world e document_start e cholo.
// Tab / window dhaka porle (onno window upore ashle) X ke bole dey "ami ekhono visible + focused".
(() => {
  try {
    if (window.__TGL_GUARD__) return;
    window.__TGL_GUARD__ = true;
    const def = (obj, prop, val) => { try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {} };
    def(Document.prototype, 'hidden', false);
    def(Document.prototype, 'webkitHidden', false);
    def(Document.prototype, 'visibilityState', 'visible');
    def(Document.prototype, 'webkitVisibilityState', 'visible');
    try { Document.prototype.hasFocus = function () { return true; }; } catch (e) {}
    const kill = (e) => { e.stopImmediatePropagation(); };
    ['visibilitychange', 'webkitvisibilitychange', 'pagehide', 'freeze', 'blur'].forEach((n) => {
      window.addEventListener(n, kill, true);
      document.addEventListener(n, kill, true);
    });
  } catch (e) {}
})();
