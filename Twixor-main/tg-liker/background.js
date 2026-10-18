// TG LIKER background
// 1) Extension icon e click -> side panel khule
// 2) Content script ke tar tab id dey
// 3) "Trusted click": synthetic click X e kaj na korle, Chrome debugger (CDP) diye ASOL mouse click pathay.
//    Shudhu tokhon-i attach hoy jokhon dorkar, job shesh hole detach hoy. Kono network call nai.

// Icon click e nijei panel kholi (onClicked) — tahole Chrome oi tab er jonno "activeTab" dey,
// ar tab capture (picker chhara current tab record) kaj kore.
function setupPanel() {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (e) {}
}
setupPanel();
chrome.runtime.onInstalled.addListener(setupPanel);
chrome.runtime.onStartup.addListener(setupPanel);
chrome.action.onClicked.addListener((tab) => {
  try { chrome.sidePanel.open({ tabId: tab.id }); } catch (e) {}
});

const attached = new Set();
const recTabs = new Set();    // screencast recording cholche emon tab
const keepTabs = new Set();   // job cholche emon tab — debugger attach rakho + focus emulate koro
chrome.debugger.onDetach.addListener((src) => { if (src && src.tabId != null) attached.delete(src.tabId); });
chrome.tabs.onRemoved.addListener((id) => { attached.delete(id); keepTabs.delete(id); recTabs.delete(id); });

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // service worker ghumiye uthle set khali hoy kintu debugger attach thake
    if (!/already attached/i.test(String(e && e.message))) throw e;
  }
  attached.add(tabId);
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  try { await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
}

const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function trusted(tabId, action, x, y) {
  await ensureAttached(tabId);
  const base = { x, y, pointerType: 'mouse' };
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', buttons: 0 });
  if (action === 'move') return;
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
  await wait(55 + Math.random() * 55);
  await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 });
}

async function detach(tabId) {
  if (keepTabs.has(tabId) || recTabs.has(tabId)) return;   // job cholche — focus emulation chalu rakho
  if (!attached.has(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} return; }
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg) return;

  if (msg.type === 'tabstream' && !sender.tab) {
    (async () => {
      try {
        const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: Number(msg.tabId) });
        sendResponse({ ok: true, id });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  if (msg.type === 'keepalive' && sender.tab) {
    const tabId = sender.tab.id;
    (async () => {
      try {
        if (msg.on) { keepTabs.add(tabId); await ensureAttached(tabId); }
        else { keepTabs.delete(tabId); await detach(tabId); }
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  if (msg.type === 'whoami') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return;
  }

  if (msg.type === 'trusted' && sender.tab) {
    const tabId = sender.tab.id;
    (async () => {
      try {
        if (msg.action === 'detach') { await detach(tabId); sendResponse({ ok: true }); return; }
        if (msg.action === 'wheel') {
          await ensureAttached(tabId);
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(msg.x) || 400, y: Number(msg.y) || 400, deltaX: 0, deltaY: Number(msg.dy) || 0, pointerType: 'mouse' });
          sendResponse({ ok: true }); return;
        }
        const x = Number(msg.x), y = Number(msg.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { sendResponse({ ok: false, error: 'bad coords' }); return; }
        await trusted(tabId, msg.action === 'move' ? 'move' : 'click', x, y);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;   // async response
  }
});


// ---------------------------------------------------------------------------------
// SCREENCAST (picker chhara current tab record): CDP Page.startScreencast -> frame gulo panel e jay
// ---------------------------------------------------------------------------------
const castPorts = new Map();   // tabId -> port
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender && port.sender.id !== chrome.runtime.id) return;
  if (port.name !== 'screencast') return;
  let tabId = null;
  port.onMessage.addListener(async (m) => {
    try {
      if (m.cmd === 'start') {
        tabId = Number(m.tabId);
        recTabs.add(tabId);
        await ensureAttached(tabId);
        castPorts.set(tabId, port);
        await cdp(tabId, 'Page.startScreencast', { format: 'jpeg', quality: m.quality || 88, maxWidth: m.maxWidth || 1920, maxHeight: m.maxHeight || 1200, everyNthFrame: 1 });
        port.postMessage({ type: 'started' });
      }
      if (m.cmd === 'stop') await stopCast(tabId);
    } catch (e) {
      recTabs.delete(tabId); castPorts.delete(tabId);
      try { port.postMessage({ type: 'error', error: String((e && e.message) || e) }); } catch (x) {}
    }
  });
  port.onDisconnect.addListener(() => { if (tabId != null) stopCast(tabId); });
});

async function stopCast(tabId) {
  if (tabId == null) return;
  castPorts.delete(tabId);
  try { await cdp(tabId, 'Page.stopScreencast'); } catch (e) {}
  recTabs.delete(tabId);
  if (!keepTabs.has(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} attached.delete(tabId); }
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method !== 'Page.screencastFrame' || !src || src.tabId == null) return;
  const port = castPorts.get(src.tabId);
  cdp(src.tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  if (!port) return;
  const md = params.metadata || {};
  try { port.postMessage({ type: 'frame', data: params.data, w: md.deviceWidth, h: md.deviceHeight, ts: md.timestamp }); } catch (e) {}
});
