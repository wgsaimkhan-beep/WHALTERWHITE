/**
 * ATOMX TAB SHIELD — MAIN WORLD PROTECTOR
 * Registered in manifest.json with "world": "MAIN" and "run_at": "document_start".
 * Runs inside the page's execution context before Twitter/X scripts load.
 * Permanently neutralizes window.close, Window.prototype.close, self.close,
 * and dangerous history.back() on /home, ensuring Twitter router never closes the browser tab.
 */
(function() {
  'use strict';

  if (window.__atomx_tab_shield_active) return;
  window.__atomx_tab_shield_active = true;

  const blockedClose = function() {
    console.warn('[ATOMX TAB SHIELD] Intercepted and blocked script call to window.close()');
    try {
      if (window.location && window.location.pathname && window.location.pathname.includes('/compose/post')) {
        window.history.replaceState({}, '', '/home');
      }
    } catch (e) {}
    return false;
  };

  // 1. Lock down window.close
  try {
    Object.defineProperty(window, 'close', {
      value: blockedClose,
      writable: false,
      configurable: false
    });
  } catch (e) {
    try { window.close = blockedClose; } catch (err) {}
  }

  // 2. Lock down Window.prototype.close
  try {
    if (typeof Window !== 'undefined' && Window.prototype) {
      Object.defineProperty(Window.prototype, 'close', {
        value: blockedClose,
        writable: false,
        configurable: false
      });
    }
  } catch (e) {}

  // 3. Lock down self.close, top.close, parent.close
  try { self.close = blockedClose; } catch (e) {}
  try { if (window.top) window.top.close = blockedClose; } catch (e) {}
  try { if (window.parent) window.parent.close = blockedClose; } catch (e) {}

  // 4. Trap window.open so spawned references cannot call .close()
  try {
    const origOpen = window.open;
    window.open = function() {
      const win = origOpen.apply(window, arguments);
      if (win) {
        try {
          Object.defineProperty(win, 'close', { value: blockedClose, writable: false, configurable: false });
        } catch (e) {
          try { win.close = blockedClose; } catch (err) {}
        }
      }
      return win;
    };
  } catch (e) {}

  // 5. Guard history.back on /home to prevent exiting the timeline into a blank/closed tab
  try {
    const origBack = window.history.back;
    window.history.back = function() {
      if (window.location && window.location.pathname === '/home' && window.history.length <= 2) {
        console.warn('[ATOMX TAB SHIELD] Intercepted history.back() on /home to prevent leaving feed.');
        return;
      }
      return origBack.apply(window.history, arguments);
    };
  } catch (e) {}

  // 6. Suppress beforeunload prompt that can stall or crash tabs
  try {
    window.addEventListener('beforeunload', function(e) {
      try { e.stopImmediatePropagation(); } catch (err) {}
    }, true);
  } catch (e) {}

  console.log('[ATOMX TAB SHIELD] MAIN world tab close protection active.');
})();
