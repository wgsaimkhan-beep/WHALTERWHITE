/**
 * ATOMX ENGAGE — BACKGROUND SERVICE WORKER (Manifest V3)
 * ==========================================================
 * Handles:
 *  1. AI reply generation proxy (bypasses page-level CORS/HTTPS blocks)
 *  2. Context menu
 *  3. WORKFLOW RELAY ENGINE: Runs all agent workflows (Telegram Raid, Audience Builder,
 *     Sorsa Booster, Followers Increase, Reply Back Loop, Commenter Reciprocator)
 *     — workflows CONTINUE even when the extension popup is closed.
 *     State is persisted in chrome.storage.local and resumed via chrome.alarms.
 */

// >>> Your Render URL (must match popup.js / Options page)
const DEFAULT_BACKEND_URL = 'https://twixor.onrender.com';

// Migrate legacy saved backend URLs (localhost / dead vercel) to the Render URL so background workflows keep working
(async () => {
  try {
    const r = await chrome.storage.local.get(['backendUrl']);
    if (!r.backendUrl || /localhost|127\.0\.0\.1|vercel\.app/i.test(r.backendUrl)) {
      await chrome.storage.local.set({ backendUrl: DEFAULT_BACKEND_URL });
      await chrome.storage.sync?.set({ backendUrl: DEFAULT_BACKEND_URL });
    }
  } catch (e) {}
})();

// ─────────────────────────────────────────────────────────────────────────────
// MODE B: CHROME DEVTOOLS PROTOCOL (CDP) DEBUGGER API INTEGRATION
// Handles system-level authentic mouse dispatching via Input.dispatchMouseEvent
// ─────────────────────────────────────────────────────────────────────────────

const attachedDebuggerTabs = new Set();
const recTabs = new Set();
const castPorts = new Map(); // tabId -> port

if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source?.tabId) {
      attachedDebuggerTabs.delete(source.tabId);
      recTabs.delete(source.tabId);
      castPorts.delete(source.tabId);
      console.log(`[ATOMX CDP] Debugger detached from tab ${source.tabId} (${reason}).`);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onEvent) {
  chrome.debugger.onEvent.addListener((src, method, params) => {
    if (method !== 'Page.screencastFrame' || !src || src.tabId == null) return;
    const port = castPorts.get(src.tabId);
    sendCdpCommand(src.tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (!port) return;
    const md = params.metadata || {};
    try {
      port.postMessage({ type: 'frame', data: params.data, w: md.deviceWidth, h: md.deviceHeight, ts: md.timestamp });
    } catch (e) {}
  });
}

async function attachDebuggerSafely(tabId) {
  if (typeof chrome === 'undefined' || !chrome.debugger) {
    console.warn('[ATOMX CDP] chrome.debugger API is not available on this browser/environment.');
    return false;
  }
  if (attachedDebuggerTabs.has(tabId)) {
    return true;
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedDebuggerTabs.add(tabId);
    console.log(`[ATOMX CDP] Debugger successfully attached to tab ${tabId}`);
    return true;
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('already attached') || msg.includes('Another debugger')) {
      attachedDebuggerTabs.add(tabId);
      return true;
    }
    console.warn(`[ATOMX CDP] Failed to attach debugger to tab ${tabId}:`, msg);
    return false;
  }
}

async function detachDebuggerSafely(tabId) {
  if (typeof chrome === 'undefined' || !chrome.debugger || !tabId) return;
  if (recTabs.has(tabId)) return; // Keep attached if active recording screencast
  try {
    if (attachedDebuggerTabs.has(tabId)) {
      attachedDebuggerTabs.delete(tabId);
      await chrome.debugger.detach({ tabId });
      console.log(`[ATOMX CDP] Debugger detached from tab ${tabId}`);
    }
  } catch (e) {}
}

async function stopCast(tabId) {
  if (tabId == null) return;
  castPorts.delete(tabId);
  try { await sendCdpCommand(tabId, 'Page.stopScreencast'); } catch (e) {}
  recTabs.delete(tabId);
  await detachDebuggerSafely(tabId);
}

function sendCdpCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(result);
    });
  });
}

const sleepAsync = ms => new Promise(r => setTimeout(r, ms));

async function dispatchCdpMouseClick(tabId, x, y) {
  const attached = await attachDebuggerSafely(tabId);
  if (!attached) {
    return { ok: false, fallback: true, error: 'Cannot attach debugger to tab' };
  }

  const targetX = Math.round(x);
  const targetY = Math.round(y);

  try {
    // 1. Dispatch mouseMoved (hover over target coordinates)
    await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: targetX,
      y: targetY
    });
    await sleepAsync(45 + Math.random() * 45);

    // 2. Dispatch mousePressed (left click down)
    await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      x: targetX,
      y: targetY
    });
    await sleepAsync(65 + Math.random() * 65);

    // 3. Dispatch mouseReleased (left click release)
    await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      x: targetX,
      y: targetY
    });

    return { ok: true, x: targetX, y: targetY };
  } catch (err) {
    console.warn('[ATOMX CDP] dispatchMouseEvent error:', err);
    return { ok: false, fallback: true, error: err?.message };
  }
}

async function dispatchCdpInsertText(tabId, text) {
  const attached = await attachDebuggerSafely(tabId);
  if (!attached) {
    return { ok: false, fallback: true, error: 'Cannot attach debugger to tab' };
  }

  try {
    await sendCdpCommand(tabId, 'Input.insertText', { text });
    return { ok: true };
  } catch (err) {
    console.warn('[ATOMX CDP] Input.insertText error:', err);
    return { ok: false, fallback: true, error: err?.message };
  }
}

function safeRemoveTab(tabId) {
  // Safety rule: never close active browser tabs or windows automatically
  return;
}

// Neutralizes window.close in the MAIN world of the tab so Twitter's router can NEVER close the tab
async function injectTabCloseProtection(tabId) {
  if (!tabId || typeof tabId !== 'number' || !chrome.scripting) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const noop = function() {
          console.warn('[ATOMX] Blocked script attempt to close tab via window.close()');
          if (window.location.pathname.includes('/compose/post')) {
            try {
              window.history.replaceState({}, '', '/home');
            } catch (e) {}
          }
          return false;
        };
        try { window.close = noop; } catch (e) {}
        try { if (typeof Window !== 'undefined' && Window.prototype) Window.prototype.close = noop; } catch (e) {}
        try { self.close = noop; } catch (e) {}
        try { top.close = noop; } catch (e) {}
        try { parent.close = noop; } catch (e) {}
        try {
          Object.defineProperty(window, 'close', { value: noop, writable: false, configurable: false });
        } catch (e) {}
        try {
          if (typeof Window !== 'undefined' && Window.prototype) {
            Object.defineProperty(Window.prototype, 'close', { value: noop, writable: false, configurable: false });
          }
        } catch (e) {}
        try {
          const origOpen = window.open;
          window.open = function(url, target) {
            if (target === '_self' || target === '') {
              const win = origOpen.apply(window, arguments);
              try { win.close = noop; } catch (e) {}
              return win;
            }
            return origOpen.apply(window, arguments);
          };
        } catch (e) {}
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
      }
    });
  } catch (err) {}
}

// Ensure every Twitter / X tab automatically gets window.close protection on load
if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab?.url && (tab.url.includes('x.com') || tab.url.includes('twitter.com'))) {
      injectTabCloseProtection(tabId);
    }
  });
}

// Reuses a SINGLE browser tab/window for all links/actions instead of opening/closing repeatedly
async function getOrCreateReusedTab(existingTabId, targetUrl) {
  let selectedTabId = null;

  // 1. If an existing working tab is known, verify it is still open and update it in-place
  if (existingTabId && typeof existingTabId === 'number' && existingTabId > 0) {
    try {
      const existingTab = await chrome.tabs.get(existingTabId);
      if (existingTab && existingTab.id) {
        const curNorm = (existingTab.url || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
        const tgtNorm = (targetUrl || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
        if (curNorm !== tgtNorm) {
          await chrome.tabs.update(existingTab.id, { url: targetUrl, active: true });
        }
        selectedTabId = existingTab.id;
      }
    } catch (e) {
      // Tab was closed by user
    }
  }

  // 2. Check for active tab in current window
  if (!selectedTabId) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id) {
        await chrome.tabs.update(activeTab.id, { url: targetUrl, active: true });
        selectedTabId = activeTab.id;
      }
    } catch (e) {}
  }

  // 3. Check for active tab in last focused window
  if (!selectedTabId) {
    try {
      const [lastTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (lastTab && lastTab.id) {
        await chrome.tabs.update(lastTab.id, { url: targetUrl, active: true });
        selectedTabId = lastTab.id;
      }
    } catch (e) {}
  }

  // 4. Check for ANY open Twitter / X tab in any window so we reuse it instead of opening new tabs
  if (!selectedTabId) {
    try {
      const openTwitterTabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
      if (openTwitterTabs && openTwitterTabs.length > 0 && openTwitterTabs[0]?.id) {
        const tabToUse = openTwitterTabs[0];
        await chrome.tabs.update(tabToUse.id, { url: targetUrl, active: true });
        selectedTabId = tabToUse.id;
      }
    } catch (e) {}
  }

  // 5. Check for ANY open tab anywhere in browser to reuse in-place
  if (!selectedTabId) {
    try {
      const allTabs = await chrome.tabs.query({});
      if (allTabs && allTabs.length > 0 && allTabs[0]?.id) {
        const tabToUse = allTabs[0];
        await chrome.tabs.update(tabToUse.id, { url: targetUrl, active: true });
        selectedTabId = tabToUse.id;
      }
    } catch (e) {}
  }

  // 6. Absolute fallback: only if browser has 0 tabs open
  if (!selectedTabId) {
    const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
    selectedTabId = newTab.id;
  }

  // Inject tab close protection directly into the MAIN world of the active tab
  if (selectedTabId) {
    injectTabCloseProtection(selectedTabId);
  }

  return selectedTabId;
}

// ─────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ATOMX BG] Extension installed.');
  chrome.storage.local.get(['credits', 'atomx_safety_settings'], (res) => {
    if (res.credits === undefined) chrome.storage.local.set({ credits: 10000 });
    const resolvedSafety = getResolvedSafetySettings(res?.atomx_safety_settings || {});
    chrome.storage.local.set({ atomx_safety_settings: resolvedSafety });
  });
  chrome.contextMenus.create({
    id: 'atomx-generate-reply',
    title: 'ATOMX: Generate AI Reply for selection',
    contexts: ['selection']
  });
});

// ─────────────────────────────────────────────
// POPUP LIFECYCLE (Guaranteed detection when popup closes to show Floating HUD)
// ─────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender && port.sender.id !== chrome.runtime.id) return;

  if (port.name === 'screencast') {
    let tabId = null;
    port.onMessage.addListener(async (m) => {
      try {
        if (m.cmd === 'start') {
          tabId = Number(m.tabId);
          recTabs.add(tabId);
          await attachDebuggerSafely(tabId);
          castPorts.set(tabId, port);
          await sendCdpCommand(tabId, 'Page.startScreencast', {
            format: 'jpeg',
            quality: m.quality || 88,
            maxWidth: m.maxWidth || 1920,
            maxHeight: m.maxHeight || 1200,
            everyNthFrame: 1
          });
          port.postMessage({ type: 'started' });
        }
        if (m.cmd === 'stop') await stopCast(tabId);
      } catch (e) {
        recTabs.delete(tabId);
        castPorts.delete(tabId);
        try { port.postMessage({ type: 'error', error: String((e && e.message) || e) }); } catch (x) {}
      }
    });
    port.onDisconnect.addListener(() => { if (tabId != null) stopCast(tabId); });
    return;
  }

  if (port.name === 'atomx_popup_lifecycle') {
    chrome.storage.local.set({ atomx_popup_open: true }).catch(() => null);
    // When popup opens, instantly hide Floating HUD on tabs so they don't overlap
    try {
      chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
        if (tabs && tabs.length > 0) {
          for (const t of tabs) {
            if (t.id) chrome.tabs.sendMessage(t.id, { type: 'POPUP_OPENED' }).catch(() => null);
          }
        }
      });
    } catch (e) {}

    port.onDisconnect.addListener(() => {
      chrome.storage.local.set({ atomx_popup_open: false }).catch(() => null);
      // When popup closes, instantly show Floating HUD on tabs if a workflow is running
      try {
        chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
          if (tabs && tabs.length > 0) {
            for (const t of tabs) {
              if (t.id) chrome.tabs.sendMessage(t.id, { type: 'POPUP_CLOSED' }).catch(() => null);
            }
          }
        });
      } catch (e) {}
    });
  }
});

// Keep service worker alive while a workflow is running
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'atomx_tg_raid_step')        { processTgRaidStep();        return; }
  if (alarm.name === 'atomx_agent_workflow_step') { processAgentWorkflowStep(); return; }
  if (alarm.name === 'atomx_keepalive')           { pingKeepAlive();            return; }
});

function pingKeepAlive() {
  chrome.storage.local.get(['atomx_tg_raid', 'atomx_agent_workflow'], (res) => {
    const active = res?.atomx_tg_raid?.active || res?.atomx_agent_workflow?.active;
    if (active) chrome.alarms.create('atomx_keepalive', { delayInMinutes: 0.4 });
  });
}

// ─────────────────────────────────────────────
// CONTEXT MENU
// ─────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'atomx-generate-reply' && info.selectionText) {
    try {
      const stored = await chrome.storage.local.get(['currentUser', 'user', 'verifiedXHandle']).catch(() => ({}));
      const uHandle = stored?.verifiedXHandle || stored?.currentUser?.handle || stored?.user?.handle || '@user';
      const response = await fetch(`${DEFAULT_BACKEND_URL}/api/generate-reply`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-handle': uHandle
        },
        body: JSON.stringify({ 
          tweetText: info.selectionText, 
          style: 'Natural & Concise',
          userHandle: uHandle
        })
      });
      if (response.ok) {
        const data = await response.json();
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'INSERT_REPLY_TEXT', text: data.reply });
      }
    } catch (err) {
      console.warn('[ATOMX BG] Context menu fetch failed:', err);
    }
  }
});

