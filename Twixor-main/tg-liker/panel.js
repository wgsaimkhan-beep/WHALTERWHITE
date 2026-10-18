// TG LIKER side panel — shudhu settings likhe, Pause/Resume/Stop control kore, status dekhay.
// Asol kaj content.js e hoy (tai popup bondho korleo raid cholte thake).
(() => {
  'use strict';
  const K = { cfg: 'tgl_cfg', ctrl: 'tgl_ctrl', state: 'tgl_state', form: 'tgl_form', seen: 'tgl_seen' };
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ link parsing
  const RESERVED = new Set(['home', 'i', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose',
    'intent', 'hashtag', 'login', 'signup', 'tos', 'privacy', 'jobs', 'share', 'account', 'lists',
    'communities', 'premium', 'grok', 'about']);

  function parseTargets(raw) {
    const out = [];
    const seen = new Set();
    const push = (t) => { if (!seen.has(t.key)) { seen.add(t.key); out.push(t); } };
    const text = String(raw || '');
    let m;

    // 1) tweet (status) link
    const reStatus = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/gi;
    while ((m = reStatus.exec(text)) !== null) {
      push({ kind: 'status', key: 's' + m[2], handle: m[1].toLowerCase() === 'i' ? null : m[1], id: m[2] });
    }

    // 2) profile link  (x.com/username  ba  x.com/username/reposts)
    const reProfile = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})((?:\/[^\s]*)?)/gi;
    while ((m = reProfile.exec(text)) !== null) {
      const handle = m[1];
      const rest = (m[2] || '').toLowerCase();
      if (RESERVED.has(handle.toLowerCase())) continue;
      if (rest.startsWith('/status')) continue;
      push({ kind: 'profile', key: 'p' + handle.toLowerCase(), handle });
    }

    // 3) plain @username
    const reAt = /(?:^|\s)@([A-Za-z0-9_]{1,15})(?=\s|$)/g;
    while ((m = reAt.exec(text)) !== null) {
      push({ kind: 'profile', key: 'p' + m[1].toLowerCase(), handle: m[1] });
    }
    return out;
  }

  function buildTarget(t, section) {
    let mode = section || 'auto';
    if (mode === 'auto') mode = t.kind === 'profile' ? 'profile_reposts' : 'quotes';

    const profile = (h) => mode === 'profile_all'
      ? { url: `https://x.com/${h}`, label: `@${h} profile` }
      : { url: `https://x.com/${h}/reposts`, label: `@${h} reposts` };

    if (t.kind === 'profile') return profile(t.handle);
    if (mode.startsWith('profile') && t.handle) return profile(t.handle);

    const base = `https://x.com/${t.handle || 'i'}/status/${t.id}`;
    if (mode === 'replies') return { url: base, label: 'Replies' };
    return { url: `${base}/quotes`, label: 'Quotes' };
  }

  // ------------------------------------------------------------ form save / load
  const FIELDS = ['links', 'section', 'speed', 'evMin', 'evMax', 'bsMin', 'bsMax', 'hourly', 'maxPosts', 'lbEvMin', 'lbEvMax', 'lbMinMin', 'lbMinMax', 'stopText', 'stopPick'];

  // ---- Stop at post: picked post (id) ba likha text (@handle + lekha) ba tweet link
  function buildStop() {
    const raw = ($('stopText').value || '').trim();
    if (!raw) return null;
    try {
      const pk = JSON.parse($('stopPick').value || 'null');
      if (pk && pk.label === raw && (pk.id || pk.handle)) return { id: pk.id || null, handle: pk.handle || '', text: pk.text || '' };
    } catch (e) {}
    const ms = raw.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/i);
    if (ms) return { id: ms[2], handle: ms[1], text: '' };
    // trailing '#2' = 2nd match (ek-i lekha duita post thakle)
    let nth = 1, body = raw;
    const mn = body.match(/\s#(\d{1,2})\s*$/);
    if (mn) { nth = Math.max(1, parseInt(mn[1], 10)); body = body.slice(0, mn.index).trim(); }
    const mh = body.match(/^@([A-Za-z0-9_]{1,15})\s*(.*)$/s);
    if (mh) return { id: null, handle: mh[1], text: mh[2].replace(/^[\s\-\u2013\u2014|:\u00b7]+/, '').trim(), nth };
    return { id: null, handle: '', text: body, nth };
  }

  async function pickStop() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs && tabs[0];
    if (!t || !/^https:\/\/(x|twitter)\.com\//i.test(t.url || '')) { $('stopInfo').textContent = '⚠ Age X tab e jao (jekhane post ta dekha jay), tarpor Pick chapo.'; return; }
    chrome.tabs.sendMessage(t.id, { type: 'pickstop' }, (r) => {
      if (chrome.runtime.lastError || !r) { $('stopInfo').textContent = '⚠ Page e extension load hoyni — X tab ta F5 diye abar Pick chapo.'; return; }
      $('stopInfo').textContent = '👆 X page e jai post e thamte chao oi post e click koro (Esc = cancel).';
    });
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.tgl_stoppick || !ch.tgl_stoppick.newValue) return;
    const v = ch.tgl_stoppick.newValue;
    const label = v.handle ? `@${v.handle}${v.text ? ' — ' + v.text.slice(0, 60) : ''}` : (v.text || v.id);
    $('stopPick').value = JSON.stringify({ id: v.id, handle: v.handle, text: v.text, label });
    $('stopText').value = label;
    $('stopInfo').textContent = '✓ Stop point set: ' + label;
    saveForm();
  });

  const CHECKS = ['aLike', 'aRepost', 'aBookmark', 'loop', 'brkOn', 'lbOn'];

  async function loadForm() {
    const { [K.form]: f } = await chrome.storage.local.get(K.form);
    if (!f) return;
    FIELDS.forEach((id) => { if (f[id] != null) $(id).value = f[id]; });
    CHECKS.forEach((id) => { if (f[id] != null) $(id).checked = !!f[id]; });
  }

  function saveForm() {
    const f = {};
    FIELDS.forEach((id) => (f[id] = $(id).value));
    CHECKS.forEach((id) => (f[id] = $(id).checked));
    chrome.storage.local.set({ [K.form]: f });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ------------------------------------------------------------ UI state
  let ctrl = { state: 'stopped', runId: 0 };
  let st = {};
  let cfgSaved = null;

  function render() {
    const active = (ctrl.state === 'running' || ctrl.state === 'paused') && st.phase === 'running';
    const paused = active && ctrl.state === 'paused';

    $('btnStart').classList.toggle('hide', active);
    $('btnPause').classList.toggle('hide', !active || paused);
    $('btnResume').classList.toggle('hide', !paused);
    $('btnStop').classList.toggle('hide', !active);

    // job chalar shomoy settings lock
    FIELDS.concat(CHECKS).forEach((id) => { $(id).disabled = active; });

    const pill = $('pill');
    pill.className = 'pill';
    let label = 'Idle';
    if (active) {
      if (paused) { label = 'Paused'; pill.classList.add('pause'); }
      else if (st.onBreak) { label = 'On break'; pill.classList.add('brk'); }
      else { label = 'Running'; pill.classList.add('run'); }
    } else if (ctrl.state === 'stopped' && st.phase === 'running') {
      label = 'Stopped';
    } else if (st.phase === 'done') { label = 'Done'; }
    else if (st.phase === 'error') { label = 'Error'; pill.classList.add('err'); }
    else if (st.phase === 'stopped') { label = 'Stopped'; }
    pill.textContent = label;

    const s = st.stats || { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 };
    $('sLiked').textContent = s.liked;
    $('sReposted').textContent = s.reposted;
    $('sBook').textContent = s.bookmarked;
    $('sSkip').textContent = s.skipped;

    let line = st.status || 'Ready.';
    if (active && st.round > 1) line = `Round ${st.round} • ` + line;
    if (!active && ctrl.state === 'stopped' && st.phase === 'running') line = '⏹ Stopped (tab open ache)';
    $('statusLine').textContent = line;

    // ---- boro break / wait timer ----
    const wb = $('waitBanner');
    const w = st.wait;
    if (active && w && typeof w.left === 'number') {
      const kind = w.kind === 'long' ? 'long' : (w.kind === 'hourly' ? 'hourly' : 'break');
      wb.className = 'wait ' + kind + (paused ? ' paused' : '');
      $('waitLabel').textContent = kind === 'long' ? '🛑 LONG BREAK' : (kind === 'hourly' ? '⏳ HOURLY LIMIT — WAITING' : '☕ BREAK');
      $('waitTime').textContent = fmtTime(w.left);
      const pct = w.total > 0 ? Math.min(100, Math.max(0, (1 - w.left / w.total) * 100)) : 0;
      $('waitBar').style.width = pct + '%';
      $('waitNote').textContent = paused ? '⏸ Paused — timer ruk ache' : 'Timer shesh hole nijei abar shuru hobe';
    } else {
      wb.className = 'wait hide';
    }

    // ---- porer break kokhon ----
    const ni = $('nextInfo');
    if (active && !w && cfgSaved) {
      const parts = [];
      if (cfgSaved.breaks && cfgSaved.breaks.enabled && st.breakAt) parts.push(`☕ Next break: ${Math.max(0, st.breakAt - (st.sinceBreak || 0))} post por`);
      if (cfgSaved.longBreak && cfgSaved.longBreak.enabled && st.longAt) parts.push(`🛑 Long break: ${Math.max(0, st.longAt - (st.sinceLong || 0))} post por`);
      ni.textContent = parts.join('  •  ');
      ni.classList.toggle('hide', parts.length === 0);
    } else {
      ni.classList.add('hide');
    }

    // ---- Add-on / Continue box ----
    const ended = !active && cfgSaved && (st.total || 0) > 0 &&
      (st.phase === 'done' || st.phase === 'stopped' || (ctrl.state === 'stopped' && st.phase === 'running'));
    $('contBox').classList.toggle('hide', !ended);
    if (ended) {
      const tg = cfgSaved.targets && cfgSaved.targets[st.targetIndex || 0];
      $('contInfo').textContent = `Last: ${st.total} post • ${s.liked} like, ${s.skipped} skip${tg ? ' • ' + tg.label : ''}`;
      const n = parseInt($('contN').value, 10) || 0;
      $('contNew').textContent = n > 0 ? `Limit: ${st.total} ➔ ${st.total + n}` : '';
      document.querySelectorAll('#presets .pre').forEach((b) => b.classList.toggle('on', parseInt(b.dataset.n, 10) === n));
    }

    // ---- Reset button: shudhu job na cholle ----
    $('btnReset').classList.toggle('hide', active);
    // ---- Break now: shudhu job cholle ----
    $('btnBreakNow').disabled = !active;
    $('bnMin').disabled = false;

    // ---- Last post result + warning ----
    const ll = $('lastLine');
    if (st.last && (active || st.total)) {
      const ic = { like: '❤️', repost: '🔁', bookmark: '🔖' };
      const part = (k) => {
        const r = st.last[k] || 'off';
        if (r === 'off') return '';
        const cls = r === 'ok' ? 'ok' : (r.startsWith('fail') ? 'fail' : 'skip');
        const sym = r === 'ok' ? '✓' : (r.startsWith('fail') ? '✗' : '↷');
        return `${ic[k]} <b class="${cls}">${sym}</b>`;
      };
      ll.innerHTML = 'Last post: ' + ['like', 'bookmark', 'repost'].map(part).filter(Boolean).join(' &nbsp; ') +
        (st.failed && (st.failed.like || st.failed.repost || st.failed.bookmark)
          ? `<br><span style="font-size:11px">Fail: ❤️${st.failed.like} 🔖${st.failed.bookmark} 🔁${st.failed.repost}</span>` : '');
      ll.classList.remove('hide');
    } else { ll.classList.add('hide'); }

    const nl = $('noteLine');
    let noteText = st.note || '';
    if (!noteText && st.last) {
      const bad = Object.keys(st.last).filter((k) => String(st.last[k]).startsWith('fail'));
      if (bad.length) noteText = '⚠ ' + bad.map((k) => ({ like: '❤️', repost: '🔁', bookmark: '🔖' }[k] + ' ' + String(st.last[k]).replace(/^fail: /, ''))).join(' • ');
    }
    nl.textContent = noteText;
    nl.classList.toggle('hide', !noteText);

    renderClock();
  }

  // ⏱ running time (pause er shomoy thame thake)
  function renderClock() {
    const el = $('clock');
    const active = (ctrl.state === 'running' || ctrl.state === 'paused') && st.phase === 'running';
    if (!active || !st.startedAt) { el.classList.add('hide'); return; }
    const now = Date.now();
    const ms = now - st.startedAt - (st.pausedMs || 0) - (st.pausedAt ? now - st.pausedAt : 0);
    el.textContent = '⏱ ' + fmtTime(Math.max(0, ms / 1000));
    el.classList.remove('hide');
  }
  setInterval(renderClock, 1000);

  async function refresh() {
    const d = await chrome.storage.local.get([K.ctrl, K.state, K.cfg]);
    ctrl = d[K.ctrl] || { state: 'stopped', runId: 0 };
    st = d[K.state] || {};
    cfgSaved = d[K.cfg] || null;
    render();
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch[K.ctrl]) ctrl = ch[K.ctrl].newValue || { state: 'stopped', runId: 0 };
    if (ch[K.state]) st = ch[K.state].newValue || {};
    if (ch[K.cfg]) cfgSaved = ch[K.cfg].newValue || null;
    render();
  });

  // ------------------------------------------------------------ actions
  function num(id, fallback, min = 0) {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) ? Math.max(min, v) : fallback;
  }

  async function start() {
    const actions = { like: $('aLike').checked, repost: $('aRepost').checked, bookmark: $('aBookmark').checked };
    if (!actions.like && !actions.repost && !actions.bookmark) {
      $('statusLine').textContent = '⚠ Kom pokkhe ekta action (Like / Repost / Bookmark) select koro.';
      return;
    }

    // current tab
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs && tabs[0];
    const isX = !!(activeTab && /^https:\/\/(x|twitter)\.com\//i.test(activeTab.url || ''));

    // targets: textarea, na thakle current X tab er link
    let parsed = parseTargets($('links').value);
    if (!parsed.length && isX) parsed = parseTargets(activeTab.url);
    if (!parsed.length) {
      $('statusLine').textContent = '⚠ Profile link (x.com/username) ba tweet link paste koro, ba X tab khule rakho.';
      return;
    }
    const section = $('section').value;
    const targets = parsed.map((t) => buildTarget(t, section));

    let evMin = num('evMin', 25, 1), evMax = num('evMax', 40, 1);
    if (evMax < evMin) [evMin, evMax] = [evMax, evMin];
    let bsMin = num('bsMin', 45, 1), bsMax = num('bsMax', 120, 1);
    if (bsMax < bsMin) [bsMin, bsMax] = [bsMax, bsMin];

    let lbEvMin = num('lbEvMin', 100, 1), lbEvMax = num('lbEvMax', 150, 1);
    if (lbEvMax < lbEvMin) [lbEvMin, lbEvMax] = [lbEvMax, lbEvMin];
    let lbMinMin = num('lbMinMin', 5, 1), lbMinMax = num('lbMinMax', 10, 1);
    if (lbMinMax < lbMinMin) [lbMinMin, lbMinMax] = [lbMinMax, lbMinMin];

    const cfg = {
      tabId: null,
      targets,
      actions,
      speedMs: parseInt($('speed').value, 10) || 0,
      loop: $('loop').checked,
      breaks: { enabled: $('brkOn').checked, everyMin: evMin, everyMax: evMax, secMin: bsMin, secMax: bsMax },
      longBreak: { enabled: $('lbOn').checked, everyMin: lbEvMin, everyMax: lbEvMax, minMin: lbMinMin, minMax: lbMinMax },
      hourlyMax: num('hourly', 0, 0),
      maxPosts: num('maxPosts', 0, 0),
      stop: buildStop()
    };

    // tab thik koro: X tab hole ota, na hole notun tab
    let tabId;
    let newTab = false;
    if (isX) {
      tabId = activeTab.id;
    } else {
      const t = await chrome.tabs.create({ url: 'about:blank', active: true });
      tabId = t.id;
      newTab = true;
    }
    cfg.tabId = tabId;

    const runId = Date.now();
    const first = cfg.breaks.enabled ? evMin + Math.floor(Math.random() * (evMax - evMin + 1)) : 0;
    const firstLong = cfg.longBreak.enabled ? lbEvMin + Math.floor(Math.random() * (lbEvMax - lbEvMin + 1)) : 0;

    // storage AGE, navigation PORE (content script load holei config pabe)
    await chrome.storage.local.set({
      [K.cfg]: cfg,
      [K.ctrl]: { state: 'running', runId },
      [K.seen]: {},    // notun Start = notun kore shuru (ager "seen" post bhule jao)
      [K.state]: {
        phase: 'running', targetIndex: 0, round: 1, total: 0, onBreak: false, wait: null,
        startedAt: Date.now(), pausedMs: 0, pausedAt: null, failed: { like: 0, repost: 0, bookmark: 0 }, off: {}, last: null, note: '',
        sinceBreak: 0, breakAt: first, sinceLong: 0, longAt: firstLong,
        stats: { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 },
        status: 'Starting...'
      }
    });
    saveForm();

    await chrome.tabs.update(tabId, { url: targets[0].url, active: true });
    if (newTab) { /* about:blank theke navigate hoyeche */ }
  }

  // ➕ Add-on: ager shesh jayga theke aro N ta post
  async function continueRun() {
    const n = parseInt($('contN').value, 10) || 0;
    if (n < 1) { $('statusLine').textContent = '⚠ Koyta post aro chao seta likho (jemon 20).'; return; }
    const d = await chrome.storage.local.get([K.cfg, K.state]);
    const cfg = d[K.cfg];
    const S = d[K.state] || {};
    if (!cfg || !cfg.targets || !cfg.targets.length) return;

    // ager tab ekhono ache kina
    let tabId = cfg.tabId;
    let ok = false;
    try { ok = !!(tabId != null && (await chrome.tabs.get(tabId))); } catch (e) { ok = false; }
    if (!ok) { const t = await chrome.tabs.create({ url: 'about:blank', active: true }); tabId = t.id; }
    cfg.tabId = tabId;
    cfg.maxPosts = (S.total || 0) + n;          // 100 shesh hole +20 = 120

    const idx = S.targetIndex || 0;
    await chrome.storage.local.set({
      [K.cfg]: cfg,
      [K.ctrl]: { state: 'running', runId: Date.now() },
      [K.state]: { ...S, phase: 'running', onBreak: false, wait: null, off: {}, note: '', startedAt: Date.now(), pausedMs: 0, pausedAt: null, status: `Continuing... (+${n} post)` }
    });
    await chrome.tabs.update(tabId, { url: cfg.targets[idx].url, active: true });
  }

  // 🔄 Reset: counter, continue-memory (seen list) shob muche idle e fire jay (cholar shomoy kaj kore na)
  async function resetAll() {
    if ((ctrl.state === 'running' || ctrl.state === 'paused') && st.phase === 'running') return;
    if (!confirm('Reset korbe? Counter ar "Add more" er memory (ja ager e kora hoyeche) muche jabe.')) return;
    await chrome.storage.local.set({
      [K.ctrl]: { state: 'stopped', runId: Date.now() },
      [K.seen]: {},
      [K.state]: { phase: 'idle', total: 0, stats: { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 },
                   failed: { like: 0, repost: 0, bookmark: 0 }, off: {}, last: null, note: '', wait: null, onBreak: false, status: 'Ready.' }
    });
  }

  // ☕ Break now: ekhoni N minute break nao (timer boro kore dekhabe)
  async function breakNow() {
    const min = Math.max(1, parseInt($('bnMin').value, 10) || 2);
    const d = await chrome.storage.local.get(K.ctrl);
    const c = d[K.ctrl] || { state: 'stopped', runId: 0 };
    await chrome.storage.local.set({ [K.ctrl]: { ...c, breakNow: { id: Date.now(), sec: min * 60 } } });
  }

  async function setCtrl(state) {
    const d = await chrome.storage.local.get(K.ctrl);
    const c = d[K.ctrl] || { runId: 0 };
    await chrome.storage.local.set({ [K.ctrl]: { ...c, state } });
  }


  // ============================================================ SCROLL RECORDER (like job er theke alada)
  // Button click -> Chrome er screen/tab picker -> record shuru -> X tab uporer dike smooth scroll -> top e giye auto stop + save.
  const RK = 'tgl_rec';
  const rec = { active: false, stream: null, mr: null, chunks: [], mime: '', ext: 'webm', tabId: null, t0: 0, timer: null, stopping: false };
  const MIMES = [['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'], ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'],
                 ['video/mp4;codecs=avc1.640028', 'mp4'], ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'],
                 ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']];

  function recStatus(t) { $('recStatus').textContent = t; }
  function recUI() {
    $('btnRecStart').classList.toggle('hide', rec.active);
    $('btnRecStop').classList.toggle('hide', !rec.active);
    $('recPace').disabled = rec.active; $('recSource').disabled = rec.active; $('recFolder').disabled = rec.active;
  }
  async function recLoad() {
    const d = await chrome.storage.local.get(RK); const f = d[RK];
    if (!f) return;
    if (f.pace) $('recPace').value = f.pace;
    if (f.source) $('recSource').value = f.source;
    if (f.folder) $('recFolder').value = f.folder;
  }
  function recSavePrefs() { chrome.storage.local.set({ [RK]: { pace: $('recPace').value, source: $('recSource').value, folder: $('recFolder').value } }); }

  function recFinalize(reason) {
    if (!rec.active || rec.stopping) return;
    rec.stopping = true;
    clearInterval(rec.timer);
    if (rec.tabId != null) chrome.tabs.sendMessage(rec.tabId, { type: 'recabort' }, () => void chrome.runtime.lastError);
    recStatus('💾 Video save hochche...');
    const mr = rec.mr;
    if (mr && mr.state !== 'inactive') { try { mr.requestData(); } catch (e) {} try { mr.stop(); } catch (e) {} }
    else recSave(reason);
  }

  async function recSave(reason) {
    try { if (rec.stream) { if (rec.castStop) { rec.castStop(); rec.castStop = null; } rec.stream.getTracks().forEach((t) => t.stop()); } } catch (e) {}
    try { if (rec.actx) rec.actx.close(); rec.actx = null; } catch (e) {}
    const blob = new Blob(rec.chunks, { type: rec.mime.split(';')[0] || 'video/webm' });
    const ext = rec.ext;
    rec.chunks = []; rec.active = false; rec.stopping = false; rec.stream = null; rec.mr = null; rec.tabId = null;
    recUI();
    if (!blob.size) { recStatus('⚠ Video khali — save hoyni.'); return; }
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const h12 = d.getHours() % 12 || 12, mm = String(d.getMinutes()).padStart(2, '0'), ap = d.getHours() >= 12 ? 'PM' : 'AM';
    const stamp = `${h12}.${mm} ${ap} ${d.getDate()} ${MON[d.getMonth()]}`;   // Windows e ':' cholena, tai 11.33 PM 17 Oct
    const who = (rec.who || 'x').replace(/[^A-Za-z0-9_]/g, '') || 'x';
    const folder = ($('recFolder').value || 'TG-LIKER').replace(/\\/g, '/').split('/').map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '').trim()).filter((s) => s && s !== '.' && s !== '..').join('/') || 'TG-LIKER';
    const filename = `${folder}/${who} ${stamp}.${ext}`;
    const mb = (blob.size / 1048576).toFixed(1);
    let fallback = false;
    try {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } catch (e) {
      fallback = true;   // Save dialog cancel korle video harate na diye Downloads e rakhi
      try { await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' }); }
      catch (e2) { recStatus('⚠ Save fail: ' + ((e2 && e2.message) || e2)); return; }
    }
    recStatus(`✓ Video saved (${mb} MB)${fallback ? ` — Downloads/${folder} e` : ''}${reason ? ' • ' + reason : ''}`);
    setTimeout(() => URL.revokeObjectURL(url), 15 * 60 * 1000);
  }

  // Picker chhara current tab record: Chrome debugger screencast -> canvas -> MediaStream
  async function screencastStream(tabId) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'screencast' });
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d', { alpha: false });
      let last = null, sized = false, done = false, timer = null;
      const fail = (err) => { if (done) return; done = true; try { port.disconnect(); } catch (e) {} reject(new Error(err)); };
      const failT = setTimeout(() => fail('Screencast frame ashe nai (DevTools khola thakle bondho koro)'), 6000);
      port.onMessage.addListener(async (m) => {
        if (m.type === 'error') { clearTimeout(failT); fail(m.error); return; }
        if (m.type !== 'frame') return;
        try {
          const bin = atob(m.data); const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const bmp = await createImageBitmap(new Blob([u8], { type: 'image/jpeg' }));
          if (!sized) {
            cv.width = bmp.width - (bmp.width % 2); cv.height = bmp.height - (bmp.height % 2);
            sized = true;
            timer = setInterval(() => { if (last) ctx.drawImage(last, 0, 0, cv.width, cv.height); }, 1000 / 30);
            const stream = cv.captureStream(30);
            stream.__tglStop = () => { clearInterval(timer); try { port.postMessage({ cmd: 'stop' }); } catch (e) {} try { port.disconnect(); } catch (e) {} };
            clearTimeout(failT);
            if (!done) { done = true; resolve(stream); }
          }
          if (last && last.close) { try { last.close(); } catch (e) {} }
          last = bmp;
          ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        } catch (e) {}
      });
      port.onDisconnect.addListener(() => { if (!done) fail('Screencast disconnect holo'); });
      port.postMessage({ cmd: 'start', tabId });
    });
  }

  async function recStart() {
    if (rec.active) return;
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !/^https:\/\/(x|twitter)\.com\//i.test(tab.url || '')) {
      recStatus('⚠ Age X (x.com) tab e jao, jekhan theke scroll shuru korbe sekhane thako, tarpor abar chap.');
      return;
    }
    let stream = null, direct = false, castStop = null;
    const askMode = $('recSource').value === 'ask';
    // 0) DEFAULT: current X tab ke debugger screencast diye capture (picker/permission lage na)
    if (!askMode) {
      try { stream = await screencastStream(tab.id); castStop = stream.__tglStop; direct = true; }
      catch (e) { stream = null; recStatus('Screencast hoyni (' + ((e && e.message) || e) + ') — porer method try hochche...'); }
    }
    // 1) Fallback: tabCapture (extension icon click kora thakle)
    if (!stream && !askMode) try {
      const idr = await chrome.runtime.sendMessage({ type: 'tabstream', tabId: tab.id });
      if (idr && idr.ok && idr.id) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: idr.id, maxFrameRate: 60 } } });
        direct = true;
      }
    } catch (e) { stream = null; }
    // 2) Chrome picker (Ask mode, ba onno method kaj na korle)
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 }, displaySurface: 'browser' }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false });
      } catch (e) {
        recStatus('⚠ Record shuru hoyni: ' + ((e && e.message) || e));
        return;
      }
    }
    // Nirob (silent) audio track jog kori: audio chhara video ke Telegram GIF/animation dhore,
    // ar group e GIF off thakle send kora jay na. Audio track thakle normal video hoye jay.
    let actx = null;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = actx.createOscillator(), gain = actx.createGain(), dest = actx.createMediaStreamDestination();
      gain.gain.value = 0; osc.connect(gain); gain.connect(dest); osc.start();
      stream = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    } catch (e) { actx = null; }
    let ext = 'webm', mime = '';
    for (const [m, e] of MIMES) { if (MediaRecorder.isTypeSupported(m)) { mime = m; ext = e; break; } }
    const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8000000 });
    let who = '';
    try { const a = parseTargets($('links').value).find((t) => t.handle) || parseTargets(tab.url).find((t) => t.handle); who = a ? a.handle : ''; } catch (e) {}
    Object.assign(rec, { who, active: true, stream, castStop, actx, mr, chunks: [], mime, ext, tabId: tab.id, t0: Date.now(), stopping: false });
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = () => recSave('');
    stream.getVideoTracks()[0].addEventListener('ended', () => recFinalize('sharing bondho kora hoyechilo'));
    mr.start(1000);
    recUI();
    rec.timer = setInterval(() => recStatus(`🔴 Recording${direct ? ' (current tab)' : ''} ${fmtTime((Date.now() - rec.t0) / 1000)} — scroll hochche...`), 500);

    // Picker bondho howar por ektu shomoy diye X tab e scroll command
    await new Promise((r) => setTimeout(r, 700));
    const send = () => new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'recscroll', pace: $('recPace').value }, (r) => {
        if (chrome.runtime.lastError) resolve(null); else resolve(r || { ok: false });
      });
    });
    let r = await send();
    if (!r) {
      // Content script nai (extension reload er por page refresh hoyni) -> nijei inject kori, F5 lagbe na
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); await new Promise((x) => setTimeout(x, 400)); r = await send(); } catch (e) {}
    }
    if (!r) { recFinalize(''); recStatus('⚠ X tab e script load hoyni — X tab refresh (F5) kore abar try koro.'); return; }
    if (!r.ok) { recFinalize(''); recStatus('⚠ Scroll hoyni: ' + (r.error || 'unknown')); return; }
    recFinalize(r.reachedTop ? 'profile top e pouchhechhe' : 'scroll theme gese');
  }

  $('btnRecStart').addEventListener('click', recStart);
  $('btnRecStop').addEventListener('click', () => recFinalize('manually stop'));
  $('recPace').addEventListener('change', recSavePrefs);
  $('recSource').addEventListener('change', recSavePrefs);
  
  $('recFolder').addEventListener('input', recSavePrefs);
  recLoad();

  $('btnStart').addEventListener('click', start);
  $('btnPause').addEventListener('click', () => setCtrl('paused'));
  $('btnResume').addEventListener('click', () => setCtrl('running'));
  $('btnStop').addEventListener('click', () => setCtrl('stopped'));
  $('btnContinue').addEventListener('click', continueRun);
  $('btnReset').addEventListener('click', resetAll);
  $('btnBreakNow').addEventListener('click', breakNow);
  $('btnPickStop').addEventListener('click', pickStop);
  document.querySelectorAll('#presets .pre').forEach((b) => b.addEventListener('click', () => { $('contN').value = b.dataset.n; render(); }));
  $('contN').addEventListener('input', render);

  FIELDS.concat(CHECKS).forEach((id) => {
    $(id).addEventListener('change', saveForm);
    $(id).addEventListener('input', saveForm);
  });

  (async () => { await loadForm(); await refresh(); })();
})();
