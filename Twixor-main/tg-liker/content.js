// =====================================================================
// TG LIKER — content script (X / Twitter page er vitore cholo)
// Kono server / login / credit nai. Shob kichu local browser e.
//
// Storage keys:
//   tgl_cfg   -> popup likhe (settings + targets)         [content shudhu pore]
//   tgl_ctrl  -> popup likhe (running / paused / stopped) [content shudhu pore]
//   tgl_state -> content likhe (stats, status, progress)   [popup shudhu pore]
//   tgl_hourlog -> content likhe (hourly limit er jonno timestamps)
// =====================================================================
(() => {
  'use strict';
  try { if (window.__TGL_LOADED__ && window.__TGL_ALIVE__ && window.__TGL_ALIVE__()) return; } catch (e) {}
  window.__TGL_LOADED__ = true;
  window.__TGL_ALIVE__ = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  const K = { cfg: 'tgl_cfg', ctrl: 'tgl_ctrl', state: 'tgl_state', hour: 'tgl_hourlog', seen: 'tgl_seen' };

  // ---- Background-proof timer: Worker er timer tab hidden/dhaka thakleo throttle hoy na
  const _tw = (() => {
    try {
      const src = 'self.onmessage=function(e){var d=e.data;setTimeout(function(){self.postMessage(d.id)},d.ms)}';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const pend = new Map(); let nid = 1; let broken = false;
      w.onmessage = (e) => { const f = pend.get(e.data); if (f) { pend.delete(e.data); f(); } };
      w.onerror = () => { broken = true; pend.forEach((f) => f()); pend.clear(); };
      return (ms) => new Promise((r) => {
        if (broken) return setTimeout(r, ms);
        const id = nid++; pend.set(id, r);
        try { w.postMessage({ id, ms }); } catch (e) { pend.delete(id); setTimeout(r, ms); }
      });
    } catch (e) { return null; }
  })();
  const sleep = (ms) => (_tw ? _tw(ms) : new Promise((r) => setTimeout(r, ms)));

  // ---- Keep-alive: job cholar shomoy tab ke "active" rakhe (background e gele-o)
  let _audio = null;
  function keepAlive(on) {
    try { chrome.runtime.sendMessage({ type: 'keepalive', on: !!on }, () => void chrome.runtime.lastError); } catch (e) {}
    try {
      if (on) {
        if (!_audio) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            const ctx = new AC(); const osc = ctx.createOscillator(); const g = ctx.createGain();
            g.gain.value = 0.0001; osc.frequency.value = 30; osc.connect(g); g.connect(ctx.destination); osc.start();
            _audio = ctx;
          }
        }
        if (_audio && _audio.state === 'suspended') _audio.resume().catch(() => {});
        if (navigator.locks && !window.__TGL_LOCK__) {
          window.__TGL_LOCK__ = true;
          navigator.locks.request('tgl-keepalive', () => new Promise(() => {})).catch(() => {});
        }
      } else if (_audio) { try { _audio.close(); } catch (e) {} _audio = null; }
    } catch (e) {}
  }

  // ---- Stop at post: article theke handle/text ber kora + match
  let stopCount = 0;   // text match koyta hoyeche (nth er jonno)
  const normTxt = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function articleInfo(a) {
    let handle = '';
    const un = a.querySelector('[data-testid="User-Name"]');
    if (un) { const m = (un.textContent || '').match(/@([A-Za-z0-9_]{1,15})/); if (m) handle = m[1]; }
    const tt = a.querySelector('[data-testid="tweetText"]');
    return { id: articleId(a), handle, text: tt ? (tt.textContent || '') : '' };
  }
  function matchesStop(stop, a, id) {
    if (!stop || (!stop.id && !stop.handle && !stop.text)) return false;
    if (stop.id) return id === stop.id;
    const info = articleInfo(a);
    if (stop.handle && info.handle.toLowerCase() !== String(stop.handle).toLowerCase()) return false;
    const want = normTxt(stop.text);
    let hit;
    if (!want) hit = !!stop.handle;
    else { const have = normTxt(info.text); hit = have.length >= 6 && (have.includes(want) || want.includes(have)); }
    if (!hit) return false;
    stopCount++;
    return stopCount >= (stop.nth || 1);
  }

  // ---- Pick mode: user page e post e click korle oi post ke stop point hishebe save kore
  let pickOn = false;
  function startPick() {
    if (pickOn) return;
    pickOn = true;
    const bar = document.createElement('div');
    bar.textContent = '📍 Jei post e thamte chao oi post e click koro  (Esc = cancel)';
    bar.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0e7490;color:#fff;padding:9px 16px;border-radius:999px;font:600 14px system-ui;box-shadow:0 4px 18px rgba(0,0,0,.5);pointer-events:none';
    document.documentElement.appendChild(bar);
    let hl = null;
    const clearHl = () => { if (hl) { hl.style.outline = ''; hl.style.outlineOffset = ''; hl = null; } };
    const artOf = (t) => (t && t.closest ? t.closest('article[data-testid="tweet"]') : null);
    const over = (e) => { const a = artOf(e.target); if (a === hl) return; clearHl(); if (a) { hl = a; a.style.outline = '3px solid #22d3ee'; a.style.outlineOffset = '-3px'; } };
    const finish = () => {
      pickOn = false; clearHl(); bar.remove();
      ['mouseover', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((n) => document.removeEventListener(n, n === 'mouseover' ? over : swallow, true));
      document.removeEventListener('keydown', key, true);
    };
    const swallow = (e) => {
      const a = artOf(e.target);
      if (!a) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.type !== 'click') return;
      const info = articleInfo(a);
      if (!info.id) { bar.textContent = '⚠ Ei post e id pawa jayni, onno post e click koro'; return; }
      try { chrome.storage.local.set({ tgl_stoppick: { id: info.id, handle: info.handle, text: normTxt(info.text).slice(0, 140), at: Date.now() } }); } catch (x) {}
      finish();
    };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(); } };
    document.addEventListener('mouseover', over, true);
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((n) => document.addEventListener(n, swallow, true));
    document.addEventListener('keydown', key, true);
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  let ctrl = { state: 'stopped', runId: 0 };
  let S = {};            // content-written state
  let hourLog = [];      // last 1 hour er action timestamps
  let myRun = null;
  let seenMap = {};      // { [targetUrl]: [post ids jegulo already handle hoyeche] } — Continue er jonno "jekhane shesh" mone rakhe
  let seenCtx = null;
  let pauseStart = 0;
  let consec = null;    // ei page er seen list
  let dead = false;
  let busy = false;

  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[K.ctrl]) {
      ctrl = changes[K.ctrl].newValue || { state: 'stopped', runId: 0 };
    }
  });

  // ---------------------------------------------------------------- state / status
  let lastStatus = '';
  let lastStatusAt = 0;

  async function save(patch) {
    if (!extAlive()) { dead = true; return; }
    Object.assign(S, patch);
    try { await chrome.storage.local.set({ [K.state]: S }); } catch (e) { dead = true; }
  }

  function status(text, force) {
    const now = Date.now();
    if (!force && (text === lastStatus || now - lastStatusAt < 200)) return;
    lastStatus = text;
    lastStatusAt = now;
    save({ status: text });
  }

  async function saveHour() {
    if (!extAlive()) return;
    try { await chrome.storage.local.set({ [K.hour]: hourLog }); } catch (e) {}
  }

  async function flushSeen() {
    if (!seenCtx || !extAlive()) return;
    seenMap[seenCtx.url] = seenCtx.list.slice(-4000);
    try { await chrome.storage.local.set({ [K.seen]: seenMap }); } catch (e) {}
  }

  function markSeen(id) {
    if (!seenCtx) return;
    seenCtx.list.push(id);
    if (seenCtx.list.length % 5 === 0) flushSeen();
  }

  // Pause / Stop gate: paused hole ekhane thake, stopped hole false return kore
  async function gate() {
    while (true) {
      if (dead || !extAlive()) return false;
      if (ctrl.runId !== myRun || ctrl.state === 'stopped') return false;
      if (ctrl.state === 'paused') {
        if (!pauseStart) { pauseStart = Date.now(); save({ pausedAt: pauseStart }); }
        status('⏸ Paused');
        await sleep(250);
        continue;
      }
      if (pauseStart) {
        const d = Date.now() - pauseStart;
        pauseStart = 0;
        save({ pausedMs: (S.pausedMs || 0) + d, pausedAt: null });
      }
      return true;
    }
  }

  async function waitUntil(fn, maxMs, step = 50) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (dead || ctrl.state === 'stopped' || ctrl.runId !== myRun) return false;
      try { if (fn()) return true; } catch (e) {}
      await sleep(step);
    }
    try { return !!fn(); } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- DOM helpers
  const isLiked = (a) => !!a.querySelector('[data-testid="unlike"]');

  function articleId(a) {
    const timeLink = a.querySelector('a[href*="/status/"] time');
    const link = (timeLink && timeLink.closest('a')) || a.querySelector('a[href*="/status/"]');
    const href = (link && link.getAttribute('href')) || '';
    const m = href.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  const articlesNow = () =>
    Array.from((document.querySelector('div[data-testid="primaryColumn"]') || document)
      .querySelectorAll('article[data-testid="tweet"]'));

  async function clickShowMore() {
    const btn = Array.from(document.querySelectorAll('div[role="button"], button')).find((b) => {
      const t = (b.textContent || '').trim();
      return t.length < 90 && /show (more|additional) replies|show probable spam/i.test(t);
    });
    if (btn) { try { btn.click(); } catch (e) {} await sleep(1000); }
  }

  const nextFrame = () => new Promise((res) => {
    let fired = false;
    const f = () => { if (!fired) { fired = true; res(); } };
    requestAnimationFrame(f);
    setTimeout(f, 50);   // background tab e rAF thame jay, tai fallback
  });

  // ---------------------------------------------------------------- virtual mouse cursor
  let cursorEl = null;
  let cur = { x: 0, y: 0 };

  function placeCursor(x, y) {
    cur = { x, y };
    if (cursorEl) cursorEl.style.transform = `translate3d(${Math.round(x - 3)}px, ${Math.round(y - 2)}px, 0)`;
  }

  function ensureCursor() {
    if (cursorEl && cursorEl.isConnected) return;
    cursorEl = document.createElement('div');
    cursorEl.id = 'tgl-cursor';
    cursorEl.style.cssText =
      'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;' +
      'will-change:transform;filter:drop-shadow(0 2px 3px rgba(0,0,0,.55));';
    cursorEl.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;transform-origin:3px 2px">' +
      '<path d="M3 2v17l4.6-4.1 3 6.6 2.7-1.2-3-6.5H17z" fill="#fff" stroke="#0b0b0b" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursorEl);
    if (!cur.x && !cur.y) cur = { x: window.innerWidth * 0.62, y: window.innerHeight * 0.55 };
    placeCursor(cur.x, cur.y);
  }

  function removeCursor() {
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
  }

  // Curved path e cursor chalano (ease-in-out)
  async function moveCursor(tx, ty, ms) {
    ensureCursor();
    const sx = cur.x, sy = cur.y;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 3) { placeCursor(tx, ty); return; }
    const nx = -dy / dist, ny = dx / dist;
    const bend = (Math.random() - 0.5) * Math.min(80, dist * 0.3);
    const cx = sx + dx / 2 + nx * bend;
    const cy = sy + dy / 2 + ny * bend;
    const t0 = performance.now();
    while (true) {
      if (dead) return;
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const u = 1 - e;
      placeCursor(u * u * sx + 2 * u * e * cx + e * e * tx, u * u * sy + 2 * u * e * cy + e * e * ty);
      if (t >= 1) break;
      await nextFrame();
    }
  }

  function clickEffect(x, y, color) {
    const svg = cursorEl && cursorEl.firstElementChild;
    if (svg && svg.animate) {
      svg.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }],
        { duration: 220, easing: 'ease-out' });
    }
    const ring = document.createElement('div');
    ring.style.cssText =
      `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;` +
      `border:2px solid ${color};background:${color}33;z-index:2147483646;pointer-events:none;`;
    document.documentElement.appendChild(ring);
    if (ring.animate) {
      const an = ring.animate([{ transform: 'scale(.3)', opacity: 0.95 }, { transform: 'scale(1.9)', opacity: 0 }],
        { duration: 480, easing: 'ease-out' });
      an.onfinish = () => ring.remove();
    } else {
      setTimeout(() => ring.remove(), 480);
    }
  }

  function dispatchClick(el, x, y) {
    const PE = window.PointerEvent || MouseEvent;
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
    const p = { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PE('pointerover', p));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new PE('pointermove', p));
    el.dispatchEvent(new MouseEvent('mousemove', o));
    el.dispatchEvent(new PE('pointerdown', { ...p, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    el.dispatchEvent(new PE('pointerup', p));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // Cursor element er upore jabe, ektu thambe, tarpor click
  async function humanClick(el, color, delay) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { el.click(); return; }
    const x = r.left + r.width * rand(0.3, 0.7);
    const y = r.top + r.height * rand(0.3, 0.7);
    const cursorMs = clamp(delay * 0.15, 220, 500);
    const dist = Math.hypot(x - cur.x, y - cur.y);
    await moveCursor(x, y, clamp(cursorMs + dist * 0.25, cursorMs, 650));
    await sleep(clamp(delay * 0.05, 70, 250));          // button er upor ektu thame
    clickEffect(x, y, color);
    await sleep(rand(60, 110));                          // press hold
    let target = el;
    try {                                                // asol click er moto cursor er niche je element ache seta
      const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
      if (hit && el.contains(hit)) target = hit;
    } catch (e) {}
    dispatchClick(target, x, y);
  }

  // ---------------------------------------------------------------- TRUSTED CLICK (Chrome debugger diye asol mouse click)
  // Synthetic click X e kaj na korle eta fallback. Browser zoom er jonno coordinate AUTO calibrate hoy.
  const trustedEvent = (e) => e.isTrusted || window.__TGL_TEST__ === true;
  let trustedScale = null;
  let trustedErr = '';

  const sendTrusted = (action, x, y) => new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'trusted', action, x, y }, (r) => {
        if (chrome.runtime.lastError) return res({ ok: false, error: chrome.runtime.lastError.message });
        res(r || { ok: false, error: 'no response' });
      });
    } catch (e) { res({ ok: false, error: String(e) }); }
  });

  function detachTrusted() {
    try { chrome.runtime.sendMessage({ type: 'trusted', action: 'detach' }, () => void chrome.runtime.lastError); } catch (e) {}
  }

  // Ekta trusted mouse-move pathiye dekhi page e kothay pouchhay, tahole zoom er scale ber hoy
  async function calibrateTrusted(x, y) {
    let got = null;
    const h = (e) => { if (trustedEvent(e)) got = { x: e.clientX, y: e.clientY }; };
    document.addEventListener('mousemove', h, true);
    const r = await sendTrusted('move', x, y);
    if (!r.ok) { document.removeEventListener('mousemove', h, true); trustedErr = r.error || 'attach hoyni'; return false; }
    await waitUntil(() => got, 700, 30);
    document.removeEventListener('mousemove', h, true);
    if (!got) { trustedErr = 'trusted mouse event page e pouchhayni'; return false; }
    let sc = got.x > 1 ? x / got.x : 1;
    if (!(sc > 0.4 && sc < 3)) sc = 1;
    if (Math.abs(sc - 1) < 0.03) sc = 1;
    trustedScale = sc;
    return true;
  }

  async function trustedClickEl(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { trustedErr = 'element dekha jachhe na'; return false; }
    const x = r.left + r.width * rand(0.35, 0.65);
    const y = r.top + r.height * rand(0.35, 0.65);
    if (trustedScale == null && !(await calibrateTrusted(x, y))) return false;
    if (cursorEl) { await moveCursor(x, y, 260); clickEffect(x, y, '#facc15'); }   // human mode e cursor o dekhabe
    const resp = await sendTrusted('click', x * trustedScale, y * trustedScale);
    if (!resp.ok) { trustedErr = resp.error || 'click pathano gelo na'; return false; }
    return true;
  }

  async function tryTrusted(getEl, isDone) {
    const el = getEl();
    if (!el || !el.isConnected) return false;
    if (!(await trustedClickEl(el))) return false;
    return await waitUntil(isDone, 1000);
  }

  // Like / Bookmark: normal click -> direct .click() -> trusted click (kon ta kaj kore seta mone rakhe)
  async function smartClick(getEl, isDone, color, human, delay, waitMs) {
    let el = getEl();
    if (!el) return { ok: false, reason: 'button pawa jayni' };
    if (S.trusted && (await tryTrusted(getEl, isDone))) return { ok: true };
    if (isDone()) return { ok: true };
    if (human) await humanClick(el, color, delay); else el.click();
    if (await waitUntil(isDone, waitMs)) return { ok: true };
    if (ctrl.state === 'stopped') return { ok: false, reason: 'stopped' };
    el = getEl();
    if (el) { try { el.click(); } catch (e) {} if (await waitUntil(isDone, 700)) return { ok: true }; }
    if (!S.trusted && (await tryTrusted(getEl, isDone))) { S.trusted = true; save({ trusted: true }); return { ok: true }; }
    return { ok: false, reason: 'click register hoyni' + (trustedErr ? ` (trusted click: ${trustedErr})` : '') };
  }

  // ---------------------------------------------------------------- repost menu helpers
  // "Repost" option: testid diye, na hole menuitem er text diye khuje
  function findRepostMenuItem() {
    const byId = document.querySelector('[data-testid="retweetConfirm"]');
    if (byId) return byId;
    const cands = document.querySelectorAll('[role="menuitem"], [role="menu"] a, [role="menu"] [role="button"]');
    for (const el of cands) {
      if (/^\s*repost\s*$/i.test((el.textContent || '').trim())) return el;
    }
    return null;
  }
  const repostMenuOpen = () => !!findRepostMenuItem();

  // Menu sotti bondho kore (Escape er sathe keyCode 27 + mask click)
  async function closeRepostMenu() {
    for (let i = 0; i < 3; i++) {
      if (!repostMenuOpen()) return true;
      const kd = (t) => new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
      [document.activeElement, document, document.body].filter(Boolean).forEach((t) => {
        try { t.dispatchEvent(kd('keydown')); t.dispatchEvent(kd('keyup')); } catch (e) {}
      });
      await sleep(250);
      if (!repostMenuOpen()) return true;
      const mask = document.querySelector('[data-testid="mask"]');
      if (mask) { try { mask.click(); } catch (e) {} await sleep(250); }
    }
    return !repostMenuOpen();
  }

  // Repost: menu khole, "Repost" e click (koyekta paddhoti try kore), verify kore. Return { ok, reason }
  async function doRepost(rt, getArticle, human, delay, SPEED) {
    if (human) await humanClick(rt, '#10B981', delay); else rt.click();

    let item = null;
    await waitUntil(() => (item = findRepostMenuItem()), SPEED.menuMax);
    if (!item) {
      await closeRepostMenu();
      return { ok: false, reason: 'Repost menu te "Repost" option khuje pai nai' };
    }

    await sleep(120);                                  // menu animation shesh hok

    const synthetic = [];
    if (human) synthetic.push({ name: 'cursor', fn: (it) => humanClick(it, '#10B981', delay) });
    synthetic.push({ name: 'click', fn: (it) => { it.click(); } });
    synthetic.push({ name: 'point', fn: (it) => {
      const r = it.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(cx, cy) : null;
      dispatchClick(hit || it, cx, cy);
    } });
    const trustedStep = { name: 'trusted', fn: (it) => trustedClickEl(it) };
    // Ager bar trusted lagle ei bar prothome trusted
    const strategies = S.trusted ? [trustedStep, ...synthetic] : [...synthetic, trustedStep];

    let used = '';
    for (const st of strategies) {
      const it = findRepostMenuItem();
      if (!it) break;                                   // menu already bondho = click kaj korechhe
      try { await st.fn(it); } catch (e) {}
      await waitUntil(() => !repostMenuOpen(), 900, 60);
      if (!repostMenuOpen()) { used = st.name; break; }
      if (ctrl.state === 'stopped') break;
    }

    if (repostMenuOpen()) {
      await closeRepostMenu();
      return { ok: false, reason: 'Repost option e click kaj korchhe na' + (trustedErr ? ` (trusted click: ${trustedErr})` : '') };
    }
    if (used === 'trusted' && !S.trusted) { S.trusted = true; save({ trusted: true }); }
    const ok = await waitUntil(() => getArticle().querySelector('[data-testid="unretweet"]'), SPEED.likeMax);
    return ok ? { ok: true } : { ok: false, reason: 'Menu bondho holo kintu repost confirm hoyni' };
  }

  // ---------------------------------------------------------------- smooth scroll
  async function glideScroll(dy, ms) {
    if (Math.abs(dy) < 4) return;
    const t0 = performance.now();
    let last = 0;
    while (true) {
      if (dead || ctrl.state === 'stopped') return;
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // easeInOutCubic
      const target = Math.round(dy * e);
      if (target !== last) { window.scrollBy({ top: target - last, behavior: 'instant' }); last = target; }
      if (t >= 1) break;
      await nextFrame();
    }
  }


  // ---------------------------------------------------------------- STANDALONE: scroll to top (screen recorder er jonno)
  // Like job er sathe kono connection nai. Panel er "Scroll Recorder" button theke message ashe.
  // Pace = ref video moto: ~1 screen/second, choto choto "mouse wheel" burst + ektu pause.
  const PACE = {
    slow:   { burst: 1.0, pause: [380, 760], dist: [0.45, 0.8] },   // ~0.55 screen/s
    normal: { burst: 1.6, pause: [160, 380], dist: [0.45, 0.8] },   // ~1 screen/s  (ref video)
    fast:   { burst: 2.4, pause: [90, 200],  dist: [0.45, 0.8] },   // ~1.6 screen/s
    faster: { burst: 4.5, pause: [40, 110],  dist: [0.8, 1.3] },    // ~3 screen/s
    turbo:  { burst: 8,   pause: [15, 60],   dist: [1.2, 1.8] },    // ~5 screen/s
    insane: { burst: 14,  pause: [0, 25],    dist: [1.8, 2.6] }     // ~9 screen/s
  };
  let recAbort = false;
  let recRunning = false;

  // X page er asol scroller khuje ber kori (shadharon-e window / documentElement; na hole sobcheye boro scrollable element)
  function findScroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se && se.scrollHeight > se.clientHeight + 50) return se;
    let best = null, bestH = 0;
    document.querySelectorAll('main, [data-testid="primaryColumn"], [data-testid="primaryColumn"] *, body, body > div, #react-root, #react-root *').forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll' || el === document.body) && el.clientHeight > bestH) { best = el; bestH = el.clientHeight; }
      }
    });
    return best || se;
  }
  const isRoot = (el) => el === document.scrollingElement || el === document.documentElement || el === document.body;
  const getTop = (el) => (isRoot(el) ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) : el.scrollTop);
  function setTop(el, y) {
    y = Math.max(0, y);
    if (isRoot(el)) {
      window.scrollTo({ top: y, behavior: 'instant' });
      if (Math.abs(getTop(el) - y) > 2) { document.documentElement.scrollTop = y; document.body.scrollTop = y; }
    } else el.scrollTop = y;
  }
  // Fallback: Chrome debugger diye asol mouse-wheel (jodi DOM scroll kaj na kore)
  function wheelViaCdp(dy) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: 'trusted', action: 'wheel', x: Math.round(window.innerWidth * 0.5), y: Math.round(window.innerHeight * 0.5), dy }, (r) => { void chrome.runtime.lastError; res(!!(r && r.ok)); });
      } catch (e) { res(false); }
    });
  }

  // Smooth ease scroll: dy negative = uporer dike. Return kore kototuku ashole scroll holo
  async function recGlide(el, dy, ms) {
    if (Math.abs(dy) < 4) return 0;
    const from = getTop(el);
    const t0 = performance.now();
    while (!recAbort) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setTop(el, from + dy * e);
      if (t >= 1) break;
      await nextFrame();
    }
    return from - getTop(el);
  }

  async function recScrollToTop(pace) {
    const P = PACE[pace] || PACE.normal;
    const t0 = Date.now();
    let stuck = 0, useWheel = false;
    let el = findScroller();
    while (getTop(el) > 3 && !recAbort) {
      if (Date.now() - t0 > 20 * 60 * 1000) break;               // safety: max 20 min
      const vh = window.innerHeight;
      const before = getTop(el);
      const d = Math.min(before, vh * rand(P.dist[0], P.dist[1]));           // ekta wheel-burst er doori
      const ms = clamp((d / vh) / P.burst * 1000 * rand(0.9, 1.1), 40, 1400);
      if (!useWheel) await recGlide(el, -d, ms);
      else {
        // real wheel: choto choto step e
        const steps = Math.max(3, Math.round(ms / 40));
        for (let i = 0; i < steps && !recAbort; i++) { await wheelViaCdp(-d / steps); await sleep(ms / steps); }
      }
      await sleep(40);
      if (Math.abs(getTop(el) - before) < 2) {
        stuck++;
        if (stuck === 2) { el = findScroller(); }                 // onno scroller hote pare
        else if (stuck === 3 && !useWheel) { useWheel = true; }   // DOM scroll kaj korche na -> real wheel
        else if (stuck >= 6) { setTop(el, 0); break; }
      } else stuck = 0;
      await sleep(rand(P.pause[0], P.pause[1]));
    }
    if (useWheel) { try { chrome.runtime.sendMessage({ type: 'trusted', action: 'detach' }, () => void chrome.runtime.lastError); } catch (e) {} }
    return getTop(el) <= 3;
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || sender.id !== chrome.runtime.id) return;
      if (msg.type === 'recscroll') {
        if (recRunning) { sendResponse({ ok: false, error: 'already scrolling' }); return; }
        recRunning = true; recAbort = false;
        (async () => {
          try {
            removeCursor();
            await sleep(900);                                     // video er shuru te ektu thira frame
            const reached = await recScrollToTop(msg.pace);
            if (reached && !recAbort) await sleep(1800);          // top e ektu thame
            sendResponse({ ok: true, reachedTop: reached });
          } catch (e) { sendResponse({ ok: false, error: String(e) }); }
          finally { recRunning = false; }
        })();
        return true;
      }
      if (msg.type === 'pickstop') { startPick(); sendResponse({ ok: true }); return; }
      if (msg.type === 'recping') { sendResponse({ ok: true }); return; }
      if (msg.type === 'recabort') { recAbort = true; sendResponse({ ok: true }); return; }
    });
  } catch (e) {}

  // ---------------------------------------------------------------- break
  // Generic timer wait (break / long / hourly). Timer state "wait" e likhe jate panel e boro kore dekhay
  async function doWait(kind, total) {
    let left = total;
    let lastSave = 0;
    await save({ onBreak: true, wait: { kind, left: total, total } });
    while (left > 0) {
      if (!(await gate())) { await save({ onBreak: false, wait: null }); return false; }
      const now = Date.now();
      if (now - lastSave >= 1000) {
        lastSave = now;
        lastStatus = '';
        save({ status: `${kind === 'long' ? '🛑 Long break' : '☕ Break'} — ${fmt(Math.max(0, left))} baki`, wait: { kind, left: Math.max(0, left), total } });
      }
      await sleep(250);
      left -= 0.25;                  // pause thakle gate() ekhane atke thake, tai pause er shomoy count hoy na
    }
    await save({ onBreak: false, wait: null });
    return true;
  }

  async function takeBreak(cfg, long) {
    const b = long ? cfg.longBreak : cfg.breaks;
    const total = long ? rand(b.minMin * 60, b.minMax * 60) : rand(b.secMin, b.secMax);
    if (!(await doWait(long ? 'long' : 'break', total))) return false;
    const patch = { sinceBreak: 0, breakAt: randInt(cfg.breaks.everyMin, cfg.breaks.everyMax) };
    if (long) { patch.sinceLong = 0; patch.longAt = randInt(cfg.longBreak.everyMin, cfg.longBreak.everyMax); }
    await save(patch);
    return true;
  }

  // Hourly limit: ghontay max N ta post e kaj
  async function quotaGate(cfg) {
    if (!cfg.hourlyMax) return true;
    while (true) {
      const now = Date.now();
      hourLog = hourLog.filter((t) => now - t < 3600e3);
      if (hourLog.length < cfg.hourlyMax) { if (S.wait) await save({ wait: null }); return true; }
      const waitSec = Math.ceil((hourLog[0] + 3600e3 - now) / 1000);
      if (!(await gate())) { await save({ wait: null }); return false; }
      lastStatus = '';
      save({ status: `⏳ Hourly limit (${hourLog.length}/${cfg.hourlyMax}) — ${fmt(waitSec)} por abar shuru`,
             wait: { kind: 'hourly', left: waitSec, total: 3600 } });
      await sleep(1000);
    }
  }

  // ---------------------------------------------------------------- main raid (ekta page)
  async function raidPage(cfg, target) {
    try { return await raidPageInner(cfg, target); }
    finally { await flushSeen(); detachTrusted(); }
  }

  async function raidPageInner(cfg, target) {
    const delay = Number.isFinite(cfg.speedMs) ? cfg.speedMs : 2000;
    const instant = delay < 1000;       // Turbo: instant jump + direct click, cursor nai
    const human = !instant;             // baki: smooth scroll + mouse cursor
    const A = cfg.actions || { like: true };

    const SPEED = instant
      ? { settle: 30, likeMax: 900, menuMax: 2000, afterAction: 80, scrollWaitMax: 1200, pollStep: 40 }
      : { settle: 70, likeMax: 1500, menuMax: 2500, afterAction: 60, scrollWaitMax: 2000, pollStep: 60,
          scrollMsMin: 320, scrollMsMax: Math.min(800, Math.round(delay * 0.35)), likeAtViewportPct: 0.62 };

    stopCount = 0;
    const mainId = (location.pathname.match(/\/status\/(\d+)/) || [])[1] || null;
    // Ager run e jegulo handle hoyeche (Continue e) segulo silently skip hobe, count hobe na
    const seenList = Array.isArray(seenMap[target.url]) ? seenMap[target.url].slice() : [];
    seenCtx = { url: target.url, list: seenList };
    const done = new Set(seenList);
    const preSeen = seenList.length;
    const viewed = new Set();
    const doneNoId = new WeakSet();
    let emptyScrolls = 0;
    let failStreak = 0;

    const hasFresh = () => articlesNow().some((a) => {
      const id = articleId(a);
      return id ? (id !== mainId && !done.has(id)) : !doneNoId.has(a);
    });

    const nextArticle = () => {
      for (const a of articlesNow()) {
        const id = articleId(a);
        if (!id) { if (doneNoId.has(a)) continue; return { a, id: null }; }
        if (id === mainId || done.has(id)) continue;
        return { a, id };
      }
      return null;
    };

    // Ei post e kaj baki ache kina (already like/repost/bookmark kora hole scroll/click lagbe na)
    const needsWork = (a) =>
      (A.like && !isLiked(a)) ||
      (A.repost && !!a.querySelector('[data-testid="retweet"]')) ||
      (A.bookmark && !!a.querySelector('[data-testid="bookmark"]'));

    const glideToPost = async (a) => {
      const anchor = a.querySelector('[data-testid="like"], [data-testid="unlike"]') || a;
      const vh = window.innerHeight || 800;
      const dy = anchor.getBoundingClientRect().top - vh * SPEED.likeAtViewportPct;
      const ms = clamp(260 + Math.abs(dy) * 0.45, SPEED.scrollMsMin, SPEED.scrollMsMax) * rand(0.92, 1.08);
      ensureCursor();
      // scroll korar shomoy cursor o ektu ghure jay (manush er moto)
      await Promise.all([
        glideScroll(dy, ms),
        moveCursor(clamp(cur.x + rand(-140, 140), 40, window.innerWidth - 40),
                   clamp(cur.y + rand(-90, 90), 80, window.innerHeight - 40), Math.min(ms, 420))
      ]);
    };

    status('Loading posts...', true);
    const first = await waitUntil(() => document.querySelector('article[data-testid="tweet"]'), 15000, 200);
    if (!first) {
      if (ctrl.state === 'stopped') return { stopped: true };
      return { error: 'X page e kono post paoa jayni (login / page load check koro)' };
    }

    let handled = 0;

    while (true) {
      if (!(await gate())) return { stopped: true };

      // Panel theke "Break now" request
      const bn = ctrl.breakNow;
      if (bn && bn.id !== S.bnDone && bn.sec > 0) {
        await save({ bnDone: bn.id });
        if (!(await doWait('break', bn.sec))) return { stopped: true };
      }

      const item = nextArticle();

      // notun post nai -> niche scroll
      if (!item) {
        // DOM e notun (ekhono na dekha) post ashle seta progress, "list shesh" na
        const idsNow = articlesNow().map(articleId).filter(Boolean);
        const newInDom = idsNow.some((x) => !viewed.has(x));
        idsNow.forEach((x) => viewed.add(x));
        if (newInDom) emptyScrolls = 0; else emptyScrolls++;
        if (emptyScrolls > (instant ? 7 : 6)) return { endReached: true };

        // Continue: ager jaygay pouchhanor jonno dhuto instant scroll (ager post gulo already kora)
        if (preSeen > 0 && handled === 0) {
          status(`⏩ Ager jaygay jachhe... ${done.size} post paar hoyeche`);
          window.scrollBy({ top: Math.round(window.innerHeight * 1.6), behavior: 'instant' });
          await waitUntil(() => hasFresh() || articlesNow().some((x) => { const i = articleId(x); return i && !viewed.has(i); }), 1200, 60);
          continue;
        }

        status(`Scrolling... ${done.size} post dekha, ${handled} te kaj`);
        if (emptyScrolls >= 2) await clickShowMore();
        if (human) await glideScroll(Math.round(window.innerHeight * 0.85), 650);
        else window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: 'instant' });
        await waitUntil(hasFresh, SPEED.scrollWaitMax, SPEED.pollStep);
        continue;
      }
      emptyScrolls = 0;

      const { a, id } = item;
      if (!id) { doneNoId.add(a); continue; }   // Ad / promoted skip
      done.add(id);
      const stopHit = matchesStop(cfg.stop, a, id);

      // Shob kaj already kora -> scroll/click chhara skip
      if (!needsWork(a)) {
        S.stats.skipped++;
        handled++;
        markSeen(id);
        S.total = (S.total || 0) + 1;
        if (stopHit) { await save({ stats: S.stats, total: S.total }); return { stopReached: true }; }
        if (cfg.maxPosts && S.total >= cfg.maxPosts) {
          await save({ stats: S.stats, total: S.total });
          return { limitReached: true };
        }
        if (S.stats.skipped % 10 === 0) await save({ stats: S.stats, total: S.total });   // storage e beshi write na
        status(`${instant ? '⚡ Turbo' : '🖱️ Running'} — ${S.total}${cfg.maxPosts ? '/' + cfg.maxPosts : ''} posts`);
        continue;
      }

      if (!(await quotaGate(cfg))) return { stopped: true };

      const postStart = Date.now();
      const ev = { liked: false, reposted: false, bookmarked: false };
      let attempted = false;
      let failed = false;

      // ---- scroll ----
      if (human) await glideToPost(a);
      else a.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(SPEED.settle);
      if (!(await gate())) return { stopped: true };

      // Page re-render hole purano element stale hoy, tai id diye abar khuje ber kori
      const cur = () => articlesNow().find((x) => articleId(x) === id) || a;
      const res = { like: 'off', repost: 'off', bookmark: 'off' };   // ok | skip | fail: karon | off
      const offNow = S.off || {};

      // ---- 1) LIKE ----
      if (A.like && !offNow.like) {
        if (isLiked(cur())) res.like = 'skip';
        else {
          attempted = true;
          const r = await smartClick(() => cur().querySelector('[data-testid="like"]'), () => isLiked(cur()), '#F43F5E', human, delay, SPEED.likeMax);
          if (r.ok) { ev.liked = true; res.like = 'ok'; } else res.like = 'fail: ' + r.reason;
        }
      }

      // ---- 2) BOOKMARK ---- (repost er age, karon repost menu sobcheye jhamelar)
      if (A.bookmark && !offNow.bookmark && (await gate())) {
        if (cur().querySelector('[data-testid="removeBookmark"]')) res.bookmark = 'skip';
        else {
          attempted = true;
          const r = await smartClick(() => cur().querySelector('[data-testid="bookmark"]'), () => !!cur().querySelector('[data-testid="removeBookmark"]'), '#3B82F6', human, delay, SPEED.likeMax);
          if (r.ok) { ev.bookmarked = true; res.bookmark = 'ok'; } else res.bookmark = 'fail: ' + r.reason;
        }
      }

      // ---- 3) REPOST ---- (shesh e)
      if (A.repost && !offNow.repost && (await gate())) {
        if (cur().querySelector('[data-testid="unretweet"]')) res.repost = 'skip';
        else {
          const rt = cur().querySelector('[data-testid="retweet"]');
          if (!rt) { res.repost = 'fail: repost button pawa jayni'; attempted = true; }
          else {
            attempted = true;
            const r = await doRepost(rt, cur, human, delay, SPEED);
            if (r.ok) { ev.reposted = true; res.repost = 'ok'; await sleep(SPEED.afterAction); }
            else { res.repost = 'fail: ' + r.reason; }
          }
        }
      }
      await closeRepostMenu();                               // kono karone menu khola thakle bondho

      // ---- action wise fail track: porpor 3 bar fail hole oi action ei run e bondho (baki action cholbe) ----
      S.failed = S.failed || { like: 0, repost: 0, bookmark: 0 };
      S.off = S.off || {};
      consec = consec || { like: 0, repost: 0, bookmark: 0 };
      let note = '';
      for (const k of ['like', 'repost', 'bookmark']) {
        if (res[k].startsWith('fail')) {
          failed = true;
          S.failed[k]++;
          consec[k]++;
          if (consec[k] >= 3 && !S.off[k]) {
            S.off[k] = true;
            const nm = { like: '❤️ Like', repost: '🔁 Repost', bookmark: '🔖 Bookmark' }[k];
            note = `⚠ ${nm} porpor 3 bar fail korlo — ei run e ${nm} bondho kore dilam, baki action cholche. (${res[k].replace(/^fail: /, '')})`;
          }
        } else if (res[k] === 'ok') {
          consec[k] = 0;
        }
      }
      S.last = res;
      if (note) S.note = note;

      const acted = ev.liked || ev.reposted || ev.bookmarked;
      handled++;
      markSeen(id);
      if (ev.liked) S.stats.liked++;
      if (ev.reposted) S.stats.reposted++;
      if (ev.bookmarked) S.stats.bookmarked++;
      if (!acted) S.stats.skipped++;

      failStreak = (attempted && failed && !acted) ? failStreak + 1 : 0;

      if (acted) {
        hourLog.push(Date.now());
        S.sinceBreak = (S.sinceBreak || 0) + 1;
        S.sinceLong = (S.sinceLong || 0) + 1;
        saveHour();
      }
      S.total = (S.total || 0) + 1;
      await save({ stats: S.stats, sinceBreak: S.sinceBreak, sinceLong: S.sinceLong, total: S.total, failed: S.failed, off: S.off, last: S.last, note: S.note || '' });
      status(`${instant ? '⚡ Turbo' : '🖱️ Running'} — ${S.total}${cfg.maxPosts ? '/' + cfg.maxPosts : ''} posts`);

      // Stop point: user er dewa post e pouchhe gele (oi post shoho) stop
      if (stopHit) return { stopReached: true };
      // Max posts: N ta post dekha (like + skip mile) hoye gele nijei stop
      if (cfg.maxPosts && S.total >= cfg.maxPosts) return { limitReached: true };

      // 3 ta post e porpor fail -> X rate limit / block hote pare, thamo
      if (failStreak >= 3) {
        return { error: 'Porpor 3 ta post e action fail holo (X rate limit hote pare). Kichhukkhon por abar try koro.' };
      }

      // ---- Break system ----
      if (acted) {
        const longDue = cfg.longBreak && cfg.longBreak.enabled && S.sinceLong >= S.longAt;
        const shortDue = cfg.breaks && cfg.breaks.enabled && S.sinceBreak >= S.breakAt;
        if (longDue) { if (!(await takeBreak(cfg, true))) return { stopped: true }; }
        else if (shortDue) { if (!(await takeBreak(cfg, false))) return { stopped: true }; }
      }

      // Post proti total time = select kora delay
      if (human && acted) {
        const remain = delay * rand(0.92, 1.08) - (Date.now() - postStart);
        if (remain > 0) await sleep(remain);
      }
    }
  }

  // ---------------------------------------------------------------- target navigation / loop
  const normPath = (p) => p.replace(/\/+$/, '').toLowerCase();

  async function waitActive(seconds, label) {
    let left = seconds;
    while (left > 0) {
      if (!(await gate())) return false;
      status(`${label} — ${Math.ceil(left)}s`);
      await sleep(250);
      left -= 0.25;
    }
    return true;
  }

  async function runJob(cfg) {
    const idx = S.targetIndex || 0;
    const target = cfg.targets[idx];
    if (!target) return;

    myRun = ctrl.runId;
    keepAlive(true);
    let res;
    try { res = await raidPage(cfg, target); } finally { keepAlive(false); }
    removeCursorLater();

    if (res.stopReached) {
      const s = S.stats || {};
      await save({
        phase: 'done',
        status: `📍 Stop post e pouchhe gesi — ${S.total} post (${s.liked || 0} like, ${s.reposted || 0} repost, ${s.bookmarked || 0} bookmark, ${s.skipped || 0} skip). Ekhon screen record dao.`
      });
      return;
    }
    if (res.limitReached) {
      const s = S.stats || {};
      await save({
        phase: 'done',
        status: `✓ Target complete: ${S.total} post (${s.liked || 0} like, ${s.reposted || 0} repost, ${s.bookmarked || 0} bookmark, ${s.skipped || 0} skip). Tab open ache.`
      });
      return;
    }
    if (res.stopped) { await save({ phase: 'stopped', status: '⏹ Stopped (tab open ache)' }, true); return; }
    if (res.error) { await save({ phase: 'error', status: '⚠ ' + res.error }); return; }

    // page er shesh -> porer target
    if (idx + 1 < cfg.targets.length) {
      await save({ targetIndex: idx + 1, status: 'Porer target e jachhe...' });
      await sleep(500);
      location.href = cfg.targets[idx + 1].url;
      return;
    }

    if (cfg.loop) {
      const wait = cfg.speedMs < 3000 ? 20 : 60;
      const ok = await waitActive(wait, '✓ Pass complete — refresh hobe');
      if (!ok) { await save({ phase: 'stopped', status: '⏹ Stopped (tab open ache)' }); return; }
      await save({ targetIndex: 0, round: (S.round || 1) + 1, status: 'Refresh...' });
      location.href = cfg.targets[0].url;
      return;
    }

    await save({ phase: 'done', status: '✓ Complete (tab open ache)' });
  }

  function removeCursorLater() { setTimeout(removeCursor, 1500); }

  // ---------------------------------------------------------------- init
  async function init() {
    if (!extAlive() || busy) return;
    busy = true;
    try {
      const data = await chrome.storage.local.get([K.cfg, K.ctrl, K.state, K.hour, K.seen]);
      const cfg = data[K.cfg];
      ctrl = data[K.ctrl] || { state: 'stopped', runId: 0 };
      S = data[K.state] || {};
      hourLog = Array.isArray(data[K.hour]) ? data[K.hour] : [];
      seenMap = data[K.seen] && typeof data[K.seen] === 'object' ? data[K.seen] : {};

      if (!cfg || !(ctrl.state === 'running' || ctrl.state === 'paused') || S.phase !== 'running') return;

      const me = await chrome.runtime.sendMessage({ type: 'whoami' });
      if (!me || me.tabId !== cfg.tabId) return;

      const target = cfg.targets[S.targetIndex || 0];
      if (!target) return;

      let want = '';
      try { want = normPath(new URL(target.url).pathname); } catch (e) {}
      if (want && normPath(location.pathname) !== want) {
        await save({ status: '⚠ Tab ta target page e nai. Start abar dao.' });
        return;
      }

      S.stats = S.stats || { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 };
      if (S.breakAt == null && cfg.breaks) S.breakAt = randInt(cfg.breaks.everyMin, cfg.breaks.everyMax);
      if (S.sinceBreak == null) S.sinceBreak = 0;
      if (S.longAt == null && cfg.longBreak) S.longAt = randInt(cfg.longBreak.everyMin, cfg.longBreak.everyMax);
      if (S.sinceLong == null) S.sinceLong = 0;
      if (!S.failed) S.failed = { like: 0, repost: 0, bookmark: 0 };
      if (!S.off) S.off = {};
      if (S.trusted == null) S.trusted = false;

      await runJob(cfg);
    } catch (e) {
      // extension reload hole purano script chup kore thamo
    } finally {
      busy = false;
    }
  }

  init();
})();