// ─────────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PING') {
    sendResponse({ status: 'PONG', version: '1.0.0' });
    return true;
  }

  // TG Liker Content Tab Identification
  if (request.type === 'whoami') {
    sendResponse({ tabId: sender?.tab ? sender.tab.id : null });
    return true;
  }

  // ── Mode B: Chrome DevTools Protocol Mouse Dispatcher ──────────────
  if (request.type === 'CDP_DISPATCH_MOUSE_CLICK') {
    const tabId = request.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, fallback: true, error: 'No tab ID available for CDP click' });
      return true;
    }
    dispatchCdpMouseClick(tabId, request.x, request.y).then(res => {
      sendResponse(res);
    }).catch(err => {
      sendResponse({ ok: false, fallback: true, error: err?.message });
    });
    return true;
  }

  if (request.type === 'CDP_INSERT_TEXT') {
    const tabId = request.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, fallback: true, error: 'No tab ID available for CDP text insert' });
      return true;
    }
    dispatchCdpInsertText(tabId, request.text || '').then(res => {
      sendResponse(res);
    }).catch(err => {
      sendResponse({ ok: false, fallback: true, error: err?.message });
    });
    return true;
  }

  if (request.type === 'CDP_DETACH_DEBUGGER') {
    const tabId = request.tabId || sender?.tab?.id;
    if (tabId) detachDebuggerSafely(tabId);
    sendResponse({ ok: true });
    return true;
  }

  // ── TabCapture MediaStream ID for Recording ─────────────────────────
  if (request.type === 'tabstream') {
    (async () => {
      try {
        const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: Number(request.tabId) });
        sendResponse({ ok: true, id });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // ── Trusted Native Input Actions (Wheel / Detach) ────────────────────
  if (request.type === 'trusted') {
    const tabId = request.tabId || sender?.tab?.id;
    (async () => {
      try {
        if (request.action === 'detach') {
          if (tabId) detachDebuggerSafely(tabId);
          sendResponse({ ok: true });
          return;
        }
        if (request.action === 'wheel') {
          await attachDebuggerSafely(tabId);
          await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: Number(request.x) || 400,
            y: Number(request.y) || 400,
            deltaX: 0,
            deltaY: Number(request.dy) || 0,
            pointerType: 'mouse'
          });
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, error: 'unknown action' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // ── Network Relay Proxy (bypasses mobile popup sandbox & fetch hangs) ──
  if (request.type === 'API_FETCH_RELAY' || request.type === 'AUTH_LOGIN_RELAY') {
    const { endpoint, method = 'POST', body, headers = {}, timeout = 70000 } = request;
    const targetBase = (request.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
    const url = (endpoint && endpoint.startsWith('http')) ? endpoint : `${targetBase}${endpoint ? (endpoint.startsWith('/') ? '' : '/') + endpoint : ''}`;
    (async () => {
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
          signal: controller.signal
        });
        clearTimeout(tid);
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'Network request failed' });
      }
    })();
    return true;
  }

  if (request.type === 'GET_CREDITS') {
    chrome.storage.local.get(['credits'], (result) => sendResponse({ credits: result.credits || 0 }));
    return true;
  }

  // ── Suspension Enforcement ─────────────────────────────────────────
  if (['GENERATE_AI_REPLY', 'GENERATE_INLINE_REPLY', 'BG_START_TG_RAID', 'BG_START_AGENT_WORKFLOW'].includes(request.type)) {
    chrome.storage.local.get(['user', 'currentUser'], (res) => {
      const u = res?.user || res?.currentUser;
      if (u && (u.status || '').toUpperCase() === 'SUSPENDED') {
        sendResponse({ error: 'Account suspended by administrator.', status: 'SUSPENDED' });
        return;
      }
    });
  }

  // ── AI Reply Generation (bypasses page CORS) ────────────────────
  if (request.type === 'GENERATE_AI_REPLY' || request.type === 'GENERATE_INLINE_REPLY') {
    handleAiReplyGeneration(request, sendResponse);
    return true;
  }

  // ── Telegram Group Engage Relay ─────────────────────────────────
  if (request.type === 'BG_START_TG_RAID') {
    handleStartTgRaid(request, sendResponse);
    return true;
  }

  if (request.type === 'BG_ABORT_TG_RAID') {
    abortTgRaid();
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'TOGGLE_WORKFLOW_PAUSE') {
    chrome.storage.local.get(['atomx_tg_raid', 'atomx_agent_workflow', 'atomx_workflow_paused'], (res) => {
      const isPaused = (request.isPaused !== undefined) ? request.isPaused : !res?.atomx_workflow_paused;
      chrome.storage.local.set({ atomx_workflow_paused: isPaused });
      if (res?.atomx_tg_raid) {
        chrome.storage.local.set({ atomx_tg_raid: { ...res.atomx_tg_raid, isPaused } });
      }
      if (res?.atomx_agent_workflow) {
        chrome.storage.local.set({ atomx_agent_workflow: { ...res.atomx_agent_workflow, isPaused } });
      }
      // Broadcast pause state to all tabs
      chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
        if (tabs) {
          for (const t of tabs) {
            if (t.id) chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_WORKFLOW_PAUSE', isPaused }).catch(() => null);
          }
        }
      });
      sendResponse({ ok: true, isPaused });
    });
    return true;
  }

  if (request.type === 'SKIP_WORKFLOW_ITEM') {
    chrome.storage.local.get(['atomx_agent_workflow', 'atomx_active_hud', 'atomx_tg_raid'], async (res) => {
      const wf = res?.atomx_agent_workflow;
      const tg = res?.atomx_tg_raid;
      const activeHud = res?.atomx_active_hud;
      if (wf && wf.active) {
        const newSkipped = (wf.ignoredCount || 0) + 1;
        const total = wf.total || 10;
        const done = wf.successCount || 0;
        const nextIdx = Math.min(total, done + newSkipped);
        wf.ignoredCount = newSkipped;
        wf.currentIndex = nextIdx;
        wf.statusText = '⏭️ Skipping current item...';

        const updatedHud = {
          ...(activeHud || {}),
          skipped: newSkipped,
          indicator: `${nextIdx}/${total}`,
          statusText: '⏭️ Skipping current item...'
        };

        await chrome.storage.local.set({
          atomx_skip_current: true,
          atomx_agent_workflow: wf,
          atomx_active_hud: updatedHud
        });

        broadcastHudToTabs(updatedHud);
      } else if (tg && tg.active) {
        // Signal the active step to skip cleanly.
        // DO NOT pre-increment tg.ignoredCount or tg.currentIndex here!
        // processTgRaidStep handles the tab response, increments ignoredCount exactly once,
        // advances currentIndex, and clears atomx_skip_current.
        await chrome.storage.local.set({
          atomx_skip_current: true,
          atomx_workflow_paused: false
        });
        if (activeHud) {
          const updatedHud = {
            ...activeHud,
            statusText: '⏭️ Skipping current tweet...'
          };
          await chrome.storage.local.set({ atomx_active_hud: updatedHud });
          broadcastHudToTabs(updatedHud);
        }
      } else {
        await chrome.storage.local.set({ atomx_skip_current: true });
      }

      chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
        tabs?.forEach(t => { if (t.id) injectTabCloseProtection(t.id); });
      });

      if (tgRaidWorkingTabId) {
        injectTabCloseProtection(tgRaidWorkingTabId);
        chrome.tabs.sendMessage(tgRaidWorkingTabId, { type: 'SKIP_WORKFLOW_ITEM' }).catch(() => null);
      }
      if (agentWorkflowWorkingTabId) {
        injectTabCloseProtection(agentWorkflowWorkingTabId);
        chrome.tabs.sendMessage(agentWorkflowWorkingTabId, { type: 'SKIP_WORKFLOW_ITEM' }).catch(() => null);
      }
    });

    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'BG_GET_TG_RAID_STATUS') {
    chrome.storage.local.get(['atomx_tg_raid'], (res) => sendResponse({ raid: res?.atomx_tg_raid || null }));
    return true;
  }

  // ── Generic Agent Workflow Relay (Audience, Sorsa, Followers, ReplyBack, Reciprocator) ──
  if (request.type === 'BG_START_AGENT_WORKFLOW') {
    handleStartAgentWorkflow(request, sendResponse);
    return true;
  }

  if (request.type === 'BG_ABORT_AGENT_WORKFLOW') {
    abortAgentWorkflow();
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'BG_GET_AGENT_WORKFLOW_STATUS') {
    chrome.storage.local.get(['atomx_agent_workflow'], (res) => sendResponse({ workflow: res?.atomx_agent_workflow || null }));
    return true;
  }

  // ── Universal ABORT from mini-hud or content.js ──────────────────
  if (request.type === 'ABORT_WORKFLOW') {
    abortTgRaid();
    abortAgentWorkflow();
    sendResponse({ ok: true });
    return true;
  }

  // ── Twitter Daily Post Limit & Rate Limit Auto-Stop Handler ──────
  if (request.type === 'RATE_LIMIT_DETECTED') {
    const isDailyLimit = Boolean(request.isDailyLimit);
    const reason = request.error || (isDailyLimit ? "You've hit the daily post limit. Subscribe to Premium for higher limits." : 'Twitter Rate Limit: Sorry, you are rate limited.');
    console.warn(`[ATOMX BG] ${isDailyLimit ? 'DAILY POST LIMIT' : 'RATE LIMIT'} DETECTED! Aborting all active workflows immediately.`);

    // 1. Immediately abort active agent workflow & TG raid
    abortTgRaid();
    abortAgentWorkflow();

    // 2. Clear all pacing and workflow step alarms
    chrome.alarms.clear('atomx_agent_workflow_step').catch(() => null);
    chrome.alarms.clear('atomx_agent_pacing').catch(() => null);
    chrome.alarms.clear('atomx_tg_raid_step').catch(() => null);
    chrome.alarms.clear('atomx_tg_raid_pacing').catch(() => null);
    chrome.alarms.clear('atomx_keepalive').catch(() => null);

    const limitInfo = {
      active: true,
      isDailyLimit,
      reason,
      timestamp: Date.now()
    };

    chrome.storage.local.get(['atomx_agent_workflow', 'atomx_tg_raid', 'atomx_active_hud'], async (res) => {
      const prevWf = res?.atomx_agent_workflow || {};
      const prevTg = res?.atomx_tg_raid || {};
      const prevHud = res?.atomx_active_hud || {};

      const badge = isDailyLimit ? 'DAILY_LIMIT' : 'RATE_LIMITED';
      const statusText = isDailyLimit
        ? '🛑 Daily Post Limit Hit! All automation stopped immediately.'
        : '🚨 Rate limit detected! All automation stopped immediately.';

      const stoppedWf = {
        ...prevWf,
        active: false,
        isStopped: true,
        stateBadge: badge,
        statusText: reason,
        timerBadge: '🛑 Stopped'
      };

      const stoppedTg = {
        ...prevTg,
        active: false,
        isStopped: true,
        stateBadge: badge,
        statusText: reason,
        timerBadge: '🛑 Stopped'
      };

      const stoppedHud = {
        ...prevHud,
        active: false,
        isStopped: true,
        stateBadge: badge,
        statusText,
        timerBadge: '🛑 Stopped',
        nextAction: isDailyLimit ? 'Stopped: Daily Limit Hit' : 'Stopped: Rate Limit Hit'
      };

      await chrome.storage.local.set({
        atomx_rate_limited: limitInfo,
        atomx_daily_post_limit: limitInfo,
        atomx_agent_workflow: stoppedWf,
        atomx_tg_raid: stoppedTg,
        atomx_active_hud: stoppedHud,
        atomx_workflow_paused: false
      }).catch(() => null);

      broadcastHudToTabs(stoppedHud);
    });

    sendResponse({ ok: true });
    return true;
  }
});

// ─────────────────────────────────────────────
// AI REPLY GENERATION
// ─────────────────────────────────────────────

async function handleAiReplyGeneration(request, sendResponse) {
  try {
    const [storedSync, storedLocal] = await Promise.all([
      chrome.storage.sync.get(['backendUrl']).catch(() => ({})),
      chrome.storage.local.get(['backendUrl', 'selectedTone', 'selectedTonePrompt']).catch(() => ({}))
    ]);
    const rawBackendUrl = storedSync?.backendUrl || storedLocal?.backendUrl || DEFAULT_BACKEND_URL;
    const backendUrl = (rawBackendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');

    const tweetText    = request.tweetText || request.tweet?.text || '';
    const tweetAuthor  = request.tweetAuthor || request.tweet?.authorHandle || '@user';
    const tweetAuthorName = request.tweetAuthorName || request.tweet?.authorName || '';

    // Enforce Active Global AI Voice: Always prioritize user's active global voice & custom prompt
    const activeGlobalTone = storedLocal?.selectedTone || 'Bullish (5-10 words)';
    const activeGlobalPrompt = storedLocal?.selectedTonePrompt || null;

    // Use caller's explicit style ONLY if it's explicitly non-generic and has a custom stylePrompt
    const isGenericFallback = !request.style || request.style === 'Natural & Concise' || request.style === 'Bullish (5-10 words)' || request.style === 'default';
    const style = (isGenericFallback ? activeGlobalTone : request.style) || activeGlobalTone;
    const stylePrompt = request.stylePrompt || (style === activeGlobalTone ? activeGlobalPrompt : null) || activeGlobalPrompt;

    const userStored = await chrome.storage.local.get(['currentUser', 'user', 'verifiedXHandle']).catch(() => ({}));
    const userHandle = userStored?.verifiedXHandle || userStored?.currentUser?.handle || userStored?.user?.handle || '@user';
    const userEmail  = userStored?.currentUser?.email || userStored?.user?.email || '';
    const userId     = userStored?.currentUser?.id || userStored?.user?.id || null;

    const res = await fetch(`${backendUrl}/api/generate-reply`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-handle': userHandle,
        'x-user-id': userId ? String(userId) : '1'
      },
      body: JSON.stringify({ 
        tweetText, 
        tweetAuthor, 
        tweetAuthorName, 
        style, 
        stylePrompt,
        userHandle,
        userEmail,
        userId
      })
    });

    if (res.ok) {
      const data = await res.json();
      sendResponse({ success: true, reply: data.reply });
    } else {
      const errData = await res.json().catch(() => ({}));
      sendResponse({ success: false, error: errData.error || `HTTP ${res.status}` });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM GROUP ENGAGE — BACKGROUND RELAY ENGINE
//
// Architecture:
//  1. popup.js sends BG_START_TG_RAID with full tweet list + actions + options
//  2. background.js saves state to chrome.storage.local and fires first step
//  3. Each step: open tab → wait for load → send EXECUTE_AUTONOMOUS_ENGAGEMENT
//     → receive result → update counters → close tab → schedule next step via alarm
//  4. Works even when popup is closed — state survives service worker idle restarts
//  5. popup.js listens to chrome.storage.onChanged to update its own UI
// ─────────────────────────────────────────────────────────────────────────────

let tgRaidWorkingTabId = null;

async function handleStartTgRaid(request, sendResponse) {
  // Check if telegram agent is disabled by admin
  try {
    const statusRes = await chrome.storage.local.get(['atomx_agent_status_map']).catch(() => ({}));
    const tgStatus = statusRes?.atomx_agent_status_map?.['telegram'];
    if (tgStatus && tgStatus.enabled === false) {
      const reason = tgStatus.reason ? ` Reason: ${tgStatus.reason}` : '';
      sendResponse({ ok: false, error: `TG Pulse is disabled by administrator.${reason}` });
      return;
    }
  } catch (e) {}

  const { tweets, actions, options = {} } = request;
  if (!tweets || tweets.length === 0) { sendResponse({ ok: false, error: 'No tweets.' }); return; }

  const total = tweets.length;
  const raidState = {
    active: true,
    tweets,
    actions,
    options,
    currentIndex: 0,
    successCount: 0,
    ignoredCount: 0,
    skippedCommentsCount: 0,
    skippedItems: [],
    total,
    startedAt: Date.now()
  };

  await chrome.storage.local.remove(['atomx_hud_dismissed', 'atomx_rate_limited', 'atomx_daily_post_limit']).catch(() => null);
  await chrome.storage.local.set({ atomx_tg_raid: raidState, atomx_skip_current: false, atomx_workflow_paused: false });
  await syncTgHud(raidState, `Starting Telegram Raid engagement (${total} tweets)...`, 'ENGAGING', 5);

  // Keepalive heartbeat so service worker stays alive
  chrome.alarms.create('atomx_keepalive', { delayInMinutes: 0.4 });

  // Fire first step immediately (small delay to ensure storage is written)
  setTimeout(() => processTgRaidStep(), 300);

  sendResponse({ ok: true });
}

let isTgRaidStepRunning = false;
async function processTgRaidStep() {
  if (isTgRaidStepRunning) {
    console.log('[ATOMX BG] TG Raid step already running. Preventing concurrent duplicate execution.');
    return;
  }
  isTgRaidStepRunning = true;

  const stored = await chrome.storage.local.get(['atomx_tg_raid', 'atomx_workflow_paused', 'atomx_skip_current', 'atomx_rate_limited']).catch(() => ({}));
  if (stored?.atomx_rate_limited?.active) {
    console.log('[ATOMX BG] TG Raid: Twitter rate limit or daily limit active. Halting execution.');
    isTgRaidStepRunning = false;
    return;
  }
  const raid = stored?.atomx_tg_raid;

  if (!raid || !raid.active) {
    console.log('[ATOMX BG] TG Raid: no active raid found, stopping.');
    isTgRaidStepRunning = false;
    return;
  }

  // Handle pause: wait if paused
  if (stored?.atomx_workflow_paused || raid.isPaused) {
    console.log('[ATOMX BG] TG Raid is paused. Waiting for user to resume...');
    await syncTgHud(raid, '⏸️ Workflow Paused by User', 'PAUSED', raid.progressPercent || 0, '', 'Paused', '⏸️ Paused');
    while (true) {
      await delay(500);
      const recheck = await chrome.storage.local.get(['atomx_tg_raid', 'atomx_workflow_paused']).catch(() => ({}));
      if (!recheck?.atomx_tg_raid?.active) {
        isTgRaidStepRunning = false;
        return;
      }
      if (!recheck?.atomx_workflow_paused && !recheck?.atomx_tg_raid?.isPaused) break;
    }
  }

  const { tweets, actions, options, currentIndex, total, successCount, ignoredCount } = raid;

  // Finished?
  if (currentIndex >= total) {
    isTgRaidStepRunning = false;
    await finishTgRaid(raid);
    return;
  }

  const tweet = tweets[currentIndex];
  const nextTweet = tweets[currentIndex + 1];
  const indexStr = `[${currentIndex + 1}/${total}]`;

  const cleanHandle = (tweet?.handle && tweet.handle !== 'i' && tweet.handle !== '@i')
    ? tweet.handle.replace(/^@+/, '')
    : '';
  const displayCurrent = cleanHandle ? `@${cleanHandle}` : `Tweet ${currentIndex + 1}/${total}`;

  const nextCleanHandle = (nextTweet?.handle && nextTweet.handle !== 'i' && nextTweet.handle !== '@i')
    ? nextTweet.handle.replace(/^@+/, '')
    : '';
  const nextInfo = nextTweet
    ? (nextCleanHandle ? `@${nextCleanHandle}` : `Tweet ${currentIndex + 2}/${total}`)
    : 'Completion';

  console.log(`[ATOMX BG] TG Raid step ${indexStr}: ${tweet.canonicalUrl}`);

  await syncTgHud(
    raid,
    `${indexStr} Visiting ${displayCurrent}...`,
    'ENGAGING',
    Math.round((currentIndex / total) * 100),
    '',
    `Visiting ${displayCurrent}`,
    '⚡ Active'
  );

  try {
    // Discard any unsaved drafts from prior tweet to eliminate browser "Leave site?" prompts
    if (tgRaidWorkingTabId) {
      await sendMessageToTab(tgRaidWorkingTabId, { type: 'CLEANUP_DRAFTS_BEFORE_NAV' }, 1500).catch(() => null);
    }

    // Navigate in single reused tab/window across all tweets
    const tabId = await getOrCreateReusedTab(tgRaidWorkingTabId, tweet.canonicalUrl);
    tgRaidWorkingTabId = tabId;

    // Wait for tab to load with specific tweetId verification
    await waitForTabLoad(tabId, 12000, tweet.tweetId);
    await delay(2000); // React hydration

    // Re-check abort or skip after tab load
    const recheckStored = await chrome.storage.local.get(['atomx_tg_raid', 'atomx_skip_current']).catch(() => ({}));
    if (!recheckStored?.atomx_tg_raid?.active) {
      tgRaidWorkingTabId = null;
      return;
    }

    if (recheckStored?.atomx_skip_current) {
      console.log(`[ATOMX BG] TG Raid ${indexStr}: Skipped by user!`);
      const skippedItems = Array.isArray(raid.skippedItems) ? [...raid.skippedItems] : [];
      skippedItems.push({
        url: tweet.canonicalUrl || tweet.url || (tweet.tweetId ? `https://x.com/i/status/${tweet.tweetId}` : ''),
        handle: tweet.handle || '',
        tweetId: tweet.tweetId || '',
        reason: 'Skipped by user'
      });
      const updatedRaid = { ...raid, currentIndex: currentIndex + 1, ignoredCount: ignoredCount + 1, skippedItems };
      await chrome.storage.local.set({ atomx_tg_raid: updatedRaid, atomx_skip_current: false });
      if (updatedRaid.currentIndex < total) {
        setTimeout(() => processTgRaidStep(), 800);
      } else {
        await finishTgRaid(updatedRaid);
      }
      return;
    }

    // Get options from storage (tone, backend, etc.)
    const localData = await chrome.storage.local.get(['backendUrl', 'selectedTone', 'selectedTonePrompt', 'verifiedXHandle']).catch(() => ({}));
    const backendUrl = (options.backendUrl || localData.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');

    await syncTgHud(
      raid,
      `${indexStr} Executing actions on @${tweet.handle || 'user'}...`,
      'ENGAGING',
      Math.round((currentIndex / total) * 100),
      '',
      `Like & Comment @${tweet.handle || 'user'}`,
      '⚡ Active'
    );

    // Send engagement command to content script
    const result = await sendMessageToTab(tabId, {
      type: 'EXECUTE_AUTONOMOUS_ENGAGEMENT',
      actions,
      replyText: '',
      style: options.style || localData.selectedTone || 'Bullish (5-10 words)',
      stylePrompt: options.stylePrompt || localData.selectedTonePrompt || null,
      backendUrl,
      tweetAuthor: tweet.handle || '',
      tweetUrl: tweet.canonicalUrl,
      generateContextual: actions.comment,
      verifiedXHandle: options.verifiedXHandle || localData.verifiedXHandle || ''
    }, 45000);

    // Re-check abort after engagement
    const recheckStored2 = await chrome.storage.local.get(['atomx_tg_raid']).catch(() => ({}));
    if (!recheckStored2?.atomx_tg_raid?.active) {
      tgRaidWorkingTabId = null;
      return;
    }

    // Process result
    const isIgnored = !result || !result.success || Boolean(result.ignored || result.commentSkipped || result.skipped || result.aborted);
    let newSuccessCount = successCount;
    let newIgnoredCount = ignoredCount;
    let newSkippedComments = raid.skippedCommentsCount || 0;
    const skippedItems = Array.isArray(raid.skippedItems) ? [...raid.skippedItems] : [];
    const skipReason = isIgnored ? (result?.commentSkipReason || result?.reason || (result?.error ? `Error: ${result.error}` : 'Comments restricted or post unavailable')) : null;

    if (isIgnored) {
      newIgnoredCount++;
      if (result?.commentSkipped) newSkippedComments++;
      console.log(`[ATOMX BG] TG Raid ${indexStr}: Auto-ignored/skipped — ${skipReason}`);

      // Add to skipped items for user visibility in panel
      skippedItems.push({
        url: tweet.canonicalUrl || tweet.url || (tweet.tweetId ? `https://x.com/i/status/${tweet.tweetId}` : ''),
        handle: tweet.handle || '',
        tweetId: tweet.tweetId || '',
        reason: skipReason || 'Post skipped or unavailable'
      });

      // Save to engagedTweetIds if confirmed already engaged on Twitter or satisfied
      const rLower = (result?.reason || '').toLowerCase();
      if (result?.isAlreadyLiked || result?.isAlreadyCommented || result?.commentSkipped || result?.likeSkipped || rLower.includes('already') || rLower.includes('satisfied') || rLower.includes('completed')) {
        const engData = await chrome.storage.local.get(['engagedTweetIds']).catch(() => ({}));
        const engIds = Array.from(new Set([...(engData.engagedTweetIds || []), String(tweet.tweetId)].filter(Boolean)));
        await chrome.storage.local.set({ engagedTweetIds: engIds }).catch(() => null);
      }
    } else {
      newSuccessCount++;
      const credData = await chrome.storage.local.get(['credits']).catch(() => ({}));
      const newCredits = Math.max(0, (credData.credits || 0) - 1);
      await chrome.storage.local.set({ credits: newCredits }).catch(() => null);

      const engData = await chrome.storage.local.get(['engagedTweetIds']).catch(() => ({}));
      const engIds = Array.from(new Set([...(engData.engagedTweetIds || []), String(tweet.tweetId)].filter(Boolean)));
      await chrome.storage.local.set({ engagedTweetIds: engIds }).catch(() => null);

      fetch(`${backendUrl}/api/tweets/mark-engaged`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweets: [{ tweet_id: tweet.tweetId, handle: tweet.handle, canonical_url: tweet.canonicalUrl, action_type: 'autonomous_raid' }] })
      }).catch(() => null);
    }

    // Keep tgRaidWorkingTabId open so subsequent tweets reuse the exact same tab/window!

    // Update raid state and ensure atomx_skip_current is consumed/reset to false
    const updatedRaid = {
      ...raid,
      currentIndex: currentIndex + 1,
      successCount: newSuccessCount,
      ignoredCount: newIgnoredCount,
      skippedCommentsCount: newSkippedComments,
      skippedItems
    };
    await chrome.storage.local.set({ atomx_tg_raid: updatedRaid, atomx_skip_current: false });

    // HUD update with result
    const statusLabel = isIgnored
      ? `${indexStr} Skipped ${displayCurrent} (${result?.commentSkipReason || result?.reason || 'already done'})`
      : `${indexStr} ✓ Engaged ${displayCurrent}`;

    await syncTgHud(
      updatedRaid,
      statusLabel,
      'ENGAGING',
      Math.round(((currentIndex + 1) / total) * 100),
      '',
      nextInfo,
      'Ready'
    );

    // Schedule anti-ban pacing delay or safety batch rest break before next tweet
    if (updatedRaid.currentIndex < total) {
      if (recheckStored?.atomx_skip_current) {
        // User explicitly clicked the Skip button on HUD -> transition swiftly
        setTimeout(() => processTgRaidStep(), 800);
      } else if (result?.skipped || result?.aborted || isIgnored) {
        // Auto-skipped (comments restricted, post unavailable, already done, etc.)
        // Pacing delay 3s with active countdown timer so user sees live visual countdown
        console.log(`[ATOMX BG] TG Raid: Tweet was skipped (${skipReason}). Waiting 3s cooldown before next tweet...`);
        await schedulePacingCountdown(3, updatedRaid, currentIndex + 1, total, nextInfo || 'Next post');
      } else {
        const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
        const safety = safetyRes?.atomx_safety_settings || {};
        const isBatchBreak = shouldTakeSafetyBatchBreak(newSuccessCount, updatedRaid, safety, 10, 15);

        // Check if batch rest is due
        if (isBatchBreak) {
          await chrome.storage.local.set({ atomx_tg_raid: updatedRaid });
          const restSec = getSafetyRestDurationSec(safety, 1, 3);
          console.log(`[ATOMX BG] TG Raid: Batch complete at ${newSuccessCount} tweets. Taking safety break of ${restSec}s...`);
          await schedulePacingCountdown(
            restSec,
            updatedRaid,
            currentIndex + 1,
            total,
            `Safety Batch Break: Resting ${Math.round(restSec / 60)}m...`
          );
        } else {
          await chrome.storage.local.set({ atomx_tg_raid: updatedRaid });
          const delaySec = getSafetyPacingDelay(safety, 'profileWait', 10, 20);
          console.log(`[ATOMX BG] TG Raid: Anti-ban wait delay ${delaySec}s before next tweet...`);
          await schedulePacingCountdown(delaySec, updatedRaid, currentIndex + 1, total, nextInfo);
        }
      }
    } else {
      // Last tweet — finish immediately
      await finishTgRaid(updatedRaid);
    }

  } catch (err) {
    console.warn(`[ATOMX BG] TG Raid error on ${tweet?.canonicalUrl || tweet?.url}:`, err);
    if (tgRaidWorkingTabId) {
      tgRaidWorkingTabId = null;
    }
    const skippedItems = Array.isArray(raid.skippedItems) ? [...raid.skippedItems] : [];
    skippedItems.push({
      url: tweet?.canonicalUrl || tweet?.url || (tweet?.tweetId ? `https://x.com/i/status/${tweet.tweetId}` : ''),
      handle: tweet?.handle || '',
      tweetId: tweet?.tweetId || '',
      reason: `Error: ${err?.message || 'Execution error'}`
    });
    const updatedRaid = { ...raid, currentIndex: currentIndex + 1, ignoredCount: ignoredCount + 1, skippedItems };
    await chrome.storage.local.set({ atomx_tg_raid: updatedRaid, atomx_skip_current: false });
    setTimeout(() => processTgRaidStep(), 1500);
  } finally {
    isTgRaidStepRunning = false;
  }
}

async function schedulePacingCountdown(delaySec, raid, completedIndex, total, nextActionText = '') {
  if (delaySec <= 0) {
    setTimeout(() => processTgRaidStep(), 200);
    return;
  }

  for (let sec = delaySec; sec > 0; sec--) {
    let recheckStored = await chrome.storage.local.get(['atomx_tg_raid', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
    if (!recheckStored?.atomx_tg_raid?.active) return; // Aborted

    if (recheckStored?.atomx_skip_current) {
      // Skip clicked during pacing delay!
      await chrome.storage.local.set({ atomx_skip_current: false });
      setTimeout(() => processTgRaidStep(), 100);
      return;
    }

    // If workflow is paused, freeze and hold here until resumed
    while (recheckStored?.atomx_workflow_paused || recheckStored?.atomx_tg_raid?.isPaused) {
      await syncTgHud(
        recheckStored?.atomx_tg_raid || raid,
        '⏸️ Workflow Paused by User',
        'PAUSED',
        Math.round((completedIndex / total) * 100),
        '',
        nextActionText,
        '⏸️ Paused'
      );
      await delay(400);
      recheckStored = await chrome.storage.local.get(['atomx_tg_raid', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
      if (!recheckStored?.atomx_tg_raid?.active) return;
      if (recheckStored?.atomx_skip_current) {
        await chrome.storage.local.set({ atomx_skip_current: false });
        setTimeout(() => processTgRaidStep(), 100);
        return;
      }
      if (!recheckStored?.atomx_workflow_paused && !recheckStored?.atomx_tg_raid?.isPaused) break;
    }

    const min = Math.floor(sec / 60);
    const s = sec % 60;
    const timeStr = min > 0 ? `${min}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
    const isBatchBreak = sec > 60 || (nextActionText && nextActionText.includes('Batch Break'));
    const isSkippedCooldown = nextActionText && nextActionText.includes('skipped');

    const statusMsg = isBatchBreak
      ? `☕ Safety Batch Break: Resting ${timeStr} after ${completedIndex} tweets...`
      : (isSkippedCooldown
          ? `⚠️ Skipped post cooldown: ${sec}s before ${nextActionText || ('tweet ' + (completedIndex + 1) + '/' + total)}...`
          : `⏳ Profile Wait (Between Accounts): ${sec}s before ${nextActionText || ('tweet ' + (completedIndex + 1) + '/' + total)}...`);

    const countdownLabel = isBatchBreak
      ? `☕ Break: ${timeStr}`
      : (isSkippedCooldown ? `Cooldown: ${timeStr}` : `Profile Wait: ${timeStr}`);

    await syncTgHud(
      recheckStored?.atomx_tg_raid || raid,
      statusMsg,
      isBatchBreak ? 'BATCH_BREAK' : 'PACING',
      Math.round((completedIndex / total) * 100),
      countdownLabel,
      countdownLabel,
      `⏱️ ${timeStr}`
    );
    await delay(1000);
  }

  // PACING FINISHED: Clear countdown text before processing next tweet
  const curRaid = (await chrome.storage.local.get(['atomx_tg_raid']).catch(() => ({})))?.atomx_tg_raid || raid;
  await syncTgHud(
    curRaid,
    `Anti-ban delay complete. Navigating to next tweet...`,
    'ENGAGING',
    Math.round((completedIndex / total) * 100),
    '',
    nextActionText || `Tweet ${completedIndex + 1}/${total}`,
    '⚡ Active'
  );

  setTimeout(() => processTgRaidStep(), 200);
}

async function finishTgRaid(raid) {
  const { successCount, ignoredCount, total } = raid;
  console.log(`[ATOMX BG] TG Raid COMPLETE: ${successCount}/${total} engaged, ${ignoredCount} skipped.`);

  const finalRaid = {
    ...raid,
    active: false,
    stateBadge: 'DONE',
    progressPercent: 100,
    countdownText: '',
    nextAction: 'Complete',
    timerBadge: '✓ Done',
    statusText: `✓ Raid complete! ${successCount} engaged, ${ignoredCount} skipped.`,
    finishedAt: Date.now()
  };
  await chrome.storage.local.set({ atomx_tg_raid: finalRaid });

  await chrome.storage.local.set({
    atomx_active_hud: {
      title: 'TG Pulse',
      stateBadge: 'DONE',
      indicator: `${total}/${total}`,
      done: successCount,
      collected: total,
      skipped: ignoredCount,
      progressPercent: 100,
      statusText: `✓ Raid complete! ${successCount} engaged, ${ignoredCount} skipped.`,
      countdownText: '',
      nextAction: 'Completed',
      timerBadge: '✓ Done',
      isStopped: true,
      active: false
    }
  });

  chrome.alarms.clear('atomx_keepalive').catch(() => null);
  tgRaidWorkingTabId = null;
}

async function abortTgRaid() {
  console.log('[ATOMX BG] TG Raid: Aborting...');
  const stored = await chrome.storage.local.get(['atomx_tg_raid']).catch(() => ({}));
  const raid = stored?.atomx_tg_raid;

  if (raid) {
    await chrome.storage.local.set({
      atomx_tg_raid: { ...raid, active: false, stateBadge: 'STOPPED', statusText: 'Workflow stopped by user.', countdownText: '', nextAction: 'Stopped', timerBadge: '⏹️ Stopped' },
      atomx_active_hud: {
        title: 'TG Pulse',
        stateBadge: 'STOPPED',
        done: raid.successCount || 0,
        collected: raid.total || 0,
        skipped: raid.ignoredCount || 0,
        progressPercent: Math.round(((raid.currentIndex || 0) / (raid.total || 1)) * 100),
        statusText: 'Workflow stopped by user.',
        countdownText: '',
        nextAction: 'Stopped',
        timerBadge: '⏹️ Stopped',
        isStopped: true,
        active: false
      }
    });
  }

  if (tgRaidWorkingTabId) {
    chrome.tabs.sendMessage(tgRaidWorkingTabId, { type: 'ABORT_WORKFLOW' }).catch(() => null);
    await delay(300);
    safeRemoveTab(tgRaidWorkingTabId);
    tgRaidWorkingTabId = null;
  }

  chrome.alarms.clear('atomx_tg_raid_step').catch(() => null);
  chrome.alarms.clear('atomx_keepalive').catch(() => null);
}

// Broadcast floating HUD state to all open Twitter/X tabs in real-time
function broadcastHudToTabs(hudPayload) {
  try {
    chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
      if (tabs && tabs.length > 0) {
        for (const t of tabs) {
          if (t.id) {
            chrome.tabs.sendMessage(t.id, {
              type: 'UPDATE_FLOATING_HUD',
              data: hudPayload,
              hud: hudPayload
            }).catch(() => null);
          }
        }
      }
    });
  } catch (e) {}
}

// Sync floating HUD state and Telegram raid state to chrome.storage.local
async function syncTgHud(raid, statusText, stateBadge = 'ENGAGING', progressPercent = 0, countdownText = '', nextAction = '', timerBadge = '') {
  const { successCount = 0, ignoredCount = 0, total = 0, currentIndex = 0 } = raid;
  const updatedRaid = {
    ...raid,
    statusText,
    stateBadge,
    progressPercent,
    countdownText,
    nextAction,
    timerBadge
  };
  const activeHud = {
    title: 'TG Pulse',
    stateBadge,
    indicator: `Tweet ${currentIndex}/${total}`,
    done: successCount,
    collected: total,
    skipped: ignoredCount,
    progressPercent,
    statusText,
    countdownText,
    nextAction: nextAction || (stateBadge === 'DONE' ? 'Completed' : (stateBadge === 'STOPPED' ? 'Stopped' : (total > 0 && currentIndex < total ? `Tweet ${currentIndex + 1}/${total}` : 'Active'))),
    timerBadge: timerBadge || (countdownText ? countdownText.replace('Next tweet in ', '⏱️ ') : '⚡ Active'),
    isStopped: stateBadge === 'STOPPED' || stateBadge === 'DONE',
    active: stateBadge !== 'STOPPED' && stateBadge !== 'DONE'
  };
  await chrome.storage.local.set({
    atomx_tg_raid: updatedRaid,
    atomx_active_hud: activeHud
  }).catch(() => null);
  broadcastHudToTabs(activeHud);
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED AGENT WORKFLOW ENGINE (SURVIVES EXTENSION POPUP CLOSES)
// Supports: Audience Builder, Sorsa Booster, Followers Growth, Reply Back, Reciprocator
// ─────────────────────────────────────────────────────────────────────────────

let agentWorkflowWorkingTabId = null;
let isAgentStepRunning = false;
let currentWorkflowSessionId = 0;

function isValidTwitterHandle(handle) {
  if (!handle || typeof handle !== 'string') return false;
  const clean = handle.replace(/^@+/, '').trim().toLowerCase();
  const INVALID = [
    'unknown', 'undefined', 'null', 'user', 'none', 'not logged in',
    'home', 'explore', 'notifications', 'messages', 'i', 'compose',
    'settings', 'search', 'hashtag', 'lists', 'communities',
    'verified-orgs-signup', 'login', 'signup', 'jobs', 'premium'
  ];
  return clean.length >= 2 && !INVALID.includes(clean) && /^[\w_]{1,30}$/.test(clean);
}

/**
 * Instant Account Lock Enforcement:
 * Checks active Twitter account on working tab against AtomX verified account.
 * If mismatch or logged out, shows modal on page, updates HUD, and halts instantly.
 */
async function verifyTabAccountLock(tabId, expectedHandle, workflow) {
  if (!tabId || !expectedHandle) return { ok: true };
  const expected = expectedHandle.replace(/^@/, '').toLowerCase().trim();

  try {
    const res = await sendMessageToTab(tabId, { type: 'CHECK_CURRENT_LOGGED_IN_X_HANDLE' }, 8000);
    const current = (res?.rawHandle || '').toLowerCase().trim();

    if (isValidTwitterHandle(current) && current !== expected) {
      console.warn(`[ATOMX BG] ACCOUNT LOCK MISMATCH DETECTED! Active: @${current}, Expected: @${expected}`);
      await chrome.storage.local.set({
        atomx_account_lock_warning: {
          expected,
          current,
          timestamp: Date.now()
        }
      }).catch(() => null);

      if (workflow) {
        workflow.active = false;
        workflow.isStopped = true;
        workflow.status = 'STOPPED';
        await syncAgentHud(workflow, `🛑 Account Mismatch: Active @${current} ≠ Verified @${expected}. Locked.`, 'STOPPED', 0);
        await chrome.storage.local.set({
          atomx_agent_workflow: workflow,
          atomx_active_hud: {
            visible: true,
            title: workflow.title || 'AtomX Agent',
            statusText: `🛑 Account Mismatch: Active @${current} ≠ Verified @${expected}. Locked.`,
            stateBadge: 'STOPPED',
            isStopped: true
          }
        });
      }
      return { ok: false, current, expected, reason: 'ID_MISMATCH' };
    }

    if (!isValidTwitterHandle(current) && res?.isDefinitelyLoggedOut) {
      await sendMessageToTab(tabId, {
        type: 'SHOW_ACCOUNT_MISMATCH_MODAL',
        expected,
        current: 'Not Logged In'
      }, 5000).catch(() => null);

      if (workflow) {
        workflow.active = false;
        workflow.isStopped = true;
        workflow.status = 'STOPPED';
        await syncAgentHud(workflow, `🛑 Please log into verified Twitter account @${expected}. Locked.`, 'STOPPED', 0);
        await chrome.storage.local.set({ atomx_agent_workflow: workflow });
      }
      return { ok: false, expected, reason: 'X_NOT_LOGGED_IN' };
    }

    // Tab is either confirmed on verified handle or session is active (mobile drawer closed)
    chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
  } catch (err) {
    console.warn('[ATOMX BG] verifyTabAccountLock check notice:', err);
  }
  return { ok: true };
}

function getResolvedSafetySettings(rawSafety = {}) {
  const s = { ...rawSafety };

  // 1. Reply Delay (seconds)
  let rMin = s.replyDelayMin !== undefined ? Number(s.replyDelayMin) : (s.replyDelay !== undefined ? Math.max(0, Number(s.replyDelay) - 3) : 3);
  let rMax = s.replyDelayMax !== undefined ? Number(s.replyDelayMax) : (s.replyDelay !== undefined ? Number(s.replyDelay) : 6);
  if (isNaN(rMin)) rMin = 3;
  if (isNaN(rMax)) rMax = 6;
  if (rMin > rMax) [rMin, rMax] = [rMax, rMin];
  s.replyDelayMin = rMin;
  s.replyDelayMax = rMax;
  s.replyDelay = rMax;

  // 2. Profile Wait (seconds)
  let pMin = s.profileWaitMin !== undefined ? Number(s.profileWaitMin) : (s.profileWait !== undefined ? Math.max(0, Number(s.profileWait) - 10) : 10);
  let pMax = s.profileWaitMax !== undefined ? Number(s.profileWaitMax) : (s.profileWait !== undefined ? Number(s.profileWait) : 20);
  if (isNaN(pMin)) pMin = 10;
  if (isNaN(pMax)) pMax = 20;
  if (pMin > pMax) [pMin, pMax] = [pMax, pMin];
  s.profileWaitMin = pMin;
  s.profileWaitMax = pMax;
  s.profileWait = pMax;

  // 3. Break Actions (actions count)
  let bMin = s.breakActionsMin !== undefined ? Number(s.breakActionsMin) : (s.breakActions !== undefined ? Math.max(0, Number(s.breakActions) - 5) : 10);
  let bMax = s.breakActionsMax !== undefined ? Number(s.breakActionsMax) : (s.breakActions !== undefined ? Number(s.breakActions) : 15);
  if (isNaN(bMin)) bMin = 10;
  if (isNaN(bMax)) bMax = 15;
  if (bMin > bMax) [bMin, bMax] = [bMax, bMin];
  s.breakActionsMin = bMin;
  s.breakActionsMax = bMax;
  s.breakActions = bMax;

  // 4. Rest Duration (minutes)
  let rdMin = s.restDurationMin !== undefined ? Number(s.restDurationMin) : (s.restDuration !== undefined ? Math.max(0, Number(s.restDuration) - 1) : 1);
  let rdMax = s.restDurationMax !== undefined ? Number(s.restDurationMax) : (s.restDuration !== undefined ? Number(s.restDuration) : 3);
  if (isNaN(rdMin)) rdMin = 1;
  if (isNaN(rdMax)) rdMax = 3;
  if (rdMin > rdMax) [rdMin, rdMax] = [rdMax, rdMin];
  s.restDurationMin = rdMin;
  s.restDurationMax = rdMax;
  s.restDuration = rdMax;

  return s;
}

function getSafetyPacingDelay(safety, type = 'replyDelay', fallbackMin = 3, fallbackMax = 8) {
  const resolved = getResolvedSafetySettings(safety);
  const minKey = `${type}Min`;
  const maxKey = `${type}Max`;
  const min = resolved[minKey] !== undefined ? resolved[minKey] : fallbackMin;
  const max = resolved[maxKey] !== undefined ? resolved[maxKey] : fallbackMax;
  if (min === 0 && max === 0) return 0;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const chosen = Math.floor(low + Math.random() * (high - low + 1));
  console.log(`[ATOMX BG] Dynamic safety delay for ${type}: chosen ${chosen}s from range [${low}s - ${high}s]`);
  return chosen;
}

function getSafetyBatchBreakActions(safety, fallbackMin = 10, fallbackMax = 15) {
  const resolved = getResolvedSafetySettings(safety);
  const min = resolved.breakActionsMin !== undefined ? resolved.breakActionsMin : fallbackMin;
  const max = resolved.breakActionsMax !== undefined ? resolved.breakActionsMax : fallbackMax;
  if (min === 0 && max === 0) return 0;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function shouldTakeSafetyBatchBreak(currentSuccessCount, stateObj, safety, fallbackMin = 10, fallbackMax = 15) {
  const resolved = getResolvedSafetySettings(safety);
  const min = resolved.breakActionsMin !== undefined ? resolved.breakActionsMin : fallbackMin;
  const max = resolved.breakActionsMax !== undefined ? resolved.breakActionsMax : fallbackMax;
  if (min === 0 && max === 0) return false;

  if (!stateObj || typeof stateObj !== 'object') return false;

  const low = Math.min(min, max);
  const high = Math.max(min, max);

  // Initialize or re-randomize nextBreakInterval if not yet set
  if (!stateObj.nextBreakInterval || stateObj.nextBreakInterval <= 0) {
    stateObj.nextBreakInterval = Math.floor(low + Math.random() * (high - low + 1));
    console.log(`[ATOMX BG] Initial batch break scheduled after ${stateObj.nextBreakInterval} actions (range ${low}-${high}).`);
  }

  const lastBreak = Number(stateObj.lastBreakSuccessCount || 0);
  const actionsSinceBreak = currentSuccessCount - lastBreak;

  if (currentSuccessCount > 0 && actionsSinceBreak >= stateObj.nextBreakInterval) {
    stateObj.lastBreakSuccessCount = currentSuccessCount;
    stateObj.nextBreakInterval = Math.floor(low + Math.random() * (high - low + 1));
    console.log(`[ATOMX BG] Batch break triggered at ${currentSuccessCount} actions! Next break scheduled after ${stateObj.nextBreakInterval} actions.`);
    return true;
  }

  return false;
}

function getSafetyRestDurationSec(safety, fallbackMinMin = 1, fallbackMaxMin = 3) {
  const resolved = getResolvedSafetySettings(safety);
  let minMin = resolved.restDurationMin !== undefined ? resolved.restDurationMin : fallbackMinMin;
  let maxMin = resolved.restDurationMax !== undefined ? resolved.restDurationMax : fallbackMaxMin;
  if (minMin === 0 && maxMin === 0) return 0;
  if (minMin > maxMin) [minMin, maxMin] = [maxMin, minMin];

  const minSec = Math.round(minMin * 60);
  const maxSec = Math.round(maxMin * 60);

  const chosenSec = Math.floor(minSec + Math.random() * (maxSec - minSec + 1));
  console.log(`[ATOMX BG] Dynamic batch rest duration: chosen ${chosenSec}s (${Math.round(chosenSec / 60)}m) from range [${minMin}m - ${maxMin}m]`);
  return Math.max(5, chosenSec);
}

async function handleStartAgentWorkflow(request, sendResponse) {
  const { agentId, title, items = [], options = {}, tabId } = request;

  // Check if agent is disabled by admin
  if (agentId) {
    try {
      const statusRes = await chrome.storage.local.get(['atomx_agent_status_map']).catch(() => ({}));
      const aStatus = statusRes?.atomx_agent_status_map?.[agentId];
      if (aStatus && aStatus.enabled === false) {
        const reason = aStatus.reason ? ` Reason: ${aStatus.reason}` : '';
        sendResponse({ ok: false, error: `${title || agentId} is temporarily disabled by administrator.${reason}` });
        return;
      }
    } catch (e) {}
  }

  if ((!items || items.length === 0) && !(agentId === 'reciprocator' && options.postUrl) && !(agentId === 'feedengager') && !(agentId === 'nicheengager') && !(agentId === 'tgliker') && !(options.feedUrl) && !(agentId === 'followers') && !(agentId === 'audience') && !(agentId === 'unfollow')) {
    sendResponse({ ok: false, error: 'No targets/items provided.' });
    return;
  }

  // Generate unique session ID to cancel any prior asynchronous timers or loops immediately
  currentWorkflowSessionId = Date.now();
  isAgentStepRunning = false;

  // Lock onto passed working tabId if provided and protect immediately
  if (tabId && typeof tabId === 'number' && tabId > 0) {
    agentWorkflowWorkingTabId = tabId;
    injectTabCloseProtection(tabId);
  }
  // Ensure all open Twitter/X tabs are guarded against tab close
  chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
    tabs?.forEach(t => { if (t.id) injectTabCloseProtection(t.id); });
  });

  let workflowItems = items;
  if (agentId === 'sorsa' && items && items.length > 0) {
    const targetCount = Number(options.targetCount) || 10;
    if (options.mode === 'sequential') {
      const idxRes = await chrome.storage.local.get(['atomx_sorsa_last_index']).catch(() => ({}));
      let lastIdx = Number(idxRes?.atomx_sorsa_last_index) || 0;
      if (lastIdx >= items.length) lastIdx = 0;
      workflowItems = items.slice(lastIdx, lastIdx + targetCount);
      const nextIdx = (lastIdx + workflowItems.length) % items.length;
      await chrome.storage.local.set({ atomx_sorsa_last_index: nextIdx });
    } else {
      // Mode 2: Rolling Deduplication Window
      const cooloffHours = Number(options.cooloffHours) || 24;
      const cooloffMs = cooloffHours * 3600 * 1000;
      const now = Date.now();
      const histRes = await chrome.storage.local.get(['atomx_sorsa_engaged_history']).catch(() => ({}));
      const history = (histRes?.atomx_sorsa_engaged_history && typeof histRes.atomx_sorsa_engaged_history === 'object') ? histRes.atomx_sorsa_engaged_history : {};
      workflowItems = items.filter(it => {
        const h = (it.cleanHandle || it.handle || '').replace(/^@/, '').toLowerCase();
        const last = history[h];
        return !last || (now - last >= cooloffMs);
      }).slice(0, targetCount);
    }
  }

  const total = (agentId === 'feedengager' || agentId === 'nicheengager' || agentId === 'unfollow' || agentId === 'tgliker')
    ? (Number(options.targetLimit || options.targetCount) || (agentId === 'tgliker' && options.targetCount === 0 ? 0 : 20))
    : (agentId === 'reciprocator' && workflowItems.length === 0 ? (Number(options.maxCount || options.targetCount) || 10) : workflowItems.length);
  const workflowState = {
    active: true,
    agentId,
    title: title || 'AtomX Agent',
    items: workflowItems,
    options,
    currentIndex: 0,
    successCount: 0,
    ignoredCount: 0,
    total,
    startedAt: Date.now(),
    stateBadge: 'RUNNING',
    progressPercent: 5,
    statusText: agentId === 'reciprocator' && workflowItems.length === 0
      ? `Scanning post comments for ${title || 'Reciprocator'}...`
      : (agentId === 'feedengager'
        ? `Navigating to Home Timeline (x.com/home)... Filtering Ads & scanning posts.`
        : (agentId === 'nicheengager'
          ? `Searching X for "${options.keyword || 'niche'}"... Filtering Ads & scanning posts.`
          : (agentId === 'tgliker'
            ? `Preparing TG Liker mass raid... Navigating & scanning timeline.`
            : (agentId === 'audience'
              ? `Opening Twitter List to discover top engaged posts...`
              : (agentId === 'unfollow'
                ? `Navigating to Following list (x.com/.../following)... Scanning non-followers.`
                : `Starting fresh ${title || 'Agent'} automation (${total || options.targetCount || 10} targets)...`)))))
  };

  await chrome.storage.local.remove(['atomx_hud_dismissed', 'atomx_rate_limited', 'atomx_daily_post_limit']).catch(() => null);
  await chrome.storage.local.set({
    atomx_agent_workflow: workflowState,
    atomx_workflow_paused: false,
    atomx_skip_current: false
  });
  await syncAgentHud(workflowState, workflowState.statusText, 'RUNNING', 5);

  chrome.alarms.clear('atomx_agent_workflow_step').catch(() => null);
  chrome.alarms.clear('atomx_agent_pacing').catch(() => null);
  if (agentId !== 'tgliker') {
    setTimeout(() => processAgentWorkflowStep(), 300);
  }

  sendResponse({ ok: true });
}

async function syncAgentHud(workflow, statusText, stateBadge = 'RUNNING', progressPercent = 0, countdownText = '', nextAction = '', timerBadge = '') {
  const { title, successCount = 0, ignoredCount = 0, total = 0, currentIndex = 0 } = workflow;
  const updated = {
    ...workflow,
    statusText,
    stateBadge,
    progressPercent,
    countdownText,
    nextAction,
    timerBadge
  };
  const activeHud = {
    title,
    stateBadge,
    indicator: `${currentIndex}/${total}`,
    done: successCount,
    collected: total,
    skipped: ignoredCount,
    progressPercent,
    statusText,
    countdownText,
    nextAction: nextAction || (stateBadge === 'DONE' ? 'Completed' : (stateBadge === 'STOPPED' ? 'Stopped' : (total > 0 && currentIndex < total ? `Target ${currentIndex + 1}/${total}` : 'Active'))),
    timerBadge: timerBadge || (countdownText ? countdownText.replace(/.*?(\d+:\d+|\d+s)/, '⏱️ $1') : '⚡ Active'),
    isStopped: stateBadge === 'STOPPED' || stateBadge === 'DONE',
    active: stateBadge !== 'STOPPED' && stateBadge !== 'DONE'
  };
  await chrome.storage.local.set({
    atomx_agent_workflow: updated,
    atomx_active_hud: activeHud
  }).catch(() => null);
  broadcastHudToTabs(activeHud);
}

async function processAgentWorkflowStep() {
  if (isAgentStepRunning) {
    console.log('[ATOMX BG] Agent workflow step already running. Preventing concurrent execution.');
    return;
  }
  isAgentStepRunning = true;
  const thisSession = currentWorkflowSessionId;

  try {
    const stored = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_rate_limited']).catch(() => ({}));
    if (stored?.atomx_rate_limited?.active) {
      console.log('[ATOMX BG] Agent workflow: Rate limit or daily post limit active, stopping.');
      return;
    }
    const workflow = stored?.atomx_agent_workflow;

    if (!workflow || !workflow.active || currentWorkflowSessionId !== thisSession) {
      console.log('[ATOMX BG] Agent workflow inactive or superseded, stopping.');
      return;
    }

  const { agentId, items = [], options = {}, currentIndex = 0, total = 0, successCount = 0, ignoredCount = 0 } = workflow;

  // =========================================================================
  // AGENT 13: COMMENTER RECIPROCATOR IN-THREAD SEQUENTIAL WORKFLOW ENGINE
  // 1. Opens post in reusable tab & checks account lock
  // 2. Smoothly scrolls into comments, finds first unliked comment
  // 3. Likes comment with virtual cursor, clicks avatar/handle to visit profile in SAME tab
  // 4. Follows (if enabled), scrolls to posts, likes posts (per Posts per Profile), scrolls back up to non-pinned post, comments/reposts
  // 5. Returns via browser back (chrome.tabs.goBack) to post, smoothly scrolls to next comment, repeats!
  // =========================================================================
  if (agentId === 'reciprocator') {
    if (!options.postUrl) {
      await finishAgentWorkflow(workflow);
      return;
    }

    const postUrl = options.postUrl;
    const targetCount = Number(options.maxCount || options.targetCount) || 10;
    const isAllFound = targetCount >= 999;
    const verifiedXHandle = options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle;

    await syncAgentHud(workflow, `Opening post to reciprocate with commenters...`, 'SCANNING', 10);
    try {
      const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId, postUrl);
      agentWorkflowWorkingTabId = tabId;
      await waitForTabLoad(tabId, 15000);
      await delay(2500);

      // Instant Account Lock Check
      const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
      if (!lockCheck.ok) return;

      const targetLimit = isAllFound ? Infinity : targetCount;

      while (((workflow.successCount || 0) + (workflow.ignoredCount || 0)) < targetLimit) {
        const stopChk = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_skip_current']).catch(() => ({}));
        if (stopChk?.atomx_agent_workflow?.isStopped || !stopChk?.atomx_agent_workflow?.active) return;

        if (stopChk?.atomx_skip_current) {
          await chrome.storage.local.set({ atomx_skip_current: false });
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          await syncAgentHud(
            workflow,
            `[${workflow.currentIndex}/${isAllFound ? 'All' : targetCount}] ⏭️ Skipped comment. Finding next...`,
            'SCANNING',
            isAllFound ? 50 : Math.round((workflow.currentIndex / targetCount) * 100)
          );
          continue;
        }

        const curIdx = (workflow.successCount || 0) + (workflow.ignoredCount || 0) + 1;
        await syncAgentHud(
          workflow,
          `[${curIdx}/${isAllFound ? 'All' : targetCount}] Finding next unliked comment on your post...`,
          'SCANNING',
          isAllFound ? 50 : Math.round(((curIdx - 1) / targetCount) * 100)
        );

        const commentRes = await sendMessageToTab(tabId, {
          type: 'FIND_AND_LIKE_NEXT_UNPROCESSED_COMMENT',
          verifiedXHandle,
          mainAuthor: verifiedXHandle,
          ignoreEngagedHistory: true
        }, 45000);

        const stopChk2 = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopChk2?.atomx_agent_workflow?.isStopped || !stopChk2?.atomx_agent_workflow?.active) return;

        if (commentRes?.error) {
          console.warn('[ATOMX BG] Notice from tab in comment scan:', commentRes.error);
          await delay(2000);
          continue;
        }

        if (!commentRes || !commentRes.found) {
          console.log('[ATOMX BG] All comments on post processed or exhausted.');
          break; // Done with all found commenters!
        }

        const cleanHandle = commentRes.cleanHandle;
        const profileUrl = `https://x.com/${cleanHandle}`;

        await syncAgentHud(
          workflow,
          `[${curIdx}/${isAllFound ? 'All' : targetCount}] Liked comment by @${cleanHandle}! Visiting profile in same tab...`,
          'ENGAGING',
          isAllFound ? 60 : Math.round(((curIdx - 1) / targetCount) * 100)
        );

        const safetyBg = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
        const isInstantBg = Number(safetyBg?.atomx_safety_settings?.cursorSpeed) === 0;

        // Visit commenter profile in the SAME tab!
        if (commentRes?.profileClicked) {
          // Profile link was clicked directly via virtual cursor in-app!
          // Wait for Twitter client-side router to mount profile without redundant full reload
          console.log(`[ATOMX BG] Profile link was clicked via virtual cursor. Waiting for in-app navigation to @${cleanHandle}...`);
          let inAppDone = false;
          for (let w = 0; w < 18; w++) {
            await delay(250);
            try {
              const curTab = await chrome.tabs.get(tabId);
              const path = new URL(curTab.url).pathname.toLowerCase().replace(/^\//, '').split('/')[0];
              if (path === cleanHandle.toLowerCase()) {
                inAppDone = true;
                break;
              }
            } catch (e) {}
          }
          if (!inAppDone) {
            console.warn(`[ATOMX BG] In-app navigation fallback to URL load.`);
            await getOrCreateReusedTab(tabId, profileUrl);
            await waitForTabLoad(tabId, 12000);
          } else {
            await delay(isInstantBg ? 400 : 1500); // Allow profile page components to mount smoothly
          }
        } else {
          await getOrCreateReusedTab(tabId, profileUrl);
          await waitForTabLoad(tabId, 15000);
          await delay(isInstantBg ? 600 : 2000);
        }

        const lockCheck2 = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
        if (!lockCheck2.ok) return;

        // Engage on commenter profile with user-selected actions:
        // follow, like, comment, repost, and postsCount!
        const engageRes = await sendMessageToTab(tabId, {
          type: 'AUDIENCE_ENGAGE_AND_FOLLOW',
          handle: cleanHandle,
          likePosts: options.likePosts !== false && options.likeRecent !== false,
          replyPosts: options.replyPosts !== false && options.commentRecent !== false,
          repostPosts: options.repostPosts === true,
          followPosts: options.followPosts === true || options.followUser === true,
          postsCount: options.postsCount || options.postsPerProfile || 'random',
          style: options.style || 'Bullish (5-10 words)',
          stylePrompt: options.stylePrompt || null,
          backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
          verifiedXHandle
        }, 65000);

        const stopChk3 = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopChk3?.atomx_agent_workflow?.isStopped || !stopChk3?.atomx_agent_workflow?.active) return;

        const isIgnored = engageRes?.ignored || engageRes?.skipped || engageRes?.alreadyDone;
        const isSuccess = Boolean(engageRes?.success && !isIgnored);

        if (isSuccess) {
          workflow.successCount = (workflow.successCount || 0) + 1;
          chrome.storage.local.get(['credits'], (c) => {
            const curCredits = c?.credits || 0;
            if (curCredits > 0) chrome.storage.local.set({ credits: curCredits - 1 });
          });
        } else {
          const curWf = (await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({})))?.atomx_agent_workflow;
          workflow.ignoredCount = Math.max((workflow.ignoredCount || 0) + 1, curWf?.ignoredCount || 0);
        }

        // Clear skip flag
        await chrome.storage.local.set({ atomx_skip_current: false });

        // Record history so this commenter is tracked
        chrome.storage.local.get(['atomx_reciprocated_commenters', 'atomx_audience_engaged_history'], (r) => {
          const recip = Array.isArray(r?.atomx_reciprocated_commenters) ? r.atomx_reciprocated_commenters : [];
          if (!recip.includes(cleanHandle)) recip.push(cleanHandle);
          const hist = (r?.atomx_audience_engaged_history && typeof r.atomx_audience_engaged_history === 'object') ? r.atomx_audience_engaged_history : {};
          hist[cleanHandle.toLowerCase()] = Date.now();
          chrome.storage.local.set({ atomx_reciprocated_commenters: recip, atomx_audience_engaged_history: hist }).catch(() => null);
        });

        const currentTotalDone = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
        workflow.currentIndex = currentTotalDone;
        workflow.total = isAllFound ? currentTotalDone + 1 : targetCount;
        await chrome.storage.local.set({ atomx_agent_workflow: workflow });

        await syncAgentHud(
          workflow,
          isIgnored
            ? `[${workflow.successCount}/${isAllFound ? currentTotalDone : targetCount}] ⏭️ Skipped @${cleanHandle}! Returning back to post in same tab...`
            : `[${workflow.successCount}/${isAllFound ? currentTotalDone : targetCount}] ✓ Reciprocated @${cleanHandle}! Returning back to post in same tab...`,
          'ENGAGING',
          isAllFound ? 70 : Math.round((currentTotalDone / targetCount) * 100)
        );

        // Return cleanly back to post in the EXACT SAME tab using browser back to preserve exact comment scroll position!
        console.log(`[ATOMX BG] Navigating cleanly back to post via browser goBack (preserving comment scroll position)...`);
        let navigatedBack = false;

        // Twitter SPA router or reply modals can push 1-3 history entries while on the profile.
        // We step back up to 4 times, checking after each step if the tab URL has returned to /status/!
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await chrome.tabs.goBack(tabId);
          } catch (gbErr) {
            console.warn(`[ATOMX BG] tabs.goBack error on attempt ${attempt + 1}:`, gbErr);
            break;
          }

          // Check if we reached the status post URL
          for (let w = 0; w < 10; w++) {
            await delay(250);
            try {
              const curTab = await chrome.tabs.get(tabId);
              if (curTab?.url && curTab.url.includes('/status/')) {
                navigatedBack = true;
                break;
              }
            } catch (e) {}
          }

          if (navigatedBack) {
            console.log(`[ATOMX BG] Successfully returned to post via browser goBack on step ${attempt + 1}!`);
            break;
          }
          console.log(`[ATOMX BG] Still on profile after goBack step ${attempt + 1}, repeating goBack...`);
        }

        if (!navigatedBack) {
          console.warn(`[ATOMX BG] Could not reach status page via history. Fallback navigation back to post URL: ${postUrl}...`);
          await getOrCreateReusedTab(tabId, postUrl);
          await waitForTabLoad(tabId, 12000);
        }
        await delay(isInstantBg ? 300 : 800);

        if (!isIgnored) {
          const safety = safetyBg?.atomx_safety_settings || {};
          const isBatchBreak = shouldTakeSafetyBatchBreak(workflow.successCount, workflow, safety, 10, 15);
          if (isBatchBreak) {
            await chrome.storage.local.set({ atomx_agent_workflow: workflow });
            const restSec = getSafetyRestDurationSec(safety, 1, 3);
            await scheduleAgentPacingCountdown(restSec, workflow, workflow.successCount, isAllFound ? currentTotalDone : targetCount, `Safety Batch Break: Resting ${Math.round(restSec / 60)}m...`);
          } else {
            await chrome.storage.local.set({ atomx_agent_workflow: workflow });
            const delaySec = getSafetyPacingDelay(safety, 'profileWait', 10, 20);
            if (delaySec > 0) {
              await scheduleAgentPacingCountdown(delaySec, workflow, workflow.successCount, isAllFound ? currentTotalDone : targetCount, `Next commenter from your post`);
            }
          }
        }
      }

      workflow.active = false;
      await syncAgentHud(workflow, `✓ Reciprocation complete! Engaged ${workflow.successCount || 0} commenters.`, 'DONE', 100);
      await finishAgentWorkflow(workflow);
      return;
    } catch (err) {
      console.warn('[ATOMX BG] Error in reciprocator workflow:', err);
      agentWorkflowWorkingTabId = null;
      await finishAgentWorkflow(workflow);
      return;
    }
  }

  // =========================================================================
  // AGENT 14: HOME FEED ENGAGER (x.com/home with Ad Skip & AI Voice)
  // =========================================================================
  if (agentId === 'feedengager') {
    const targetCount = Number(options.targetCount) || 10;
    const verifiedXHandle = options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle;
    const safetyData = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
    const pacingDelaySec = Math.max(5, Number(safetyData?.atomx_safety_settings?.replyDelay) || Number(options.pacingDelaySec) || 10);
    const localData = await chrome.storage.local.get(['backendUrl', 'selectedTone', 'selectedTonePrompt']).catch(() => ({}));
    const backendUrl = (options.backendUrl || localData.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');

    await syncAgentHud(workflow, `Navigating to Home Timeline (x.com/home)...`, 'SCANNING', 5);

    try {
      const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId || options.tabId, 'https://x.com/home');
      agentWorkflowWorkingTabId = tabId;

      const curTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!curTab?.url || !curTab.url.includes('/home')) {
        await waitForTabLoad(tabId, 15000);
        await delay(2000);
      } else {
        await delay(1000);
      }

      // Account Lock Check
      const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
      if (!lockCheck.ok) return;

      while ((workflow.successCount || 0) < targetCount) {
        const stopChk = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_skip_current', 'atomx_workflow_paused', 'engagedTweetIds']).catch(() => ({}));
        if (stopChk?.atomx_agent_workflow?.isStopped || !stopChk?.atomx_agent_workflow?.active) return;

        // Handle user pause
        while (stopChk?.atomx_workflow_paused || stopChk?.atomx_agent_workflow?.isPaused) {
          await syncAgentHud(
            workflow,
            '⏸️ Home Feed Engager Paused by User',
            'PAUSED',
            Math.round(((workflow.successCount || 0) / targetCount) * 100),
            '',
            'Resume to continue',
            '⏸️ Paused'
          );
          await delay(500);
          const repause = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
          if (repause?.atomx_agent_workflow?.isStopped || !repause?.atomx_agent_workflow?.active) return;
          if (repause?.atomx_skip_current) {
            await chrome.storage.local.set({ atomx_workflow_paused: false });
            break;
          }
          if (!repause?.atomx_workflow_paused && !repause?.atomx_agent_workflow?.isPaused) break;
        }

        // Handle user skip
        const curSkipData = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
        if (stopChk?.atomx_skip_current || curSkipData?.atomx_skip_current) {
          await chrome.storage.local.set({ atomx_skip_current: false, atomx_workflow_paused: false });
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped post by user. Finding next...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          await delay(1200);
          continue;
        }

        const curDone = workflow.successCount || 0;
        await syncAgentHud(
          workflow,
          `[${curDone + 1}/${targetCount}] Scanning Home Feed (filtering Ads & detecting fresh posts)...`,
          'SCANNING',
          Math.round((curDone / targetCount) * 100)
        );

        const feedRes = await sendMessageToTab(tabId, {
          type: 'EXECUTE_HOME_FEED_ENGAGEMENT_STEP',
          actions: {
            like: options.likePosts ?? true,
            comment: options.commentPosts ?? true,
            repost: options.repostPosts ?? false,
            follow: options.followPosts ?? false
          },
          style: options.style || localData.selectedTone || 'Bullish (5-10 words)',
          stylePrompt: options.stylePrompt || localData.selectedTonePrompt || null,
          backendUrl,
          verifiedXHandle,
          alreadyEngagedIds: stopChk?.engagedTweetIds || []
        }, 90000);

        const stopChk2 = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopChk2?.atomx_agent_workflow?.isStopped || !stopChk2?.atomx_agent_workflow?.active) return;

        if (feedRes?.rateLimited) {
          await finishAgentWorkflow(workflow);
          return;
        }

        // Explicit abort check (user pressed Stop)
        if (feedRes?.aborted && stopChk2?.atomx_agent_workflow?.isStopped) {
          await finishAgentWorkflow(workflow);
          return;
        }

        // Timeout / content-script disconnect: do NOT hang — scroll and retry
        if (!feedRes || feedRes?.error === 'timeout' || feedRes?.error?.includes('Receiving end')) {
          console.warn('[ATOMX BG] feedengager: sendMessageToTab timed out or disconnected. Scrolling and retrying...');
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⚠️ Page not responding. Waiting to retry...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(3000);
          await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          await delay(2000);
          continue;
        }

        // User skip: advance counter and move on without aborting
        if (feedRes?.skipped || (feedRes?.aborted && !stopChk2?.atomx_agent_workflow?.isStopped)) {
          await chrome.storage.local.set({ atomx_skip_current: false });
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          if (feedRes?.tweetId) {
            const engData = await chrome.storage.local.get(['engagedTweetIds']).catch(() => ({}));
            const engIds = Array.from(new Set([...(engData.engagedTweetIds || []), feedRes.tweetId].filter(Boolean)));
            await chrome.storage.local.set({ engagedTweetIds: engIds }).catch(() => null);
          }
          await chrome.storage.local.set({ atomx_agent_workflow: workflow });
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped. Moving to next post...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(800);
          continue;
        }

        if (feedRes?.aborted) {
          await finishAgentWorkflow(workflow);
          return;
        }

        if (feedRes?.success && feedRes?.engaged) {
          workflow.successCount = (workflow.successCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);

          if (feedRes.commented) {
            const credData = await chrome.storage.local.get(['credits']).catch(() => ({}));
            const newCredits = Math.max(0, (credData.credits || 0) - 1);
            await chrome.storage.local.set({ credits: newCredits }).catch(() => null);
          }

          if (feedRes.tweetId) {
            const engData = await chrome.storage.local.get(['engagedTweetIds']).catch(() => ({}));
            const engIds = Array.from(new Set([...(engData.engagedTweetIds || []), feedRes.tweetId].filter(Boolean)));
            await chrome.storage.local.set({ engagedTweetIds: engIds }).catch(() => null);
          }

          const actionList = Object.entries(feedRes.performed || {})
            .filter(([, v]) => v)
            .map(([k]) => k.toUpperCase())
            .join(' + ');

          if (workflow.successCount >= targetCount) {
            workflow.active = false;
            await syncAgentHud(
              workflow,
              `✓ Home Feed engagement complete! Engaged ${workflow.successCount} posts.`,
              'DONE',
              100
            );
            await finishAgentWorkflow(workflow);
            return;
          }

          await syncAgentHud(
            workflow,
            `[${workflow.successCount}/${targetCount}] ✓ Engaged @${feedRes.authorHandle || 'creator'} (${actionList || 'DONE'})`,
            'SUCCESS',
            Math.round((workflow.successCount / targetCount) * 100)
          );

          // Anti-ban safety pacing countdown before next post
          if (workflow.successCount < targetCount) {
            const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
            const safety = safetyRes?.atomx_safety_settings || {};
            const isBatchBreak = shouldTakeSafetyBatchBreak(workflow.successCount, workflow, safety, 10, 15);
            if (isBatchBreak) {
              await chrome.storage.local.set({ atomx_agent_workflow: workflow });
              const restSec = getSafetyRestDurationSec(safety, 1, 3);
              await scheduleAgentPacingCountdown(
                restSec,
                workflow,
                workflow.successCount,
                targetCount,
                `Safety Batch Break: Resting ${Math.round(restSec / 60)}m...`
              );
            } else {
              await chrome.storage.local.set({ atomx_agent_workflow: workflow });
              const randomizedDelay = getSafetyPacingDelay(safety, 'profileWait', 10, 20);
              await scheduleAgentPacingCountdown(
                randomizedDelay,
                workflow,
                workflow.successCount,
                targetCount,
                `post ${workflow.successCount + 1}/${targetCount}`
              );
            }
          }
        } else if (feedRes?.skippedAd) {
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] 🛡️ Promoted Ad detected & skipped automatically.`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          if (!feedRes?.scrolledMore) {
            await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          }
          await delay(1500);
        } else {
          // No fresh post found in current viewport — scroll to hydrate new posts
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] 🔍 No fresh post found. Scrolling for more...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          if (!feedRes?.scrolledMore) {
            await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          }
          await delay(2000);
        }
      }

      workflow.active = false;
      await syncAgentHud(workflow, `✓ Home Feed engagement complete! Engaged ${workflow.successCount || 0} posts.`, 'DONE', 100);
      await finishAgentWorkflow(workflow);
      return;
    } catch (err) {
      console.warn('[ATOMX BG] Error in feedengager workflow:', err);
      agentWorkflowWorkingTabId = null;
      await finishAgentWorkflow(workflow);
      return;
    }
  }

  // =========================================================================
  // AGENT 15: NICHE SEARCH ENGAGER (x.com/search with Ad Skip & AI Voice)
  // =========================================================================
  if (agentId === 'nicheengager') {
    const keyword = (options.keyword || '').trim();
    const targetCount = Number(options.targetCount) || 10;
    const verifiedXHandle = options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle;
    const safetyData = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
    const pacingDelaySec = Math.max(5, Number(safetyData?.atomx_safety_settings?.replyDelay) || Number(options.pacingDelaySec) || 10);
    const localData = await chrome.storage.local.get(['backendUrl', 'selectedTone', 'selectedTonePrompt']).catch(() => ({}));
    const backendUrl = (options.backendUrl || localData.backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '');

    // Twitter search query with -filter:retweets AND -filter:replies to guarantee 100% original root posts only
    const cleanKw = keyword.trim();
    const searchUrl = options.feedMode === 'top'
      ? `https://x.com/search?q=${encodeURIComponent(cleanKw)} -filter:retweets -filter:replies&src=typed_query`
      : `https://x.com/search?q=${encodeURIComponent(cleanKw)} -filter:retweets -filter:replies&f=live`;

    await syncAgentHud(workflow, `Searching X for "${cleanKw}"...`, 'SCANNING', 5);

    try {
      const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId || options.tabId, searchUrl);
      agentWorkflowWorkingTabId = tabId;
      await waitForTabLoad(tabId, 15000);
      await delay(2500);

      // Account Lock Check
      const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
      if (!lockCheck.ok) return;

      while ((workflow.successCount || 0) < targetCount) {
        const stopChk = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_skip_current', 'atomx_workflow_paused', 'engagedTweetIds']).catch(() => ({}));
        if (stopChk?.atomx_agent_workflow?.isStopped || !stopChk?.atomx_agent_workflow?.active) return;

        // Handle user pause
        while (stopChk?.atomx_workflow_paused || stopChk?.atomx_agent_workflow?.isPaused) {
          await syncAgentHud(
            workflow,
            '⏸️ Niche Search Engager Paused by User',
            'PAUSED',
            Math.round(((workflow.successCount || 0) / targetCount) * 100),
            '',
            'Resume to continue',
            '⏸️ Paused'
          );
          await delay(500);
          const repause = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
          if (repause?.atomx_agent_workflow?.isStopped || !repause?.atomx_agent_workflow?.active) return;
          if (repause?.atomx_skip_current) {
            await chrome.storage.local.set({ atomx_workflow_paused: false });
            break;
          }
          if (!repause?.atomx_workflow_paused && !repause?.atomx_agent_workflow?.isPaused) break;
        }

        // Handle user skip
        const curSkipData2 = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
        if (stopChk?.atomx_skip_current || curSkipData2?.atomx_skip_current) {
          await chrome.storage.local.set({ atomx_skip_current: false, atomx_workflow_paused: false });
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped post by user. Finding next...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          await delay(1200);
          continue;
        }

        const curDone = workflow.successCount || 0;
        await syncAgentHud(
          workflow,
          `[${curDone + 1}/${targetCount}] Scanning "${keyword}" search feed (filtering Ads & detecting fresh posts)...`,
          'SCANNING',
          Math.round((curDone / targetCount) * 100)
        );

        const feedRes = await sendMessageToTab(tabId, {
          type: 'EXECUTE_HOME_FEED_ENGAGEMENT_STEP',
          filterRepliesAndReposts: true,
          actions: {
            like: options.likePosts ?? true,
            comment: options.commentPosts ?? true,
            repost: options.repostPosts ?? false,
            follow: options.followPosts ?? false
          },
          style: options.style || localData.selectedTone || 'Bullish (5-10 words)',
          stylePrompt: options.stylePrompt || localData.selectedTonePrompt || null,
          backendUrl,
          verifiedXHandle,
          alreadyEngagedIds: stopChk?.engagedTweetIds || []
        }, 60000);

        const stopChk2 = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopChk2?.atomx_agent_workflow?.isStopped || !stopChk2?.atomx_agent_workflow?.active) return;

        if (feedRes?.rateLimited) {
          await finishAgentWorkflow(workflow);
          return;
        }

        if (feedRes?.skipped || (feedRes?.aborted && !stopChk2?.atomx_agent_workflow?.isStopped)) {
          // USER CLICKED SKIP: Do not abort! Advance ignored count and continue smoothly to next post
          await chrome.storage.local.set({ atomx_skip_current: false });
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          await chrome.storage.local.set({ atomx_agent_workflow: workflow });
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped current item. Moving to next post...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(800);
          continue;
        }

        if (feedRes?.aborted) {
          await finishAgentWorkflow(workflow);
          return;
        }

        if (feedRes?.success && feedRes?.engaged) {
          workflow.successCount = (workflow.successCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);

          if (feedRes.commented) {
            const credData = await chrome.storage.local.get(['credits']).catch(() => ({}));
            const newCredits = Math.max(0, (credData.credits || 0) - 1);
            await chrome.storage.local.set({ credits: newCredits }).catch(() => null);
          }

          if (feedRes.tweetId) {
            const engData = await chrome.storage.local.get(['engagedTweetIds']).catch(() => ({}));
            const engIds = Array.from(new Set([...(engData.engagedTweetIds || []), feedRes.tweetId].filter(Boolean)));
            await chrome.storage.local.set({ engagedTweetIds: engIds }).catch(() => null);
          }

          const actionList = Object.entries(feedRes.performed || {})
            .filter(([, v]) => v)
            .map(([k]) => k.toUpperCase())
            .join(' + ');

          if (workflow.successCount >= targetCount) {
            workflow.active = false;
            await syncAgentHud(
              workflow,
              `✓ Niche engagement complete! Engaged ${workflow.successCount} posts.`,
              'DONE',
              100
            );
            await finishAgentWorkflow(workflow);
            return;
          }

          await syncAgentHud(
            workflow,
            `[${workflow.successCount}/${targetCount}] ✓ Engaged @${feedRes.authorHandle || 'creator'} (${actionList || 'DONE'})`,
            'SUCCESS',
            Math.round((workflow.successCount / targetCount) * 100)
          );

          // Anti-ban safety pacing countdown before next post
          if (workflow.successCount < targetCount) {
            const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
            const safety = safetyRes?.atomx_safety_settings || {};
            const isBatchBreak = shouldTakeSafetyBatchBreak(workflow.successCount, workflow, safety, 10, 15);
            if (isBatchBreak) {
              await chrome.storage.local.set({ atomx_agent_workflow: workflow });
              const restSec = getSafetyRestDurationSec(safety, 1, 3);
              await scheduleAgentPacingCountdown(
                restSec,
                workflow,
                workflow.successCount,
                targetCount,
                `Safety Batch Break: Resting ${Math.round(restSec / 60)}m...`
              );
            } else {
              await chrome.storage.local.set({ atomx_agent_workflow: workflow });
              const randomizedDelay = getSafetyPacingDelay(safety, 'profileWait', 10, 20);
              await scheduleAgentPacingCountdown(
                randomizedDelay,
                workflow,
                workflow.successCount,
                targetCount,
                `post ${workflow.successCount + 1}/${targetCount}`
              );
            }
          }
        } else if (feedRes?.skippedAd) {
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] 🛡️ Promoted Ad detected & skipped automatically.`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(600);
        } else if (feedRes?.skippedRepost) {
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] 🛡️ Repost (Retweet) filtered out. Scanning original...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(600);
        } else if (feedRes?.skippedReply) {
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] 🛡️ Reply / Comment filtered out. Scanning original...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(600);
        } else {
          // No fresh post in current screen, scroll down to hydrate more posts if content script hasn't already scrolled
          if (!feedRes?.scrolledMore) {
            await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
            await delay(1500);
          }
        }
      }

      workflow.active = false;
      await syncAgentHud(workflow, `✓ Niche search engagement complete! Engaged ${workflow.successCount || 0} posts for "${keyword}".`, 'DONE', 100);
      await finishAgentWorkflow(workflow);
      return;
    } catch (err) {
      console.warn('[ATOMX BG] Error in nicheengager workflow:', err);
      agentWorkflowWorkingTabId = null;
      await finishAgentWorkflow(workflow);
      return;
    }
  }

  // =========================================================================
  // AGENT 16: TG LIKER (MASS RAID, REPOSTS & QUOTES ENGAGER)
  // Continuous In-Page Autonomous Engine
  // =========================================================================
  if (agentId === 'tgliker') {
    if (tabId && typeof tabId === 'number') {
      agentWorkflowWorkingTabId = tabId;
      injectTabCloseProtection(tabId);
    }
    return;
  }

  // Dynamic live scan phase (Followers Increase, Sorsa Booster custom list, Audience Builder custom list)
  // =========================================================================
  // AGENT 4: FOLLOWERS INCREASE (Autonomous direct timeline engagement on List's recent posts)
  // Opens list timeline / search query feed and directly engages on cards from top down.
  // =========================================================================
  // AGENT 4: FOLLOWERS INCREASE
  // MODE A: "Newest Tweet First" -> Direct top-down engagement on list timeline (no scan)
  // MODE B: "Most Active" -> Scans list within timeframe, ranks by replies/engagement, queues top posts
  // =========================================================================
  if (agentId === 'followers' && (!items || items.length === 0)) {
    const listId = options.listId;
    const isNewestFirst = (options.sortPriority === 'recent');
    const targetCount = Number(options.targetCount) || 8;
    const verifiedXHandle = options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle;

    // ─────────────────────────────────────────────────────────────────────
    // BRANCH A: "NEWEST TWEET FIRST" (Sequential Top-Down Engagement on Timeline)
    // Uses search live with -filter:replies -filter:retweets so only pure original posts load.
    // ─────────────────────────────────────────────────────────────────────
    if (isNewestFirst) {
      const searchFeedUrl = options.searchFeedUrl || (listId ? `https://x.com/search?q=${encodeURIComponent(`list:${listId} -filter:replies -filter:retweets`)}&f=live` : null);
      const canonicalListUrl = options.targetListUrl || options.feedUrl || (listId ? `https://x.com/i/lists/${listId}` : 'https://x.com/home');
      const primaryFeedUrl = searchFeedUrl || canonicalListUrl;

      await syncAgentHud(workflow, `Opening filtered search feed for newest pure posts...`, 'ENGAGING', 10);
      try {
        const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId, primaryFeedUrl);
        agentWorkflowWorkingTabId = tabId;
        await waitForTabLoad(tabId, 15000);
        await delay(3000);

        const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
        if (!lockCheck.ok) return;

        const stopCheck = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopCheck?.atomx_agent_workflow?.isStopped || !stopCheck?.atomx_agent_workflow?.active) return;

        await syncAgentHud(workflow, `Engaging on list timeline directly from top downwards...`, 'ENGAGING', 15);

        const cycleRes = await sendMessageToTab(tabId, {
          type: 'EXECUTE_FOLLOWERS_LIST_CYCLE',
          targetCount,
          freshness: '7d',  // Newest-first: no freshness cut-off — engage whatever is at top of list
          sortPriority: 'recent',
          likePosts: options.likePosts !== false,
          replyPosts: options.replyPosts !== false,
          repostPosts: options.repostPosts === true,
          autoFollow: options.autoFollow !== false,
          style: options.style || 'Natural & Concise',
          stylePrompt: options.stylePrompt || null,
          backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
          verifiedXHandle
        }, 600000);

        const chk = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (chk?.atomx_agent_workflow?.isStopped || !chk?.atomx_agent_workflow?.active) return;

        const engaged = cycleRes?.engagedCount || 0;
        const skipped = cycleRes?.skippedCount || 0;

        if (engaged > 0) {
          const credData = await chrome.storage.local.get(['credits']).catch(() => ({}));
          const newCredits = Math.max(0, (credData.credits || 0) - engaged);
          await chrome.storage.local.set({ credits: newCredits }).catch(() => null);
        }

        const finishedWf = {
          ...workflow,
          active: false,
          isStopped: true,
          currentIndex: engaged,
          total: targetCount,
          successCount: engaged,
          ignoredCount: skipped,
          stateBadge: 'DONE',
          statusText: `✓ Followers Increase complete! ${engaged} posts engaged directly on timeline (${skipped} skipped).`
        };
        await chrome.storage.local.set({ atomx_agent_workflow: finishedWf });
        await syncAgentHud(finishedWf, finishedWf.statusText, 'DONE', 100);
        await finishAgentWorkflow(finishedWf);
        return;
      } catch (fErr) {
        console.warn('[ATOMX BG] Error in Followers Increase Newest cycle:', fErr);
        agentWorkflowWorkingTabId = null;
        await finishAgentWorkflow(workflow);
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // BRANCH B: "MOST ACTIVE" (Scan within timeframe, rank by replies, queue top posts)
    // ─────────────────────────────────────────────────────────────────────
    else {
      const searchFeedUrl = options.searchFeedUrl || (listId ? `https://x.com/search?q=${encodeURIComponent(`list:${listId} -filter:replies -filter:retweets`)}&f=live` : null);
      const canonicalListUrl = options.targetListUrl || (listId ? `https://x.com/i/lists/${listId}` : (options.feedUrl || 'https://x.com'));
      const primaryFeedUrl = searchFeedUrl || canonicalListUrl;

      await syncAgentHud(workflow, `Opening filtered search feed for top active posts (${options.freshness || '1h'})...`, 'SCANNING', 10);
      try {
        const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId, primaryFeedUrl);
        agentWorkflowWorkingTabId = tabId;
        await waitForTabLoad(tabId, 15000);
        await delay(3000);

        const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
        if (!lockCheck.ok) return;

        const discRes = await sendMessageToTab(tabId, {
          type: 'DISCOVER_TOP_ACTIVE_LIST_TWEETS',
          targetCount,
          freshness: options.freshness || '1h',
          sortPriority: 'active',
          verifiedXHandle
        }, 300000);

        // Immediate stop check after scan
        const stopCheck = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopCheck?.atomx_agent_workflow?.isStopped || !stopCheck?.atomx_agent_workflow?.active) return;

        const topTweets = Array.isArray(discRes?.topTweets) ? discRes.topTweets : [];

        if (topTweets.length === 0) {
          workflow.active = false;
          workflow.successCount = 0;
          workflow.total = targetCount;
          await syncAgentHud(workflow, `No unengaged posts found in selected timeframe (${options.freshness || '1h'}).`, 'DONE', 100);
          await finishAgentWorkflow(workflow);
          return;
        }

        // Populate workflow queue with top active posts sorted by replies
        const workflowItems = topTweets.slice(0, targetCount).map(t => ({
          tweetUrl: t.tweetUrl,
          tweetId: t.tweetId,
          targetHandle: t.authorHandle,
          authorHandle: t.authorHandle,
          authorName: t.authorName,
          text: t.text,
          repliesCount: t.repliesCount
        }));

        const updatedWorkflow = {
          ...workflow,
          items: workflowItems,
          total: workflowItems.length,
          targetCount,
          currentIndex: 0,
          successCount: 0,
          ignoredCount: discRes?.skippedCount || 0,
          statusText: `Selected top ${workflowItems.length} most active posts. Engaging individually...`
        };
        await chrome.storage.local.set({ atomx_agent_workflow: updatedWorkflow });
        await syncAgentHud(updatedWorkflow, updatedWorkflow.statusText, 'ENGAGING', 20);
        setTimeout(() => processAgentWorkflowStep(), 800);
        return;
      } catch (aErr) {
        console.warn('[ATOMX BG] Error in Followers Most Active scan:', aErr);
        await finishAgentWorkflow(workflow);
        return;
      }
    }
  }

  // =========================================================================
  // AGENT 1: AUDIENCE BUILDER (In-Thread Single-Tab Comment Loop)
  // 1. Opens list to discover top engaged post(s)
  // 2. Navigates to top post in SAME tab
  // 3. Inspects comments directly: likes comment to track, clicks profile in SAME tab,
  //    engages, goes back in SAME tab, repeats for next comment!
  // =========================================================================
  if (agentId === 'audience') {
    const listId = options.listId;
    const searchFeedUrl = options.searchFeedUrl || (listId ? `https://x.com/search?q=${encodeURIComponent(`list:${listId} -filter:replies -filter:retweets`)}&f=live` : null);
    const canonicalListUrl = options.targetListUrl || options.feedUrl || (listId ? `https://x.com/i/lists/${listId}` : 'https://x.com');
    const primaryFeedUrl = searchFeedUrl || canonicalListUrl;
    const targetCount = Number(options.targetCount) || 10;
    const verifiedXHandle = options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle;

    await syncAgentHud(workflow, `Opening filtered search feed to discover top engaged posts...`, 'SCANNING', 10);
    try {
      const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId, primaryFeedUrl);
      agentWorkflowWorkingTabId = tabId;
      await waitForTabLoad(tabId, 15000);
      await delay(3000);

      const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
      if (!lockCheck.ok) return;

      // Discover candidate top engaged tweets with replies
      let topTweetsRes = await sendMessageToTab(tabId, {
        type: 'DISCOVER_TOP_ENGAGED_LIST_TWEETS',
        freshness: options.freshness || '2h',
        targetCount
      }, 60000);

      let topTweets = Array.isArray(topTweetsRes?.topTweets) ? topTweetsRes.topTweets : [];

      // Fallback: If 0 tweets in search feed (e.g. list has low original post activity), check list timeline directly
      if (topTweets.length === 0 && canonicalListUrl && primaryFeedUrl !== canonicalListUrl) {
        console.log('[ATOMX BG] Search feed yielded 0 tweets. Checking list timeline directly...');
        await syncAgentHud(workflow, `Checking list timeline directly for active posts...`, 'SCANNING', 15);
        await getOrCreateReusedTab(tabId, canonicalListUrl);
        await waitForTabLoad(tabId, 15000);
        await delay(3000);
        topTweetsRes = await sendMessageToTab(tabId, {
          type: 'DISCOVER_TOP_ENGAGED_LIST_TWEETS',
          freshness: options.freshness || '2h',
          targetCount
        }, 60000);
        topTweets = Array.isArray(topTweetsRes?.topTweets) ? topTweetsRes.topTweets : [];
      }

      if (topTweets.length === 0) {
        workflow.active = false;
        await syncAgentHud(workflow, `No active posts found in selected timeframe (${options.freshness || '2h'}).`, 'DONE', 100);
        await finishAgentWorkflow(workflow);
        return;
      }

      // Loop through candidate top posts, inspecting their comment sections directly in-thread
      for (const t of topTweets) {
        if ((workflow.successCount || 0) >= targetCount) break;
        if (!t.url) continue;

        const chk = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_rate_limited']).catch(() => ({}));
        if (chk?.atomx_agent_workflow?.isStopped || !chk?.atomx_agent_workflow?.active || chk?.atomx_rate_limited?.active) return;

        const mainAuthor = (t.author || '').toLowerCase().replace(/^@/, '').trim();
        await syncAgentHud(workflow, `Navigating to post by @${mainAuthor || 'creator'} to inspect comments...`, 'SCANNING', Math.round(((workflow.successCount || 0) / targetCount) * 100));

        // Visibly move virtual cursor to top post on the page and click to enter!
        const clickPostRes = await sendMessageToTab(tabId, {
          type: 'CLICK_AND_OPEN_TARGET_POST',
          postUrl: t.url,
          author: mainAuthor
        }, 5000).catch(() => null);

        if (!clickPostRes || !clickPostRes.clicked) {
          // Fallback tab navigation if not clicked via DOM
          await getOrCreateReusedTab(tabId, t.url);
        }
        await waitForTabLoad(tabId, 15000);
        await delay(2500);

        // Inside this post: iteratively find unliked comment -> like comment -> visit profile in same tab -> engage -> go back -> repeat
        while ((workflow.successCount || 0) < targetCount) {
          const stopChk = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_skip_current', 'atomx_rate_limited']).catch(() => ({}));
          if (stopChk?.atomx_agent_workflow?.isStopped || !stopChk?.atomx_agent_workflow?.active || stopChk?.atomx_rate_limited?.active) return;

          if (stopChk?.atomx_skip_current) {
            await chrome.storage.local.set({ atomx_skip_current: false });
            workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
            workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
            await syncAgentHud(
              workflow,
              `[${(workflow.successCount || 0) + 1}/${targetCount}] ⏭️ Skipped current item. Finding next...`,
              'SCANNING',
              Math.round(((workflow.successCount || 0) / targetCount) * 100)
            );
            continue;
          }

          await syncAgentHud(
            workflow,
            `[${(workflow.successCount || 0) + 1}/${targetCount}] Finding next unliked comment on post by @${mainAuthor || 'creator'}...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );

          const commentRes = await sendMessageToTab(tabId, {
            type: 'FIND_AND_LIKE_NEXT_UNPROCESSED_COMMENT',
            verifiedXHandle,
            mainAuthor
          }, 45000);

          const stopChk2 = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_rate_limited']).catch(() => ({}));
          if (stopChk2?.atomx_agent_workflow?.isStopped || !stopChk2?.atomx_agent_workflow?.active || stopChk2?.atomx_rate_limited?.active) return;

          if (!commentRes || !commentRes.found) {
            console.log(`[ATOMX BG] Comments exhausted or completed on post by @${mainAuthor}. Moving to next top post.`);
            const skipAfterFind = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
            if (skipAfterFind?.atomx_skip_current) {
              await chrome.storage.local.set({ atomx_skip_current: false });
              workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
              workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
              await syncAgentHud(
                workflow,
                `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped comment scan. Moving to next top post...`,
                'SCANNING',
                Math.round(((workflow.successCount || 0) / targetCount) * 100)
              );
            }
            break; // Move to next post in topTweets
          }

          const cleanHandle = commentRes.cleanHandle;
          const profileUrl = `https://x.com/${cleanHandle}`;

          await syncAgentHud(
            workflow,
            `[${(workflow.successCount || 0) + 1}/${targetCount}] Liked comment by @${cleanHandle}! Visiting profile in same tab...`,
            'ENGAGING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );

          // Visit commenter profile in the SAME tab!
          if (commentRes?.profileClicked) {
            console.log(`[ATOMX BG] Profile was clicked via virtual cursor. Waiting for in-app navigation to @${cleanHandle}...`);
            let inAppDone = false;
            for (let w = 0; w < 12; w++) {
              await delay(350);
              try {
                const curTab = await chrome.tabs.get(tabId);
                const path = new URL(curTab.url).pathname.toLowerCase().replace(/^\//, '').split('/')[0];
                if (path === cleanHandle.toLowerCase()) {
                  inAppDone = true;
                  break;
                }
              } catch (e) {}
            }
            if (!inAppDone) {
              console.warn(`[ATOMX BG] In-app navigation fallback to URL load.`);
              await getOrCreateReusedTab(tabId, profileUrl);
              await waitForTabLoad(tabId, 12000);
            } else {
              await delay(1800); // Allow profile page components to mount smoothly
            }
          } else {
            await getOrCreateReusedTab(tabId, profileUrl);
            await waitForTabLoad(tabId, 15000);
            await delay(2500);
          }

          const lockCheck2 = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
          if (!lockCheck2.ok) return;

          // Engage on commenter profile
          const engageRes = await sendMessageToTab(tabId, {
            type: 'AUDIENCE_ENGAGE_AND_FOLLOW',
            handle: cleanHandle,
            likePosts: options.likePosts !== false,
            replyPosts: options.replyPosts !== false,
            repostPosts: options.repostPosts === true,
            followPosts: options.autoFollow !== false,
            postsCount: options.postsCount || options.postsPerProfile || 'random',
            style: options.style || 'Bullish (5-10 words)',
            stylePrompt: options.stylePrompt || null,
            backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
            verifiedXHandle
          }, 65000);

          const stopChk3 = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_rate_limited']).catch(() => ({}));
          if (stopChk3?.atomx_agent_workflow?.isStopped || !stopChk3?.atomx_agent_workflow?.active || stopChk3?.atomx_rate_limited?.active || engageRes?.rateLimited || engageRes?.isDailyLimit) {
            console.log('[ATOMX BG] Rate limit, daily post limit, or stop detected during audience engagement. Halting workflow.');
            return;
          }

          const isIgnored = engageRes?.ignored || engageRes?.skipped || engageRes?.alreadyDone;
          const isSuccess = Boolean(engageRes?.success && !isIgnored);

          if (isSuccess) {
            workflow.successCount = (workflow.successCount || 0) + 1;
            chrome.storage.local.get(['credits'], (c) => {
              const curCredits = c?.credits || 0;
              if (curCredits > 0) chrome.storage.local.set({ credits: curCredits - 1 });
            });
          } else {
            const curWf = (await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({})))?.atomx_agent_workflow;
            workflow.ignoredCount = Math.max((workflow.ignoredCount || 0) + 1, curWf?.ignoredCount || 0);
          }

          // Clear skip flag
          await chrome.storage.local.set({ atomx_skip_current: false });

          // Persist history so commenter isn't targeted again within 24h
          chrome.storage.local.get(['atomx_audience_engaged_history'], (r) => {
            const hist = (r?.atomx_audience_engaged_history && typeof r.atomx_audience_engaged_history === 'object') ? r.atomx_audience_engaged_history : {};
            hist[cleanHandle.toLowerCase()] = Date.now();
            chrome.storage.local.set({ atomx_audience_engaged_history: hist }).catch(() => null);
          });

          // Accurately compute currentIndex = successCount + ignoredCount
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          workflow.total = targetCount;
          await chrome.storage.local.set({ atomx_agent_workflow: workflow });

          await syncAgentHud(
            workflow,
            isIgnored
              ? `[${workflow.successCount}/${targetCount}] ⏭️ Skipped @${cleanHandle}! Returning back to post in same tab...`
              : `[${workflow.successCount}/${targetCount}] ✓ Engaged @${cleanHandle}! Returning back to post in same tab...`,
            'ENGAGING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );

          // Return cleanly back to post in the EXACT SAME tab! (Direct URL navigation prevents exiting X or hanging on browser new tab)
          console.log(`[ATOMX BG] Navigating cleanly back to post: ${t.url}...`);
          await getOrCreateReusedTab(tabId, t.url);
          await waitForTabLoad(tabId, 12000);
          await delay(2000);

          if ((workflow.successCount || 0) >= targetCount) break;

          // Natural pacing delay countdown before next comment (bypassed if skipped)
          if (!isIgnored) {
            const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
            const safety = safetyRes?.atomx_safety_settings || {};
            const isBatchBreak = shouldTakeSafetyBatchBreak(workflow.successCount, workflow, safety, 10, 15);
            if (isBatchBreak) {
              await chrome.storage.local.set({ atomx_agent_workflow: workflow });
              const restSec = getSafetyRestDurationSec(safety, 1, 3);
              await scheduleAgentPacingCountdown(restSec, workflow, workflow.successCount, targetCount, `Safety Batch Break: Resting ${Math.round(restSec / 60)}m...`);
            } else {
              await chrome.storage.local.set({ atomx_agent_workflow: workflow });
              const delaySec = getSafetyPacingDelay(safety, 'profileWait', 10, 20);
              await scheduleAgentPacingCountdown(delaySec, workflow, workflow.successCount, targetCount, `Next commenter from post`);
            }
          }
        }
      }

      await finishAgentWorkflow(workflow);
      return;
    } catch (auditErr) {
      console.warn('[ATOMX BG] Error in Audience Builder cycle:', auditErr);
      await finishAgentWorkflow(workflow);
      return;
    }
  }

  // =========================================================================
  // AGENT 5 / 7: AUTO UNFOLLOW (Defaulter Audit & Clean-Up)
  // Single-Tab Workflow:
  // 1. Reuses working tab to open https://x.com/${verifiedXHandle}/following
  // 2. Checks verified account lock
  // 3. Connects to Global AI Voice & Centralized Safety Settings
  // 4. In-page loop scans following accounts, skips whitelisted or follow-backs,
  //    and smoothly clicks unfollow + confirms modal on non-reciprocal accounts
  // 5. Pacing countdowns, batch rest breaks, and live Floating HUD updates
  // =========================================================================
  if (agentId === 'unfollow') {
    let verifiedXHandle = (options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle || '').replace(/^@/, '').trim();
    if (!verifiedXHandle) {
      const activeTabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }).catch(() => []);
      const probeId = activeTabs?.[0]?.id || agentWorkflowWorkingTabId || options.tabId;
      if (probeId) {
        const probeRes = await sendMessageToTab(probeId, { type: 'CHECK_CURRENT_LOGGED_IN_X_HANDLE' }, 4000).catch(() => null);
        if (probeRes?.rawHandle) {
          verifiedXHandle = probeRes.rawHandle.replace(/^@/, '').trim();
          await chrome.storage.local.set({ verifiedXHandle });
        }
      }
    }

    const followingUrl = options.feedUrl || (verifiedXHandle ? `https://x.com/${verifiedXHandle}/following` : 'https://x.com/home');
    const targetCount = Number(options.targetCount || options.targetLimit) || 25;

    // Connect to Centralized Safety Settings
    const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
    const safety = safetyRes?.atomx_safety_settings || {};
    const delaySec = Math.max(3, Number(safety.profileWait) || Number(options.delaySec) || 15);
    const batchCount = Math.max(2, Number(safety.batchCount) || Number(options.batchCount) || 15);
    const breakDurationSec = Math.max(5, Number(safety.restDuration ? safety.restDuration * 60 : 0) || Number(options.breakDuration) || 60);

    // Global AI Voice reference
    const localData = await chrome.storage.local.get(['selectedTone', 'selectedTonePrompt']).catch(() => ({}));
    const activeVoice = options.style || localData.selectedTone || 'Bullish (5-10 words)';

    const cleanWhitelist = (options.whitelist || []).map(w => (w || '').replace(/^@/, '').toLowerCase().trim()).filter(Boolean);

    await syncAgentHud(workflow, `Navigating to Following list (${followingUrl})...`, 'SCANNING', 5, '', 'Connecting to Following list');

    try {
      const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId || options.tabId, followingUrl);
      agentWorkflowWorkingTabId = tabId;

      const curTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!curTab?.url || !curTab.url.includes('/following')) {
        await waitForTabLoad(tabId, 15000);
        await delay(3500);
      } else {
        await delay(1500);
      }

      // Check account lock
      const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
      if (!lockCheck.ok) return;

      let consecutiveNoMore = 0;

      while ((workflow.successCount || 0) < targetCount) {
        const stopChk = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_skip_current', 'atomx_workflow_paused']).catch(() => ({}));
        if (stopChk?.atomx_agent_workflow?.isStopped || !stopChk?.atomx_agent_workflow?.active) return;

        // User pause handling
        while (stopChk?.atomx_workflow_paused || stopChk?.atomx_agent_workflow?.isPaused) {
          await syncAgentHud(
            workflow,
            '⏸️ Auto Unfollow Paused by User',
            'PAUSED',
            Math.round(((workflow.successCount || 0) / targetCount) * 100),
            '',
            'Resume to continue',
            '⏸️ Paused'
          );
          await delay(500);
          const repause = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
          if (repause?.atomx_agent_workflow?.isStopped || !repause?.atomx_agent_workflow?.active) return;
          if (repause?.atomx_skip_current) {
            await chrome.storage.local.set({ atomx_workflow_paused: false });
            break;
          }
          if (!repause?.atomx_workflow_paused && !repause?.atomx_agent_workflow?.isPaused) break;
        }

        // User skip handling
        const curSkipData = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
        if (stopChk?.atomx_skip_current || curSkipData?.atomx_skip_current) {
          await chrome.storage.local.set({ atomx_skip_current: false, atomx_workflow_paused: false });
          workflow.ignoredCount = (workflow.ignoredCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);
          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped current account by user. Scanning next...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          await delay(1200);
          continue;
        }

        const curDone = workflow.successCount || 0;
        await syncAgentHud(
          workflow,
          `[${curDone + 1}/${targetCount}] Auditing Following list (finding non-reciprocal accounts)...`,
          'SCANNING',
          Math.round((curDone / targetCount) * 100),
          '',
          `Target ${curDone + 1}/${targetCount}`,
          '⚡ Scanning'
        );

        const stepRes = await sendMessageToTab(tabId, {
          type: 'EXECUTE_AUTO_UNFOLLOW_STEP',
          criteria: options.criteria || { notFollowing: true, lowScore: false },
          scoreThreshold: options.scoreThreshold || 30,
          whitelist: cleanWhitelist,
          verifiedXHandle,
          targetCount,
          activeVoice,
          resetSession: (workflow.successCount === 0 && workflow.ignoredCount === 0)
        }, 65000);

        const stopChk2 = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
        if (stopChk2?.atomx_agent_workflow?.isStopped || !stopChk2?.atomx_agent_workflow?.active) return;

        if (stepRes?.unfollowed) {
          consecutiveNoMore = 0;
          workflow.successCount = (workflow.successCount || 0) + 1;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);

          // Deduct 1 credit per 5 unfollows (Rule: 5 unfollows = 1 credit)
          if (workflow.successCount % 5 === 0) {
            chrome.storage.local.get(['credits', 'verifiedXHandle', 'backendUrl'], async (c) => {
              const curCredits = c?.credits || 0;
              if (curCredits > 0) chrome.storage.local.set({ credits: curCredits - 1 });
              try {
                const bUrl = c?.backendUrl || DEFAULT_BACKEND_URL;
                const handle = (c?.verifiedXHandle || '').replace(/^@/, '').trim();
                if (handle) {
                  fetch(`${bUrl}/api/credits/deduct`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      handle,
                      amount: 1,
                      action: 'Auto Unfollow',
                      reason: `Batch unfollow: 5 accounts (@${stepRes.handle || 'user'})`
                    })
                  }).catch(() => null);
                }
              } catch (e) {}
            });
          }

          // Persist unfollow counters in storage for popup UI
          chrome.storage.local.set({
            atomx_unfollow_counters: {
              done: workflow.successCount,
              skipped: workflow.ignoredCount,
              target: targetCount
            }
          }).catch(() => null);

          await chrome.storage.local.set({ atomx_agent_workflow: workflow });

          await syncAgentHud(
            workflow,
            `[${workflow.successCount}/${targetCount}] ✓ Unfollowed @${stepRes.handle}!`,
            'ENGAGING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );

          if ((workflow.successCount || 0) >= targetCount) break;

          // Check if batch rest is due
          const curSafetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
          const curSafety = curSafetyRes?.atomx_safety_settings || safety;
          const isBatchBreak = shouldTakeSafetyBatchBreak(workflow.successCount, workflow, curSafety, 10, 15);
          if (isBatchBreak) {
            await chrome.storage.local.set({ atomx_agent_workflow: workflow });
            const dynamicRestSec = getSafetyRestDurationSec(curSafety, 1, 3);
            console.log(`[ATOMX BG] Batch of unfollows complete at ${workflow.successCount}. Taking safety break of ${dynamicRestSec}s...`);
            await scheduleAgentPacingCountdown(dynamicRestSec, workflow, workflow.successCount, targetCount, `Safety Batch Break: Resting ${Math.round(dynamicRestSec / 60)}m...`);
          } else {
            await chrome.storage.local.set({ atomx_agent_workflow: workflow });
            const jitterDelay = getSafetyPacingDelay(curSafety, 'profileWait', 10, 20);
            await scheduleAgentPacingCountdown(jitterDelay, workflow, workflow.successCount, targetCount, `Next account in Following list`);
          }
        } else if (stepRes?.skipped) {
          consecutiveNoMore = 0;
          const skippedCount = Number(stepRes.skippedCount) || 1;
          workflow.ignoredCount = (workflow.ignoredCount || 0) + skippedCount;
          workflow.currentIndex = (workflow.successCount || 0) + (workflow.ignoredCount || 0);

          chrome.storage.local.set({
            atomx_unfollow_counters: {
              done: workflow.successCount || 0,
              skipped: workflow.ignoredCount,
              target: targetCount
            }
          }).catch(() => null);

          await chrome.storage.local.set({ atomx_agent_workflow: workflow });

          await syncAgentHud(
            workflow,
            `[${workflow.successCount || 0}/${targetCount}] ⏭️ Skipped ${stepRes.handle ? '@' + stepRes.handle : 'accounts'}: ${stepRes.reason || 'Follows you back'}. Scanning next...`,
            'SCANNING',
            Math.round(((workflow.successCount || 0) / targetCount) * 100)
          );
          await delay(1500);
        } else if (stepRes?.exhausted || stepRes?.noMore) {
          consecutiveNoMore++;
          console.log(`[ATOMX BG] Following list exhausted check ${consecutiveNoMore}/4...`);
          if (consecutiveNoMore >= 4) {
            console.log('[ATOMX BG] Following list exhausted after multiple retries. Audit complete.');
            await syncAgentHud(workflow, `Following list audit completed. No more matching accounts.`, 'DONE', 100);
            break;
          }
          await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          await delay(2500);
        } else {
          // General scroll or delay before retrying
          if (!stepRes?.scrolledMore) {
            await sendMessageToTab(tabId, { type: 'SCROLL_FEED_DOWN' }, 5000).catch(() => null);
          }
          await delay(2000);
        }
      }

      await finishAgentWorkflow(workflow);
      return;
    } catch (unfErr) {
      console.warn('[ATOMX BG] Error in Auto Unfollow workflow:', unfErr);
      await finishAgentWorkflow(workflow);
      return;
    }
  }

  if (currentIndex >= total) {
    await finishAgentWorkflow(workflow);
    return;
  }

  const item = items[currentIndex];
  const targetHandle = (item.cleanHandle || item.handle || '').replace(/^@/, '').trim();
  const indexStr = `[${currentIndex + 1}/${total}]`;

  const displayTarget = item.authorHandle ? `@${item.authorHandle}` : (targetHandle ? `@${targetHandle}` : 'target');
  await syncAgentHud(
    workflow,
    `${indexStr} Visiting ${displayTarget}...`,
    'ENGAGING',
    Math.round((currentIndex / total) * 100)
  );

  try {
    let targetUrl = '';
    let messagePayload = null;
    let timeoutMs = 45000;

    if (agentId === 'followers') {
      targetUrl = item.tweetUrl;
      messagePayload = {
        type: 'EXECUTE_AUTONOMOUS_ENGAGEMENT',
        tweetUrl: item.tweetUrl,
        tweetId: item.tweetId,
        authorHandle: item.authorHandle,
        actions: {
          like: options.likePosts !== false,
          comment: options.replyPosts !== false,
          repost: options.repostPosts === true,
          follow: options.autoFollow !== false,
          scroll: true
        },
        style: options.style || 'Natural & Concise',
        stylePrompt: options.stylePrompt || null,
        backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
        verifiedXHandle: options.verifiedXHandle
      };
      timeoutMs = 65000;
    } else if (agentId === 'replyback') {
      targetUrl = item.tweetUrl || options.tweetUrl;
      messagePayload = {
        type: 'EXECUTE_REPLY_BACK_CYCLE',
        maxComments: options.maxReplies || options.maxComments || 10,
        delaySec: options.delaySec || 12,
        autoLike: options.autoLike !== false,
        style: options.style || 'Natural & Concise',
        backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
        verifiedXHandle: options.verifiedXHandle
      };
      timeoutMs = 180000; // 3 minutes timeout for multiple replies with delaySec
    } else if (agentId === 'reciprocator') {
      targetUrl = `https://x.com/${targetHandle}`;
      messagePayload = {
        type: 'AUDIENCE_ENGAGE_AND_FOLLOW',
        handle: targetHandle,
        likePosts: options.likePosts !== false && options.likeRecent !== false,
        replyPosts: options.replyPosts !== false && options.commentRecent !== false,
        repostPosts: options.repostPosts === true,
        followPosts: options.followPosts === true || options.followUser === true,
        postsCount: options.postsCount || options.postsPerProfile || 'random',
        style: options.style || 'Bullish (5-10 words)',
        stylePrompt: options.stylePrompt || null,
        backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
        verifiedXHandle: options.verifiedXHandle
      };
      timeoutMs = 45000;
    } else {
      // audience, sorsa
      targetUrl = `https://x.com/${targetHandle}`;
      const shouldFollow = options.autoFollow !== undefined ? Boolean(options.autoFollow) : (options.followPosts !== false);
      messagePayload = {
        type: 'AUDIENCE_ENGAGE_AND_FOLLOW',
        handle: targetHandle,
        likePosts: options.likePosts !== false,
        replyPosts: options.replyPosts !== false,
        repostPosts: options.repostPosts === true,
        followPosts: shouldFollow,
        autoUnfollow: options.autoUnfollow === true,
        postsCount: options.postsCount || options.postsPerProfile || 'random',
        style: options.style || 'Bullish (5-10 words)',
        stylePrompt: options.stylePrompt || null,
        backendUrl: options.backendUrl || DEFAULT_BACKEND_URL,
        verifiedXHandle: options.verifiedXHandle
      };
      timeoutMs = 90000;
    }

    if (agentWorkflowWorkingTabId) {
      await sendMessageToTab(agentWorkflowWorkingTabId, { type: 'CLEANUP_DRAFTS_BEFORE_NAV' }, 1500).catch(() => null);
    }

    const tabId = await getOrCreateReusedTab(agentWorkflowWorkingTabId, targetUrl);
    agentWorkflowWorkingTabId = tabId;

    await waitForTabLoad(tabId, 12000);

    // Instant skip check right after tab load
    const skipCheckLoad = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
    if (skipCheckLoad?.atomx_skip_current) {
      await chrome.storage.local.set({ atomx_skip_current: false });
      console.log(`[ATOMX BG] Target @${targetHandle} skipped on 1st click during tab load.`);
      const updatedWorkflow = {
        ...workflow,
        currentIndex: currentIndex + 1,
        ignoredCount: ignoredCount + 1
      };
      await chrome.storage.local.set({ atomx_agent_workflow: updatedWorkflow });
      await syncAgentHud(updatedWorkflow, `${indexStr} Skipped ${displayTarget} (skipped by user)`, 'SKIPPED', Math.round(((currentIndex + 1) / total) * 100));
      setTimeout(() => processAgentWorkflowStep(), 100);
      return;
    }

    await delay(2500);

    // Instant Account Lock Check before executing task
    const verifiedXHandle = options.verifiedXHandle || (await chrome.storage.local.get(['verifiedXHandle'])).verifiedXHandle;
    const lockCheck = await verifyTabAccountLock(tabId, verifiedXHandle, workflow);
    if (!lockCheck.ok) return;

    const recheck = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_skip_current']).catch(() => ({}));
    if (!recheck?.atomx_agent_workflow?.active) {
      return;
    }

    if (recheck?.atomx_skip_current) {
      await chrome.storage.local.set({ atomx_skip_current: false });
      console.log(`[ATOMX BG] Target @${targetHandle} skipped on 1st click before message dispatch.`);
      const updatedWorkflow = {
        ...workflow,
        currentIndex: currentIndex + 1,
        ignoredCount: ignoredCount + 1
      };
      await chrome.storage.local.set({ atomx_agent_workflow: updatedWorkflow });
      await syncAgentHud(updatedWorkflow, `${indexStr} Skipped ${displayTarget} (skipped by user)`, 'SKIPPED', Math.round(((currentIndex + 1) / total) * 100));
      setTimeout(() => processAgentWorkflowStep(), 100);
      return;
    }

    const result = await sendMessageToTab(tabId, messagePayload, timeoutMs);
    // Keep agentWorkflowWorkingTabId open so subsequent accounts/profiles reuse the exact same tab/window!

    // Verify if workflow was stopped during step execution
    const recheckAfter = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
    if (!recheckAfter?.atomx_agent_workflow?.active || recheckAfter?.atomx_agent_workflow?.isStopped) {
      console.log('[ATOMX BG] Workflow stopped while waiting for tab execution. Halting loop.');
      return;
    }
    const isSuccess = Boolean(result?.success);
    const isIgnored = Boolean(result?.ignored || result?.skipped || result?.alreadyDone);
    const newSuccess = isSuccess && !isIgnored ? successCount + 1 : successCount;
    const newIgnored = isIgnored || !isSuccess ? ignoredCount + 1 : ignoredCount;

    if (isSuccess && !isIgnored) {
      chrome.storage.local.get(['credits'], (c) => {
        const curCredits = c?.credits || 0;
        if (curCredits > 0) chrome.storage.local.set({ credits: curCredits - 1 });
      });

      if (agentId === 'reciprocator' && targetHandle) {
        chrome.storage.local.get(['atomx_reciprocated_commenters'], (r) => {
          const list = Array.isArray(r?.atomx_reciprocated_commenters) ? r.atomx_reciprocated_commenters : [];
          list.push(targetHandle);
          chrome.storage.local.set({ atomx_reciprocated_commenters: list }).catch(() => null);
        });
      }

      if (agentId === 'followers' && item.tweetId) {
        chrome.storage.local.get(['atomx_follower_engaged_tweets', 'atomx_follower_engaged_history'], (r) => {
          const tweets = (r?.atomx_follower_engaged_tweets && typeof r.atomx_follower_engaged_tweets === 'object') ? r.atomx_follower_engaged_tweets : {};
          const authors = (r?.atomx_follower_engaged_history && typeof r.atomx_follower_engaged_history === 'object') ? r.atomx_follower_engaged_history : {};
          tweets[item.tweetId] = Date.now();
          if (item.authorHandle) authors[item.authorHandle.toLowerCase()] = Date.now();
          chrome.storage.local.set({ atomx_follower_engaged_tweets: tweets, atomx_follower_engaged_history: authors }).catch(() => null);
        });
      }
    }

    // Always record visited timestamp for cool-off and deduplication across all visits
    if (targetHandle) {
      const lower = targetHandle.toLowerCase();
      if (agentId === 'sorsa') {
        chrome.storage.local.get(['atomx_sorsa_engaged_history'], (r) => {
          const history = (r?.atomx_sorsa_engaged_history && typeof r.atomx_sorsa_engaged_history === 'object') ? r.atomx_sorsa_engaged_history : {};
          history[lower] = Date.now();
          chrome.storage.local.set({ atomx_sorsa_engaged_history: history }).catch(() => null);
        });
      } else if (agentId === 'audience') {
        chrome.storage.local.get(['atomx_audience_engaged_history'], (r) => {
          const history = (r?.atomx_audience_engaged_history && typeof r.atomx_audience_engaged_history === 'object') ? r.atomx_audience_engaged_history : {};
          history[lower] = Date.now();
          chrome.storage.local.set({ atomx_audience_engaged_history: history }).catch(() => null);
        });
      } else if (agentId === 'followers') {
        chrome.storage.local.get(['atomx_follower_engaged_history'], (r) => {
          const history = (r?.atomx_follower_engaged_history && typeof r.atomx_follower_engaged_history === 'object') ? r.atomx_follower_engaged_history : {};
          history[lower] = Date.now();
          chrome.storage.local.set({ atomx_follower_engaged_history: history }).catch(() => null);
        });
      }
    }

    const updatedWorkflow = {
      ...workflow,
      currentIndex: currentIndex + 1,
      successCount: newSuccess,
      ignoredCount: newIgnored
    };
    await chrome.storage.local.set({ atomx_agent_workflow: updatedWorkflow });

    const statusLabel = isIgnored
      ? `${indexStr} Skipped ${displayTarget} (${result?.reason || 'already engaged'})`
      : `${indexStr} ✓ Engaged ${displayTarget}`;

    const targetGoal = Number(options.targetCount || workflow.targetCount || total);
    const targetReached = (targetGoal > 0) ? (newSuccess >= targetGoal) : (updatedWorkflow.currentIndex >= total);
    const progressPct = targetGoal > 0 ? Math.min(100, Math.round((newSuccess / targetGoal) * 100)) : Math.round(((currentIndex + 1) / total) * 100);

    await syncAgentHud(updatedWorkflow, statusLabel, 'ENGAGING', progressPct);

    if (!targetReached && updatedWorkflow.currentIndex < updatedWorkflow.items.length) {
      // Read centralized Anti-Ban Safety controls
      const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
      const isBatchBreak = shouldTakeSafetyBatchBreak(updatedWorkflow.successCount, updatedWorkflow, safety, 10, 15);
      const nextIdx = updatedWorkflow.currentIndex;
      if (isBatchBreak) {
        const restDurationSec = getSafetyRestDurationSec(safety, 1, 3);
        await scheduleAgentPacingCountdown(restDurationSec, updatedWorkflow, nextIdx, total, `Safety Batch Break: Resting ${Math.round(restDurationSec / 60)}m...`);
      } else if (agentId === 'followers' && Date.now() - (workflow.startedAt || 0) > 2 * 3600 * 1000) {
        // Followers Increase: 30m recovery pause after 2 hours
        await scheduleAgentPacingCountdown(30 * 60, updatedWorkflow, nextIdx, total, `Natural Schedule: 30m recovery pause after 2 hours...`);
      } else if (agentId === 'followers' && Date.now() - (workflow.startedAt || 0) > 30 * 60 * 1000 && !workflow.had30mBreak) {
        // Followers Increase: 12m rest break every 30 mins
        workflow.had30mBreak = true;
        await chrome.storage.local.set({ atomx_agent_workflow: workflow });
        await scheduleAgentPacingCountdown(12 * 60, updatedWorkflow, nextIdx, total, `Natural Schedule: 12m rest pause after 30 mins...`);
      } else {
        const delaySec = getSafetyPacingDelay(safety, 'profileWait', 10, 20);
        await scheduleAgentPacingCountdown(delaySec, updatedWorkflow, nextIdx, total);
      }
    } else {
      await finishAgentWorkflow(updatedWorkflow);
    }

  } catch (err) {
    console.warn(`[ATOMX BG] Agent workflow error on @${targetHandle}:`, err);
    if (targetHandle) {
      const lower = targetHandle.toLowerCase();
      const historyKey = agentId === 'sorsa' ? 'atomx_sorsa_engaged_history'
        : agentId === 'followers' ? 'atomx_follower_engaged_history'
        : agentId === 'audience' ? 'atomx_audience_engaged_history' : null;
      if (historyKey) {
        chrome.storage.local.get([historyKey], (r) => {
          const hist = (r?.[historyKey] && typeof r[historyKey] === 'object') ? r[historyKey] : {};
          hist[lower] = Date.now();
          chrome.storage.local.set({ [historyKey]: hist }).catch(() => null);
        });
      }
    }
    const updatedWorkflow = { ...workflow, currentIndex: currentIndex + 1, ignoredCount: ignoredCount + 1 };
    await chrome.storage.local.set({ atomx_agent_workflow: updatedWorkflow });
    if (updatedWorkflow.currentIndex < total) {
      const delaySec = Math.max(4, Math.min(options.delaySec || 12, 12));
      await scheduleAgentPacingCountdown(delaySec, updatedWorkflow, currentIndex + 1, total, 'Safety delay recovering before next target');
    } else {
      await finishAgentWorkflow(updatedWorkflow);
    }
  }
} finally {
  isAgentStepRunning = false;
}
}

async function scheduleAgentPacingCountdown(delaySec, workflow, completedIndex, total, nextActionText = '') {
  const pacingSession = currentWorkflowSessionId;
  for (let sec = delaySec; sec > 0; sec--) {
    if (currentWorkflowSessionId !== pacingSession) return;
    let recheck = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
    if (!recheck?.atomx_agent_workflow?.active || recheck?.atomx_agent_workflow?.isStopped) return;

    if (recheck?.atomx_skip_current) {
      await chrome.storage.local.set({ atomx_skip_current: false });
      setTimeout(() => processAgentWorkflowStep(), 100);
      return;
    }

    while (recheck?.atomx_workflow_paused || recheck?.atomx_agent_workflow?.isPaused) {
      await delay(400);
      if (currentWorkflowSessionId !== pacingSession) return;
      recheck = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_workflow_paused', 'atomx_skip_current']).catch(() => ({}));
      if (!recheck?.atomx_agent_workflow?.active || recheck?.atomx_agent_workflow?.isStopped) return;
      if (recheck?.atomx_skip_current) {
        await chrome.storage.local.set({ atomx_skip_current: false });
        setTimeout(() => processAgentWorkflowStep(), 100);
        return;
      }
      if (!recheck?.atomx_workflow_paused && !recheck?.atomx_agent_workflow?.isPaused) break;
    }

    const min = Math.floor(sec / 60);
    const s = sec % 60;
    const timeStr = min > 0 ? `${min}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
    const isBatchBreak = sec > 60 || (nextActionText && nextActionText.includes('Batch Break'));
    const statusMsg = isBatchBreak
      ? `☕ Safety Batch Break: Resting ${timeStr} after ${completedIndex} targets...`
      : `⏳ Profile Wait (Between Accounts): ${sec}s before ${nextActionText || ('target ' + (completedIndex + 1) + '/' + total)}...`;
    const countdownLabel = isBatchBreak ? `☕ Break: ${timeStr}` : `Profile Wait: ${timeStr}`;

    await syncAgentHud(
      recheck.atomx_agent_workflow,
      statusMsg,
      isBatchBreak ? 'BATCH_BREAK' : 'PACING',
      Math.round((completedIndex / total) * 100),
      countdownLabel,
      countdownLabel,
      `⏱️ ${timeStr}`
    );
    await delay(1000);
  }
  if (currentWorkflowSessionId === pacingSession) {
    setTimeout(() => processAgentWorkflowStep(), 200);
  }
}

async function finishAgentWorkflow(workflow) {
  const { title, successCount, ignoredCount, total } = workflow;
  console.log(`[ATOMX BG] ${title} COMPLETE: ${successCount}/${total} engaged, ${ignoredCount} skipped.`);

  const finalWorkflow = {
    ...workflow,
    active: false,
    stateBadge: 'DONE',
    progressPercent: 100,
    countdownText: '',
    statusText: `✓ Workflow complete! ${successCount} processed, ${ignoredCount} skipped.`,
    finishedAt: Date.now()
  };
  const activeHud = {
    title,
    stateBadge: 'DONE',
    indicator: `${total}/${total}`,
    done: successCount,
    collected: total,
    skipped: ignoredCount,
    progressPercent: 100,
    statusText: `✓ Workflow complete! ${successCount} processed, ${ignoredCount} skipped.`,
    countdownText: '',
    timerBadge: '✓ Done',
    nextAction: 'Workflow Completed',
    isStopped: true,
    active: false
  };
  await chrome.storage.local.set({
    atomx_agent_workflow: finalWorkflow,
    atomx_active_hud: activeHud
  });
  broadcastHudToTabs(activeHud);

  chrome.alarms.clear('atomx_agent_workflow_step').catch(() => null);
  chrome.alarms.clear('atomx_agent_pacing').catch(() => null);
}

async function abortAgentWorkflow() {
  currentWorkflowSessionId = 0;
  isAgentStepRunning = false;

  const stored = await chrome.storage.local.get(['atomx_agent_workflow']).catch(() => ({}));
  const workflow = stored?.atomx_agent_workflow;
  const activeHud = {
    title: workflow?.title || 'AtomX Agent',
    stateBadge: 'STOPPED',
    statusText: 'Workflow stopped by user.',
    countdownText: '',
    timerBadge: '🛑 Stopped',
    nextAction: 'Stopped',
    isStopped: true,
    active: false
  };
  await chrome.storage.local.set({
    atomx_agent_workflow: { ...workflow, active: false, isStopped: true, stateBadge: 'STOPPED', statusText: 'Workflow stopped by user.', countdownText: '', timerBadge: '🛑 Stopped' },
    atomx_active_hud: activeHud,
    atomx_workflow_paused: false,
    atomx_skip_current: false
  });

  // Broadcast ABORT_WORKFLOW to all open Twitter/X tabs
  try {
    chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
      if (tabs && tabs.length > 0) {
        tabs.forEach(t => {
          if (t.id) chrome.tabs.sendMessage(t.id, { type: 'ABORT_WORKFLOW' }).catch(() => null);
        });
      }
    });
  } catch (e) {}

  broadcastHudToTabs(activeHud);
  try {
    chrome.runtime.sendMessage({ type: 'ABORT_WORKFLOW' }).catch(() => null);
  } catch (e) {}

  if (agentWorkflowWorkingTabId) {
    chrome.tabs.sendMessage(agentWorkflowWorkingTabId, { type: 'ABORT_WORKFLOW' }).catch(() => null);
  }
  chrome.alarms.clear('atomx_agent_workflow_step').catch(() => null);
  chrome.alarms.clear('atomx_agent_pacing').catch(() => null);
  chrome.alarms.clear('atomx_keepalive').catch(() => null);
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

async function delay(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = await chrome.storage.local.get(['atomx_skip_current', 'atomx_agent_workflow', 'atomx_tg_raid', 'atomx_rate_limited']).catch(() => ({}));
    if (s?.atomx_skip_current) break;
    if (s?.atomx_rate_limited?.active) break;

    const tg = s?.atomx_tg_raid;
    const wf = s?.atomx_agent_workflow;

    // Only abort if the currently active workflow is stopped
    if (tg?.active) {
      if (tg.isStopped || tg.stateBadge === 'STOPPED' || tg.stateBadge === 'RATE_LIMITED' || tg.stateBadge === 'DAILY_LIMIT') break;
    } else if (wf?.active) {
      if (wf.isStopped || wf.stateBadge === 'STOPPED' || wf.stateBadge === 'RATE_LIMITED' || wf.stateBadge === 'DAILY_LIMIT') break;
    }

    const chunk = Math.min(100, ms - (Date.now() - start));
    if (chunk <= 0) break;
    await new Promise(r => setTimeout(r, chunk));
  }
}

async function waitForTabLoad(tabId, maxTimeout = 12000, expectedSubstring = '') {
  // 1. Wait until tab.status === 'complete' (and matches expectedSubstring if provided) or until maxTimeout
  await new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        chrome.tabs.onUpdated.removeListener(updateListener);
        resolve(true);
      }
    }, maxTimeout);

    function updateListener(id, changeInfo, tab) {
      if (id === tabId && changeInfo.status === 'complete') {
        const curUrl = tab?.url || changeInfo.url || '';
        const urlMatches = expectedSubstring ? curUrl.includes(expectedSubstring) : true;
        if (!finished && urlMatches) {
          finished = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(updateListener);
          resolve(true);
        }
      }
    }
    chrome.tabs.onUpdated.addListener(updateListener);

    // Initial check: only consider tab complete if its URL already matches expectedSubstring
    chrome.tabs.get(tabId, (tab) => {
      const urlMatches = expectedSubstring ? (tab?.url && tab.url.includes(expectedSubstring)) : true;
      if (!finished && tab?.status === 'complete' && urlMatches) {
        setTimeout(() => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(updateListener);
            resolve(true);
          }
        }, 500);
      }
    });
  });

  // 2. Active content script ping verification (up to 6 attempts)
  for (let p = 0; p < 6; p++) {
    const skipCheck = await chrome.storage.local.get(['atomx_skip_current', 'atomx_agent_workflow', 'atomx_tg_raid']).catch(() => ({}));
    if (skipCheck?.atomx_skip_current) return true;
    const tg = skipCheck?.atomx_tg_raid;
    const wf = skipCheck?.atomx_agent_workflow;
    if (tg?.active && (tg.isStopped || tg.stateBadge === 'STOPPED')) return true;
    if (wf?.active && (wf.isStopped || wf.stateBadge === 'STOPPED')) return true;

    const isReady = await new Promise((res) => {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, (resp) => {
        if (chrome.runtime?.lastError || !resp?.ok) res(false);
        else res(true);
      });
    });
    if (isReady) {
      await delay(400);
      return true;
    }
    await delay(500);
  }

  return true;
}

async function sendMessageToTab(tabId, message, timeout = 30000) {
  const trySend = () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, error: 'timeout' }), timeout);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime?.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response ?? { success: true });
        }
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    }
  });

  let res = await trySend();

  // If content script is disconnected, try re-injection first (no page reload)
  if (res?.error && (res.error.includes('Receiving end does not exist') || res.error.includes('Could not establish connection') || res.error.includes('no tab'))) {
    console.log(`[ATOMX BG] Content script disconnected in tab ${tabId}. Attempting auto-injection...`);
    try {
      if (chrome.scripting) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => null);
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => null);
        await delay(1000);
        res = await trySend();
      }
    } catch (injectErr) {
      console.warn('[ATOMX BG] Auto-injection failed:', injectErr);
    }

    // If still disconnected, do NOT navigate or reload tab — preserve page content and return error
  }

  // Normalize null/undefined response to an error object so callers never get null
  return res ?? { success: false, error: 'timeout' };
}

