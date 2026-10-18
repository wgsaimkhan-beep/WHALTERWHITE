/**
 * ATOMX ENGAGE — CHROME EXTENSION POPUP CONTROLLER
 * Full 10 Autonomous Agents Suite + Multi-Provider AI + Anti-Ban Pacing
 */

// >>> Your Render URL (Render Dashboard -> your service -> top of page). Can also be changed in the extension Options page.
const DEFAULT_BACKEND_URL = 'https://twixor.onrender.com';

async function getBackendUrl() {
  let url = '';
  try {
    if (typeof chrome !== 'undefined') {
      const [localRes, syncRes] = await Promise.all([
        chrome.storage?.local ? chrome.storage.local.get(['backendUrl']).catch(() => ({})) : {},
        chrome.storage?.sync ? chrome.storage.sync.get(['backendUrl']).catch(() => ({})) : {}
      ]);
      const stored = localRes?.backendUrl || syncRes?.backendUrl;
      // ignore legacy localhost / dead vercel values so old installs migrate to the Render URL automatically
      if (stored && typeof stored === 'string' && stored.startsWith('http') && !/localhost|127\.0\.0\.1|vercel\.app/i.test(stored)) {
        url = stored;
      }
    }
  } catch(e) {}
  return (url || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
}

/**
 * Robust network fetch with timeout, dual endpoint fallback (local <-> cloud),
 * and automatic background service worker relay.
 */
async function fetchApiWithFallback(endpoint, options = {}, timeoutMs = 70000) {
  const backendUrl = await getBackendUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const fullUrl = `${backendUrl}${cleanEndpoint}`;

  // Render's free plan sleeps when idle: the first request can take ~50 s. Give it time and retry once.
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(fullUrl, { ...options, signal: controller.signal });
      clearTimeout(tid);
      // 502/503/504 = Render still waking up -> retry once
      if ([502, 503, 504].includes(res.status) && attempt === 1) {
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }
      return res;
    } catch (directErr) {
      lastErr = directErr;
      console.warn(`[Twixor POPUP] fetch ${fullUrl} failed (attempt ${attempt}): ${directErr?.message}`);
      if (attempt === 1) await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Fallback: relay through the background service worker
  try {
    const bgRes = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Background relay timed out')), timeoutMs + 5000);
      chrome.runtime.sendMessage({
        type: 'API_FETCH_RELAY',
        endpoint: cleanEndpoint,
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        backendUrl,
        timeout: timeoutMs
      }, response => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(response);
      });
    });
    if (bgRes && typeof bgRes === 'object' && (bgRes.status || bgRes.ok)) {
      return {
        ok: Boolean(bgRes.ok),
        status: bgRes.status || (bgRes.ok ? 200 : 500),
        json: async () => bgRes.data || {},
        text: async () => typeof bgRes.data === 'string' ? bgRes.data : JSON.stringify(bgRes.data || {})
      };
    }
  } catch (relayErr) {
    console.error('[Twixor POPUP] Background relay failed:', relayErr);
  }
  throw new Error(`Cannot reach the Twixor server (${backendUrl}). If it was idle it may still be waking up - wait ~1 minute and try again. (${lastErr?.name === 'AbortError' ? 'timed out' : (lastErr?.message || 'network error')})`);
}

function safeRemoveTab(tabId) {
  // Safety rule: never close active browser tabs or windows automatically
  return;
}

// Reuses a SINGLE browser tab/window for all links/actions instead of opening/closing repeatedly
async function getOrCreateReusedTab(existingTabId, targetUrl) {
  // 1. If an existing working tab is known, verify it is still open and update it in-place
  if (existingTabId && typeof existingTabId === 'number' && existingTabId > 0) {
    try {
      const existingTab = await chrome.tabs.get(existingTabId);
      if (existingTab && existingTab.id) {
        await chrome.tabs.update(existingTab.id, { url: targetUrl, active: true });
        return existingTab.id;
      }
    } catch (e) {
      // Tab was closed by user
    }
  }

  // 2. Check for active tab in current window
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    if (activeTab && activeTab.id) {
      await chrome.tabs.update(activeTab.id, { url: targetUrl, active: true });
      return activeTab.id;
    }
  } catch (e) {}

  // 3. Check for active tab in last focused window
  try {
    const [lastTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (lastTab && lastTab.id) {
      await chrome.tabs.update(lastTab.id, { url: targetUrl, active: true });
      return lastTab.id;
    }
  } catch (e) {}

  // 4. Check for ANY open Twitter / X tab in any window so we reuse it instead of opening new tabs
  try {
    const openTwitterTabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
    if (openTwitterTabs && openTwitterTabs.length > 0 && openTwitterTabs[0]?.id) {
      const tabToUse = openTwitterTabs[0];
      await chrome.tabs.update(tabToUse.id, { url: targetUrl, active: true });
      return tabToUse.id;
    }
  } catch (e) {}

  // 5. Check for ANY open tab anywhere in browser to reuse in-place
  try {
    const allTabs = await chrome.tabs.query({});
    if (allTabs && allTabs.length > 0 && allTabs[0]?.id) {
      const tabToUse = allTabs[0];
      await chrome.tabs.update(tabToUse.id, { url: targetUrl, active: true });
      return tabToUse.id;
    }
  } catch (e) {}

  // 6. Absolute fallback: only if browser has 0 tabs open
  const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
  return newTab.id;
}
// Notify background service worker and content scripts of popup lifecycle via persistent port
let popupLifecyclePort = null;
if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
  try {
    popupLifecyclePort = chrome.runtime.connect({ name: 'atomx_popup_lifecycle' });
  } catch (e) {
    // ignore
  }
}

// Global safe JSON parser for all backend API responses
async function safeParseApiResponse(res) {
  if (!res) return {};
  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    if (!res.ok) {
      throw new Error(`Server temporarily unavailable (${res.status}). Please try again in a moment.`);
    }
    throw new Error('Invalid response received from server.');
  }
  return data || {};
}
if (typeof window !== 'undefined') window.safeParseApiResponse = safeParseApiResponse;
if (typeof globalThis !== 'undefined') globalThis.safeParseApiResponse = safeParseApiResponse;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let state = {
  agentStatusMap: null,
  currentDetailAgentId: null,
  credits: 0,
  isAborted: false,
  isPaused: false,
  skipCurrent: false,
  selectedTone: 'Bullish (5-10 words)',
  selectedTonePrompt: 'Write a bullish, positive comment replying to the post.\nCRITICAL LENGTH CONSTRAINT: Strictly between 5 and 10 words. Do not exceed 10 words.\nLANGUAGE: Match the post\'s language exactly.\nSTYLE: Sound like an authentic human community member. No AI clichés, no generic hype.\nFORMAT: Output ONLY the single comment text. No emojis, no quotes, no dashes, no preamble, no exclamation marks (!).',
  selectedToneId: 'bullish-short',
  defaultTones: [
    {
      id: 'ct-human',
      name: 'CT Human Reply',
      prompt: 'Write a highly authentic, natural human reply to the post as a Crypto Twitter (CT) community member.\nCRITICAL CONTEXT ADAPTATION: If the post is personal (birthday, milestone, achievement, or struggle), congratulate or empathize genuinely based on what they actually wrote. If technical/crypto, provide relatable builder thoughts.\nCRITICAL LENGTH CONSTRAINT: Strictly between 5 and 12 words.\nLANGUAGE: Match the post\'s language exactly.\nSTYLE: Sound like an authentic human friend/peer. Zero robotic AI clichés, no generic hype, no irrelevant market talk on personal posts.\nFORMAT: Output ONLY the single comment text. No emojis, no quotes, no preamble.'
    },
    {
      id: 'bullish-short',
      name: 'Bullish (5-10 words)',
      prompt: 'Write a bullish, positive comment replying to the post.\nCRITICAL LENGTH CONSTRAINT: Strictly between 5 and 10 words. Do not exceed 10 words.\nLANGUAGE: Match the post\'s language exactly.\nSTYLE: Sound like an authentic human community member. No AI clichés, no generic hype.\nFORMAT: Output ONLY the single comment text. No emojis, no quotes, no dashes, no preamble, no exclamation marks (!).'
    },
    { id: 'natural', name: 'Natural & Concise', prompt: 'Write a casual, highly human, 1-2 sentence response. Direct and concise.' },
    { id: 'professional', name: 'Professional', prompt: 'Sound authoritative, sharp, and executive-level in 1-2 sentences.' },
    { id: 'question', name: 'Engaging Question', prompt: 'Offer an astute observation and conclude with an insightful question.' },
    { id: 'witty', name: 'Witty', prompt: 'Deliver a clever, witty, and humorous observation.' }
  ],
  customTones: [],
  maxCustomTemplates: 2,
  selectedProvider: 'groq',
  selectedModel: 'llama-3.3-70b-versatile',
  selectedLength: 'medium',
  activeTabId: null,
  detectedTweet: null,
  accessKey: '',
  delaySeconds: 8,
  breakActions: 20,
  backgroundMode: true,
  creators: [],
  engagedTweetIds: [],
  modelsCache: {
    openai: [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast)' },
      { id: 'gpt-4o', name: 'GPT-4o (Omni Flagship)' },
      { id: 'o1-mini', name: 'o1 Mini (Reasoning)' }
    ],
    gemini: [
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }
    ],
    groq: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq LPU)' },
      { id: 'allam-2-7b', name: 'ALLaM 2 7B (SDAIA / Groq)' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct (Groq)' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
      { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B' }
    ],
    openrouter: [
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta Llama 3.3 70B Instruct' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o (OpenRouter)' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' }
    ]
  }
};

// Global working tabs tracking for bulletproof stop / cancel execution across all workflows
let audienceWorkingTabId = null;
let sorsaWorkingTabId = null;
let followerWorkingTabId = null;
let replyBackWorkingTabId = null;
let autoUnfollowWorkingTabId = null;
let reciprocatorWorkingTabId = null;
let tgWorkingTabId = null; // TG Pulse working tab

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

// ─────────────────────────────────────────────────────────────────────
// ROBUST TAB HELPERS (DESKTOP & MOBILE BROWSER COMPATIBLE)
// Works seamlessly on Chrome Desktop, Kiwi, Lemur, Mises, and Yandex.
// ─────────────────────────────────────────────────────────────────────

/** Safely query the active or open Twitter / X tab across desktop and mobile */
async function getActiveTwitterTab() {
  if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.query !== 'function') return null;
  try {
    // 1. Check active tab in current window
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (currentTabs && currentTabs[0] && (currentTabs[0].url?.includes('x.com') || currentTabs[0].url?.includes('twitter.com'))) {
      return currentTabs[0];
    }
    // 2. Mobile browsers (Kiwi, Lemur) where windowId/currentWindow may be omitted
    const activeTabs = await chrome.tabs.query({ active: true }).catch(() => []);
    if (activeTabs && activeTabs[0] && (activeTabs[0].url?.includes('x.com') || activeTabs[0].url?.includes('twitter.com'))) {
      return activeTabs[0];
    }
    // 3. Fallback: Any open X / Twitter tab
    const xTabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }).catch(() => []);
    if (xTabs && xTabs.length > 0) return xTabs[0];

    // 4. Fallback: All open tabs check
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    const matching = (allTabs || []).find(t => t.url && (t.url.includes('x.com') || t.url.includes('twitter.com')));
    if (matching) return matching;
  } catch (e) {}
  return null;
}

/** Safely query all open X/Twitter tabs */
async function safeQueryXTabs() {
  if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.query !== 'function') return [];
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }).catch(() => []);
    if (tabs && tabs.length > 0) return tabs;
    const all = await chrome.tabs.query({}).catch(() => []);
    return (all || []).filter(t => t.url && (t.url.includes('x.com') || t.url.includes('twitter.com')));
  } catch (e) {
    return [];
  }
}

/** Safely send a message to a tab */
function safeSendTabMessage(tabId, message) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return;
  try {
    chrome.tabs.sendMessage(tabId, message).catch(() => null);
  } catch (e) {}
}

/** Broadcast a message to all open X/Twitter tabs */
async function broadcastToXTabs(message) {
  try {
    const tabs = await safeQueryXTabs();
    tabs.forEach(t => { if (t.id) safeSendTabMessage(t.id, message); });
  } catch (e) {}
}


async function syncFloatingHud(tabId, data = {}) {
  const isStopping = data.isStopped === true || data.stateBadge === 'STOPPED' || data.stateBadge === 'DONE';
  const cleanData = {
    ...data,
    isStopped: isStopping,
    active: !isStopping
  };
  if (!isStopping) {
    cleanData.isNewWorkflow = data.isNewWorkflow !== undefined ? data.isNewWorkflow : true;
    if (!cleanData.stateBadge || cleanData.stateBadge === 'STOPPED' || cleanData.stateBadge === 'DONE') {
      cleanData.stateBadge = 'ACTIVE';
    }
  }

  // 1. Save state to chrome.storage.local so all tabs hydrate it immediately
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      if (!isStopping) {
        await chrome.storage.local.remove('atomx_hud_dismissed').catch(() => null);
      }
      const stored = await chrome.storage.local.get(['atomx_active_hud']).catch(() => ({}));
      const current = stored?.atomx_active_hud || {};
      const merged = { ...current, ...cleanData };
      if (!isStopping) {
        merged.isStopped = false;
        merged.active = true;
      }
      await chrome.storage.local.set({ atomx_active_hud: merged }).catch(() => null);
    }
  } catch (e) {}

  // 2. Broadcast UPDATE_FLOATING_HUD to active tab and all Twitter/X tabs
  if (typeof chrome !== 'undefined' && chrome.tabs) {
    try {
      const payload = { ...cleanData };
      const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }).catch(() => []);
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, {
          type: 'UPDATE_FLOATING_HUD',
          data: payload
        }).catch(() => null);
      }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (activeTab && activeTab.id) {
        chrome.tabs.sendMessage(activeTab.id, {
          type: 'UPDATE_FLOATING_HUD',
          data: payload
        }).catch(() => null);
      }
      if (tabId && (!activeTab || activeTab.id !== tabId)) {
        chrome.tabs.sendMessage(tabId, {
          type: 'UPDATE_FLOATING_HUD',
          data: payload
        }).catch(() => null);
      }
    } catch (e) {}
  }
}

// Global runtime listener for instant Twitter Rate Limit auto-abort & worker notifications
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RATE_LIMIT_DETECTED') {
      console.warn('[ATOMX ALERT] Twitter Rate Limit Detected! Stopping all workflows immediately.');
      state.isAborted = true;

      const activeTabs = [
        audienceWorkingTabId,
        sorsaWorkingTabId,
        followerWorkingTabId,
        replyBackWorkingTabId,
        autoUnfollowWorkingTabId,
        reciprocatorWorkingTabId
      ].filter(Boolean);

      activeTabs.forEach(tId => {
        chrome.tabs?.sendMessage(tId, { type: 'ABORT_WORKFLOW' }).catch(() => null);
      });

      activeTabs.forEach(tId => {
        syncFloatingHud(tId, {
          stateBadge: 'RATE_LIMITED',
          statusText: '🚨 Rate limited! Stopped immediately to protect account.',
          isStopped: true
        });
      });

      const badges = document.querySelectorAll(
        '#audienceStateBadge, #sorsaStateBadge, #followerStateBadge, #replyBackStateBadge, #reciprocatorStateBadge'
      );
      badges.forEach(b => {
        b.textContent = 'RATE_LIMITED';
        b.style.background = 'rgba(239, 68, 68, 0.25)';
        b.style.color = '#EF4444';
      });

      const statusEls = document.querySelectorAll(
        '#audienceLiveStatusText, #sorsaLiveStatusText, #followerLiveStatusText, #replyBackLiveStatusText, #reciprocatorLiveStatusText'
      );
      statusEls.forEach(el => {
        el.textContent = '🚨 Twitter Rate Limit: "Sorry, you are rate limited". All workflows halted immediately!';
      });

      const startBtns = document.querySelectorAll(
        '#runAudienceBuilderBtn, #runSorsaBoosterBtn, #runFollowerIncreaseBtn, #startReplyBackBtn, #runReciprocatorBtn'
      );
      startBtns.forEach(b => { b.style.display = 'block'; });

      const stopBtns = document.querySelectorAll(
        '#stopAudienceBuilderBtn, #stopSorsaBoosterBtn, #stopFollowerIncreaseBtn, #stopReplyBackBtn, #stopReciprocatorBtn'
      );
      stopBtns.forEach(b => { b.style.display = 'none'; });

      showExtToast?.('Twitter Rate Limit: Aborted all workflows', '🚨');
      alert('🚨 Twitter Rate Limit Detected!\n\nTwitter/X reported: "Sorry, you are rate limited".\n\nAtomX has immediately aborted all running workflows to protect your account from restrictions.');
      sendResponse({ success: true, acknowledged: true });
      return true;
    }

    if (message.type === 'TOGGLE_WORKFLOW_PAUSE') {
      state.isPaused = typeof message.isPaused === 'boolean' ? message.isPaused : !state.isPaused;
      updateAllPauseButtonsUI(state.isPaused);
      sendResponse({ success: true, isPaused: state.isPaused });
      return true;
    }

    if (message.type === 'SKIP_WORKFLOW_ITEM') {
      state.skipCurrent = true;
      showExtToast?.('Skipping current item...', '⏭️');
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'ABORT_WORKFLOW' || message.type === 'BG_ABORT_TG_RAID' || message.type === 'BG_ABORT_AGENT_WORKFLOW') {
      state.isAborted = true;
      state.isWorkflowRunning = false;
      state.isPaused = false;
      updateAllPauseButtonsUI(false);
      setAutomationRunningUI(false);
      if (typeof updateAllStopButtonsUI === 'function') {
        updateAllStopButtonsUI();
      }
      console.log('[ATOMX] Workflow aborted via message signal.');
      sendResponse({ success: true });
      return true;
    }
  });
}

// =============================================================
// ROBUST X / TWITTER LINK EXTRACTOR & DEDUPLICATION ENGINE
// Handles: standard URLs, intent/like, Telegram chats, timestamps, labels
// =============================================================
const EXT_STATUS_REGEX = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|vxtwitter\.com|fixupx\.com|fxtwitter\.com)\/(?:#!\/)?([a-zA-Z0-9_]{1,30})(?:\/web)?\/status(?:es)?\/(\d{5,25})/gi;
const EXT_INTENT_REGEX = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\/intent\/(?:like|retweet|tweet)[^?\s]*\?(?:[^&\s]*&)*(?:tweet_id|in_reply_to)=(\d{5,25})/gi;

function extractTweetLinks(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const results = [];

  // Match status links
  EXT_STATUS_REGEX.lastIndex = 0;
  let match;
  while ((match = EXT_STATUS_REGEX.exec(rawText)) !== null) {
    let handle = (match[1] || 'user').replace(/^@+/, '');
    if (handle === 'i' || handle === 'intent') handle = 'user';
    const tweetId = match[2];
    results.push({
      tweetId,
      handle,
      canonicalUrl: `https://x.com/${handle}/status/${tweetId}`,
      rawMatch: match[0]
    });
  }

  // Match intent links (e.g. intent/like?tweet_id=...)
  EXT_INTENT_REGEX.lastIndex = 0;
  while ((match = EXT_INTENT_REGEX.exec(rawText)) !== null) {
    const tweetId = match[1];
    results.push({
      tweetId,
      handle: 'user',
      canonicalUrl: `https://x.com/i/status/${tweetId}`,
      rawMatch: match[0]
    });
  }

  return results;
}

function filterTweetLinks(extractedLinks, options = {}) {
  const engagedSet = new Set((options.engagedTweetIds || state.engagedTweetIds || []).map(String));
  const seenInBatch = new Set();
  const freshTweets = [];
  const duplicateLinks = [];
  const alreadyEngagedLinks = [];

  for (const item of extractedLinks) {
    const id = String(item.tweetId);
    if (seenInBatch.has(id)) {
      duplicateLinks.push(item);
      continue;
    }
    seenInBatch.add(id);

    if (engagedSet.has(id)) {
      alreadyEngagedLinks.push(item);
      continue;
    }

    freshTweets.push(item);
  }

  return {
    totalFound: extractedLinks.length,
    uniqueInBatch: seenInBatch.size,
    duplicateCount: duplicateLinks.length,
    alreadyEngagedCount: alreadyEngagedLinks.length,
    freshCount: freshTweets.length,
    freshTweets,
    duplicateLinks,
    alreadyEngagedLinks
  };
}

// ==============================================================
// LUXURY IN-EXTENSION NOTIFICATION & TOAST ENGINE
// Replaces default browser alert() with sleek native in-extension UI
// ==============================================================
function showExtNotification(message, options = {}) {
  const overlay = document.getElementById('extNotificationOverlay');
  const titleEl = document.getElementById('extNotifyTitle');
  const iconEl = document.getElementById('extNotifyIcon');
  const bodyEl = document.getElementById('extNotifyBody');
  const okBtn = document.getElementById('extNotifyOkBtn');
  if (!overlay || !bodyEl) {
    console.log('[ATOMX Notification]', message);
    return;
  }

  const str = String(message || '');
  let title = options.title || 'Twixor Notification';
  let icon = options.icon || '✨';
  let iconClass = '';

  if (str.includes('⚠️') || str.toLowerCase().includes('limit') || str.toLowerCase().includes('insufficient') || str.toLowerCase().includes('error')) {
    title = options.title || 'Attention Needed';
    icon = '⚠️';
    iconClass = 'warning';
  } else if (str.includes('✓') || str.toLowerCase().includes('finish') || str.toLowerCase().includes('complete') || str.toLowerCase().includes('success')) {
    title = options.title || 'Engagement Completed';
    icon = '🚀';
    iconClass = 'success';
  }

  if (titleEl) titleEl.textContent = title;
  if (iconEl) {
    iconEl.textContent = icon;
    iconEl.className = `ext-notify-icon-box ${iconClass}`;
  }

  // Parse lines: extract stats / bullet points into sleek styled stat boxes
  const lines = str.split('\n');
  let formattedHtml = '';
  const bulletItems = [];
  const textParas = [];

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('•') || trimmed.startsWith('-')) {
      const clean = trimmed.replace(/^[•\-]\s*/, '');
      const colonIdx = clean.indexOf(':');
      if (colonIdx !== -1) {
        bulletItems.push({
          label: clean.substring(0, colonIdx).trim(),
          val: clean.substring(colonIdx + 1).trim()
        });
      } else {
        bulletItems.push({ label: clean, val: '' });
      }
    } else {
      textParas.push(trimmed.replace(/^[✓⚠️ℹ️🚀]\s*/, ''));
    }
  });

  if (textParas.length > 0) {
    formattedHtml += `<div style="font-weight:700; color:var(--text-primary); font-size:13px; margin-bottom:8px;">${textParas[0]}</div>`;
  }

  if (bulletItems.length > 0) {
    formattedHtml += `<div class="stat-badge-row">`;
    bulletItems.forEach(b => {
      let valColor = 'var(--text-primary)';
      const l = b.label.toLowerCase();
      if (l.includes('engaged') || l.includes('fresh')) valColor = '#10B981';
      else if (l.includes('skip') || l.includes('ignored')) valColor = '#9CA3AF';
      else if (l.includes('total') || l.includes('found')) valColor = '#3B82F6';

      formattedHtml += `
        <div class="stat-badge-item">
          <span style="color:var(--text-secondary);">${b.label}:</span>
          <strong style="color:${valColor};">${b.val}</strong>
        </div>`;
    });
    formattedHtml += `</div>`;
  }

  if (textParas.length > 1) {
    formattedHtml += `<div style="color:var(--text-muted); font-size:11px; margin-top:6px; line-height:1.4;">${textParas.slice(1).join('<br>')}</div>`;
  }

  if (!formattedHtml) {
    formattedHtml = `<div>${str}</div>`;
  }

  const cancelBtn = document.getElementById('extNotifyCancelBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (okBtn) {
    okBtn.textContent = 'Got It';
    okBtn.style.background = '';
    okBtn.style.borderColor = '';
  }

  bodyEl.innerHTML = formattedHtml;
  overlay.style.display = 'flex';

  const closeNotification = () => {
    overlay.style.display = 'none';
  };

  const closeBtn = document.getElementById('extNotifyCloseBtn');
  if (closeBtn) closeBtn.onclick = closeNotification;
  if (okBtn) okBtn.onclick = closeNotification;
  overlay.onclick = (e) => {
    if (e.target === overlay) closeNotification();
  };
}

function showExtConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('extNotificationOverlay');
    const titleEl = document.getElementById('extNotifyTitle');
    const iconEl = document.getElementById('extNotifyIcon');
    const bodyEl = document.getElementById('extNotifyBody');
    const okBtn = document.getElementById('extNotifyOkBtn');
    const cancelBtn = document.getElementById('extNotifyCancelBtn');
    const closeBtn = document.getElementById('extNotifyCloseBtn');

    if (!overlay || !bodyEl || !okBtn) {
      resolve(true);
      return;
    }

    const title = options.title || 'Confirmation';
    const icon = options.icon || '⚠️';
    const confirmText = options.confirmText || 'Confirm';
    const cancelText = options.cancelText || 'Cancel';

    if (titleEl) titleEl.textContent = title;
    if (iconEl) {
      iconEl.textContent = icon;
      iconEl.className = options.danger ? 'ext-notify-icon-box warning' : 'ext-notify-icon-box';
    }

    bodyEl.innerHTML = `<div style="font-weight:600; color:var(--text-primary); font-size:13px; line-height:1.5;">${String(message || '')}</div>`;

    okBtn.textContent = confirmText;
    if (options.danger) {
      okBtn.style.background = '#DC2626';
      okBtn.style.borderColor = '#DC2626';
    } else {
      okBtn.style.background = '';
      okBtn.style.borderColor = '';
    }

    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.textContent = cancelText;
    }

    overlay.style.display = 'flex';

    const cleanup = (result) => {
      overlay.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
      okBtn.textContent = 'Got It';
      okBtn.style.background = '';
      okBtn.style.borderColor = '';
      okBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (closeBtn) closeBtn.onclick = null;
      overlay.onclick = null;
      resolve(result);
    };

    okBtn.onclick = () => cleanup(true);
    if (cancelBtn) cancelBtn.onclick = () => cleanup(false);
    if (closeBtn) closeBtn.onclick = () => cleanup(false);
    overlay.onclick = (e) => {
      if (e.target === overlay) cleanup(false);
    };
  });
}

let toastTimer = null;
function showExtToast(text, icon = '✓') {
  const toast = document.getElementById('extToastBanner');
  const iconEl = document.getElementById('extToastIcon');
  const textEl = document.getElementById('extToastText');
  if (!toast) return;

  if (iconEl) iconEl.textContent = icon;
  if (textEl) textEl.textContent = text;

  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2600);
}

// Redirect global window.alert to sleek native in-extension notification
if (typeof window !== 'undefined') {
  window.alert = function (msg) {
    showExtNotification(msg);
  };
}

function updateAllPauseButtonsUI(isPaused) {
  const pauseButtonIds = [
    'pauseTgEngageBtn',
    'pauseAudienceBuilderBtn',
    'pauseSorsaBoosterBtn',
    'pauseFollowerIncreaseBtn',
    'pauseReplyBackBtn',
    'pauseAutoUnfollowBtn',
    'pauseReciprocatorBtn'
  ];
  const PAUSE_BTN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>`;
  const RESUME_BTN_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg>`;
  pauseButtonIds.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.innerHTML = isPaused ? `${RESUME_BTN_SVG}Resume` : `${PAUSE_BTN_SVG}Pause`;
      btn.style.background = isPaused ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.4) 100%)' : '';
      btn.style.borderColor = isPaused ? 'rgba(52, 211, 153, 0.6)' : '';
      btn.style.color = isPaused ? '#34D399' : '';
    }
  });

  const stateBadges = document.querySelectorAll(
    '#tgStateBadge, #audienceStateBadge, #sorsaStateBadge, #followerStateBadge, #replyBackStateBadge, #unfollowStateBadge, #reciprocatorStateBadge'
  );
  stateBadges.forEach(badge => {
    if (isPaused && badge.textContent !== 'IDLE' && badge.textContent !== 'STOPPED' && badge.textContent !== 'DONE') {
      badge.dataset.prevText = badge.textContent;
      badge.textContent = 'PAUSED';
    } else if (!isPaused && badge.textContent === 'PAUSED') {
      badge.textContent = badge.dataset.prevText || 'ENGAGING';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM & AGENT BACKGROUND WORKFLOW SYNCHRONIZATION
// Keeps popup trackers 100% in sync with background execution & survives closes
// ─────────────────────────────────────────────────────────────────────────────

function updateTelegramProgressUI(raidState) {
  if (!raidState) return;
  const progressCard = document.getElementById('tgProgressCard');
  const tgStateBadge = document.getElementById('tgStateBadge');
  const tgQueueInd   = document.getElementById('tgQueueIndicator');
  const tgDoneEl     = document.getElementById('tgDoneCount');
  const tgColEl      = document.getElementById('tgCollectedCount');
  const tgSkipEl     = document.getElementById('tgSkippedCount');
  const tgBar        = document.getElementById('tgProgressBar');
  const tgStatus     = document.getElementById('tgLiveStatusText');
  const tgCountdown  = document.getElementById('tgCountdownText');
  const runBtn       = document.getElementById('runTgEngageBtn');
  const pauseBtn     = document.getElementById('pauseTgEngageBtn');
  const skipBtn      = document.getElementById('skipTgEngageBtn');
  const stopBtn      = document.getElementById('stopTgEngageBtn');

  if (progressCard) progressCard.style.display = 'block';

  const total = raidState.total || raidState.tweets?.length || 0;
  const current = raidState.currentIndex || 0;
  const done = raidState.successCount || 0;
  const skipped = raidState.ignoredCount || 0;

  if (tgQueueInd) tgQueueInd.textContent = `Tweet ${Math.min(current + 1, total)}/${total}`;
  if (tgDoneEl) tgDoneEl.textContent = String(done);
  if (tgColEl) tgColEl.textContent = String(total);
  if (tgSkipEl) tgSkipEl.textContent = String(skipped);

  // Render Skipped Posts telemetry list
  const skippedContainer = document.getElementById('tgSkippedPostsContainer');
  const skippedBadgeCount = document.getElementById('tgSkippedBadgeCount');
  const skippedListEl = document.getElementById('tgSkippedPostsList');
  const skippedItems = Array.isArray(raidState.skippedItems) ? raidState.skippedItems : [];

  if (skippedContainer && skippedBadgeCount && skippedListEl) {
    if (skippedItems.length > 0) {
      skippedContainer.style.display = 'block';
      skippedBadgeCount.textContent = String(skippedItems.length);
      skippedListEl.innerHTML = skippedItems.map((item, idx) => {
        let urlStr = '';
        let handleText = '';
        let tweetId = '';
        let reason = 'Comments restricted or post unavailable';

        if (typeof item === 'string') {
          if (item.startsWith('http://') || item.startsWith('https://')) {
            urlStr = item;
          } else {
            reason = item;
          }
        } else if (item && typeof item === 'object') {
          urlStr = item.url || item.canonicalUrl || (item.tweetId ? `https://x.com/i/status/${item.tweetId}` : '');
          handleText = item.handle ? (item.handle.startsWith('@') ? item.handle : `@${item.handle}`) : '';
          tweetId = item.tweetId || '';
          reason = item.reason || 'Comments restricted or post unavailable';
        }

        let displayLink = urlStr
          ? urlStr.replace(/^https?:\/\/(www\.)?/, '')
          : (tweetId ? `x.com/i/status/${tweetId}` : 'x.com/status');

        return `
          <div style="display:flex; flex-direction:column; gap:4px; padding:6px 8px; background:rgba(255,255,255,0.03); border:1px solid rgba(245,158,11,0.22); border-radius:6px; font-size:10.5px; box-sizing:border-box; width:100%;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; min-width:0;">
              <div style="display:flex; align-items:center; gap:6px; min-width:0; flex:1; overflow:hidden;">
                <span style="background:rgba(245,158,11,0.2); color:#FBBF24; font-size:9.5px; font-weight:800; padding:1px 5px; border-radius:3px; flex-shrink:0;">#${idx + 1}</span>
                ${handleText ? `<span style="color:var(--text-primary, #F3F4F6); font-weight:700; font-size:10px; flex-shrink:0;">${handleText}</span>` : ''}
                <a href="${urlStr || '#'}" target="_blank" rel="noopener noreferrer" style="color:#60A5FA; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:10px; flex:1; min-width:0;" title="${urlStr || 'Tweet Link'}">
                  ${displayLink}
                </a>
              </div>
              ${urlStr ? `
                <a href="${urlStr}" target="_blank" rel="noopener noreferrer" style="color:#60A5FA; display:flex; align-items:center; justify-content:center; text-decoration:none; opacity:0.85; flex-shrink:0; padding:2px 4px; border-radius:3px; background:rgba(96,165,250,0.12);" title="Open tweet in new tab">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                  </svg>
                </a>
              ` : ''}
            </div>
            <div style="display:flex; align-items:flex-start; gap:4px; font-size:9.5px; line-height:1.35; color:#FCD34D; background:rgba(245,158,11,0.08); border-left:2.5px solid #F59E0B; padding:3px 6px; border-radius:0 3px 3px 0; word-break:break-word;">
              <span style="font-weight:700; flex-shrink:0; color:#F59E0B;">Reason:</span>
              <span style="flex:1;">${reason}</span>
            </div>
          </div>
        `;
      }).join('');
    } else {
      skippedContainer.style.display = 'none';
      skippedListEl.innerHTML = '';
      skippedBadgeCount.textContent = '0';
    }
  }

  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  if (tgBar) tgBar.style.width = `${raidState.active ? Math.max(5, pct) : (done + skipped >= total ? 100 : pct)}%`;

  const cleanBtn = document.getElementById('cleanTgInputBtn');
  const resetBtn = document.getElementById('resetTelegramQueueBtn');

  if (raidState.active) {
    if (runBtn) runBtn.style.display = 'none';
    if (cleanBtn) cleanBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    if (pauseBtn) {
      pauseBtn.style.display = 'inline-flex';
      const pSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>`;
      const rSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg>`;
      pauseBtn.innerHTML = raidState.isPaused ? `${rSvg}Resume` : `${pSvg}Pause`;
      pauseBtn.style.background = raidState.isPaused ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.4) 100%)' : '';
      pauseBtn.style.borderColor = raidState.isPaused ? 'rgba(52, 211, 153, 0.6)' : '';
      pauseBtn.style.color = raidState.isPaused ? '#34D399' : '';
    }
    if (skipBtn) skipBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    if (tgStateBadge) tgStateBadge.textContent = raidState.isPaused ? 'PAUSED' : (raidState.stateBadge || 'ENGAGING');
    if (tgStatus && raidState.statusText) tgStatus.textContent = raidState.statusText;
    if (tgCountdown) {
      if (raidState.countdownText) {
        tgCountdown.style.display = 'block';
        tgCountdown.textContent = raidState.countdownText;
      } else {
        tgCountdown.style.display = 'none';
      }
    }
  } else if (raidState.stateBadge === 'DAILY_LIMIT' || raidState.stateBadge === 'DAILY LIMIT' || raidState.stateBadge === 'RATE_LIMITED') {
    if (runBtn) { runBtn.style.display = 'inline-flex'; runBtn.disabled = false; runBtn.textContent = '▶ Launch'; }
    if (cleanBtn) cleanBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (tgStateBadge) {
      tgStateBadge.textContent = raidState.stateBadge.replace('_', ' ');
      tgStateBadge.style.background = 'rgba(239, 68, 68, 0.25)';
      tgStateBadge.style.color = '#EF4444';
      tgStateBadge.style.border = '1px solid rgba(239, 68, 68, 0.6)';
    }
    if (tgStatus) tgStatus.textContent = raidState.statusText || '🛑 Stopped: Twitter Daily Post Limit reached.';
    if (tgCountdown) tgCountdown.style.display = 'none';
  } else if (raidState.isStopped) {
    if (runBtn) { runBtn.style.display = 'inline-flex'; runBtn.disabled = false; runBtn.textContent = '▶ Launch'; }
    if (cleanBtn) cleanBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (tgStateBadge) tgStateBadge.textContent = 'STOPPED';
    if (tgStatus) tgStatus.textContent = raidState.statusText || 'Workflow stopped by user.';
    if (tgCountdown) tgCountdown.style.display = 'none';
  } else if (done + skipped >= total && total > 0) {
    if (runBtn) { runBtn.style.display = 'inline-flex'; runBtn.disabled = false; runBtn.textContent = '▶ Launch'; }
    if (cleanBtn) cleanBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (tgStateBadge) tgStateBadge.textContent = 'DONE';
    if (tgStatus) tgStatus.textContent = `✓ Completed! ${done} engaged, ${skipped} skipped.`;
    if (tgCountdown) tgCountdown.style.display = 'none';
    if (tgBar) tgBar.style.width = '100%';
  }
}

function updateAgentWorkflowProgressUI(wf) {
  if (!wf) return;
  const cardMap = {
    audience: {
      card: 'audienceProgressCard', badge: 'audienceStateBadge', ind: 'audienceQueueIndicator',
      done: 'audienceDoneCount', col: 'audienceCollectedCount', skip: 'audienceSkippedCount',
      bar: 'audienceProgressBar', status: 'audienceLiveStatusText', cd: 'audienceCountdownText',
      startBtn: 'runAudienceBuilderBtn', stopBtn: 'stopAudienceBuilderBtn',
      pauseBtn: 'pauseAudienceBuilderBtn', skipBtn: 'skipAudienceBuilderBtn',
      resetBtn: 'resetAudienceQueueBtn'
    },
    sorsa: {
      card: 'sorsaProgressCard', badge: 'sorsaStateBadge', ind: 'sorsaQueueIndicator',
      done: 'sorsaDoneCount', col: 'sorsaCollectedCount', skip: 'sorsaSkippedCount',
      bar: 'sorsaProgressBar', status: 'sorsaLiveStatusText', cd: 'sorsaCountdownText',
      startBtn: 'runSorsaBoosterBtn', stopBtn: 'stopSorsaBoosterBtn',
      pauseBtn: 'pauseSorsaBoosterBtn', skipBtn: 'skipSorsaBoosterBtn',
      resetBtn: 'resetSorsaQueueBtn'
    },
    followers: {
      card: 'followerProgressCard', badge: 'followerStateBadge', ind: 'followerQueueIndicator',
      done: 'followerDoneCount', col: 'followerCollectedCount', skip: 'followerSkippedCount',
      bar: 'followerProgressBar', status: 'followerLiveStatusText', cd: 'followerCountdownText',
      startBtn: 'runFollowerIncreaseBtn', stopBtn: 'stopFollowerIncreaseBtn',
      pauseBtn: 'pauseFollowerIncreaseBtn', skipBtn: 'skipFollowerIncreaseBtn',
      resetBtn: 'resetFollowerQueueBtn'
    },
    replyback: {
      card: 'replyBackProgressCard', badge: 'replyBackStateBadge', ind: 'replyBackQueueIndicator',
      done: 'replyBackDoneCount', col: 'replyBackCollectedCount', skip: 'replyBackSkippedCount',
      bar: 'replyBackProgressBar', status: 'replyBackLiveStatusText', cd: 'replyBackCountdownText',
      startBtn: 'runReplyBackBtn', stopBtn: 'stopReplyBackBtn',
      pauseBtn: 'pauseReplyBackBtn', skipBtn: 'skipReplyBackBtn',
      resetBtn: 'resetReplyBackQueueBtn'
    },
    unfollow: {
      card: 'unfollowProgressCard', badge: 'unfollowStateBadge', ind: 'unfollowProgressText',
      done: 'unfollowCountDone', col: null, skip: 'unfollowCountSkipped',
      bar: 'unfollowProgressBar', status: 'unfollowLiveStatusText', cd: 'unfollowCountdownText',
      startBtn: 'runAutoUnfollowBtn', stopBtn: 'stopAutoUnfollowBtn',
      pauseBtn: 'pauseAutoUnfollowBtn', skipBtn: 'skipAutoUnfollowBtn',
      resetBtn: 'resetUnfollowQueueBtn'
    },
    reciprocator: {
      card: 'reciprocatorProgressCard', badge: 'reciprocatorStateBadge', ind: 'reciprocatorQueueIndicator',
      done: 'reciprocatorCountDone', col: 'reciprocatorCountQueue', skip: 'reciprocatorCountSkipped',
      bar: 'reciprocatorProgressBar', status: 'reciprocatorLiveStatusText', cd: 'reciprocatorCountdownText',
      startBtn: 'runReciprocatorBtn', stopBtn: 'stopReciprocatorBtn',
      pauseBtn: 'pauseReciprocatorBtn', skipBtn: 'skipReciprocatorBtn',
      resetBtn: 'resetReciprocatorQueueBtn'
    },
    feedengager: {
      card: 'feedEngagerProgressCard', badge: 'feedEngagerStateBadge', ind: 'feedEngagerQueueIndicator',
      done: 'feedEngagerCountDone', col: 'feedEngagerCountQueue', skip: 'feedEngagerCountSkipped',
      bar: 'feedEngagerProgressBar', status: 'feedEngagerLiveStatusText', cd: 'feedEngagerCountdownText',
      startBtn: 'runFeedEngagerBtn', stopBtn: 'stopFeedEngagerBtn',
      pauseBtn: 'pauseFeedEngagerBtn', skipBtn: 'skipFeedEngagerBtn',
      resetBtn: 'resetFeedEngagerBtn'
    },
    nicheengager: {
      card: 'nicheEngagerProgressCard', badge: 'nicheEngagerStateBadge', ind: 'nicheEngagerQueueIndicator',
      done: 'nicheEngagerCountDone', col: 'nicheEngagerCountQueue', skip: 'nicheEngagerCountSkipped',
      bar: 'nicheEngagerProgressBar', status: 'nicheEngagerLiveStatusText', cd: 'nicheEngagerCountdownText',
      startBtn: 'runNicheEngagerBtn', stopBtn: 'stopNicheEngagerBtn',
      pauseBtn: 'pauseNicheEngagerBtn', skipBtn: 'skipNicheEngagerBtn',
      resetBtn: 'resetNicheEngagerBtn'
    },
    tgliker: {
      card: 'tgLikerProgressCard', badge: 'tgLikerStateBadge', ind: 'tgLikerQueueIndicator',
      done: 'tgLikerCountLiked', col: 'tgLikerCountReposted', skip: 'tgLikerCountSkipped',
      bar: 'tgLikerProgressBar', status: 'tgLikerLiveStatusText', cd: 'tgLikerCountdownText',
      startBtn: 'runTgLikerBtn', stopBtn: 'stopTgLikerBtn',
      pauseBtn: 'pauseTgLikerBtn', skipBtn: 'skipTgLikerBtn',
      resetBtn: 'resetTgLikerBtn'
    },
    tg: {
      card: 'telegramProgressCard', badge: 'tgStateBadge', ind: null,
      done: 'tgDoneCount', col: 'tgTotalCount', skip: 'tgSkippedCount',
      bar: 'tgProgressBar', status: 'tgLiveStatus', cd: null,
      startBtn: 'runTgEngageBtn', stopBtn: 'stopTgEngageBtn',
      pauseBtn: 'pauseTgEngageBtn', skipBtn: 'skipTgEngageBtn',
      resetBtn: 'resetTelegramQueueBtn'
    }
  };

  let agentId = wf.agentId;
  if (!agentId && wf.title) {
    const t = wf.title.toLowerCase();
    if (t.includes('follower')) agentId = 'followers';
    else if (t.includes('audience')) agentId = 'audience';
    else if (t.includes('sorsa')) agentId = 'sorsa';
    else if (t.includes('reply')) agentId = 'replyback';
    else if (t.includes('unfollow')) agentId = 'unfollow';
    else if (t.includes('reciprocator')) agentId = 'reciprocator';
    else if (t.includes('feed') || t.includes('home')) agentId = 'feedengager';
    else if (t.includes('niche')) agentId = 'nicheengager';
    else if (t.includes('tgliker') || t.includes('tg liker') || t.includes('raid')) agentId = 'tgliker';
  }
  if (!agentId) {
    const activePanel = document.querySelector('.agent-panel-content:not([style*="display: none"])');
    if (activePanel && activePanel.id) {
      agentId = activePanel.id.replace('panel-agent-', '');
    }
  }

  const map = cardMap[agentId || 'audience'];
  if (!map) return;

  const card = document.getElementById(map.card);
  const badge = document.getElementById(map.badge);
  const ind = map.ind ? document.getElementById(map.ind) : null;
  const doneEl = document.getElementById(map.done);
  const colEl = document.getElementById(map.col);
  const skipEl = document.getElementById(map.skip);
  const bar = map.bar ? document.getElementById(map.bar) : null;
  const status = document.getElementById(map.status);
  const cd = document.getElementById(map.cd);
  const startBtn = document.getElementById(map.startBtn);
  const stopBtn = document.getElementById(map.stopBtn);
  const pauseBtn = map.pauseBtn ? document.getElementById(map.pauseBtn) : null;
  const skipBtn = map.skipBtn ? document.getElementById(map.skipBtn) : null;
  const resetBtn = map.resetBtn ? document.getElementById(map.resetBtn) : null;

  if (card) card.style.display = 'block';

  const total = wf.total || wf.items?.length || wf.collected || 0;
  const current = wf.currentIndex || 0;
  const done = (wf.successCount !== undefined) ? wf.successCount : (wf.done || 0);
  const skipped = (wf.ignoredCount !== undefined) ? wf.ignoredCount : (wf.skipped || 0);

  const targetLabel = (agentId === 'replyback') ? 'Reply' : ((agentId === 'sorsa') ? 'Account' : ((agentId === 'feedengager' || agentId === 'nicheengager' || agentId === 'tgliker') ? 'Post' : 'Profile'));
  const currentStep = (done + skipped >= total) ? total : Math.min(Math.max(current + 1, done + skipped + 1), total);
  if (ind) ind.textContent = `${targetLabel} ${done + skipped >= total ? `${total}/${total}` : `${currentStep}/${total}`}`;
  if (doneEl) doneEl.textContent = String(done);
  if (colEl) colEl.textContent = String(total);
  if (skipEl) skipEl.textContent = String(skipped);
  if (agentId === 'tgliker') {
    const lkEl = document.getElementById('tgLikerCountLiked');
    const rpEl = document.getElementById('tgLikerCountReposted');
    const bmEl = document.getElementById('tgLikerCountBookmarked');
    if (lkEl && wf.liked !== undefined) lkEl.textContent = String(wf.liked);
    if (rpEl && wf.reposted !== undefined) rpEl.textContent = String(wf.reposted);
    if (bmEl && wf.bookmarked !== undefined) bmEl.textContent = String(wf.bookmarked);
  }

  const isWorkflowRateLimited = wf.stateBadge === 'DAILY_LIMIT' || wf.stateBadge === 'DAILY LIMIT' || wf.stateBadge === 'RATE_LIMITED';
  const isWorkflowCompleted = !isWorkflowRateLimited && (wf.stateBadge === 'DONE' || (done + skipped >= total && total > 0));
  const isWorkflowStopped = !isWorkflowRateLimited && (wf.isStopped || wf.stateBadge === 'STOPPED');

  if (isWorkflowRateLimited) {
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (badge) {
      badge.textContent = wf.stateBadge.replace('_', ' ');
      badge.style.background = 'rgba(239, 68, 68, 0.25)';
      badge.style.color = '#EF4444';
      badge.style.border = '1px solid rgba(239, 68, 68, 0.6)';
    }
    if (status) status.textContent = wf.statusText || '🛑 Stopped: Twitter Daily Post Limit reached.';
    if (cd) cd.style.display = 'none';
  } else if (isWorkflowCompleted) {
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (badge) {
      badge.textContent = 'DONE';
      badge.style.background = 'rgba(16, 185, 129, 0.2)';
      badge.style.color = '#10B981';
      badge.style.border = '1px solid rgba(16, 185, 129, 0.4)';
    }
    if (status) status.textContent = wf.statusText || `✓ Completed! ${done} processed, ${skipped} skipped.`;
    if (cd) cd.style.display = 'none';
    if (bar) bar.style.width = '100%';
    if (agentId === 'tgliker') {
      const contBox = document.getElementById('tgLikerContinueBox');
      const contInfo = document.getElementById('tgLikerContinueInfo');
      if (contBox) contBox.style.display = 'flex';
      if (contInfo) contInfo.textContent = `${done} previously handled`;
    }
  } else if (isWorkflowStopped) {
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (badge) {
      badge.textContent = 'STOPPED';
      badge.style.background = 'rgba(100, 116, 139, 0.2)';
      badge.style.color = '#94A3B8';
      badge.style.border = '1px solid rgba(100, 116, 139, 0.4)';
    }
    if (status) status.textContent = wf.statusText || 'Workflow stopped by user.';
    if (cd) cd.style.display = 'none';
    if (agentId === 'tgliker') {
      const contBox = document.getElementById('tgLikerContinueBox');
      const contInfo = document.getElementById('tgLikerContinueInfo');
      if (contBox) contBox.style.display = 'flex';
      if (contInfo) contInfo.textContent = `${done} previously handled`;
    }
  } else if (wf.active) {
    if (agentId === 'tgliker') {
      const contBox = document.getElementById('tgLikerContinueBox');
      if (contBox) contBox.style.display = 'none';
    }
    if (startBtn) startBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    if (pauseBtn) {
      pauseBtn.style.display = 'inline-flex';
      const pSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>`;
      const rSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg>`;
      pauseBtn.innerHTML = wf.isPaused ? `${rSvg}Resume` : `${pSvg}Pause`;
      pauseBtn.style.background = wf.isPaused ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.4) 100%)' : 'linear-gradient(135deg, rgba(245, 158, 11, 0.22) 0%, rgba(217, 119, 6, 0.35) 100%)';
      pauseBtn.style.borderColor = wf.isPaused ? 'rgba(52, 211, 153, 0.6)' : 'rgba(251, 191, 36, 0.55)';
      pauseBtn.style.color = wf.isPaused ? '#D1FAE5' : '#FEF3C7';
    }
    if (skipBtn) skipBtn.style.display = 'inline-flex';
    if (badge) {
      badge.textContent = wf.isPaused ? 'PAUSED' : (wf.stateBadge || 'RUNNING');
      badge.style.background = wf.isPaused ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.15)';
      badge.style.color = wf.isPaused ? '#FBBF24' : '#10B981';
      badge.style.border = wf.isPaused ? '1px solid rgba(245, 158, 11, 0.5)' : '1px solid rgba(16, 185, 129, 0.4)';
    }
    if (status && wf.statusText) status.textContent = wf.statusText;
    if (cd) {
      if (wf.countdownText) {
        cd.style.display = 'block';
        cd.textContent = wf.countdownText;
      } else {
        cd.style.display = 'none';
      }
    }
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    if (bar) bar.style.width = `${Math.max(5, pct)}%`;
  }
}

function updateAllStopButtonsUI() {
  const configs = [
    { startBtn: 'runAudienceBuilderBtn', resetBtn: 'resetAudienceQueueBtn', stopBtn: 'stopAudienceBuilderBtn', pauseBtn: 'pauseAudienceBuilderBtn', skipBtn: 'skipAudienceBuilderBtn', badge: 'audienceStateBadge', status: 'audienceLiveStatusText' },
    { startBtn: 'runSorsaBoosterBtn', resetBtn: 'resetSorsaQueueBtn', stopBtn: 'stopSorsaBoosterBtn', pauseBtn: 'pauseSorsaBoosterBtn', skipBtn: 'skipSorsaBoosterBtn', badge: 'sorsaStateBadge', status: 'sorsaLiveStatusText' },
    { startBtn: 'runFollowerIncreaseBtn', resetBtn: 'resetFollowerQueueBtn', stopBtn: 'stopFollowerIncreaseBtn', pauseBtn: 'pauseFollowerIncreaseBtn', skipBtn: 'skipFollowerIncreaseBtn', badge: 'followerStateBadge', status: 'followerLiveStatusText' },
    { startBtn: 'runReplyBackBtn', resetBtn: 'resetReplyBackQueueBtn', stopBtn: 'stopReplyBackBtn', pauseBtn: 'pauseReplyBackBtn', skipBtn: 'skipReplyBackBtn', badge: 'replyBackStateBadge', status: 'replyBackLiveStatusText' },
    { startBtn: 'runAutoUnfollowBtn', resetBtn: 'resetUnfollowQueueBtn', stopBtn: 'stopAutoUnfollowBtn', pauseBtn: 'pauseAutoUnfollowBtn', skipBtn: 'skipAutoUnfollowBtn', badge: 'unfollowStateBadge', status: 'unfollowLiveStatusText' },
    { startBtn: 'runReciprocatorBtn', resetBtn: 'resetReciprocatorQueueBtn', stopBtn: 'stopReciprocatorBtn', pauseBtn: 'pauseReciprocatorBtn', skipBtn: 'skipReciprocatorBtn', badge: 'reciprocatorStateBadge', status: 'reciprocatorLiveStatusText' },
    { startBtn: 'runFeedEngagerBtn', resetBtn: 'resetFeedEngagerBtn', stopBtn: 'stopFeedEngagerBtn', pauseBtn: 'pauseFeedEngagerBtn', skipBtn: 'skipFeedEngagerBtn', badge: 'feedEngagerStateBadge', status: 'feedEngagerLiveStatusText' },
    { startBtn: 'runNicheEngagerBtn', resetBtn: 'resetNicheEngagerBtn', stopBtn: 'stopNicheEngagerBtn', pauseBtn: 'pauseNicheEngagerBtn', skipBtn: 'skipNicheEngagerBtn', badge: 'nicheEngagerStateBadge', status: 'nicheEngagerLiveStatusText' },
    { startBtn: 'runTgEngageBtn', resetBtn: 'resetTelegramQueueBtn', cleanBtn: 'cleanTgInputBtn', stopBtn: 'stopTgEngageBtn', pauseBtn: 'pauseTgEngageBtn', skipBtn: 'skipTgEngageBtn', badge: 'tgStateBadge', status: 'tgLiveStatus' }
  ];

  configs.forEach(cfg => {
    const start = document.getElementById(cfg.startBtn);
    const reset = cfg.resetBtn ? document.getElementById(cfg.resetBtn) : null;
    const clean = cfg.cleanBtn ? document.getElementById(cfg.cleanBtn) : null;
    const stop = document.getElementById(cfg.stopBtn);
    const pause = cfg.pauseBtn ? document.getElementById(cfg.pauseBtn) : null;
    const skip = cfg.skipBtn ? document.getElementById(cfg.skipBtn) : null;
    const badge = cfg.badge ? document.getElementById(cfg.badge) : null;
    const status = cfg.status ? document.getElementById(cfg.status) : null;
    if (start) start.style.display = 'inline-flex';
    if (reset) reset.style.display = 'inline-flex';
    if (clean) clean.style.display = 'inline-flex';
    if (stop) stop.style.display = 'none';
    if (pause) pause.style.display = 'none';
    if (skip) skip.style.display = 'none';
    if (badge) badge.textContent = 'STOPPED';
    if (status && (status.textContent.includes('Engaging') || status.textContent.includes('Visiting') || status.textContent.includes('Opening') || status.textContent.includes('Scanning'))) {
      status.textContent = 'Workflow stopped by user.';
    }
  });

  setAutomationRunningUI(false);
  updateAllPauseButtonsUI(false);
}

function updateAllPauseButtonsUI(isPaused) {
  const pauseBtns = document.querySelectorAll(
    '#pauseAudienceBuilderBtn, #pauseSorsaBoosterBtn, #pauseFollowerIncreaseBtn, #pauseReplyBackBtn, #pauseAutoUnfollowBtn, #pauseReciprocatorBtn, #pauseTgEngageBtn'
  );
  const pauseIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>`;
  const playIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg>`;

  pauseBtns.forEach(btn => {
    btn.innerHTML = isPaused ? `${playIcon}Resume` : `${pauseIcon}Pause`;
    btn.style.background = isPaused
      ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.4) 100%)'
      : '';
    btn.style.borderColor = isPaused ? 'rgba(52, 211, 153, 0.6)' : '';
    btn.style.color = isPaused ? '#34D399' : '';
    btn.style.boxShadow = '';
  });

  const badges = document.querySelectorAll(
    '#audienceStateBadge, #sorsaStateBadge, #followerStateBadge, #replyBackStateBadge, #reciprocatorStateBadge, #tgStateBadge'
  );
  badges.forEach(b => {
    if (isPaused) {
      if (b.textContent !== 'STOPPED' && b.textContent !== 'DONE' && b.textContent !== 'IDLE') {
        b.dataset.prevText = b.textContent;
        b.textContent = 'PAUSED';
      }
    } else {
      if (b.textContent === 'PAUSED' && b.dataset.prevText) {
        b.textContent = b.dataset.prevText;
      }
    }
  });
}

async function handleToggleWorkflowPause() {
  const stored = await chrome.storage.local.get(['atomx_workflow_paused', 'atomx_agent_workflow', 'atomx_active_hud', 'atomx_tg_raid']).catch(() => ({}));
  const newPaused = !stored?.atomx_workflow_paused;
  state.isPaused = newPaused;

  updateAllPauseButtonsUI(newPaused);

  let wf = stored?.atomx_agent_workflow;
  if (wf) {
    wf.isPaused = newPaused;
    if (newPaused) {
      wf.prevStateBadge = wf.stateBadge;
      wf.stateBadge = 'PAUSED';
    } else if (wf.prevStateBadge) {
      wf.stateBadge = wf.prevStateBadge;
    } else {
      wf.stateBadge = 'RUNNING';
    }
  }

  let hud = stored?.atomx_active_hud;
  if (hud) {
    hud.isPaused = newPaused;
    hud.stateBadge = newPaused ? 'PAUSED' : 'RUNNING';
    hud.timerBadge = newPaused ? '⏸️ Paused' : '⚡ Active';
  }

  let tg = stored?.atomx_tg_raid;
  if (tg) {
    tg.isPaused = newPaused;
    if (newPaused) {
      tg.prevStateBadge = tg.stateBadge;
      tg.stateBadge = 'PAUSED';
    } else if (tg.prevStateBadge) {
      tg.stateBadge = tg.prevStateBadge;
    } else {
      tg.stateBadge = 'RUNNING';
    }
  }

  const tglData = await chrome.storage.local.get(['tgl_ctrl']).catch(() => ({}));
  const prevTglCtrl = tglData?.tgl_ctrl || { runId: 0 };
  const newTglCtrl = { ...prevTglCtrl, state: newPaused ? 'paused' : 'running' };

  await chrome.storage.local.set({
    atomx_workflow_paused: newPaused,
    atomx_agent_workflow: wf || null,
    atomx_active_hud: hud || null,
    atomx_tg_raid: tg || null,
    tgl_ctrl: newTglCtrl
  }).catch(() => null);

  chrome.runtime.sendMessage({ type: 'TOGGLE_WORKFLOW_PAUSE', isPaused: newPaused }).catch(() => null);

  // Broadcast pause/resume to all open X tabs (mobile-safe — no-op if chrome.tabs unavailable)
  broadcastToXTabs({ type: 'TOGGLE_WORKFLOW_PAUSE', isPaused: newPaused });

  showExtToast(newPaused ? 'Workflow Paused' : 'Workflow Resumed', newPaused ? '⏸️' : '▶️');
}

let isPopupSkipDebouncing = false;
async function handleSkipWorkflowItem() {
  if (isPopupSkipDebouncing) return;
  isPopupSkipDebouncing = true;
  setTimeout(() => { isPopupSkipDebouncing = false; }, 500);

  await chrome.storage.local.set({ atomx_skip_current: true }).catch(() => null);

  chrome.storage.local.get(['atomx_agent_workflow', 'atomx_active_hud'], (res) => {
    const wf = res?.atomx_agent_workflow;
    const hud = res?.atomx_active_hud;
    if (wf && wf.active) {
      const newSkipped = (wf.ignoredCount || 0) + 1;
      const total = wf.total || 10;
      const done = wf.successCount || 0;
      const nextIdx = Math.min(total, done + newSkipped);
      wf.ignoredCount = newSkipped;
      wf.currentIndex = nextIdx;
      wf.statusText = '⏭️ Skipping current item...';
      updateAgentWorkflowProgressUI(wf);
      chrome.storage.local.set({
        atomx_agent_workflow: wf,
        atomx_active_hud: {
          ...(hud || {}),
          skipped: newSkipped,
          indicator: `${nextIdx}/${total}`,
          statusText: '⏭️ Skipping current item...'
        }
      }).catch(() => null);
    }
  });

  chrome.runtime.sendMessage({ type: 'SKIP_WORKFLOW_ITEM' }).catch(() => null);

  // Broadcast skip to all open X tabs (mobile-safe — no-op if chrome.tabs unavailable)
  broadcastToXTabs({ type: 'SKIP_WORKFLOW_ITEM' });
  showExtToast('Skipping current item...', '⏭️');
}

function syncRateLimitBannerUI() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  chrome.storage.local.get(['atomx_daily_post_limit', 'atomx_rate_limited'], (res) => {
    const banner = document.getElementById('rateLimitWarningBanner');
    const titleEl = document.getElementById('rateLimitBannerTitle');
    const descEl = document.getElementById('rateLimitBannerDesc');
    if (!banner) return;

    const daily = res?.atomx_daily_post_limit;
    const rate = res?.atomx_rate_limited;

    if (daily && daily.active) {
      if (titleEl) titleEl.textContent = 'Twitter Daily Post Limit Reached';
      if (descEl) {
        descEl.innerHTML = `<strong>You've hit the daily post limit on Twitter.</strong><br>` +
          `Twitter response: <em style="color:#FEF08A;">"${daily.reason || "You've hit the daily post limit. Subscribe to Premium for higher limits."}"</em><br>` +
          `All active tasks have been automatically stopped immediately to protect your account.<br>` +
          `<span style="font-size:10px; color:#E2E8F0; margin-top:3px; display:inline-block;">👉 Twitter limits daily posts/replies. Please wait until your limit resets before restarting automation.</span>`;
      }
      banner.style.display = 'block';
    } else if (rate && rate.active) {
      if (titleEl) titleEl.textContent = 'Twitter Rate Limit Encountered';
      if (descEl) {
        descEl.innerHTML = `<strong>Twitter rate limit encountered.</strong><br>` +
          `Twitter response: <em style="color:#FEF08A;">"${rate.reason || 'Rate limit active'}"</em><br>` +
          `All active tasks have been automatically stopped.<br>` +
          `<span style="font-size:10px; color:#E2E8F0; margin-top:3px; display:inline-block;">👉 Please wait a few minutes for cooldown before restarting automation.</span>`;
      }
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  });
}

function initBackgroundWorkflowSync() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;

  // Hydrate rate limit banner on popup open
  syncRateLimitBannerUI();

  // Hydrate current state on popup open
  chrome.storage.local.get(['atomx_tg_raid', 'atomx_agent_workflow', 'atomx_active_hud', 'atomx_workflow_paused'], (res) => {
    if (typeof res?.atomx_workflow_paused === 'boolean') {
      state.isPaused = res.atomx_workflow_paused;
      updateAllPauseButtonsUI(state.isPaused);
    }
    if (res?.atomx_tg_raid && (res.atomx_tg_raid.active || res.atomx_tg_raid.isStopped || res.atomx_tg_raid.currentIndex > 0)) {
      updateTelegramProgressUI(res.atomx_tg_raid);
    }
    if (res?.atomx_agent_workflow) {
      updateAgentWorkflowProgressUI(res.atomx_agent_workflow);
    } else if (res?.atomx_active_hud) {
      updateAgentWorkflowProgressUI(res.atomx_active_hud);
    }
    if (res?.atomx_account_lock_warning) {
      const w = res.atomx_account_lock_warning;
      const verifiedHandle = (state.verifiedXHandle || state.user?.handle || '').replace(/^@/, '').toLowerCase().trim();
      const currentHandle = (w?.current || '').replace(/^@/, '').toLowerCase().trim();
      const banner = document.getElementById('accountMismatchBanner');
      const exp = document.getElementById('mismatchExpectedHandle');
      const act = document.getElementById('mismatchActualHandle');
      if (isValidTwitterHandle(currentHandle) && currentHandle !== 'unknown' && currentHandle !== verifiedHandle) {
        if (banner && exp && act) {
          exp.textContent = `@${(w.expected || verifiedHandle).replace(/^@/, '')}`;
          act.textContent = `@${currentHandle}`;
          banner.style.display = 'block';
        }
      } else {
        // Purge stale or invalid warning
        if (banner) banner.style.display = 'none';
        chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
      }
    }
  });

  // Wire close button on mismatch banner inside popup
  document.getElementById('closeMismatchBannerBtn')?.addEventListener('click', () => {
    const banner = document.getElementById('accountMismatchBanner');
    if (banner) banner.style.display = 'none';
    chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
  });

  // Wire close button on rate limit / daily limit banner inside popup
  document.getElementById('closeRateLimitBannerBtn')?.addEventListener('click', () => {
    const banner = document.getElementById('rateLimitWarningBanner');
    if (banner) banner.style.display = 'none';
    chrome.storage.local.remove(['atomx_daily_post_limit', 'atomx_rate_limited']).catch(() => null);
  });

  // Listen to background updates in real-time
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.atomx_daily_post_limit || changes.atomx_rate_limited) {
      syncRateLimitBannerUI();
    }
    if (changes.atomx_account_lock_warning) {
      const w = changes.atomx_account_lock_warning.newValue;
      const banner = document.getElementById('accountMismatchBanner');
      const exp = document.getElementById('mismatchExpectedHandle');
      const act = document.getElementById('mismatchActualHandle');
      const verifiedHandle = (state.verifiedXHandle || state.user?.handle || '').replace(/^@/, '').toLowerCase().trim();
      const currentHandle = (w?.current || '').replace(/^@/, '').toLowerCase().trim();
      if (w && isValidTwitterHandle(currentHandle) && currentHandle !== 'unknown' && currentHandle !== verifiedHandle && banner && exp && act) {
        exp.textContent = `@${(w.expected || verifiedHandle).replace(/^@/, '')}`;
        act.textContent = `@${currentHandle}`;
        banner.style.display = 'block';
      } else if (banner) {
        banner.style.display = 'none';
      }
    }
    if (changes.atomx_workflow_paused !== undefined) {
      state.isPaused = !!changes.atomx_workflow_paused.newValue;
      updateAllPauseButtonsUI(state.isPaused);
    }
    if (changes.atomx_tg_raid && changes.atomx_tg_raid.newValue) {
      updateTelegramProgressUI(changes.atomx_tg_raid.newValue);
    }
    if (changes.engagedTweetIds && Array.isArray(changes.engagedTweetIds.newValue)) {
      state.engagedTweetIds = changes.engagedTweetIds.newValue;
      updateTgParseSummaryUI();
    }
    const wf = changes.atomx_agent_workflow?.newValue || changes.atomx_active_hud?.newValue;
    if (wf) {
      if (wf.isStopped || wf.stateBadge === 'STOPPED' || wf.stateBadge === 'DAILY_LIMIT' || wf.stateBadge === 'RATE_LIMITED' || wf.stateBadge === 'DAILY LIMIT') {
        updateAllStopButtonsUI();
      }
      updateAgentWorkflowProgressUI(wf);
    }
    if (changes.tgl_stoppick && changes.tgl_stoppick.newValue) {
      const v = changes.tgl_stoppick.newValue;
      const label = v.handle ? `@${v.handle}${v.text ? ' — ' + v.text.slice(0, 60) : ''}` : (v.text || v.id);
      const pickInput = document.getElementById('tgLikerStopPick');
      const stopInput = document.getElementById('tgLikerStopText');
      const stopInfo = document.getElementById('tgLikerStopInfo');
      if (pickInput) pickInput.value = JSON.stringify({ id: v.id, handle: v.handle, text: v.text, label });
      if (stopInput) stopInput.value = label;
      if (stopInfo) stopInfo.textContent = '✓ Stop point set: ' + label;
      chrome.storage.local.set({ atomx_tgliker_stoppick: { id: v.id, handle: v.handle, text: v.text, label } });
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    // Only set the default when nothing valid is saved (previously this overwrote the Options page value on every open)
    chrome.storage.local.get(['backendUrl']).then(r => {
      const cur = r?.backendUrl;
      if (!cur || /localhost|127\.0\.0\.1|vercel\.app/i.test(cur)) {
        chrome.storage.local.set({ backendUrl: DEFAULT_BACKEND_URL });
        chrome.storage.sync?.set({ backendUrl: DEFAULT_BACKEND_URL });
      }
    }).catch(() => null);
  }
  initExtTheme();
  initTabs();
  initListeners();
  initAgentListeners();
  initAgentStatusSystem();
  initBackgroundWorkflowSync();

  // Instant render path from cache (0 delay)
  await Promise.all([
    initToneSystem(),
    loadServerState()
  ]);

  // Non-blocking background operations
  initAudienceBuilderSystem().catch(console.warn);
  autoDetectTweet().catch(console.warn);
  checkExtensionVersion().catch(console.warn);
  startExtOfferCountdown();
  setupExtReferralFeatures();
});

// Universal Extension Version Check (Real-time GitHub Release sync)
function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  const cleanRemote = remote.replace(/^v/, '').trim();
  const cleanLocal = local.replace(/^v/, '').trim();
  const rParts = cleanRemote.split('.').map(n => parseInt(n, 10) || 0);
  const lParts = cleanLocal.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(rParts.length, lParts.length); i++) {
    const r = rParts[i] || 0;
    const l = lParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

async function checkExtensionVersion() {
  const currentVer = chrome.runtime?.getManifest?.()?.version || '1.0.0';
  try {
    const backendUrl = await getBackendUrl();
    const res = await fetch(`${backendUrl}/api/system/version`).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      // Only display update banner if an actual release has been published on GitHub
      if (data && data.hasRealRelease && data.currentVersion && isNewerVersion(data.currentVersion, currentVer)) {
        const banner = document.getElementById('extUpdateBanner');
        const verText = document.getElementById('extUpdateVersionText');
        const dlBtn = document.getElementById('extUpdateDownloadBtn');
        if (banner) {
          banner.style.display = 'flex';
          if (verText) verText.textContent = `UPDATE AVAILABLE: v${data.currentVersion}`;
          if (dlBtn && data.downloadUrl) dlBtn.href = data.downloadUrl;
        }
      }
    }
  } catch (e) {
    console.warn('Version check error:', e);
  }
}

// Live Countdown for Founding 100 Launch Offer
function startExtOfferCountdown() {
  if (window._extOfferCountdownInterval) clearInterval(window._extOfferCountdownInterval);

  function tick() {
    const el = document.getElementById('extFoundingCountdownTimer');
    const box = document.getElementById('extFoundingCountdownBox');
    if (!el) return;

    const target = window._extOfferTargetTime || (window._extOfferTargetTime = Date.now() + (2 * 86400000) + (14 * 3600000) + (37 * 60000) + 52000);
    const diff = target - Date.now();

    if (diff <= 0) {
      el.innerHTML = '<span style="color:#EF4444; font-weight:800;">OFFER EXPIRED</span>';
      if (box) box.style.borderColor = '#EF4444';
      return;
    }

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const pad = (n) => String(n).padStart(2, '0');
    el.innerText = `${pad(days)}d : ${pad(hours)}h : ${pad(minutes)}m : ${pad(seconds)}s`;
  }

  tick();
  window._extOfferCountdownInterval = setInterval(tick, 1000);
}

// Extension Referral Features & Link Copying
function setupExtReferralFeatures() {
  const copyBtn = document.getElementById('extCopyInviteLinkBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const input = document.getElementById('extInviteLinkInput');
      const url = input ? input.value : 'https://atomxengage.com';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => alert('✓ Referral link copied to clipboard!'));
      } else {
        prompt('Copy your referral link:', url);
      }
    });
  }

  // Update personal handle link if logged in
  if (state.user && state.user.handle) {
    const clean = state.user.handle.replace(/^@/, '');
    const linkInput = document.getElementById('extInviteLinkInput');
    if (linkInput) linkInput.value = `https://atomxengage.com/ref/${clean}`;
  }
}

// Tab switching
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchExtTab(tab.dataset.tab);
    });
  });
}

function switchExtTab(tabKey) {
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t.dataset.tab === tabKey));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tabKey}`));
}

// ==============================================================
// DYNAMIC TONE & STYLE SYSTEM WITH CUSTOM USER PROMPTS
// ==============================================================
// Tone & Style Dynamic Pill Rendering & Cloud Synchronization
// ==============================================================
function getCleanToneLabel(name, isMini = false) {
  if (!name) return 'Tone';
  // Remove parenthetical notes like "(5-10 words)", "(Crypto Twitter)", etc.
  const clean = name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if (isMini) return clean.split(' ')[0] || clean;
  return clean || name;
}

async function initToneSystem() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const stored = await chrome.storage.local.get(['defaultTones', 'customTones', 'selectedTone', 'selectedTonePrompt', 'selectedToneId']).catch(() => ({}));
    if (Array.isArray(stored?.defaultTones) && stored.defaultTones.length > 0) state.defaultTones = stored.defaultTones;
    if (Array.isArray(stored?.customTones)) state.customTones = stored.customTones;
    if (stored?.selectedTone) state.selectedTone = stored.selectedTone;
    if (stored?.selectedTonePrompt) state.selectedTonePrompt = stored.selectedTonePrompt;
    if (stored?.selectedToneId) state.selectedToneId = stored.selectedToneId;
  }

  // Render tone pills immediately from cache
  renderTonePills();
  setupCustomToneDrawer();

  // Instant network sync with cache-busting
  syncToneStylesFromServer();
}

async function syncToneStylesFromServer() {
  try {
    const backendUrl = await getBackendUrl();
    const res = await fetch(`${backendUrl}/api/tone-styles?_t=${Date.now()}`, {
      cache: 'no-store'
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      if (data.planQuotas) {
        state.planQuotas = data.planQuotas;
      }
      if (typeof data.maxCustomTemplatesPerUser === 'number') {
        state.maxCustomTemplates = data.maxCustomTemplatesPerUser;
      }
      if (Array.isArray(data.defaultTones) && data.defaultTones.length > 0) {
        state.defaultTones = data.defaultTones;
        let matching = state.defaultTones.find(t =>
          (state.selectedToneId && t.id === state.selectedToneId) ||
          (state.selectedTone && t.name === state.selectedTone)
        );
        if (!matching && state.defaultTones.length > 0) {
          matching = state.defaultTones[0];
        }
        if (matching) {
          state.selectedToneId = matching.id;
          state.selectedTone = matching.name;
          state.selectedTonePrompt = matching.prompt;
        }
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.set({
            defaultTones: state.defaultTones,
            planQuotas: state.planQuotas,
            selectedToneId: state.selectedToneId,
            selectedTone: state.selectedTone,
            selectedTonePrompt: state.selectedTonePrompt
          });
        }
        renderTonePills();
      }
    }
  } catch (e) { }
}

function renderTonePills() {
  const container = document.getElementById('tonePills');
  const tgContainer = document.getElementById('tgTonePillsRow');
  const tgActiveToneLabel = document.getElementById('tgActiveToneName');

  if (tgActiveToneLabel) {
    tgActiveToneLabel.textContent = state.selectedTone || 'Bullish (5-10 words)';
  }

  const renderButtonsTo = (targetEl, isMini = false) => {
    if (!targetEl) return;
    targetEl.innerHTML = '';

    // Render default system tones
    state.defaultTones.forEach(t => {
      const btn = document.createElement('button');
      const isAct = state.selectedToneId === t.id || (!state.selectedToneId && state.selectedTone === t.name);
      btn.className = `tone-pill ${isAct ? 'active' : ''}`;
      if (isMini) btn.style.fontSize = '10px';
      btn.dataset.id = t.id;
      btn.dataset.tone = t.name;

      const reqTier = (t.minPlanTier || 'free').toLowerCase();
      const canAccess = canUserAccessTier(state.userPlan, reqTier);

      if (!canAccess) {
        btn.textContent = `🔒 ${getCleanToneLabel(t.name, isMini)}`;
        btn.title = `${t.name} (${reqTier.toUpperCase()} Plan Required)`;
        btn.style.opacity = '0.65';
        btn.onclick = () => {
          alert(`🔒 Tier Upgrade Required:\nThe "${t.name}" preset is exclusively available for ${reqTier.toUpperCase()} and higher subscribers.\n\nYour current plan: ${state.userPlan || 'Free Plan'}.\nPlease upgrade your plan to unlock this voice.`);
        };
      } else {
        btn.textContent = getCleanToneLabel(t.name, isMini);
        btn.title = t.name; // NEVER reveal internal system prompt on hover!
        btn.onclick = () => selectTone(t.id, t.name, t.prompt);
      }
      targetEl.appendChild(btn);
    });

    // Render custom tones
    state.customTones.forEach(ct => {
      const pillWrap = document.createElement('div');
      pillWrap.style.display = 'inline-flex';
      pillWrap.style.alignItems = 'center';
      pillWrap.style.gap = '2px';

      const btn = document.createElement('button');
      const isAct = state.selectedToneId === ct.id || state.selectedTone === ct.name;
      btn.className = `tone-pill ${isAct ? 'active' : ''}`;
      if (isMini) btn.style.fontSize = '10px';
      btn.dataset.id = ct.id;
      btn.dataset.tone = ct.name;
      btn.textContent = `⭐ ${ct.name}`;
      btn.title = ct.name; // NEVER reveal custom prompt on hover!
      btn.onclick = () => selectTone(ct.id, ct.name, ct.prompt);

      pillWrap.appendChild(btn);

      if (!isMini) {
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '✕';
        delBtn.style.background = 'none';
        delBtn.style.border = 'none';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '10px';
        delBtn.style.color = 'var(--text-muted)';
        delBtn.style.padding = '2px 4px';
        delBtn.title = 'Delete custom style';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          deleteCustomTone(ct.id);
        };
        pillWrap.appendChild(delBtn);
      }

      targetEl.appendChild(pillWrap);
    });
  };

  renderButtonsTo(container, false);
  renderButtonsTo(tgContainer, true);

  // Update Global Tone UI in Tone & Style tab
  const globalBadge = document.getElementById('globalActiveToneBadge');
  const globalPromptArea = document.getElementById('globalActiveTonePromptArea');
  if (globalBadge) globalBadge.textContent = state.selectedTone || 'Bullish (5-10 words)';
  if (globalPromptArea && document.activeElement !== globalPromptArea) {
    globalPromptArea.value = state.selectedTonePrompt || '';
  }

  // Update voice labels across all agent panels
  const activeVoiceText = state.selectedTone || 'Bullish (5-10 words)';
  const tgVoiceLabel = document.getElementById('tgActiveToneName');
  const sorsaVoiceLabel = document.getElementById('sorsaActiveToneLabel');
  const followerVoiceLabel = document.getElementById('followerActiveToneLabel');
  const recipVoiceLabel = document.getElementById('reciprocatorActiveToneLabel');
  const feedVoiceLabel = document.getElementById('feedActiveToneLabel');
  const nicheVoiceLabel = document.getElementById('nicheActiveToneLabel');
  const unfollowVoiceLabel = document.getElementById('unfollowActiveToneLabel');
  if (tgVoiceLabel) tgVoiceLabel.textContent = activeVoiceText;
  if (sorsaVoiceLabel) sorsaVoiceLabel.textContent = activeVoiceText;
  if (followerVoiceLabel) followerVoiceLabel.textContent = activeVoiceText;
  if (recipVoiceLabel) recipVoiceLabel.textContent = activeVoiceText;
  if (feedVoiceLabel) feedVoiceLabel.textContent = activeVoiceText;
  if (nicheVoiceLabel) nicheVoiceLabel.textContent = activeVoiceText;
  if (unfollowVoiceLabel) unfollowVoiceLabel.textContent = activeVoiceText;

  // Update limit display in drawer
  state.maxCustomTemplates = getPlanMaxCustomTones(state.userPlan);
  const limitEl = document.getElementById('customLimitCount');
  if (limitEl) limitEl.textContent = state.maxCustomTemplates;
  const statusEl = document.getElementById('customLimitStatus');
  if (statusEl) statusEl.textContent = `${state.customTones.length} / ${state.maxCustomTemplates} custom used (${(state.userPlan || 'Free').toUpperCase()})`;
}

function selectTone(id, name, prompt) {
  let livePrompt = prompt;
  const sysTone = (state.defaultTones || []).find(t => t.id === id || t.name === name);
  if (sysTone && sysTone.prompt) livePrompt = sysTone.prompt;
  const custTone = (state.customTones || []).find(t => t.id === id || t.name === name);
  if (custTone && custTone.prompt) livePrompt = custTone.prompt;

  state.selectedToneId = id;
  state.selectedTone = name;
  state.selectedTonePrompt = livePrompt || '';

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({
      selectedToneId: id,
      selectedTone: name,
      selectedTonePrompt: state.selectedTonePrompt
    });
  }
  renderTonePills();
}

function setupCustomToneDrawer() {
  const drawer = document.getElementById('customToneDrawer');
  const openBtn = document.getElementById('openCustomToneBtn');
  const closeBtn = document.getElementById('closeCustomToneBtn');
  const saveBtn = document.getElementById('saveCustomToneBtn');

  if (openBtn) {
    openBtn.onclick = () => {
      if (drawer) drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
    };
  }
  if (closeBtn) {
    closeBtn.onclick = () => {
      if (drawer) drawer.style.display = 'none';
    };
  }

  if (saveBtn) {
    saveBtn.onclick = () => {
      const allowedQuota = getPlanMaxCustomTones(state.userPlan);
      state.maxCustomTemplates = allowedQuota;
      if (state.customTones.length >= allowedQuota) {
        alert(`Limit reached! Your ${(state.userPlan || 'Free').toUpperCase()} plan allows up to ${allowedQuota} custom tone templates.\nPlease upgrade to Pro or Growth for up to 25 custom styles!`);
        return;
      }

      const nameInput = document.getElementById('customToneNameInput');
      const promptInput = document.getElementById('customTonePromptInput');
      const name = nameInput ? nameInput.value.trim() : '';
      const prompt = promptInput ? promptInput.value.trim() : '';

      if (!name || !prompt) {
        alert('Please provide both a Tone Name and Custom Prompt instructions.');
        return;
      }

      const newId = 'custom_' + Date.now();
      const newCustom = { id: newId, name, prompt };
      state.customTones.push(newCustom);

      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ customTones: state.customTones });
      }

      selectTone(newId, name, prompt);

      if (nameInput) nameInput.value = '';
      if (promptInput) promptInput.value = '';
      if (drawer) drawer.style.display = 'none';
    };
  }

  const savePromptBtn = document.getElementById('saveGlobalTonePromptBtn');
  if (savePromptBtn) {
    savePromptBtn.onclick = () => {
      const area = document.getElementById('globalActiveTonePromptArea');
      if (area) {
        state.selectedTonePrompt = area.value.trim();
        chrome.storage.local.set({ selectedTonePrompt: state.selectedTonePrompt });
        showExtToast('Global Tone Prompt Saved!', '💾');
      }
    };
  }
}

function deleteCustomTone(id) {
  state.customTones = state.customTones.filter(t => t.id !== id);
  if (state.selectedToneId === id) {
    const def = state.defaultTones[0] || { id: 'natural', name: 'Natural & Concise', prompt: '' };
    selectTone(def.id, def.name, def.prompt);
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ customTones: state.customTones });
  }
  renderTonePills();
}

function updateReplyTargetSummaryUI() {
  const input = document.getElementById('targetTweetInput');
  const chip = document.getElementById('replyLinkCountChip');
  const summary = document.getElementById('replyDetectedSummary');
  const autoBtnText = document.getElementById('autoReplyEngageBtnText');
  if (!input) return;

  const raw = input.value;
  const extracted = extractTweetLinks(raw);
  if (extracted.length > 1) {
    if (chip) { chip.style.display = 'inline-block'; chip.textContent = `${extracted.length} Links`; }
    if (summary) summary.textContent = `${extracted.length} Tweets in Batch Queue`;
    if (autoBtnText) autoBtnText.textContent = `🚀 Auto Reply All (${extracted.length} Tweets)`;
  } else if (extracted.length === 1) {
    if (chip) { chip.style.display = 'inline-block'; chip.textContent = `1 Link`; }
    if (summary) summary.textContent = `1 Tweet Ready`;
    if (autoBtnText) autoBtnText.textContent = `🚀 1-Click Auto Reply & Engage`;
  } else {
    if (chip) chip.style.display = 'none';
    if (summary) summary.textContent = '';
    if (autoBtnText) autoBtnText.textContent = `🚀 1-Click Auto Reply & Engage`;
  }
}

// Standard Event Listeners
function initListeners() {
  // Target post input listeners for instant link & batch detection
  const targetInput = document.getElementById('targetTweetInput');
  if (targetInput) {
    targetInput.addEventListener('input', updateReplyTargetSummaryUI);
    targetInput.addEventListener('paste', () => setTimeout(updateReplyTargetSummaryUI, 50));
  }

  // Detect on active page
  document.getElementById('detectActiveTweetBtn')?.addEventListener('click', autoDetectTweet);

  // 1-Click Autonomous Reply & Engage (Handles single or batch links)
  document.getElementById('autoReplyEngageBtn')?.addEventListener('click', handleAutoReplyEngage);

  // Stop Automation Buttons
  document.getElementById('stopReplyAutomationBtn')?.addEventListener('click', triggerStopAutomation);
  document.getElementById('stopReplyConsoleBtn')?.addEventListener('click', triggerStopAutomation);
  document.getElementById('stopAgentBtn')?.addEventListener('click', triggerStopAutomation);

  // Generate Reply (AI Reply Tab Preview)
  document.getElementById('generateBtn')?.addEventListener('click', handleGenerateReply);

  // Insert into Tweet
  document.getElementById('insertTweetBtn')?.addEventListener('click', handleInsertTweet);

  // Copy reply
  document.getElementById('copyReplyBtn')?.addEventListener('click', () => {
    const text = document.getElementById('replyOutput').value;
    navigator.clipboard?.writeText(text);
    const btn = document.getElementById('copyReplyBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });

  // Dock / Open in Chrome Side Panel (Side-by-side with X.com)
  document.getElementById('dockSidePanelBtn')?.addEventListener('click', async () => {
    try {
      if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
        const currentWindow = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: currentWindow.id });
        window.close(); // Close floating popup so user continues seamlessly docked in Side Panel
      } else {
        alert('Chrome Side Panel is available on Chrome 116+. You can also open it via Chrome\'s Side Panel icon in the top-right toolbar.');
      }
    } catch (err) {
      console.warn('Could not open side panel programmatically:', err);
      alert('To dock in Side Panel: Click Chrome\'s Side Panel button (top-right of your browser) and select Twixor.');
    }
  });

  // Open in Floating Mini Window (Detached Mini HUD matching Screenshot 2)
  document.getElementById('popoutWindowBtn')?.addEventListener('click', async () => {
    try {
      if (chrome.windows && typeof chrome.windows.create === 'function') {
        await chrome.windows.create({
          url: chrome.runtime.getURL('mini-hud.html'),
          type: 'popup',
          width: 380,
          height: 260,
          focused: true
        });
      }
    } catch (err) {
      console.warn('Could not open detached mini window:', err);
    }
  });



  // Provider switcher
  const provSelect = document.getElementById('extProviderSelect');
  if (provSelect) {
    provSelect.addEventListener('change', (e) => {
      state.selectedProvider = e.target.value;
      updateModelSelectOptions(e.target.value);
    });
  }

  // Fetch Live Models
  document.getElementById('extFetchModelsBtn')?.addEventListener('click', fetchLiveModels);

  // Universal Centralized Safety Settings Sampling Helpers
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

  // Universal Centralized Safety Settings Sampling Helpers
  function getSafetyPacingDelay(safety, type = 'replyDelay', fallbackMin = 3, fallbackMax = 8) {
    const resolved = getResolvedSafetySettings(safety);
    const minKey = `${type}Min`;
    const maxKey = `${type}Max`;
    const min = resolved[minKey] !== undefined ? resolved[minKey] : fallbackMin;
    const max = resolved[maxKey] !== undefined ? resolved[maxKey] : fallbackMax;
    if (min === 0 && max === 0) return 0;
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return Math.floor(low + Math.random() * (high - low + 1));
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
    }

    const lastBreak = Number(stateObj.lastBreakSuccessCount || 0);
    const actionsSinceBreak = currentSuccessCount - lastBreak;

    if (currentSuccessCount > 0 && actionsSinceBreak >= stateObj.nextBreakInterval) {
      stateObj.lastBreakSuccessCount = currentSuccessCount;
      stateObj.nextBreakInterval = Math.floor(low + Math.random() * (high - low + 1));
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
    return Math.max(5, chosenSec);
  }

  // Centralized Anti-Ban Safety Controls (Dual Thumb Ranges + Cursor/Typing Controls)
  function initDualRange(minId, maxId, highlightId, valId, unit, storageKeyMin, storageKeyMax, defaultMin, defaultMax) {
    const minEl = document.getElementById(minId);
    const maxEl = document.getElementById(maxId);
    const highlightEl = document.getElementById(highlightId);
    const valEl = document.getElementById(valId);
    if (!minEl || !maxEl) return;

    function render(minVal, maxVal) {
      const minLimit = parseFloat(minEl.min);
      const maxLimit = parseFloat(minEl.max);
      const totalRange = maxLimit - minLimit || 1;
      const leftPct = Math.max(0, Math.min(100, ((minVal - minLimit) / totalRange) * 100));
      const rightPct = Math.max(0, Math.min(100, 100 - (((maxVal - minLimit) / totalRange) * 100)));
      if (highlightEl) {
        highlightEl.style.left = `${leftPct}%`;
        highlightEl.style.right = `${rightPct}%`;
      }
      if (valEl) {
        valEl.textContent = `${minVal} - ${maxVal} ${unit}`;
      }
    }

    function onMinChange() {
      let minVal = parseFloat(minEl.value);
      let maxVal = parseFloat(maxEl.value);
      if (minVal > maxVal) {
        maxVal = minVal;
        maxEl.value = maxVal;
      }
      render(minVal, maxVal);
      save();
    }

    function onMaxChange() {
      let minVal = parseFloat(minEl.value);
      let maxVal = parseFloat(maxEl.value);
      if (maxVal < minVal) {
        minVal = maxVal;
        minEl.value = minVal;
      }
      render(minVal, maxVal);
      save();
    }

    function save() {
      const minVal = parseFloat(minEl.value);
      const maxVal = parseFloat(maxEl.value);
      chrome.storage.local.get(['atomx_safety_settings'], res => {
        const s = res?.atomx_safety_settings || {};
        s[storageKeyMin] = minVal;
        s[storageKeyMax] = maxVal;
        // Keep single keys for backward compatibility
        if (storageKeyMin.startsWith('replyDelay')) s.replyDelay = maxVal;
        if (storageKeyMin.startsWith('profileWait')) s.profileWait = maxVal;
        if (storageKeyMin.startsWith('breakActions')) s.breakActions = maxVal;
        if (storageKeyMin.startsWith('restDuration')) s.restDuration = maxVal;
        chrome.storage.local.set({ atomx_safety_settings: s });
      });
    }

    minEl.addEventListener('input', onMinChange);
    maxEl.addEventListener('input', onMaxChange);

    render(parseFloat(minEl.value), parseFloat(maxEl.value));
  }

  const cursorSpeedSlider = document.getElementById('extCursorSpeedSlider');
  const valExtCursorSpeed = document.getElementById('valExtCursorSpeed');
  if (cursorSpeedSlider) {
    cursorSpeedSlider.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (valExtCursorSpeed) {
        valExtCursorSpeed.textContent = (v === 0) ? '0 ms (Instant)' : (v <= 250 ? `${v} ms (Fast)` : (v <= 650 ? `${v} ms (Natural)` : `${v} ms (Cinematic)`));
      }
      chrome.storage.local.get(['atomx_safety_settings'], res => {
        const s = res?.atomx_safety_settings || {};
        s.cursorSpeed = v;
        chrome.storage.local.set({ atomx_safety_settings: s });
      });
    });
  }

  const typingDelaySlider = document.getElementById('extTypingDelaySlider');
  const valExtTypingDelay = document.getElementById('valExtTypingDelay');
  if (typingDelaySlider) {
    typingDelaySlider.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (valExtTypingDelay) {
        valExtTypingDelay.textContent = (v === 0) ? '0 ms (Instant Paste)' : (v <= 60 ? `${v} ms/char (Fast)` : (v <= 140 ? `${v} ms/char (Human)` : `${v} ms/char (Careful)`));
      }
      chrome.storage.local.get(['atomx_safety_settings'], res => {
        const s = res?.atomx_safety_settings || {};
        s.typingDelay = v;
        chrome.storage.local.set({ atomx_safety_settings: s });
      });
    });
  }

  // Restore saved safety settings
  chrome.storage.local.get(['atomx_safety_settings'], res => {
    const raw = res?.atomx_safety_settings || {};
    const s = getResolvedSafetySettings(raw);

    // Guarantee that dual-range min/max keys are written into storage
    chrome.storage.local.set({ atomx_safety_settings: s });

    // Restore Reply Delay (min - max)
    const replyMinEl = document.getElementById('extReplyDelayMin');
    const replyMaxEl = document.getElementById('extReplyDelayMax');
    const rMin = s.replyDelayMin;
    const rMax = s.replyDelayMax;
    if (replyMinEl) replyMinEl.value = rMin;
    if (replyMaxEl) replyMaxEl.value = rMax;
    initDualRange('extReplyDelayMin', 'extReplyDelayMax', 'highlightReplyDelay', 'valExtReplyDelay', 'sec', 'replyDelayMin', 'replyDelayMax', 3, 6);

    // Restore Profile Wait (min - max)
    const profMinEl = document.getElementById('extProfileWaitMin');
    const profMaxEl = document.getElementById('extProfileWaitMax');
    const pMin = s.profileWaitMin;
    const pMax = s.profileWaitMax;
    if (profMinEl) profMinEl.value = pMin;
    if (profMaxEl) profMaxEl.value = pMax;
    initDualRange('extProfileWaitMin', 'extProfileWaitMax', 'highlightProfileWait', 'valExtProfileWait', 'sec', 'profileWaitMin', 'profileWaitMax', 10, 20);

    // Restore Break Actions (min - max)
    const brkMinEl = document.getElementById('extBreakActionsMin');
    const brkMaxEl = document.getElementById('extBreakActionsMax');
    const bMin = s.breakActionsMin;
    const bMax = s.breakActionsMax;
    if (brkMinEl) brkMinEl.value = bMin;
    if (brkMaxEl) brkMaxEl.value = bMax;
    initDualRange('extBreakActionsMin', 'extBreakActionsMax', 'highlightBreakActions', 'valExtBreakActions', 'actions', 'breakActionsMin', 'breakActionsMax', 10, 15);

    // Restore Rest Duration (min - max)
    const restMinEl = document.getElementById('extRestDurationMin');
    const restMaxEl = document.getElementById('extRestDurationMax');
    const rdMin = s.restDurationMin;
    const rdMax = s.restDurationMax;
    if (restMinEl) restMinEl.value = rdMin;
    if (restMaxEl) restMaxEl.value = rdMax;
    initDualRange('extRestDurationMin', 'extRestDurationMax', 'highlightRestDuration', 'valExtRestDuration', 'min', 'restDurationMin', 'restDurationMax', 1, 3);

    // Restore Cursor Speed
    if (cursorSpeedSlider && s.cursorSpeed !== undefined) {
      cursorSpeedSlider.value = s.cursorSpeed;
      const v = Number(s.cursorSpeed);
      if (valExtCursorSpeed) {
        valExtCursorSpeed.textContent = (v === 0) ? '0 ms (Instant)' : (v <= 250 ? `${v} ms (Fast)` : (v <= 650 ? `${v} ms (Natural)` : `${v} ms (Cinematic)`));
      }
    }

    // Restore Typing Delay
    if (typingDelaySlider && s.typingDelay !== undefined) {
      typingDelaySlider.value = s.typingDelay;
      const v = Number(s.typingDelay);
      if (valExtTypingDelay) {
        valExtTypingDelay.textContent = (v === 0) ? '0 ms (Instant Paste)' : (v <= 60 ? `${v} ms/char (Fast)` : (v <= 140 ? `${v} ms/char (Human)` : `${v} ms/char (Careful)`));
      }
    }
  });

  // Hybrid Action Execution Strategy Controller (Mode A: DOM Virtual Cursor vs Mode B: CDP Debugger)
  const execSelect = document.getElementById('extExecutionStrategySelect');
  const quickSelect = document.getElementById('extQuickStrategySelect');
  const execBadge = document.getElementById('extExecStrategyBadge');
  const execDesc = document.getElementById('extExecStrategyDesc');

  function updateExecStrategyUI(mode) {
    const isDebugger = mode === 'debugger';
    if (execSelect) execSelect.value = isDebugger ? 'debugger' : 'dom';
    if (quickSelect) quickSelect.value = isDebugger ? 'debugger' : 'dom';

    if (execBadge) {
      execBadge.textContent = isDebugger ? 'CDP Debugger' : 'Virtual Cursor';
      execBadge.style.color = isDebugger ? '#8B5CF6' : 'var(--blue-primary)';
      execBadge.style.background = isDebugger ? 'rgba(139, 92, 246, 0.15)' : 'rgba(59, 130, 246, 0.15)';
    }

    if (execDesc) {
      if (isDebugger) {
        execDesc.textContent = 'Mode B: Utilizes Chrome DevTools Protocol (CDP) Input.dispatchMouseEvent for authentic OS-level input simulation. Desktop only, with graceful Virtual Cursor fallback.';
      } else {
        execDesc.textContent = "Mode A: Injects visible animated mouse cursor with organic bezier curves and 9-stage human event sequence ('pointermove' through 'mouseup'). Safe, mobile-compatible & default.";
      }
    }
  }

  function handleStrategyChange(newMode) {
    chrome.storage.local.set({ atomx_execution_strategy: newMode }).catch(() => null);
    updateExecStrategyUI(newMode);
  }

  execSelect?.addEventListener('change', (e) => handleStrategyChange(e.target.value));
  quickSelect?.addEventListener('change', (e) => handleStrategyChange(e.target.value));

  // Restore saved execution strategy (default to 'dom')
  chrome.storage.local.get(['atomx_execution_strategy'], res => {
    const mode = res?.atomx_execution_strategy || 'dom';
    updateExecStrategyUI(mode);
  });

  function notifyActiveTabInitVirtualCursor() {
    chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
      if (tabs && tabs.length > 0) {
        tabs.forEach(t => {
          if (t.id) chrome.tabs.sendMessage(t.id, { type: 'INIT_VIRTUAL_CURSOR' }).catch(() => null);
        });
      }
    });
  }

  // Auto-inject Virtual Cursor as soon as any Launch / Run button is clicked in popup
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && (btn.id?.startsWith('run') || btn.id?.startsWith('start') || btn.id?.includes('Launch'))) {
      notifyActiveTabInitVirtualCursor();
    }
  });

  // Crypto Tx Verification
  document.getElementById('extVerifyTxBtn')?.addEventListener('click', handleVerifyCryptoTx);

  // Copy Invite Code
  document.getElementById('extCopyInviteBtn')?.addEventListener('click', () => {
    navigator.clipboard?.writeText('MYTHOPAIR-X924');
    alert('✓ Invite Code MYTHOPAIR-X924 copied to clipboard! Share with friends to earn bonus credits.');
  });

  // 1-to-1 Verified Account & In-Extension Request Access Flow
  document.getElementById('extSubmitRequestBtn')?.addEventListener('click', handleExtSubmitRequest);
  document.getElementById('extCheckStatusBtn')?.addEventListener('click', () => handleExtCheckStatus(true));
  document.getElementById('extCheckApprovalStatusPromptBtn')?.addEventListener('click', handleExtPromptCheckApprovalStatus);
  document.getElementById('extDoLookupBtn')?.addEventListener('click', handleExtDoLookup);
  document.getElementById('extLookupBackLink')?.addEventListener('click', () => showAccessSubView('request'));
  document.getElementById('extLookupHandleInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleExtDoLookup();
  });
  document.getElementById('extLookupGoToLoginLink')?.addEventListener('click', () => showAccessSubView('login'));
  document.getElementById('extPendingCheckAnotherBtn')?.addEventListener('click', handleExtCheckAnotherId);
  document.getElementById('extEditRequestBtn')?.addEventListener('click', handleExtSubmitNewAfterReject);
  document.getElementById('extRejectedSubmitNewBtn')?.addEventListener('click', handleExtSubmitNewAfterReject);
  document.getElementById('extRejectedCheckAnotherBtn')?.addEventListener('click', handleExtCheckAnotherId);
  document.getElementById('extRejectedGoLoginBtn')?.addEventListener('click', () => showAccessSubView('login'));
  document.getElementById('extGoToLoginLink')?.addEventListener('click', () => showAccessSubView('login'));
  document.getElementById('extGoToRequestLink')?.addEventListener('click', () => showAccessSubView('request'));
  document.getElementById('extGoToResetPwdLink')?.addEventListener('click', () => showAccessSubView('reset'));
  document.getElementById('extBackToLoginFromResetBtn')?.addEventListener('click', () => showAccessSubView('login'));
  document.getElementById('extForgotSuccessBackLoginBtn')?.addEventListener('click', () => showAccessSubView('login'));
  document.getElementById('extSubmitForgotPwdBtn')?.addEventListener('click', handleExtSubmitForgotPwd);
  document.getElementById('extToggleChangePasswordBox')?.addEventListener('click', toggleChangePasswordBox);
  document.getElementById('extLoggedInSubmitChangePassBtn')?.addEventListener('click', handleExtLoggedInChangePassword);
  document.getElementById('extResetPasswordSubmitBtn')?.addEventListener('click', handleExtResetPassword);
  document.getElementById('extNotifyAdminForgotPwdBtn')?.addEventListener('click', handleExtNotifyAdminForgotPwd);
  document.getElementById('extRequestReviewBtn')?.addEventListener('click', handleExtRequestReview);
  document.getElementById('extSuspendedLogoutBtn')?.addEventListener('click', handleExtLogout);
  document.getElementById('extSaveNewPasswordSubmitBtn')?.addEventListener('click', handleExtSetPassword);
  document.getElementById('extLoginSubmitBtn')?.addEventListener('click', handleExtLogin);
  document.getElementById('extLogoutBtn')?.addEventListener('click', handleExtLogout);
  document.getElementById('extForceResetBtn')?.addEventListener('click', async () => {
    const confirmed = await showExtConfirm('Clear all local extension session cache and return to request access?', {
      title: 'Reset Local Cache',
      icon: '🧹',
      confirmText: 'Clear Cache',
      cancelText: 'Cancel',
      danger: true
    });
    if (!confirmed) return;
    await purgeExtLocalUserSession();
    alert('✓ Local cache cleared successfully.');
    showAccessSubView('request');
  });
  document.getElementById('extSyncAccountBtn')?.addEventListener('click', async () => {
    await loadServerState();
    alert('✓ Account details & credit balance synchronized with server.');
  });

  // Password visibility eye toggles
  document.querySelectorAll('.pwd-eye-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
      } else {
        input.type = 'password';
        btn.textContent = '👁️';
      }
    });
  });
}

// ==============================================================
// THEME (DARK / LIGHT) CONTROLLER FOR EXTENSION
// ==============================================================
function initExtTheme() {
  const saved = localStorage.getItem('atomx_ext_theme') || 'light';
  applyExtTheme(saved);

  document.getElementById('extThemeToggleBtn')?.addEventListener('click', () => {
    const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    applyExtTheme(newTheme);
    localStorage.setItem('atomx_ext_theme', newTheme);
    chrome.storage?.local.set({ theme: newTheme });
  });
}

function applyExtTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    const btn = document.getElementById('extThemeToggleBtn');
    if (btn) btn.textContent = '☀️';
  } else {
    document.body.classList.remove('dark');
    document.documentElement.setAttribute('data-theme', 'light');
    const btn = document.getElementById('extThemeToggleBtn');
    if (btn) btn.textContent = '🌙';
  }
}

// 10 Autonomous Agents Handlers (Bento Grid + Dedicated Detail Pages)
const AGENT_META = {
  telegram: { title: 'TG Pulse', icon: '✈️', badge: 'POPULAR', desc: 'Auto-visits Telegram raid links ➔ Likes, comments & replies' },
  audience: { title: 'CrowdFi', icon: '👥', badge: 'GROWTH', desc: 'Target specific niche audiences (2 Free Curated Lists included)' },
  sorsa: { title: 'Score Accelerator', icon: '⚡', badge: 'AIRDROP ROI', desc: 'Boost Score for airdrops & promotions via top accounts' },
  followers: { title: 'GrowthFi', icon: '📈', badge: '100% AUTO', desc: '100% Automatic — Smart value-replies for high organic follow-backs' },
  replyback: { title: 'ReplyWave', icon: '🔄', badge: 'AUTO LOOP', desc: 'Auto-likes and contextually replies to all comments on your tweet' },
  unfollow: { title: 'Auto Unfollow', icon: '🧹', badge: 'SAFETY', desc: 'Filter non-followers or low Walchain scores with safety delay' },
  creators: { title: 'CreatorX', icon: '⭐', badge: 'RADAR', desc: 'Save favorite handles ➔ Instant top early comment spots' },
  defaulter: { title: 'Find Defaulters', icon: '🔍', badge: 'AUDIT POD', desc: 'Scan post comments & detect members who skipped commenting' },
  reciprocator: { title: 'Commenter Reciprocator', icon: '🤝', badge: 'RECIPROCAL', desc: 'Visits accounts who commented on your post & comments back on their recent posts' },
  feedengager: { title: 'Home Feed Engager', icon: '🏠', badge: 'FEED AI', desc: 'Autonomous engagement on your X Home Timeline with Ad skip & AI voice' },
  nicheengager: { title: 'Niche Search Engager', icon: '🎯', badge: 'NICHE AI', desc: 'Search any niche keyword (e.g. "follow for follow") & engage posts with Ad skip' },
  tgliker: { title: 'TG Liker (Raid & Repost)', icon: '⚡', badge: 'MASS RAID', desc: 'Mass Like, Repost & Bookmark on profile reposts, quotes or active tab' }
};

function extractTwitterListUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Pure numeric ID (e.g. 2103557569319219223)
  if (/^\d{10,25}$/.test(trimmed)) {
    return `https://x.com/i/lists/${trimmed}`;
  }

  // 2. Full or partial Twitter/X list URL
  const urlMatch = trimmed.match(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/(?:i\/lists\/\d+|[a-zA-Z0-9_]+\/lists\/[a-zA-Z0-9_-]+)(?:\/[a-zA-Z0-9_-]+)?/i);
  if (urlMatch) {
    let url = urlMatch[0];
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    return url;
  }

  // 3. Match i/lists/123456...
  const partialMatch = trimmed.match(/i\/lists\/\d+/i);
  if (partialMatch) {
    return `https://x.com/${partialMatch[0]}`;
  }

  return null;
}

function extractTwitterListId(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (/^\d{10,25}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/(?:lists\/|list:)(\d{10,25})/i);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

function extractHandlesFromText(text) {
  if (!text) return [];
  const matches = text.match(/@?([a-zA-Z0-9_]{1,15})/g) || [];
  const banned = new Set(['https', 'http', 'twitter', 'com', 'lists', 'i', 'x', 'status', 'search', 'home', 'notifications', 'messages', 'true', 'false', 'null', 'undefined']);
  const result = [];
  const seen = new Set();
  for (const m of matches) {
    const clean = m.replace(/^@/, '').trim();
    if (clean && !banned.has(clean.toLowerCase()) && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      result.push(clean);
    }
  }
  return result;
}

function initAgentListeners() {
  // Bento Grid Card Clicks -> Open Dedicated Page
  document.querySelectorAll('.bento-card').forEach(card => {
    card.addEventListener('click', () => {
      const agentId = card.dataset.agentId;
      openAgentDetailView(agentId);
    });
  });

  // Back Button -> Return to Bento Grid
  document.getElementById('agentDetailBackBtn')?.addEventListener('click', closeAgentDetailView);

  // Agent 1: Telegram Group Engage Live Parsers & Controls
  const tgInput = document.getElementById('tgLinksInput');
  if (tgInput) {
    tgInput.addEventListener('input', updateTgParseSummaryUI);
    tgInput.addEventListener('paste', () => setTimeout(updateTgParseSummaryUI, 50));
  }

  // Clean Telegram Input Button (Strip bot tags, emojis, timestamps)
  document.getElementById('cleanTgInputBtn')?.addEventListener('click', handleCleanTgInput);

  // Action Checkbox Preset Buttons
  document.getElementById('actionSelectAllBtn')?.addEventListener('click', () => {
    ['actionOptLike', 'actionOptComment', 'actionOptRepost', 'actionOptFollow', 'actionOptScroll'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = true;
    });
  });
  document.getElementById('actionSelectLikeCommentBtn')?.addEventListener('click', () => {
    const l = document.getElementById('actionOptLike'); if (l) l.checked = true;
    const c = document.getElementById('actionOptComment'); if (c) c.checked = true;
    const s = document.getElementById('actionOptScroll'); if (s) s.checked = true;
    const r = document.getElementById('actionOptRepost'); if (r) r.checked = false;
    const f = document.getElementById('actionOptFollow'); if (f) f.checked = false;
  });
  document.getElementById('actionSelectLikeOnlyBtn')?.addEventListener('click', () => {
    const l = document.getElementById('actionOptLike'); if (l) l.checked = true;
    const s = document.getElementById('actionOptScroll'); if (s) s.checked = true;
    const c = document.getElementById('actionOptComment'); if (c) c.checked = false;
    const r = document.getElementById('actionOptRepost'); if (r) r.checked = false;
    const f = document.getElementById('actionOptFollow'); if (f) f.checked = false;
  });

  document.getElementById('runTgEngageBtn')?.addEventListener('click', async () => {
    if (!ensureAgentEnabledOrBlock('telegram')) return;
    if (!(await ensureVerifiedAccountOrBlock())) return;

    const input = document.getElementById('tgLinksInput')?.value.trim();
    if (!input) {
      alert('Please paste at least one Telegram tweet link or chat dump.');
      return;
    }

    const extracted = extractTweetLinks(input);
    if (extracted.length === 0) {
      alert('⚠️ No valid X/Twitter links detected in your pasted text.\nEnsure links contain x.com, twitter.com, or intent/like?tweet_id=...');
      return;
    }

    // Ensure fresh engagedTweetIds from local storage before filtering
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await chrome.storage.local.get(['engagedTweetIds']);
        if (Array.isArray(stored?.engagedTweetIds)) {
          state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), ...stored.engagedTweetIds]));
        }
      } catch (e) {}
    }

    const filtered = filterTweetLinks(extracted);

    if (filtered.freshCount === 0) {
      alert(`⚠️ Nothing new to engage!\n\n• Total Links Found: ${filtered.totalFound}\n• Batch Duplicates Removed: ${filtered.duplicateCount}\n• Already Engaged Skipped: ${filtered.alreadyEngagedCount}\n\nAll tweets were already processed or duplicates. No credits were deducted.`);
      return;
    }

    // Read user's selected action checkboxes
    const actions = {
      like: document.getElementById('actionOptLike')?.checked ?? true,
      comment: document.getElementById('actionOptComment')?.checked ?? true,
      repost: document.getElementById('actionOptRepost')?.checked ?? false,
      follow: document.getElementById('actionOptFollow')?.checked ?? false,
      scroll: document.getElementById('actionOptScroll')?.checked ?? true
    };

    const hasAnyAction = actions.like || actions.comment || actions.repost || actions.follow;
    if (!hasAnyAction) {
      alert('⚠️ Please select at least one action (Like, Comment, Repost, or Follow) to execute.');
      return;
    }

    if (state.credits < filtered.freshCount) {
      alert(`⚠️ Insufficient credits!\nYou need ${filtered.freshCount} credits for ${filtered.freshCount} fresh tweets, but have ${state.credits}.\nPlease top up in the Credits tab.`);
      switchExtTab('credits');
      return;
    }

    const runBtn = document.getElementById('runTgEngageBtn');
    const pauseBtn = document.getElementById('pauseTgEngageBtn');
    const skipBtn = document.getElementById('skipTgEngageBtn');
    const stopBtn = document.getElementById('stopTgEngageBtn');
    const progressCard = document.getElementById('tgProgressCard');
    const tgStateBadge = document.getElementById('tgStateBadge');
    const tgQueueInd = document.getElementById('tgQueueIndicator');
    const tgDoneEl = document.getElementById('tgDoneCount');
    const tgColEl = document.getElementById('tgCollectedCount');
    const tgSkipEl = document.getElementById('tgSkippedCount');
    const tgBar = document.getElementById('tgProgressBar');
    const tgStatus = document.getElementById('tgLiveStatusText');
    const tgCountdown = document.getElementById('tgCountdownText');

    const cleanBtn = document.getElementById('cleanTgInputBtn');
    const resetBtn = document.getElementById('resetTelegramQueueBtn');

    if (runBtn) runBtn.style.display = 'none';
    if (cleanBtn) cleanBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    if (pauseBtn) { pauseBtn.style.display = 'inline-flex'; pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>Pause`; }
    if (skipBtn) skipBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    if (progressCard) progressCard.style.display = 'block';
    if (tgStateBadge) tgStateBadge.textContent = 'ENGAGING';
    if (tgQueueInd) tgQueueInd.textContent = `Tweet 0/${filtered.freshCount}`;
    if (tgDoneEl) tgDoneEl.textContent = '0';
    if (tgColEl) tgColEl.textContent = String(filtered.freshCount);
    if (tgSkipEl) tgSkipEl.textContent = '0';
    if (tgBar) tgBar.style.width = '5%';
    if (tgStatus) tgStatus.textContent = 'Starting Telegram Raid engagement...';
    if (tgCountdown) tgCountdown.style.display = 'none';

    // Mark workflow as running (for pagehide mini-hud auto-open)
    state.isWorkflowRunning = true;
    state.isPaused = false;
    state.skipCurrent = false;
    await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);

    // Delegate to background service worker — continues even after popup closes
    chrome.runtime.sendMessage({
      type: 'BG_START_TG_RAID',
      tweets: filtered.freshTweets,
      actions,
      options: {
        delaySeconds: state.delaySeconds || 7,
        style: state.selectedTone,
        stylePrompt: state.selectedTonePrompt,
        verifiedXHandle: state.verifiedXHandle || '',
        backendUrl: await getBackendUrl()
      }
    }, (res) => {
      if (chrome.runtime?.lastError || !res?.ok) {
        // Background relay failed — fall back to popup-based execution
        executeAutonomousRaidWorkflow(filtered.freshTweets, actions).finally(() => {
          if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Launch'; }
          if (pauseBtn) pauseBtn.style.display = 'none';
          if (skipBtn) skipBtn.style.display = 'none';
          if (stopBtn) stopBtn.style.display = 'none';
          state.isWorkflowRunning = false;
        });
      }
    });
  });

  // Stop button for Telegram Group Engage
  document.getElementById('stopTgEngageBtn')?.addEventListener('click', () => {
    state.isAborted = true;
    state.isWorkflowRunning = false;
    state.isPaused = false;
    // Tell background to abort
    chrome.runtime.sendMessage({ type: 'BG_ABORT_TG_RAID' }).catch(() => null);
    // Also abort any local running instance (mobile-safe)
    if (tgWorkingTabId) {
      safeSendTabMessage(tgWorkingTabId, { type: 'ABORT_WORKFLOW' });
      tgWorkingTabId = null;
    }
    syncFloatingHud(null, {
      title: 'TG Pulse',
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      isStopped: true
    });
    const runBtn = document.getElementById('runTgEngageBtn');
    const cleanBtn = document.getElementById('cleanTgInputBtn');
    const resetBtn = document.getElementById('resetTelegramQueueBtn');
    const pauseBtn = document.getElementById('pauseTgEngageBtn');
    const skipBtn = document.getElementById('skipTgEngageBtn');
    const stopBtn = document.getElementById('stopTgEngageBtn');
    const tgStateBadge = document.getElementById('tgStateBadge');
    const tgStatus = document.getElementById('tgLiveStatusText');
    const tgCountdown = document.getElementById('tgCountdownText');
    if (runBtn) { runBtn.style.display = 'inline-flex'; runBtn.disabled = false; runBtn.textContent = '▶ Launch'; }
    if (cleanBtn) cleanBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';
    if (tgStateBadge) tgStateBadge.textContent = 'STOPPED';
    if (tgStatus) tgStatus.textContent = 'Workflow stopped by user.';
    if (tgCountdown) tgCountdown.style.display = 'none';
    setAutomationRunningUI(false);
    showExtToast('Telegram Engage Stopped', '⏹');
  });

  // Agent 2: Audience Builder (A2, Growth, Fully Auto)
  document.getElementById('audienceListSelect')?.addEventListener('change', (e) => {
    const box = document.getElementById('customListUrlBox');
    if (box) box.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  document.getElementById('runAudienceBuilderBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('audience')) return;
    startAudienceBuilderWorkflow();
  });

  // Live Options Syncing for Followers Increase & Audience Builder (picks up toggles while running/paused)
  function syncLiveAgentOptions(agentId, updatedOptions) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get(['atomx_agent_workflow', 'atomx_follower_settings', 'atomx_audience_settings'], (res) => {
      const wf = res?.atomx_agent_workflow;
      if (wf) {
        wf.options = { ...(wf.options || {}), ...updatedOptions };
        chrome.storage.local.set({ atomx_agent_workflow: wf });
      }
      if (agentId === 'followers') {
        const prev = res?.atomx_follower_settings || {};
        chrome.storage.local.set({ atomx_follower_settings: { ...prev, ...updatedOptions } });
      } else if (agentId === 'audience') {
        const prev = res?.atomx_audience_settings || {};
        chrome.storage.local.set({ atomx_audience_settings: { ...prev, ...updatedOptions } });
      }
      broadcastToXTabs({ type: 'SYNC_WORKFLOW_OPTIONS', agentId, options: updatedOptions });
    });
  }

  ['followerOptLike', 'followerOptComment', 'followerOptRepost', 'followerOptFollow'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      const opts = {
        likePosts: document.getElementById('followerOptLike')?.checked ?? true,
        replyPosts: document.getElementById('followerOptComment')?.checked ?? true,
        repostPosts: document.getElementById('followerOptRepost')?.checked ?? false,
        autoFollow: document.getElementById('followerOptFollow')?.checked ?? true
      };
      syncLiveAgentOptions('followers', opts);
    });
  });

  ['audienceLikePostsToggle', 'audienceReplyPostsToggle', 'audienceRepostToggle', 'audienceAutoFollowToggle'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      const opts = {
        likePosts: document.getElementById('audienceLikePostsToggle')?.checked ?? true,
        replyPosts: document.getElementById('audienceReplyPostsToggle')?.checked ?? true,
        repostPosts: document.getElementById('audienceRepostToggle')?.checked ?? false,
        autoFollow: document.getElementById('audienceAutoFollowToggle')?.checked ?? false
      };
      syncLiveAgentOptions('audience', opts);
    });
  });

async function broadcastAbortToAllTabsAndStorage(agentTitle = 'AtomX') {
  state.isAborted = true;
  state.isWorkflowRunning = false;
  state.isPaused = false;

  const stored = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_active_hud']).catch(() => ({}));
  const prevWf = stored?.atomx_agent_workflow || {};
  const prevHud = stored?.atomx_active_hud || {};

  let agentId = prevWf.agentId;
  if (!agentId) {
    const t = agentTitle.toLowerCase();
    if (t.includes('audience')) agentId = 'audience';
    else if (t.includes('follower')) agentId = 'followers';
    else if (t.includes('sorsa')) agentId = 'sorsa';
    else if (t.includes('reply')) agentId = 'replyback';
    else if (t.includes('reciprocator')) agentId = 'reciprocator';
    else agentId = 'audience';
  }

  const total = prevWf.total || prevHud.collected || 0;
  const done = prevWf.successCount ?? prevHud.done ?? 0;
  const skipped = prevWf.ignoredCount ?? prevHud.skipped ?? 0;

  const stoppedWf = {
    ...prevWf,
    agentId,
    title: agentTitle,
    active: false,
    isStopped: true,
    stateBadge: 'STOPPED',
    statusText: `${agentTitle} stopped by user.`,
    countdownText: '',
    timerBadge: '🛑 Stopped',
    total,
    successCount: done,
    ignoredCount: skipped
  };

  const stoppedHud = {
    ...prevHud,
    title: agentTitle,
    stateBadge: 'STOPPED',
    statusText: `${agentTitle} stopped by user.`,
    countdownText: '',
    timerBadge: '🛑 Stopped',
    nextAction: 'Stopped',
    isStopped: true,
    active: false,
    done,
    collected: total,
    skipped,
    indicator: `${done}/${total}`
  };

  await chrome.storage.local.set({
    atomx_agent_workflow: stoppedWf,
    atomx_active_hud: stoppedHud,
    atomx_workflow_paused: false,
    atomx_tg_raid: { active: false, stateBadge: 'STOPPED', isStopped: true },
    tgl_ctrl: { state: 'stopped', runId: 0 },
    tgl_state: {
      phase: 'stopped',
      status: '⏹ Stopped by user'
    }
  }).catch(() => null);

  chrome.runtime.sendMessage({ type: 'BG_ABORT_AGENT_WORKFLOW' }).catch(() => null);
  chrome.runtime.sendMessage({ type: 'ABORT_WORKFLOW' }).catch(() => null);

  // Broadcast abort/HUD update to all open X tabs (mobile-safe — no-op if chrome.tabs unavailable)
  broadcastToXTabs({ type: 'ABORT_WORKFLOW' });
  broadcastToXTabs({ type: 'UPDATE_FLOATING_HUD', data: stoppedHud, hud: stoppedHud });

  updateAgentWorkflowProgressUI(stoppedWf);
  updateAllStopButtonsUI();
}

  // Unified Agent Controls: Stop, Pause, Skip for all agents
  const stopButtonConfigs = [
    { id: 'stopAudienceBuilderBtn', agentId: 'audience', title: 'CrowdFi' },
    { id: 'stopSorsaBoosterBtn', agentId: 'sorsa', title: 'Score Accelerator' },
    { id: 'stopFollowerIncreaseBtn', agentId: 'followers', title: 'GrowthFi' },
    { id: 'stopReplyBackBtn', agentId: 'replyback', title: 'ReplyWave' },
    { id: 'stopAutoUnfollowBtn', agentId: 'unfollow', title: 'Auto Unfollow' },
    { id: 'stopReciprocatorBtn', agentId: 'reciprocator', title: 'Commenter Reciprocator' },
    { id: 'stopFeedEngagerBtn', agentId: 'feedengager', title: 'Home Feed Engager' },
    { id: 'stopNicheEngagerBtn', agentId: 'nicheengager', title: 'Niche Search Engager' },
    { id: 'stopTgLikerBtn', agentId: 'tgliker', title: 'TG Liker' }
  ];

  stopButtonConfigs.forEach(({ id, agentId, title }) => {
    document.getElementById(id)?.addEventListener('click', () => {
      broadcastAbortToAllTabsAndStorage(title, agentId);
      if (agentId === 'audience' && audienceWorkingTabId) {
        safeRemoveTab(audienceWorkingTabId);
        audienceWorkingTabId = null;
      }
      updateAgentConsole('⏹️ Stopped', `${title} stopped by user.`);
      showExtToast(`${title} Stopped`, '⏹');
    });
  });

  // Wire all Pause Buttons
  [
    'pauseTgEngageBtn', 'pauseAudienceBuilderBtn', 'pauseSorsaBoosterBtn', 'pauseFollowerIncreaseBtn',
    'pauseReplyBackBtn', 'pauseAutoUnfollowBtn', 'pauseReciprocatorBtn', 'pauseFeedEngagerBtn', 'pauseNicheEngagerBtn',
    'pauseTgLikerBtn'
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('click', handleToggleWorkflowPause);
  });

  // Wire all Skip Buttons
  [
    'skipTgEngageBtn', 'skipAudienceBuilderBtn', 'skipSorsaBoosterBtn', 'skipFollowerIncreaseBtn',
    'skipReplyBackBtn', 'skipAutoUnfollowBtn', 'skipReciprocatorBtn', 'skipFeedEngagerBtn', 'skipNicheEngagerBtn',
    'skipTgLikerBtn'
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('click', handleSkipWorkflowItem);
  });

  // Target Preset Badges (Feed & Niche)
  document.querySelectorAll('.feed-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('feedTargetCountInput');
      if (inp) {
        inp.value = btn.dataset.count;
        inp.dispatchEvent(new Event('input'));
      }
      document.querySelectorAll('.feed-preset-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'rgba(59,130,246,0.15)';
        b.style.borderColor = 'rgba(59,130,246,0.45)';
        b.style.color = '#60A5FA';
      });
      btn.classList.add('active');
      btn.style.background = '#2563EB';
      btn.style.borderColor = '#3B82F6';
      btn.style.color = '#FFFFFF';
    });
  });
  document.querySelectorAll('.niche-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('nicheTargetCountInput');
      if (inp) {
        inp.value = btn.dataset.count;
        inp.dispatchEvent(new Event('input'));
      }
      document.querySelectorAll('.niche-preset-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'rgba(59,130,246,0.15)';
        b.style.borderColor = 'rgba(59,130,246,0.45)';
        b.style.color = '#60A5FA';
      });
      btn.classList.add('active');
      btn.style.background = '#2563EB';
      btn.style.borderColor = '#3B82F6';
      btn.style.color = '#FFFFFF';
    });
  });

  // Home Feed Engager Launch & Reset Buttons
  document.getElementById('runFeedEngagerBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('feedengager')) return;
    startHomeFeedEngagerWorkflow();
  });
  document.getElementById('resetFeedEngagerBtn')?.addEventListener('click', () => {
    const doneEl = document.getElementById('feedEngagerCountDone');
    const queueEl = document.getElementById('feedEngagerCountQueue');
    const skipEl = document.getElementById('feedEngagerCountSkipped');
    const qInd = document.getElementById('feedEngagerQueueIndicator');
    const bar = document.getElementById('feedEngagerProgressBar');
    const status = document.getElementById('feedEngagerLiveStatusText');
    const badge = document.getElementById('feedEngagerStateBadge');
    const countdown = document.getElementById('feedEngagerCountdownText');
    const card = document.getElementById('feedEngagerProgressCard');
    const startBtn = document.getElementById('runFeedEngagerBtn');
    const stopBtn = document.getElementById('stopFeedEngagerBtn');
    const pauseBtn = document.getElementById('pauseFeedEngagerBtn');
    const skipBtn = document.getElementById('skipFeedEngagerBtn');
    const inp = document.getElementById('feedTargetCountInput');

    const defaultCnt = inp ? inp.value || '10' : '10';
    if (doneEl) doneEl.textContent = '0';
    if (queueEl) queueEl.textContent = defaultCnt;
    if (skipEl) skipEl.textContent = '0';
    if (qInd) qInd.textContent = `Post 0/${defaultCnt}`;
    if (bar) bar.style.width = '0%';
    if (badge) { badge.textContent = 'IDLE'; badge.className = 'badge-mini'; }
    if (status) status.textContent = 'Ready to engage feed...';
    if (countdown) countdown.style.display = 'none';
    if (card) card.style.display = 'none';
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    showExtToast('Home Feed Engager Reset', '🔄');
  });

  // Niche Search Engager Launch & Reset Buttons
  document.getElementById('runNicheEngagerBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('nicheengager')) return;
    startNicheSearchEngagerWorkflow();
  });
  document.getElementById('resetNicheEngagerBtn')?.addEventListener('click', () => {
    const doneEl = document.getElementById('nicheEngagerCountDone');
    const queueEl = document.getElementById('nicheEngagerCountQueue');
    const skipEl = document.getElementById('nicheEngagerCountSkipped');
    const qInd = document.getElementById('nicheEngagerQueueIndicator');
    const bar = document.getElementById('nicheEngagerProgressBar');
    const status = document.getElementById('nicheEngagerLiveStatusText');
    const badge = document.getElementById('nicheEngagerStateBadge');
    const countdown = document.getElementById('nicheEngagerCountdownText');
    const card = document.getElementById('nicheEngagerProgressCard');
    const startBtn = document.getElementById('runNicheEngagerBtn');
    const stopBtn = document.getElementById('stopNicheEngagerBtn');
    const pauseBtn = document.getElementById('pauseNicheEngagerBtn');
    const skipBtn = document.getElementById('skipNicheEngagerBtn');
    const inp = document.getElementById('nicheTargetCountInput');

    const defaultCnt = inp ? inp.value || '10' : '10';
    if (doneEl) doneEl.textContent = '0';
    if (queueEl) queueEl.textContent = defaultCnt;
    if (skipEl) skipEl.textContent = '0';
    if (qInd) qInd.textContent = `Post 0/${defaultCnt}`;
    if (bar) bar.style.width = '0%';
    if (badge) { badge.textContent = 'IDLE'; badge.className = 'badge-mini'; }
    if (status) status.textContent = 'Ready to engage niche posts...';
    if (countdown) countdown.style.display = 'none';
    if (card) card.style.display = 'none';
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    showExtToast('Niche Search Engager Reset', '🔄');
  });

  // TG Liker Preset Target Buttons
  document.querySelectorAll('.tgliker-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('tgLikerTargetCountInput');
      if (inp) {
        inp.value = btn.dataset.count;
        inp.dispatchEvent(new Event('input'));
      }
      document.querySelectorAll('.tgliker-preset-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'rgba(59,130,246,0.15)';
        b.style.borderColor = 'rgba(59,130,246,0.45)';
        b.style.color = '#60A5FA';
      });
      btn.classList.add('active');
      btn.style.background = '#2563EB';
      btn.style.borderColor = '#3B82F6';
      btn.style.color = '#FFFFFF';
    });
  });

  // TG Liker Continue Add-More Preset Buttons
  let tgLikerSelectedAddCount = 20;
  document.querySelectorAll('.tgliker-cont-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tgLikerSelectedAddCount = Number(btn.dataset.add) || 20;
      document.querySelectorAll('.tgliker-cont-btn').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'rgba(15,23,42,0.8)';
        b.style.borderColor = 'rgba(59,130,246,0.35)';
        b.style.color = '#93C5FD';
      });
      btn.classList.add('active');
      btn.style.background = '#2563EB';
      btn.style.borderColor = '#3B82F6';
      btn.style.color = '#FFFFFF';
    });
  });

  document.getElementById('btnTgLikerContinue')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('tgliker')) return;
    startTgLikerWorkflow(true, tgLikerSelectedAddCount);
  });

  // TG Liker Launch & Reset Buttons
  document.getElementById('runTgLikerBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('tgliker')) return;
    startTgLikerWorkflow(false, 0);
  });
  document.getElementById('resetTgLikerBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove(['atomx_tgliker_seen', 'atomx_tgliker_last_stats'], () => {
      const doneEl = document.getElementById('tgLikerCountLiked');
      const repEl = document.getElementById('tgLikerCountReposted');
      const bmEl = document.getElementById('tgLikerCountBookmarked');
      const skipEl = document.getElementById('tgLikerCountSkipped');
      const qInd = document.getElementById('tgLikerQueueIndicator');
      const bar = document.getElementById('tgLikerProgressBar');
      const status = document.getElementById('tgLikerLiveStatusText');
      const badge = document.getElementById('tgLikerStateBadge');
      const countdown = document.getElementById('tgLikerCountdownText');
      const card = document.getElementById('tgLikerProgressCard');
      const contBox = document.getElementById('tgLikerContinueBox');
      const startBtn = document.getElementById('runTgLikerBtn');
      const stopBtn = document.getElementById('stopTgLikerBtn');
      const pauseBtn = document.getElementById('pauseTgLikerBtn');
      const skipBtn = document.getElementById('skipTgLikerBtn');
      const inp = document.getElementById('tgLikerTargetCountInput');

      const defaultCnt = inp ? inp.value || '20' : '20';
      if (doneEl) doneEl.textContent = '0';
      if (repEl) repEl.textContent = '0';
      if (bmEl) bmEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (qInd) qInd.textContent = `Post 0/${defaultCnt}`;
      if (bar) bar.style.width = '0%';
      if (badge) { badge.textContent = 'IDLE'; badge.className = 'badge-mini'; }
      if (status) status.textContent = 'Ready. Target profile reposts, quotes or active tab.';
      if (countdown) countdown.style.display = 'none';
      if (card) card.style.display = 'none';
      if (contBox) contBox.style.display = 'none';
      if (startBtn) startBtn.style.display = 'inline-flex';
      if (stopBtn) stopBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (skipBtn) skipBtn.style.display = 'none';
      const stopInput = document.getElementById('tgLikerStopText');
      const pickInput = document.getElementById('tgLikerStopPick');
      const stopInfo = document.getElementById('tgLikerStopInfo');
      if (stopInput) stopInput.value = '';
      if (pickInput) pickInput.value = '';
      if (stopInfo) stopInfo.textContent = 'Pick chap -> X page e oi post e click koro. Ba nijei likho: @username lekhar kichu ongsho. Oi post porjonto giye (post shoho) auto stop hobe. Khali = stop point nai.';
      showExtToast('TG Liker Reset', '🔄');
    });
  });

  // TG Liker: Stop Pick & Scroll Recorder Event Listeners
  document.getElementById('tgLikerBtnPickStop')?.addEventListener('click', pickTgLikerStop);
  document.getElementById('tgLikerBtnRecStart')?.addEventListener('click', tglRecStart);
  document.getElementById('tgLikerBtnRecStop')?.addEventListener('click', () => tglRecFinalize('manually stop'));
  document.getElementById('tgLikerRecPace')?.addEventListener('change', tglRecSavePrefs);
  document.getElementById('tgLikerRecSource')?.addEventListener('change', tglRecSavePrefs);
  document.getElementById('tgLikerRecFolder')?.addEventListener('input', tglRecSavePrefs);
  tglRecLoad();

  // Telegram Engage Reset Button
  document.getElementById('resetTelegramQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove(['atomx_tg_engaged_cache', 'atomx_tg_counters', 'atomx_tg_raid', 'atomx_active_hud'], () => {
      const doneEl = document.getElementById('tgDoneCount');
      const colEl = document.getElementById('tgCollectedCount');
      const skipEl = document.getElementById('tgSkippedCount');
      const qInd = document.getElementById('tgQueueIndicator');
      const bar = document.getElementById('tgProgressBar');
      const status = document.getElementById('tgLiveStatusText');
      const badge = document.getElementById('tgStateBadge');
      const countdown = document.getElementById('tgCountdownText');
      const skippedContainer = document.getElementById('tgSkippedPostsContainer');
      const skippedListEl = document.getElementById('tgSkippedPostsList');
      const skippedBadgeCount = document.getElementById('tgSkippedBadgeCount');

      if (doneEl) doneEl.textContent = '0';
      if (colEl) colEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (qInd) qInd.textContent = 'Tweet 0/0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'Telegram raid queue and active counters reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      if (skippedContainer) skippedContainer.style.display = 'none';
      if (skippedListEl) skippedListEl.innerHTML = '';
      if (skippedBadgeCount) skippedBadgeCount.textContent = '0';
      updateTgParseSummaryUI?.();
      showExtToast('Telegram Queue Reset', '🔄');
    });
  });

  // Telegram Engage Skipped Posts List Toggle
  document.getElementById('tgSkippedPostsHeader')?.addEventListener('click', () => {
    const list = document.getElementById('tgSkippedPostsList');
    const icon = document.getElementById('tgSkippedToggleIcon');
    if (!list) return;
    const isHidden = list.style.display === 'none';
    list.style.display = isHidden ? 'flex' : 'none';
    if (icon) icon.textContent = isHidden ? '▼' : '▶';
  });

  // Audience Builder Reset Button
  document.getElementById('resetAudienceQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove([
      'atomx_audience_queue',
      'atomx_audience_queue_pos',
      'atomx_audience_counters',
      'atomx_audience_engaged_history',
      'atomx_agent_workflow',
      'atomx_active_hud'
    ], () => {
      const doneEl = document.getElementById('audienceDoneCount');
      const colEl = document.getElementById('audienceCollectedCount');
      const skipEl = document.getElementById('audienceSkippedCount');
      const qInd = document.getElementById('audienceQueueIndicator');
      const bar = document.getElementById('audienceProgressBar');
      const status = document.getElementById('audienceLiveStatusText');
      const badge = document.getElementById('audienceStateBadge');
      const countdown = document.getElementById('audienceCountdownText');
      const startBtn = document.getElementById('runAudienceBuilderBtn');
      const stopBtn = document.getElementById('stopAudienceBuilderBtn');
      const pauseBtn = document.getElementById('pauseAudienceBuilderBtn');
      const skipBtn = document.getElementById('skipAudienceBuilderBtn');

      if (doneEl) doneEl.textContent = '0';
      if (colEl) colEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (qInd) qInd.textContent = 'Profile 0/0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'Audience queue, history and counters reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      if (startBtn) startBtn.style.display = 'block';
      if (stopBtn) stopBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (skipBtn) skipBtn.style.display = 'none';
      showExtToast('Audience Queue Reset', '🔄');
    });
  });

  // Sorsa Booster Reset Button
  document.getElementById('resetSorsaQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove([
      'atomx_sorsa_engaged_history',
      'atomx_sorsa_counters',
      'atomx_sorsa_queue',
      'atomx_agent_workflow',
      'atomx_active_hud'
    ], () => {
      const doneEl = document.getElementById('sorsaDoneCount');
      const colEl = document.getElementById('sorsaCollectedCount');
      const skipEl = document.getElementById('sorsaSkippedCount');
      const qInd = document.getElementById('sorsaQueueIndicator');
      const bar = document.getElementById('sorsaProgressBar');
      const status = document.getElementById('sorsaLiveStatusText');
      const badge = document.getElementById('sorsaStateBadge');
      const countdown = document.getElementById('sorsaCountdownText');
      const startBtn = document.getElementById('runSorsaBoosterBtn');
      const stopBtn = document.getElementById('stopSorsaBoosterBtn');
      const pauseBtn = document.getElementById('pauseSorsaBoosterBtn');
      const skipBtn = document.getElementById('skipSorsaBoosterBtn');

      if (doneEl) doneEl.textContent = '0';
      if (colEl) colEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (qInd) qInd.textContent = 'Account 0/0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'Score Accelerator history, queue and counters reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      if (startBtn) startBtn.style.display = 'block';
      if (stopBtn) stopBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (skipBtn) skipBtn.style.display = 'none';
      showExtToast('Score Accelerator Queue Reset', '🔄');
    });
  });

  // GrowthFi Reset Button
  document.getElementById('resetFollowerQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove([
      'atomx_follower_engaged_history',
      'atomx_follower_engaged_tweets',
      'atomx_follower_counters',
      'atomx_agent_workflow',
      'atomx_active_hud'
    ], () => {
      const doneEl = document.getElementById('followerDoneCount');
      const colEl = document.getElementById('followerCollectedCount');
      const skipEl = document.getElementById('followerSkippedCount');
      const qInd = document.getElementById('followerQueueIndicator');
      const bar = document.getElementById('followerProgressBar');
      const status = document.getElementById('followerLiveStatusText');
      const badge = document.getElementById('followerStateBadge');
      const countdown = document.getElementById('followerCountdownText');
      const startBtn = document.getElementById('runFollowerIncreaseBtn');
      const stopBtn = document.getElementById('stopFollowerIncreaseBtn');
      const pauseBtn = document.getElementById('pauseFollowerIncreaseBtn');
      const skipBtn = document.getElementById('skipFollowerIncreaseBtn');

      if (doneEl) doneEl.textContent = '0';
      if (colEl) colEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (qInd) qInd.textContent = 'Profile 0/0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'GrowthFi history and counters reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      if (startBtn) startBtn.style.display = 'block';
      if (stopBtn) stopBtn.style.display = 'none';
      if (pauseBtn) pauseBtn.style.display = 'none';
      if (skipBtn) skipBtn.style.display = 'none';
      showExtToast('GrowthFi Queue Reset', '🔄');
    });
  });

  // ReplyWave Reset Button
  document.getElementById('resetReplyBackQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove(['atomx_replyback_counters'], () => {
      const doneEl = document.getElementById('replyBackDoneCount');
      const qEl = document.getElementById('replyBackQueueCount');
      const skipEl = document.getElementById('replyBackSkippedCount');
      const bar = document.getElementById('replyBackProgressBar');
      const status = document.getElementById('replyBackLiveStatusText');
      const badge = document.getElementById('replyBackStateBadge');
      const countdown = document.getElementById('replyBackCountdownText');
      if (doneEl) doneEl.textContent = '0';
      if (qEl) qEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'ReplyWave counters reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      showExtToast('ReplyWave Counters Reset', '🔄');
    });
  });

  // Auto Unfollow Reset Button
  document.getElementById('resetUnfollowQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove(['atomx_unfollow_counters'], () => {
      const doneEl = document.getElementById('unfollowCountDone');
      const skipEl = document.getElementById('unfollowCountSkipped');
      const failEl = document.getElementById('unfollowCountFailed');
      const bar = document.getElementById('unfollowProgressBar');
      const status = document.getElementById('unfollowLiveStatusText');
      const badge = document.getElementById('unfollowStateBadge');
      const countdown = document.getElementById('unfollowCountdownText');
      if (doneEl) doneEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (failEl) failEl.textContent = '0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'Unfollow counters and queue reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      showExtToast('Unfollow Counters Reset', '🔄');
    });
  });

  // Reciprocator Reset Button
  document.getElementById('resetReciprocatorQueueBtn')?.addEventListener('click', () => {
    chrome.storage.local.remove(['atomx_reciprocated_commenters', 'atomx_reciprocator_counters'], () => {
      const doneEl = document.getElementById('reciprocatorCountDone');
      const qEl = document.getElementById('reciprocatorCountQueue');
      const skipEl = document.getElementById('reciprocatorCountSkipped');
      const bar = document.getElementById('reciprocatorProgressBar');
      const status = document.getElementById('reciprocatorLiveStatusText');
      const badge = document.getElementById('reciprocatorStateBadge');
      const countdown = document.getElementById('reciprocatorCountdownText');
      if (doneEl) doneEl.textContent = '0';
      if (qEl) qEl.textContent = '0';
      if (skipEl) skipEl.textContent = '0';
      if (bar) bar.style.width = '0%';
      if (status) status.textContent = 'Reciprocator queue, commenters history and counters reset.';
      if (badge) badge.textContent = 'IDLE';
      if (countdown) countdown.style.display = 'none';
      showExtToast('Reciprocator History Reset', '🔄');
    });
  });

  // TG Live Liker Reset Button
  document.getElementById('resetTgLiveLikerBtn')?.addEventListener('click', () => {
    const lEl = document.getElementById('tgLiveCountLiked');
    const rEl = document.getElementById('tgLiveCountReposted');
    const cEl = document.getElementById('tgLiveCountCommented');
    const bEl = document.getElementById('tgLiveCountBookmarked');
    if (lEl) lEl.textContent = '0';
    if (rEl) rEl.textContent = '0';
    if (cEl) cEl.textContent = '0';
    if (bEl) bEl.textContent = '0';
    showExtToast('TG Live Counters Reset', '🔄');
  });

  // Agent 2: Audience Builder List Selection, Delay & Cool-Off
  document.getElementById('audienceListSelect')?.addEventListener('change', (e) => {
    const box = document.getElementById('customListUrlBox');
    if (box) box.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  document.getElementById('customListUrlInput')?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim();
    const listUrl = extractTwitterListUrl(val);
    const badge = document.getElementById('audienceCustomCountBadge');
    if (!badge) return;
    if (listUrl) {
      badge.textContent = '✓ Twitter List URL recognized';
      badge.style.color = '#10B981';
    } else {
      badge.textContent = 'Enter List URL (e.g. x.com/i/lists/...)';
      badge.style.color = 'var(--text-secondary)';
    }
  });

  document.getElementById('audienceDelaySelect')?.addEventListener('change', (e) => {
    const box = document.getElementById('audienceCustomDelayBox');
    if (box) box.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });
  document.getElementById('audienceCooloffSelect')?.addEventListener('change', (e) => {
    const box = document.getElementById('audienceCustomCooloffBox');
    if (box) box.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  // Agent 3: Sorsa Score Booster (CSV Upload, Preset KOLs, Textarea & Dual Mode)
  document.getElementById('sorsaUploadCsvBtn')?.addEventListener('click', () => {
    document.getElementById('sorsaCsvFileInput')?.click();
  });

  document.getElementById('sorsaCsvFileInput')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result || '';
      const lines = String(text).split(/[\r\n,]+/);
      const extracted = lines.map(l => l.replace(/["'@\s]/g, '').trim()).filter(h => /^[A-Za-z0-9_]{1,25}$/.test(h));
      const textarea = document.getElementById('sorsaHandlesInput');
      const hint = document.getElementById('sorsaHandlesHint');
      if (textarea) {
        textarea.style.display = 'block';
        textarea.readOnly = false;
        textarea.value = extracted.map(h => `@${h}`).join(', ');
      }
      if (hint) hint.style.display = 'inline';
      const badge = document.getElementById('sorsaParsedCountBadge');
      if (badge) badge.textContent = `${extracted.length} accounts loaded from CSV`;
      const curSelect = document.getElementById('sorsaCuratedListSelect');
      if (curSelect) curSelect.value = 'custom';
      showExtToast(`Loaded ${extracted.length} handles from CSV`, '📁');
    };
    reader.readAsText(file);
  });

  document.getElementById('sorsaCuratedListSelect')?.addEventListener('change', (e) => {
    loadSorsaCuratedList(e.target.value);
  });

  document.getElementById('sorsaLoadCuratedBtn')?.addEventListener('click', () => {
    const val = document.getElementById('sorsaCuratedListSelect')?.value || 'preset_kols';
    loadSorsaCuratedList(val);
  });

  document.getElementById('sorsaLoadPresetKolsBtn')?.addEventListener('click', () => {
    const val = document.getElementById('sorsaCuratedListSelect')?.value || 'preset_kols';
    loadSorsaCuratedList(val);
  });

  document.getElementById('sorsaHandlesInput')?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim();
    if (extractTwitterListUrl(val)) {
      alert('⚠️ Score Accelerator ONLY accepts .CSV file uploads or usernames (e.g. @cz_binance, @vitalikbuterin).\n\nTwitter List URLs are NOT supported here. Please use CrowdFi or GrowthFi for Twitter List URLs.');
      e.target.value = '';
      const badge = document.getElementById('sorsaParsedCountBadge');
      if (badge) badge.textContent = '0 accounts ready';
      return;
    }
    const handles = val.split(/[\r\n,]+/).map(h => h.replace(/["'@\s]/g, '').trim()).filter(h => /^[A-Za-z0-9_]{1,25}$/.test(h));
    const badge = document.getElementById('sorsaParsedCountBadge');
    if (badge) badge.textContent = handles.length > 0 ? `${handles.length} accounts ready` : '0 accounts ready';
  });

  document.getElementById('sorsaModeSelect')?.addEventListener('change', (e) => {
    const isMode2 = e.target.value === 'deduplication';
    const box = document.getElementById('sorsaDeduplicationWindowBox');
    if (box) box.style.display = isMode2 ? 'block' : 'none';
    const desc = document.getElementById('sorsaModeDescription');
    if (desc) {
      desc.textContent = isMode2
        ? 'Checks each account against your chosen cool-off window, skipping those engaged recently.'
        : 'Remembers your last processed account index and picks up where it left off on every run.';
    }
  });

  document.getElementById('sorsaCooloffSelect')?.addEventListener('change', (e) => {
    const box = document.getElementById('sorsaCustomCooloffBox');
    if (box) box.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  // Agent 4: Followers Growth Twitter List Dropdown & Custom URL
  document.getElementById('followerNicheSelect')?.addEventListener('change', (e) => {
    const box = document.getElementById('customFollowerUrlBox');
    if (box) box.style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  document.getElementById('customFollowerUrlInput')?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim();
    const listUrl = extractTwitterListUrl(val);
    const badge = document.getElementById('followerCustomCountBadge');
    if (!badge) return;
    if (listUrl) {
      badge.textContent = '✓ Twitter List URL recognized';
      badge.style.color = '#10B981';
    } else {
      badge.textContent = 'Enter List URL (e.g. x.com/i/lists/...)';
      badge.style.color = 'var(--text-secondary)';
    }
  });

  document.getElementById('runSorsaBoosterBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('sorsa')) return;
    startSorsaScoreBoosterWorkflow();
  });
  document.getElementById('stopSorsaBoosterBtn')?.addEventListener('click', () => {
    broadcastAbortToAllTabsAndStorage('Score Accelerator');
    if (sorsaWorkingTabId) {
      safeRemoveTab(sorsaWorkingTabId);
      sorsaWorkingTabId = null;
    }
    updateAgentConsole('⏹️ Stopped', 'Score Accelerator stopped by user.');
    const startBtn = document.getElementById('runSorsaBoosterBtn');
    const stopBtn = document.getElementById('stopSorsaBoosterBtn');
    const pauseBtn = document.getElementById('pauseSorsaBoosterBtn');
    const skipBtn = document.getElementById('skipSorsaBoosterBtn');
    const resetBtn = document.getElementById('resetSorsaQueueBtn');
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    const statusText = document.getElementById('sorsaLiveStatusText');
    if (statusText) statusText.textContent = 'Workflow stopped by user.';
    const countdownEl = document.getElementById('sorsaCountdownText');
    if (countdownEl) countdownEl.style.display = 'none';
    const badge = document.getElementById('sorsaStateBadge');
    if (badge) badge.textContent = 'STOPPED';
    showExtToast('Score Accelerator Stopped', '⏹');
  });

  // Agent 4: GrowthFi
  document.getElementById('runFollowerIncreaseBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('followers')) return;
    startFollowersIncreaseWorkflow();
  });
  document.getElementById('stopFollowerIncreaseBtn')?.addEventListener('click', () => {
    broadcastAbortToAllTabsAndStorage('GrowthFi');
    if (followerWorkingTabId) {
      safeRemoveTab(followerWorkingTabId);
      followerWorkingTabId = null;
    }
    updateAgentConsole('⏹️ Stopped', 'GrowthFi stopped by user.');
    const startBtn = document.getElementById('runFollowerIncreaseBtn');
    const stopBtn = document.getElementById('stopFollowerIncreaseBtn');
    const pauseBtn = document.getElementById('pauseFollowerIncreaseBtn');
    const skipBtn = document.getElementById('skipFollowerIncreaseBtn');
    const resetBtn = document.getElementById('resetFollowerQueueBtn');
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    const statusText = document.getElementById('followerLiveStatusText');
    if (statusText) statusText.textContent = 'Workflow stopped by user.';
    const countdownEl = document.getElementById('followerCountdownText');
    if (countdownEl) countdownEl.style.display = 'none';
    const badge = document.getElementById('followerStateBadge');
    if (badge) badge.textContent = 'STOPPED';
    showExtToast('GrowthFi Stopped', '⏹');
  });

  // Agent 6: Reply Back (A6, Posts, Fully Auto)
  document.getElementById('replyBackUseCurrentTabBtn')?.addEventListener('click', async () => {
    try {
      const activeTab = await getActiveTwitterTab();
      if (activeTab?.url && (activeTab.url.includes('twitter.com') || activeTab.url.includes('x.com')) && activeTab.url.includes('/status/')) {
        const cleanUrl = activeTab.url.split('?')[0];
        const in1 = document.getElementById('myTweetUrlInput1');
        const in2 = document.getElementById('myTweetUrlInput2');
        const in3 = document.getElementById('myTweetUrlInput3');
        if (in1 && !in1.value.trim()) {
          in1.value = cleanUrl;
        } else if (in2 && !in2.value.trim()) {
          in2.value = cleanUrl;
        } else if (in3 && !in3.value.trim()) {
          in3.value = cleanUrl;
        } else if (in1) {
          in1.value = cleanUrl;
        }
        showExtToast('Current Post Linked to Reply Back', '⚡');
      } else {
        alert('Please open your tweet/post on Twitter / X in your active browser tab first, or paste the link manually.');
      }
    } catch (e) {
      alert('Please paste your tweet URL into the input field below.');
    }
  });

  document.getElementById('runReplyBackBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('replyback')) return;
    startReplyBackLoopWorkflow();
  });

  document.getElementById('stopReplyBackBtn')?.addEventListener('click', () => {
    broadcastAbortToAllTabsAndStorage('Reply Back');
    if (replyBackWorkingTabId) {
      safeRemoveTab(replyBackWorkingTabId);
      replyBackWorkingTabId = null;
    }
    updateAgentConsole('⏹️ Stopped', 'ReplyWave stopped by user.');
    const startBtn = document.getElementById('runReplyBackBtn');
    const stopBtn = document.getElementById('stopReplyBackBtn');
    const pauseBtn = document.getElementById('pauseReplyBackBtn');
    const skipBtn = document.getElementById('skipReplyBackBtn');
    const resetBtn = document.getElementById('resetReplyBackQueueBtn');
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    const statusText = document.getElementById('replyBackLiveStatusText');
    if (statusText) statusText.textContent = 'Workflow stopped by user.';
    const badge = document.getElementById('replyBackStateBadge');
    if (badge) badge.textContent = 'STOPPED';
    const countdown = document.getElementById('replyBackCountdownText');
    if (countdown) countdown.style.display = 'none';
    showExtToast('ReplyWave Stopped', '⏹');
  });

  // Agent 7: Auto Unfollow (A7, Standalone Safety Optimizer)
  document.getElementById('runAutoUnfollowBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('unfollow')) return;
    startAutoUnfollowWorkflow();
  });

  document.getElementById('stopAutoUnfollowBtn')?.addEventListener('click', () => {
    broadcastAbortToAllTabsAndStorage('Auto Unfollow');
    if (autoUnfollowWorkingTabId) {
    safeSendTabMessage(autoUnfollowWorkingTabId, { type: 'ABORT_WORKFLOW' });
      safeRemoveTab(autoUnfollowWorkingTabId);
      autoUnfollowWorkingTabId = null;
    }
    updateAgentConsole('⏹️ Stopped', 'Auto Unfollow stopped by user.');
    const startBtn = document.getElementById('runAutoUnfollowBtn');
    const stopBtn = document.getElementById('stopAutoUnfollowBtn');
    const pauseBtn = document.getElementById('pauseAutoUnfollowBtn');
    const skipBtn = document.getElementById('skipAutoUnfollowBtn');
    const resetBtn = document.getElementById('resetUnfollowQueueBtn');
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (resetBtn) resetBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    const statusText = document.getElementById('unfollowLiveStatusText');
    if (statusText) statusText.textContent = 'Workflow stopped by user.';
    const badge = document.getElementById('unfollowStateBadge');
    if (badge) badge.textContent = 'STOPPED';
    const countdown = document.getElementById('unfollowCountdownText');
    if (countdown) countdown.style.display = 'none';
    showExtToast('Auto Unfollow Stopped', '⏹');
  });


  // Agent 9: Add Creator
  document.getElementById('addCreatorBtn')?.addEventListener('click', () => {
    const input = document.getElementById('addCreatorInput');
    let val = input ? input.value.trim() : '';
    if (!val) return;
    if (!val.startsWith('@')) val = '@' + val;
    if (!state.creators.includes(val)) {
      state.creators.push(val);
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ creators: state.creators });
      }
      renderCreatorChips();
    }
    input.value = '';
    updateAgentConsole('Radar Updated', `Added creator handle ${val} to high-priority engagement radar.`);
  });

  document.getElementById('runCreatorRadarBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('creators')) return;
    updateAgentConsole('Radar Active', `Monitoring ${state.creators.length} creators for early engagement.`);
    alert(`⚡ CreatorX Active!\nMonitoring ${state.creators.length} VIP accounts.\nThe bot will scan for new posts and notify or comment immediately.`);
  });

  // Agent 11: Find Defaulter Listeners
  document.getElementById('defaulterUseCurrentTabBtn')?.addEventListener('click', async () => {
    try {
      let tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (!tabs || tabs.length === 0 || !tabs[0]?.url) {
        tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      }
      if (!tabs || tabs.length === 0 || !tabs[0]?.url || (!tabs[0].url.includes('/status/'))) {
        const twitterTabs = await chrome.tabs.query({ url: ['*://x.com/*/status/*', '*://twitter.com/*/status/*'] }).catch(() => []);
        if (twitterTabs && twitterTabs.length > 0) {
          tabs = twitterTabs;
        }
      }
      const targetTab = (tabs || []).find(t => t.url && (t.url.includes('twitter.com') || t.url.includes('x.com')) && t.url.includes('/status/')) || tabs?.[0];
      if (targetTab?.url && (targetTab.url.includes('twitter.com') || targetTab.url.includes('x.com')) && targetTab.url.includes('/status/')) {
        const inp = document.getElementById('defaulterPostUrl');
        if (inp) inp.value = targetTab.url.split('?')[0];
        showExtToast('Current Tweet URL Linked', '⚡');
      } else {
        alert('Please open your target tweet on Twitter / X in your active browser tab first.');
      }
    } catch (e) { }
  });

  document.getElementById('defaulterCleanListBtn')?.addEventListener('click', () => {
    const txt = document.getElementById('defaulterExpectedUsers');
    if (!txt) return;
    const handles = parseDefaulterHandles(txt.value);
    if (handles.length === 0) {
      showExtToast('No valid @handles or post links found', '⚠️');
      return;
    }
    txt.value = handles.map(h => '@' + h).join('\n');
    const countBadge = document.getElementById('defaulterExpectedCountBadge');
    if (countBadge) countBadge.textContent = `${handles.length} Members`;
    showExtToast(`Cleaned & Extracted ${handles.length} @handles!`, '🧹');
  });

  document.getElementById('defaulterExpectedUsers')?.addEventListener('input', (e) => {
    const handles = parseDefaulterHandles(e.target.value);
    const countBadge = document.getElementById('defaulterExpectedCountBadge');
    if (countBadge) countBadge.textContent = `${handles.length} Members`;
  });

  document.getElementById('startDefaulterAuditBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('defaulter')) return;
    startDefaulterAuditWorkflow();
  });
  document.getElementById('stopDefaulterAuditBtn')?.addEventListener('click', stopDefaulterAuditWorkflow);
  // Agent 13: Commenter Reciprocator Listeners
  document.getElementById('reciprocatorUseCurrentTabBtn')?.addEventListener('click', async () => {
    try {
      let tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (!tabs || tabs.length === 0 || !tabs[0]?.url) {
        tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      }
      if (!tabs || tabs.length === 0 || !tabs[0]?.url || (!tabs[0].url.includes('/status/'))) {
        const twitterTabs = await chrome.tabs.query({ url: ['*://x.com/*/status/*', '*://twitter.com/*/status/*'] }).catch(() => []);
        if (twitterTabs && twitterTabs.length > 0) {
          tabs = twitterTabs;
        }
      }
      const targetTab = (tabs || []).find(t => t.url && (t.url.includes('twitter.com') || t.url.includes('x.com')) && t.url.includes('/status/')) || tabs?.[0];
      if (targetTab?.url && (targetTab.url.includes('twitter.com') || targetTab.url.includes('x.com')) && targetTab.url.includes('/status/')) {
        const inp = document.getElementById('reciprocatorPostUrl');
        if (inp) inp.value = targetTab.url.split('?')[0];
        showExtToast('Current Tweet URL Linked', '⚡');
      } else {
        alert('Please open your target tweet on Twitter / X in your active browser tab first.');
      }
    } catch (e) { }
  });

  document.getElementById('runReciprocatorBtn')?.addEventListener('click', () => {
    if (!ensureAgentEnabledOrBlock('reciprocator')) return;
    startCommenterReciprocatorWorkflow();
  });
  document.getElementById('stopReciprocatorBtn')?.addEventListener('click', () => {
    broadcastAbortToAllTabsAndStorage('Commenter Reciprocator');
    if (reciprocatorWorkingTabId) {
      safeRemoveTab(reciprocatorWorkingTabId);
      reciprocatorWorkingTabId = null;
    }
    updateAgentConsole('⏹️ Stopped', 'Commenter Reciprocator stopped by user.');
    const startBtn = document.getElementById('runReciprocatorBtn');
    const stopBtn = document.getElementById('stopReciprocatorBtn');
    if (startBtn) startBtn.style.display = 'block';
    if (stopBtn) stopBtn.style.display = 'none';
    const statusText = document.getElementById('reciprocatorLiveStatusText');
    if (statusText) statusText.textContent = 'Workflow stopped by user.';
    const badge = document.getElementById('reciprocatorStateBadge');
    if (badge) badge.textContent = 'STOPPED';
    const countdown = document.getElementById('reciprocatorCountdownText');
    if (countdown) countdown.style.display = 'none';
    showExtToast('Commenter Reciprocator Stopped', '⏹');
  });
}

function renderCreatorChips() {
  const chips = document.getElementById('creatorListChips');
  if (!chips) return;
  chips.innerHTML = '';
  if (!state.creators || state.creators.length === 0) {
    chips.innerHTML = '<span style="font-size:11px; color:var(--text-muted); font-style:italic;">No creators added yet. Add a handle above to track.</span>';
    return;
  }
  state.creators.forEach((val, idx) => {
    const chip = document.createElement('span');
    chip.className = 'creator-chip';
    chip.textContent = `${val} ✕`;
    chip.onclick = () => {
      state.creators.splice(idx, 1);
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({ creators: state.creators });
      }
      renderCreatorChips();
    };
    chips.appendChild(chip);
  });
}

// =========================================================================
// AGENT 11: FIND DEFAULTERS AUDIT WORKFLOW
// =========================================================================
function parseDefaulterHandles(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const clean = new Set();
  const RESERVED_WORDS = new Set([
    'http', 'https', 'x', 'com', 'org', 'net', 'io', 'app', 'twitter',
    'status', 'statuses', 'home', 'explore', 'notifications', 'messages',
    'i', 'compose', 'settings', 'search', 'hashtag', 'intent', 'post',
    'posts', 'tweet', 'tweets', 'link', 'links', 'telegram', 't', 'me',
    'joinchat', 'photo', 'video', 'analytics', 'following', 'followers', 'verified',
    'bot', 'ape_bot', 'apebot', 'reply', 'replies', 'in', 'to', 'engage', 'with',
    'vip', 'star', 'raid', 'raids', 'member', 'members', 'admin', 'mod',
    'done', 'please', 'check', 'good', 'morning', 'night', 'support', 'great',
    'today', 'here', 'project', 'together', 'everyone', 'rules', 'pinned', 'message',
    'like', 'comment', 'retweet', 'repost', 'follow', 'thanks', 'thank', 'welcome',
    'have', 'from', 'this', 'that', 'they', 'what', 'when', 'where', 'your', 'my'
  ]);

  // Stage 1: High-Priority — Extract usernames from x.com or twitter.com post/profile URLs
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,25})(?:\/status\/\d+|\/photo|\/video|\/?\b)/gi;
  let match;
  while ((match = urlRegex.exec(raw)) !== null) {
    const handle = match[1].toLowerCase().trim();
    if (handle && !RESERVED_WORDS.has(handle) && !/^\d+$/.test(handle)) {
      clean.add(handle);
    }
  }

  // Remove URLs before scanning remaining raw text
  const textWithoutUrls = raw.replace(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[^\s\n\r]*/gi, ' ');

  // Stage 2: Extract explicit @handles (e.g. @reduansheikh11, @Bharnij, @fepz_)
  const atRegex = /@([A-Za-z0-9_]{1,25})\b/g;
  while ((match = atRegex.exec(textWithoutUrls)) !== null) {
    const handle = match[1].toLowerCase().trim();
    if (handle && !RESERVED_WORDS.has(handle) && !/^\d+$/.test(handle)) {
      clean.add(handle);
    }
  }

  // Stage 3: If NO explicit @handles or URLs found, process structured lists (one handle per line or comma-separated)
  // Only accept tokens if the line is NOT a conversational sentence
  if (clean.size === 0) {
    const lines = textWithoutUrls.split(/[\r\n]+/);
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      // Skip telegram timestamps or quote reply lines
      if (/^\[\d{1,2}-[A-Za-z]{3}-\d{2,4}/.test(line) || line.startsWith('>')) continue;

      // Clean bot labels, numbering, badges
      const cleanLine = line
        .replace(/#\d+\b/g, '')
        .replace(/^\d+[\.\)\-:\s]+/g, '')
        .replace(/[★☆💹🔥✨🔴•\-]/g, '')
        .trim();

      const words = cleanLine.split(/\s+/).filter(Boolean);
      // Conversational safeguard: If a line has 4+ English words, it's a message, not a handle list!
      if (words.length > 3) continue;

      const tokens = cleanLine.split(/[\s,;|]+/);
      for (const token of tokens) {
        const h = token.replace(/^@/, '').toLowerCase().trim();
        if (/^[a-z0-9_]{3,25}$/.test(h) && !RESERVED_WORDS.has(h) && !/^\d+$/.test(h)) {
          clean.add(h);
        }
      }
    }
  }

  return Array.from(clean);
}

let defaulterActiveTabId = null;

async function startDefaulterAuditWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  if (state.credits < 1) {
    alert(`⚠️ Insufficient credits!\nYou need 1 credit to audit post comments and find defaulters, but you have ${state.credits}.\nPlease top up credits in the Credits tab.`);
    switchExtTab('credits');
    return;
  }

  const postUrlInput = document.getElementById('defaulterPostUrl');
  let postUrl = postUrlInput ? postUrlInput.value.trim() : '';

  if (!postUrl || (!postUrl.includes('twitter.com') && !postUrl.includes('x.com'))) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (tabs && tabs[0]?.url && (tabs[0].url.includes('twitter.com') || tabs[0].url.includes('x.com')) && tabs[0].url.includes('/status/')) {
      postUrl = tabs[0].url.split('?')[0];
      if (postUrlInput) postUrlInput.value = postUrl;
    } else {
      alert('Please enter a valid tweet URL (e.g. https://x.com/username/status/123456...) or navigate to it in your active tab.');
      return;
    }
  }

  const rawUsers = document.getElementById('defaulterExpectedUsers')?.value || '';
  const expectedHandles = parseDefaulterHandles(rawUsers);

  if (expectedHandles.length === 0) {
    alert('Please paste or list the expected Telegram group members or usernames to check against.');
    return;
  }

  const startBtn = document.getElementById('startDefaulterAuditBtn');
  const stopBtn = document.getElementById('stopDefaulterAuditBtn');
  const resultsCard = document.getElementById('defaulterResultsCard');
  const heading = document.getElementById('defaulterResultsHeading');
  const statExp = document.getElementById('defaulterStatExpected');
  const statCom = document.getElementById('defaulterStatCommented');
  const statDef = document.getElementById('defaulterStatDefaulters');
  const summaryEl = document.getElementById('defaulterSummaryText');
  const copyBox = document.getElementById('defaulterCopyBox');
  const copyBoxContainer = document.getElementById('defaulterCopyBoxContainer');
  const copyMainBtn = document.getElementById('copyDefaultersMainBtn');
  const chipsContainer = document.getElementById('defaulterChipsContainer');
  const copyBtn = document.getElementById('copyDefaultersBtn');

  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'block';
  if (resultsCard) resultsCard.style.display = 'block';
  if (heading) heading.textContent = 'Scanning comments & expanding spam replies...';
  if (statExp) statExp.textContent = String(expectedHandles.length);
  if (statCom) statCom.textContent = '...';
  if (statDef) statDef.textContent = '...';
  if (summaryEl) summaryEl.textContent = 'Scrolling post comments till end & checking probable spam... Please wait.';
  if (copyBoxContainer) copyBoxContainer.style.display = 'none';
  if (chipsContainer) chipsContainer.innerHTML = '<span style="font-size:11px; color:var(--text-muted); padding:6px;">Auditing comment replies in background... Please wait ~15-30s.</span>';
  if (copyBtn) copyBtn.style.display = 'none';

  updateAgentConsole('Audit Running', `Scanning comments on: ${postUrl}`);
  state.isAborted = false;

  try {
    const tabId = await getOrCreateReusedTab(defaulterActiveTabId, postUrl);
    defaulterActiveTabId = tabId;
    await waitForTabComplete(tabId);
    await sleep(3000);

    if (state.isAborted) return;

    const auditRes = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'AUDIT_POST_DEFAULTERS', maxScrolls: 100 }, (res) => resolve(res || { success: false, commenters: [] }));
    });

    if (state.isAborted) {
      if (heading) heading.textContent = 'Audit Stopped by User';
      return;
    }

    const commentersSet = new Set((auditRes.commenters || []).map(c => c.toLowerCase()));
    const mainAuthor = (auditRes.mainAuthor || '').toLowerCase();

    // Defaulters: in expected list, but did NOT comment (and not the post author)
    const defaulters = expectedHandles.filter(h => !commentersSet.has(h) && h !== mainAuthor);
    const compliant = expectedHandles.filter(h => commentersSet.has(h));

    // Deduct 1 credit for successful audit (Rule: 1 scan = 1 credit)
    deductCredits(1, 'Find Defaulters', 'Audit post comments');

    if (heading) heading.textContent = `Audit Complete — Found ${defaulters.length} Defaulter${defaulters.length === 1 ? '' : 's'}`;
    if (statExp) statExp.textContent = String(expectedHandles.length);
    if (statCom) statCom.textContent = String(compliant.length);
    if (statDef) statDef.textContent = String(defaulters.length);

    if (summaryEl) {
      if (defaulters.length === 0) {
        summaryEl.innerHTML = '<span style="color:#10B981; font-weight:700;">🎉 100% Compliant! All ' + expectedHandles.length + ' group members commented on your post!</span>';
      } else {
        summaryEl.innerHTML = `<strong>${defaulters.length}</strong> out of <strong>${expectedHandles.length}</strong> members failed to comment on this post. (<strong>${compliant.length}</strong> commented).`;
      }
    }

    // Populate Defaulters Copy Box
    if (copyBox && copyBoxContainer) {
      if (defaulters.length > 0) {
        copyBoxContainer.style.display = 'flex';
        copyBox.value = defaulters.map(d => `@${d}`).join(' ');
        copyBox.onclick = () => {
          copyBox.select();
          navigator.clipboard?.writeText(copyBox.value);
          showExtToast(`Copied ${defaulters.length} Defaulters!`, '📋');
        };
      } else {
        copyBoxContainer.style.display = 'none';
      }
    }

    // Setup 1-Click Copy Buttons
    const handleCopyAll = () => {
      const textToCopy = defaulters.map(d => `@${d}`).join(' ');
      navigator.clipboard?.writeText(textToCopy);
      if (copyMainBtn) copyMainBtn.textContent = '✓ COPIED TO CLIPBOARD!';
      setTimeout(() => { if (copyMainBtn) copyMainBtn.textContent = '📋 COPY DEFAULTERS LIST'; }, 2000);
      showExtToast(`Copied ${defaulters.length} defaulters to clipboard`, '📋');
    };

    if (copyMainBtn && defaulters.length > 0) {
      copyMainBtn.onclick = handleCopyAll;
    }

    if (copyBtn && defaulters.length > 0) {
      copyBtn.style.display = 'block';
      copyBtn.onclick = handleCopyAll;
    }

    if (chipsContainer) {
      chipsContainer.innerHTML = '';
      if (defaulters.length === 0) {
        chipsContainer.innerHTML = '<span style="font-size:11px; color:#10B981; font-weight:700; padding:6px;">🎉 100% Compliant! Zero defaulters detected.</span>';
      } else {
        defaulters.forEach(d => {
          const badge = document.createElement('span');
          badge.className = 'badge-mini';
          badge.style.cssText = 'background:rgba(239, 68, 68, 0.15); color:#EF4444; border:1px solid rgba(239, 68, 68, 0.3); font-weight:700; cursor:pointer;';
          badge.textContent = `@${d}`;
          badge.title = 'Click to copy handle';
          badge.onclick = () => {
            navigator.clipboard?.writeText(`@${d}`);
            showExtToast(`Copied @${d}`, '📋');
          };
          chipsContainer.appendChild(badge);
        });
      }
    }

    updateAgentConsole('Audit Finished', `Found ${defaulters.length} defaulters out of ${expectedHandles.length} members. 5 credits deducted.`);
    showExtToast(`Audit Complete (${defaulters.length} Defaulters)`, '🔍');

  } catch (err) {
    console.error('Defaulter audit error:', err);
    if (heading) heading.textContent = 'Audit Failed: ' + (err.message || 'Error');
    if (defaulterActiveTabId) {
      safeRemoveTab(defaulterActiveTabId);
      defaulterActiveTabId = null;
    }
  } finally {
    if (startBtn) startBtn.style.display = 'block';
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

function stopDefaulterAuditWorkflow() {
  state.isAborted = true;
  if (defaulterActiveTabId) {
    safeRemoveTab(defaulterActiveTabId);
    defaulterActiveTabId = null;
  }
  const startBtn = document.getElementById('startDefaulterAuditBtn');
  const stopBtn = document.getElementById('stopDefaulterAuditBtn');
  if (startBtn) startBtn.style.display = 'block';
  if (stopBtn) stopBtn.style.display = 'none';
  showExtToast('Audit stopped by user', '⏹');
}

function stopTgLiveRaidWorkflow() {
  state.isAborted = true;
  const startBtn = document.getElementById('startTgLiveRaidBtn');
  const stopBtn = document.getElementById('stopTgLiveRaidBtn');
  if (startBtn) startBtn.style.display = 'block';
  if (stopBtn) stopBtn.style.display = 'none';
  const statusText = document.getElementById('tgLiveStatusText');
  if (statusText) statusText.textContent = 'Raid stopped by user. Tab is left open.';
  showExtToast('Live raid stopped (tab left open)', '⏹');
}

// =========================================================================
// AGENT 13: COMMENTER RECIPROCATOR WORKFLOW ENGINE
// =========================================================================
async function startCommenterReciprocatorWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  const postUrlInput = document.getElementById('reciprocatorPostUrl');
  let postUrl = postUrlInput ? postUrlInput.value.trim() : '';

  if (!postUrl || (!postUrl.includes('twitter.com') && !postUrl.includes('x.com'))) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (tabs && tabs[0]?.url && (tabs[0].url.includes('twitter.com') || tabs[0].url.includes('x.com')) && tabs[0].url.includes('/status/')) {
      postUrl = tabs[0].url.split('?')[0];
      if (postUrlInput) postUrlInput.value = postUrl;
    } else {
      alert('⚠️ Please enter a valid tweet URL (e.g. https://x.com/yourhandle/status/18420958...) or open it in your active tab.');
      return;
    }
  }

  if (state.credits < 1) {
    alert('⚠️ Insufficient credits!\nYou need at least 1 credit to reciprocate and comment on commenters\' posts.\nPlease top up in the Credits tab.');
    switchExtTab('credits');
    return;
  }

  const maxCount = Number(document.getElementById('reciprocatorMaxCount')?.value || 10);
  const postsCount = document.getElementById('reciprocatorPostsPerProfileSelect')?.value || 'random';
  const tone = state.selectedTone || 'Bullish (5-10 words)';
  const tonePrompt = state.selectedTonePrompt || '';
  const optLike = document.getElementById('reciprocatorOptLike')?.checked ?? true;
  const optComment = document.getElementById('reciprocatorOptComment')?.checked ?? true;
  const optRepost = document.getElementById('reciprocatorOptRepost')?.checked ?? false;
  const optFollow = document.getElementById('reciprocatorOptFollow')?.checked ?? false;

  if (!optLike && !optComment && !optRepost && !optFollow) {
    alert('⚠️ Please select at least one engagement action (Like, Comment, Repost, or Follow).');
    return;
  }

  const startBtn = document.getElementById('runReciprocatorBtn');
  const stopBtn = document.getElementById('stopReciprocatorBtn');
  const progressCard = document.getElementById('reciprocatorProgressCard');
  const stateBadge = document.getElementById('reciprocatorStateBadge');
  const queueIndicator = document.getElementById('reciprocatorQueueIndicator');
  const barEl = document.getElementById('reciprocatorProgressBar');
  const doneEl = document.getElementById('reciprocatorCountDone');
  const queueEl = document.getElementById('reciprocatorCountQueue');
  const skipEl = document.getElementById('reciprocatorCountSkipped');
  const statusText = document.getElementById('reciprocatorLiveStatusText');
  const countdownEl = document.getElementById('reciprocatorCountdownText');

  state.isAborted = false;
  state.isWorkflowRunning = true;
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (progressCard) progressCard.style.display = 'block';

  if (stateBadge) stateBadge.textContent = 'SCANNING';
  if (doneEl) doneEl.textContent = '0';
  if (queueEl) queueEl.textContent = String(maxCount);
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '5%';
  if (countdownEl) countdownEl.style.display = 'none';
  if (queueIndicator) queueIndicator.textContent = `Commenter 0/${maxCount}`;
  if (statusText) statusText.textContent = `Accessing post: ${postUrl}... Liking unliked comments & collecting profiles.`;

  syncFloatingHud(null, {
    title: 'Commenter Reciprocator',
    stateBadge: 'SCANNING',
    indicator: `Commenter 0/${maxCount}`,
    done: 0,
    collected: maxCount,
    skipped: 0,
    progressPercent: 5,
    statusText: `Accessing post: ${postUrl}... Liking unliked comments & collecting profiles.`
  });

  // Delegate immediately to background service worker — survives extension popup closing!
  const backendUrl = await getBackendUrl();
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = activeTabs && activeTabs[0]?.id;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'reciprocator',
    title: 'Commenter Reciprocator',
    tabId,
    items: [],
    options: {
      postUrl,
      maxCount,
      postsCount,
      postsPerProfile: postsCount,
      likePosts: optLike,
      replyPosts: optComment,
      repostPosts: optRepost,
      followPosts: optFollow,
      likeRecent: optLike,
      commentRecent: optComment,
      followUser: optFollow,
      style: tone,
      stylePrompt: tonePrompt,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  });
}

// =========================================================================
// AGENT 14: HOME FEED ENGAGER WORKFLOW ENGINE (x.com/home with Ad Skip)
// =========================================================================
async function startHomeFeedEngagerWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  const targetCount = Math.max(1, Number(document.getElementById('feedTargetCountInput')?.value || 10));
  const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
  const pacingDelaySec = Math.max(5, Number(safetyRes?.atomx_safety_settings?.replyDelay) || 10);

  const optLike = document.getElementById('feedOptLike')?.checked ?? true;
  const optComment = document.getElementById('feedOptComment')?.checked ?? true;
  const optRepost = document.getElementById('feedOptRepost')?.checked ?? false;
  const optFollow = document.getElementById('feedOptFollow')?.checked ?? false;

  if (!optLike && !optComment && !optRepost && !optFollow) {
    showExtToast('Select at least one action (Like, Comment, Repost, or Follow)', '⚠️');
    return;
  }

  const startBtn = document.getElementById('runFeedEngagerBtn');
  const stopBtn = document.getElementById('stopFeedEngagerBtn');
  const pauseBtn = document.getElementById('pauseFeedEngagerBtn');
  const skipBtn = document.getElementById('skipFeedEngagerBtn');
  const progressCard = document.getElementById('feedEngagerProgressCard');
  const stateBadge = document.getElementById('feedEngagerStateBadge');
  const queueIndicator = document.getElementById('feedEngagerQueueIndicator');
  const barEl = document.getElementById('feedEngagerProgressBar');
  const doneEl = document.getElementById('feedEngagerCountDone');
  const queueEl = document.getElementById('feedEngagerCountQueue');
  const skipEl = document.getElementById('feedEngagerCountSkipped');
  const statusText = document.getElementById('feedEngagerLiveStatusText');
  const countdownEl = document.getElementById('feedEngagerCountdownText');

  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  if (pauseBtn) pauseBtn.style.display = 'inline-flex';
  if (skipBtn) skipBtn.style.display = 'inline-flex';
  if (progressCard) progressCard.style.display = 'block';

  if (stateBadge) stateBadge.textContent = 'SCANNING';
  if (doneEl) doneEl.textContent = '0';
  if (queueEl) queueEl.textContent = String(targetCount);
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '5%';
  if (countdownEl) countdownEl.style.display = 'none';
  if (queueIndicator) queueIndicator.textContent = `Post 0/${targetCount}`;
  if (statusText) statusText.textContent = 'Opening Home Timeline (x.com/home)... Filtering Ads & scanning posts.';

  syncFloatingHud(null, {
    title: 'Home Feed Engager',
    stateBadge: 'SCANNING',
    indicator: `Post 0/${targetCount}`,
    done: 0,
    collected: targetCount,
    skipped: 0,
    progressPercent: 5,
    statusText: 'Opening Home Timeline (x.com/home)... Filtering Ads & scanning posts.'
  });

  const backendUrl = await getBackendUrl();
  const twTab = await getActiveTwitterTab();
  const tabId = twTab?.id;

  const tone = state.selectedTone || 'Bullish (5-10 words)';
  const tonePrompt = state.selectedTonePrompt || null;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'feedengager',
    title: 'Home Feed Engager',
    tabId,
    items: [],
    options: {
      targetCount,
      pacingDelaySec,
      likePosts: optLike,
      commentPosts: optComment,
      repostPosts: optRepost,
      followPosts: optFollow,
      style: tone,
      stylePrompt: tonePrompt,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  });
}

// =========================================================================
// AGENT 15: NICHE SEARCH ENGAGER WORKFLOW ENGINE (x.com/search with Ad Skip)
// =========================================================================
async function startNicheSearchEngagerWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  const keyword = (document.getElementById('nicheKeywordInput')?.value || '').trim();
  if (!keyword) {
    showExtToast('Please enter a niche keyword or topic (e.g. "follow for follow")', '⚠️');
    return;
  }

  const targetCount = Math.max(1, Number(document.getElementById('nicheTargetCountInput')?.value || 10));
  const feedFilter = document.getElementById('nicheFeedFilterSelect')?.value || 'live';
  const nicheSafetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
  const pacingDelaySec = Math.max(5, Number(nicheSafetyRes?.atomx_safety_settings?.replyDelay) || 10);

  const optLike = document.getElementById('nicheOptLike')?.checked ?? true;
  const optComment = document.getElementById('nicheOptComment')?.checked ?? true;
  const optRepost = document.getElementById('nicheOptRepost')?.checked ?? false;
  const optFollow = document.getElementById('nicheOptFollow')?.checked ?? false;

  if (!optLike && !optComment && !optRepost && !optFollow) {
    showExtToast('Select at least one action (Like, Comment, Repost, or Follow)', '⚠️');
    return;
  }

  const startBtn = document.getElementById('runNicheEngagerBtn');
  const stopBtn = document.getElementById('stopNicheEngagerBtn');
  const pauseBtn = document.getElementById('pauseNicheEngagerBtn');
  const skipBtn = document.getElementById('skipNicheEngagerBtn');
  const progressCard = document.getElementById('nicheEngagerProgressCard');
  const stateBadge = document.getElementById('nicheEngagerStateBadge');
  const queueIndicator = document.getElementById('nicheEngagerQueueIndicator');
  const barEl = document.getElementById('nicheEngagerProgressBar');
  const doneEl = document.getElementById('nicheEngagerCountDone');
  const queueEl = document.getElementById('nicheEngagerCountQueue');
  const skipEl = document.getElementById('nicheEngagerCountSkipped');
  const statusText = document.getElementById('nicheEngagerLiveStatusText');
  const countdownEl = document.getElementById('nicheEngagerCountdownText');

  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  if (pauseBtn) pauseBtn.style.display = 'inline-flex';
  if (skipBtn) skipBtn.style.display = 'inline-flex';
  if (progressCard) progressCard.style.display = 'block';

  if (stateBadge) stateBadge.textContent = 'SCANNING';
  if (doneEl) doneEl.textContent = '0';
  if (queueEl) queueEl.textContent = String(targetCount);
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '5%';
  if (countdownEl) countdownEl.style.display = 'none';
  if (queueIndicator) queueIndicator.textContent = `Post 0/${targetCount}`;
  if (statusText) statusText.textContent = `Searching X for "${keyword}"... Filtering Ads & scanning posts.`;

  syncFloatingHud(null, {
    title: 'Niche Search Engager',
    stateBadge: 'SCANNING',
    indicator: `Post 0/${targetCount}`,
    done: 0,
    collected: targetCount,
    skipped: 0,
    progressPercent: 5,
    statusText: `Searching X for "${keyword}"... Filtering Ads & scanning posts.`
  });

  const backendUrl = await getBackendUrl();
  const twTab = await getActiveTwitterTab();
  const tabId = twTab?.id;

  const tone = state.selectedTone || 'Bullish (5-10 words)';
  const tonePrompt = state.selectedTonePrompt || null;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'nicheengager',
    title: 'Niche Search Engager',
    tabId,
    items: [],
    options: {
      keyword,
      feedMode: feedFilter,
      targetCount,
      pacingDelaySec,
      likePosts: optLike,
      commentPosts: optComment,
      repostPosts: optRepost,
      followPosts: optFollow,
      style: tone,
      stylePrompt: tonePrompt,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  });
}

// =========================================================================
// AGENT 16: TG LIKER WORKFLOW ENGINE (MASS RAID, REPOSTS & QUOTES ENGAGER)
// =========================================================================
const TGL_RESERVED_HANDLES = new Set(['home', 'i', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose',
  'intent', 'hashtag', 'login', 'signup', 'tos', 'privacy', 'jobs', 'share', 'account', 'lists',
  'communities', 'premium', 'grok', 'about']);

function parseTgLikerTargets(raw) {
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

  // 2) profile link (x.com/username or x.com/username/reposts)
  const reProfile = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})((?:\/[^\s]*)?)/gi;
  while ((m = reProfile.exec(text)) !== null) {
    const handle = m[1];
    const rest = (m[2] || '').toLowerCase();
    if (TGL_RESERVED_HANDLES.has(handle.toLowerCase())) continue;
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

function buildTgLikerTarget(t, section) {
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

// =========================================================================
// TG LIKER: STOP AT POST & SCROLL RECORDER LOGIC
// =========================================================================

function buildTgLikerStop() {
  const stopInput = document.getElementById('tgLikerStopText');
  const pickInput = document.getElementById('tgLikerStopPick');
  const raw = (stopInput?.value || '').trim();
  if (!raw) return null;
  try {
    const pk = JSON.parse(pickInput?.value || 'null');
    if (pk && pk.label === raw && (pk.id || pk.handle)) {
      return { id: pk.id || null, handle: pk.handle || '', text: pk.text || '' };
    }
  } catch (e) {}
  const ms = raw.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/i);
  if (ms) return { id: ms[2], handle: ms[1], text: '' };
  let nth = 1, body = raw;
  const mn = body.match(/\s#(\d{1,2})\s*$/);
  if (mn) { nth = Math.max(1, parseInt(mn[1], 10)); body = body.slice(0, mn.index).trim(); }
  const mh = body.match(/^@([A-Za-z0-9_]{1,15})\s*(.*)$/s);
  if (mh) return { id: null, handle: mh[1], text: mh[2].replace(/^[\s\-\u2013\u2014|:\u00b7]+/, '').trim(), nth };
  return { id: null, handle: '', text: body, nth };
}

async function pickTgLikerStop() {
  const stopInfo = document.getElementById('tgLikerStopInfo');
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const t = tabs && tabs[0];
  if (!t || !/^https:\/\/(x|twitter)\.com\//i.test(t.url || '')) {
    if (stopInfo) stopInfo.textContent = '⚠ Age X tab e jao (jekhane post ta dekha jay), tarpor Pick chapo.';
    return;
  }
  chrome.tabs.sendMessage(t.id, { type: 'pickstop' }, (r) => {
    if (chrome.runtime.lastError || !r) {
      if (stopInfo) stopInfo.textContent = '⚠ Page e extension load hoyni — X tab ta F5 diye abar Pick chapo.';
      return;
    }
    if (stopInfo) stopInfo.textContent = '👆 X page e jei post e thamte chao oi post e click koro (Esc = cancel).';
  });
}

// ── Scroll Recorder (Screen capture, audio context, smooth scroll up & auto save) ──
const TGL_RK = 'atomx_tgl_rec';
const tglRec = { active: false, stream: null, castStop: null, actx: null, mr: null, chunks: [], mime: '', ext: 'webm', tabId: null, t0: 0, timer: null, stopping: false };
const TGL_MIMES = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/mp4;codecs=avc1.640028', 'mp4'],
  ['video/mp4;codecs=avc1', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm']
];

function tglRecStatus(t) {
  const el = document.getElementById('tgLikerRecStatus');
  if (el) el.textContent = t;
}

function tglRecUI() {
  const startBtn = document.getElementById('tgLikerBtnRecStart');
  const stopBtn = document.getElementById('tgLikerBtnRecStop');
  const pace = document.getElementById('tgLikerRecPace');
  const source = document.getElementById('tgLikerRecSource');
  const folder = document.getElementById('tgLikerRecFolder');
  if (startBtn) startBtn.style.display = tglRec.active ? 'none' : 'flex';
  if (stopBtn) stopBtn.style.display = tglRec.active ? 'flex' : 'none';
  if (pace) pace.disabled = tglRec.active;
  if (source) source.disabled = tglRec.active;
  if (folder) folder.disabled = tglRec.active;
}

async function tglRecLoad() {
  const d = await chrome.storage.local.get([TGL_RK, 'atomx_tgliker_stoppick']).catch(() => ({}));
  const f = d[TGL_RK];
  if (f) {
    if (f.pace && document.getElementById('tgLikerRecPace')) document.getElementById('tgLikerRecPace').value = f.pace;
    if (f.source && document.getElementById('tgLikerRecSource')) document.getElementById('tgLikerRecSource').value = f.source;
    if (f.folder && document.getElementById('tgLikerRecFolder')) document.getElementById('tgLikerRecFolder').value = f.folder;
  }
  const pk = d.atomx_tgliker_stoppick;
  if (pk) {
    const pickInput = document.getElementById('tgLikerStopPick');
    const stopInput = document.getElementById('tgLikerStopText');
    const stopInfo = document.getElementById('tgLikerStopInfo');
    if (pickInput) pickInput.value = JSON.stringify(pk);
    if (stopInput && !stopInput.value) stopInput.value = pk.label || '';
    if (stopInfo && pk.label) stopInfo.textContent = '✓ Stop point set: ' + pk.label;
  }
}

function tglRecSavePrefs() {
  const pace = document.getElementById('tgLikerRecPace')?.value || 'normal';
  const source = document.getElementById('tgLikerRecSource')?.value || 'auto';
  const folder = document.getElementById('tgLikerRecFolder')?.value || 'TG-LIKER';
  chrome.storage.local.set({ [TGL_RK]: { pace, source, folder } });
}

function tglRecFinalize(reason) {
  if (!tglRec.active || tglRec.stopping) return;
  tglRec.stopping = true;
  clearInterval(tglRec.timer);
  if (tglRec.tabId != null) {
    chrome.tabs.sendMessage(tglRec.tabId, { type: 'recabort' }, () => void chrome.runtime.lastError);
  }
  tglRecStatus('💾 Video save hochche...');
  const mr = tglRec.mr;
  if (mr && mr.state !== 'inactive') {
    try { mr.requestData(); } catch (e) {}
    try { mr.stop(); } catch (e) {}
  } else {
    tglRecSave(reason);
  }
}

async function tglRecSave(reason) {
  try {
    if (tglRec.stream) {
      if (tglRec.castStop) { tglRec.castStop(); tglRec.castStop = null; }
      tglRec.stream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {}
  try {
    if (tglRec.actx) tglRec.actx.close();
    tglRec.actx = null;
  } catch (e) {}

  const blob = new Blob(tglRec.chunks, { type: tglRec.mime.split(';')[0] || 'video/webm' });
  const ext = tglRec.ext;
  tglRec.chunks = [];
  tglRec.active = false;
  tglRec.stopping = false;
  tglRec.stream = null;
  tglRec.mr = null;
  tglRec.tabId = null;
  tglRecUI();

  if (!blob.size) {
    tglRecStatus('⚠ Video khali — save hoyni.');
    return;
  }

  const url = URL.createObjectURL(blob);
  const d = new Date();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h12 = d.getHours() % 12 || 12, mm = String(d.getMinutes()).padStart(2, '0'), ap = d.getHours() >= 12 ? 'PM' : 'AM';
  const stamp = `${h12}.${mm} ${ap} ${d.getDate()} ${MON[d.getMonth()]}`;
  const who = (tglRec.who || 'x').replace(/[^A-Za-z0-9_]/g, '') || 'x';
  const folderInput = document.getElementById('tgLikerRecFolder')?.value || 'TG-LIKER';
  const folder = folderInput.replace(/\\/g, '/').split('/').map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '').trim()).filter((s) => s && s !== '.' && s !== '..').join('/') || 'TG-LIKER';
  const filename = `${folder}/${who} ${stamp}.${ext}`;
  const mb = (blob.size / 1048576).toFixed(1);

  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    tglRecStatus(`✓ Video saved (${mb} MB) — Downloads/${folder} e${reason ? ' • ' + reason : ''}`);
  } catch (e) {
    try {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
      tglRecStatus(`✓ Video saved (${mb} MB) — Downloads/${folder} e${reason ? ' • ' + reason : ''}`);
    } catch (e2) {
      tglRecStatus('⚠ Save fail: ' + ((e2 && e2.message) || e2));
      return;
    }
  }
  setTimeout(() => URL.revokeObjectURL(url), 15 * 60 * 1000);
}

// Screencast stream from background debugger
async function tglScreencastStream(tabId) {
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

function tglFmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function tglRecStart() {
  if (tglRec.active) return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const tab = tabs && tabs[0];
  if (!tab || !/^https:\/\/(x|twitter)\.com\//i.test(tab.url || '')) {
    tglRecStatus('⚠ Age X (x.com) tab e jao, jekhan theke scroll shuru korbe sekhane thako, tarpor abar chap.');
    return;
  }
  let stream = null, direct = false, castStop = null;
  const sourceMode = document.getElementById('tgLikerRecSource')?.value || 'auto';
  const askMode = sourceMode === 'ask';

  // 0) Auto mode: debugger screencast
  if (!askMode) {
    try {
      stream = await tglScreencastStream(tab.id);
      castStop = stream.__tglStop;
      direct = true;
    } catch (e) {
      stream = null;
      tglRecStatus('Screencast hoyni (' + ((e && e.message) || e) + ') — tabCapture try hochche...');
    }
  }

  // 1) Fallback: tabCapture
  if (!stream && !askMode) {
    try {
      const idr = await chrome.runtime.sendMessage({ type: 'tabstream', tabId: tab.id });
      if (idr && idr.ok && idr.id) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: idr.id, maxFrameRate: 60 } }
        });
        direct = true;
      }
    } catch (e) { stream = null; }
  }

  // 2) Chrome picker
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 }, displaySurface: 'browser' },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        preferCurrentTab: false
      });
    } catch (e) {
      tglRecStatus('⚠ Record shuru hoyni: ' + ((e && e.message) || e));
      return;
    }
  }

  // Silent audio track for Telegram real video support
  let actx = null;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = actx.createOscillator(), gain = actx.createGain(), dest = actx.createMediaStreamDestination();
    gain.gain.value = 0; osc.connect(gain); gain.connect(dest); osc.start();
    stream = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  } catch (e) { actx = null; }

  let ext = 'webm', mime = '';
  for (const [m, e] of TGL_MIMES) {
    if (MediaRecorder.isTypeSupported(m)) { mime = m; ext = e; break; }
  }

  const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8000000 });
  let who = '';
  try {
    const rawTarget = document.getElementById('tgLikerTargetInput')?.value || '';
    const a = parseTgLikerTargets(rawTarget).find((t) => t.handle) || parseTgLikerTargets(tab.url).find((t) => t.handle);
    who = a ? a.handle : '';
  } catch (e) {}

  Object.assign(tglRec, { who, active: true, stream, castStop, actx, mr, chunks: [], mime, ext, tabId: tab.id, t0: Date.now(), stopping: false });
  mr.ondataavailable = (e) => { if (e.data && e.data.size) tglRec.chunks.push(e.data); };
  mr.onstop = () => tglRecSave('');
  stream.getVideoTracks()[0].addEventListener('ended', () => tglRecFinalize('sharing bondho kora hoyechilo'));
  mr.start(1000);
  tglRecUI();

  tglRec.timer = setInterval(() => {
    tglRecStatus(`🔴 Recording${direct ? ' (current tab)' : ''} ${tglFmtTime((Date.now() - tglRec.t0) / 1000)} — scroll hochche...`);
  }, 500);

  await new Promise((r) => setTimeout(r, 700));
  const send = () => new Promise((resolve) => {
    const paceVal = document.getElementById('tgLikerRecPace')?.value || 'normal';
    chrome.tabs.sendMessage(tab.id, { type: 'recscroll', pace: paceVal }, (r) => {
      if (chrome.runtime.lastError) resolve(null); else resolve(r || { ok: false });
    });
  });
  let r = await send();
  if (!r) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise((x) => setTimeout(x, 400));
      r = await send();
    } catch (e) {}
  }
  if (!r) { tglRecFinalize(''); tglRecStatus('⚠ X tab e script load hoyni — X tab refresh (F5) kore abar try koro.'); return; }
  if (!r.ok) { tglRecFinalize(''); tglRecStatus('⚠ Scroll hoyni: ' + (r.error || 'unknown')); return; }
  tglRecFinalize(r.reachedTop ? 'profile top e pouchhechhe' : 'scroll theme gese');
}

let isStartingTgLikerWorkflow = false;
async function startTgLikerWorkflow(continueMode = false, addMoreCount = 0) {
  if (isStartingTgLikerWorkflow) return;
  isStartingTgLikerWorkflow = true;
  const launchBtn = document.getElementById('runTgLikerBtn');
  if (launchBtn) launchBtn.style.pointerEvents = 'none';

  try {
    if (!(await ensureVerifiedAccountOrBlock())) {
      if (launchBtn) launchBtn.style.pointerEvents = 'auto';
      return;
    }

    const rawTarget = (document.getElementById('tgLikerTargetInput')?.value || '').trim();
  const section = document.getElementById('tgLikerSectionSelect')?.value || 'auto';
  const optLike = document.getElementById('tgLikerOptLike')?.checked ?? true;
  const optRepost = document.getElementById('tgLikerOptRepost')?.checked ?? false;
  const optBookmark = document.getElementById('tgLikerOptBookmark')?.checked ?? false;
  const speedMs = Number(document.getElementById('tgLikerSpeedSelect')?.value ?? 3500);
  let targetCount = Number(document.getElementById('tgLikerTargetCountInput')?.value ?? 20);
  const continuousLoop = document.getElementById('tgLikerContinuousLoop')?.checked ?? true;

  // Smart Break Engine inputs
  const breakOn = document.getElementById('tgLikerBreakOn')?.checked ?? true;
  let evMin = parseInt(document.getElementById('tgLikerEvMin')?.value, 10) || 25;
  let evMax = parseInt(document.getElementById('tgLikerEvMax')?.value, 10) || 40;
  if (evMax < evMin) [evMin, evMax] = [evMax, evMin];

  let bsMin = parseInt(document.getElementById('tgLikerBsMin')?.value, 10) || 45;
  let bsMax = parseInt(document.getElementById('tgLikerBsMax')?.value, 10) || 120;
  if (bsMax < bsMin) [bsMin, bsMax] = [bsMax, bsMin];

  const lbOn = document.getElementById('tgLikerLbOn')?.checked ?? true;
  let lbEvMin = parseInt(document.getElementById('tgLikerLbEvMin')?.value, 10) || 100;
  let lbEvMax = parseInt(document.getElementById('tgLikerLbEvMax')?.value, 10) || 150;
  if (lbEvMax < lbEvMin) [lbEvMin, lbEvMax] = [lbEvMax, lbEvMin];

  let lbMinMin = parseInt(document.getElementById('tgLikerLbMinMin')?.value, 10) || 5;
  let lbMinMax = parseInt(document.getElementById('tgLikerLbMinMax')?.value, 10) || 10;
  if (lbMinMax < lbMinMin) [lbMinMin, lbMinMax] = [lbMinMax, lbMinMin];

  const hourly = parseInt(document.getElementById('tgLikerHourly')?.value, 10) || 0;

  if (!optLike && !optRepost && !optBookmark) {
    showExtToast('Select at least one action (Like, Repost, or Bookmark)', '⚠️');
    return;
  }

  // Active X tab detection
  const twTab = await getActiveTwitterTab();
  const isX = !!(twTab && /^https:\/\/(x|twitter)\.com\//i.test(twTab.url || ''));

  let parsed = parseTgLikerTargets(rawTarget);
  if (!parsed.length && isX && twTab?.url) {
    parsed = parseTgLikerTargets(twTab.url);
  }
  if (!parsed.length) {
    showExtToast('Paste profile link (x.com/username) or tweet link, or open an X tab.', '⚠️');
    return;
  }

  const targets = parsed.map(t => buildTgLikerTarget(t, section));

  let prevCount = 0;
  let prevStats = { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 };
  if (continueMode) {
    const statsRes = await chrome.storage.local.get(['atomx_tgliker_last_stats']).catch(() => ({}));
    prevCount = Number(statsRes?.atomx_tgliker_last_stats?.handled) || 0;
    prevStats = statsRes?.atomx_tgliker_last_stats || prevStats;
    targetCount = prevCount + (Number(addMoreCount) || 20);
    const targetInp = document.getElementById('tgLikerTargetCountInput');
    if (targetInp) targetInp.value = String(targetCount);
  }

  const startBtn = document.getElementById('runTgLikerBtn');
  const stopBtn = document.getElementById('stopTgLikerBtn');
  const pauseBtn = document.getElementById('pauseTgLikerBtn');
  const skipBtn = document.getElementById('skipTgLikerBtn');
  const progressCard = document.getElementById('tgLikerProgressCard');
  const stateBadge = document.getElementById('tgLikerStateBadge');
  const queueIndicator = document.getElementById('tgLikerQueueIndicator');
  const barEl = document.getElementById('tgLikerProgressBar');
  const likedEl = document.getElementById('tgLikerCountLiked');
  const repostedEl = document.getElementById('tgLikerCountReposted');
  const bookmarkedEl = document.getElementById('tgLikerCountBookmarked');
  const skipEl = document.getElementById('tgLikerCountSkipped');
  const statusText = document.getElementById('tgLikerLiveStatusText');
  const countdownEl = document.getElementById('tgLikerCountdownText');

  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-flex';
  if (pauseBtn) pauseBtn.style.display = 'inline-flex';
  if (skipBtn) skipBtn.style.display = 'inline-flex';
  if (progressCard) progressCard.style.display = 'block';

  const displayTarget = targetCount > 0 ? targetCount : '∞';
  if (stateBadge) stateBadge.textContent = 'RUNNING';
  if (likedEl) likedEl.textContent = String(prevStats.liked || 0);
  if (repostedEl) repostedEl.textContent = String(prevStats.reposted || 0);
  if (bookmarkedEl) bookmarkedEl.textContent = String(prevStats.bookmarked || 0);
  if (skipEl) skipEl.textContent = String(prevStats.skipped || 0);
  if (barEl) barEl.style.width = '5%';
  if (countdownEl) countdownEl.style.display = 'none';
  if (queueIndicator) queueIndicator.textContent = `Post ${prevCount}/${displayTarget}`;
  if (statusText) statusText.textContent = continueMode
    ? `Continuing TG Liker from previous position (+${addMoreCount} posts)...`
    : `Launching TG Liker raid... Navigating & engaging.`;

  syncFloatingHud(null, {
    title: 'TG Liker (Raid & Repost)',
    stateBadge: 'RUNNING',
    indicator: `Post ${prevCount}/${displayTarget}`,
    done: prevCount,
    collected: targetCount,
    skipped: prevStats.skipped || 0,
    progressPercent: 5,
    statusText: `Preparing TG Liker mass raid...`
  });

  // 1. Resolve target URL & select exactly ONE tab to use
  const targetUrl = targets[0].url;
  const normPath = (p) => { try { return new URL(p).pathname.replace(/\/+$/, '').toLowerCase(); } catch (e) { return ''; } };

  let tabId = null;
  if (isX && twTab?.id) {
    tabId = twTab.id;
    if (normPath(twTab.url) !== normPath(targetUrl)) {
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    }
  } else {
    // Check for any open Twitter / X tab in any window to reuse
    const openTwitterTabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }).catch(() => []);
    if (openTwitterTabs && openTwitterTabs.length > 0 && openTwitterTabs[0].id) {
      tabId = openTwitterTabs[0].id;
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    } else {
      // Create EXACTLY ONE new tab directly on targetUrl (never creates about:blank)
      const t = await chrome.tabs.create({ url: targetUrl, active: true });
      tabId = t.id;
    }
  }

  const cfg = {
    tabId,
    targets,
    actions: { like: optLike, repost: optRepost, bookmark: optBookmark },
    speedMs,
    loop: continuousLoop,
    stop: buildTgLikerStop(),
    breaks: { enabled: breakOn, everyMin: evMin, everyMax: evMax, secMin: bsMin, secMax: bsMax },
    longBreak: { enabled: lbOn, everyMin: lbEvMin, everyMax: lbEvMax, minMin: lbMinMin, minMax: lbMinMax },
    hourlyMax: hourly,
    maxPosts: targetCount
  };

  const runId = Date.now();
  const first = cfg.breaks.enabled ? evMin + Math.floor(Math.random() * (evMax - evMin + 1)) : 0;
  const firstLong = cfg.longBreak.enabled ? lbEvMin + Math.floor(Math.random() * (lbEvMax - lbEvMin + 1)) : 0;

  const statePatch = {
    phase: 'running',
    targetIndex: 0,
    round: 1,
    total: continueMode ? prevCount : 0,
    onBreak: false,
    wait: null,
    sinceBreak: 0,
    breakAt: first,
    sinceLong: 0,
    longAt: firstLong,
    stats: continueMode ? prevStats : { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 },
    status: continueMode ? `Continuing... (+${addMoreCount} posts)` : 'Starting...'
  };

  const storageSet = {
    tgl_cfg: cfg,
    tgl_ctrl: { state: 'running', runId },
    tgl_state: statePatch,
    atomx_workflow_paused: false,
    atomx_agent_workflow: {
      agentId: 'tgliker',
      title: 'TG Liker (Raid & Repost)',
      active: true,
      isStopped: false,
      stateBadge: 'RUNNING',
      statusText: statePatch.status,
      total: targetCount,
      successCount: statePatch.total,
      liked: statePatch.stats.liked || 0,
      reposted: statePatch.stats.reposted || 0,
      bookmarked: statePatch.stats.bookmarked || 0,
      ignoredCount: statePatch.stats.skipped || 0,
      options: cfg
    }
  };

  if (!continueMode) {
    storageSet.tgl_seen = {};
  }
  await chrome.storage.local.set(storageSet);

  // Send message to background so background knows working tab (zero tab actions from bg)
  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'tgliker',
    title: 'TG Liker (Raid & Repost)',
    tabId,
    items: [],
    options: {
      ...cfg,
      continueMode,
      prevCount,
      addMoreCount
    }
  }).catch(() => null);

  // Trigger engine on active tab directly if already navigated
  chrome.tabs.sendMessage(tabId, { type: 'START_TG_LIKER_ENGINE', cfg }).catch(() => null);
  } finally {
    setTimeout(() => {
      isStartingTgLikerWorkflow = false;
      const btn = document.getElementById('runTgLikerBtn');
      if (btn) btn.style.pointerEvents = 'auto';
    }, 1200);
  }
}

// =========================================================================
// AGENT 1: AUDIENCE BUILDER WORKFLOW ENGINE (A2, GROWTH, FULLY AUTO)
// =========================================================================

// =========================================================================
// UNIVERSAL SUBSCRIPTION TIER HIERARCHY & FEATURE ACCESS ENGINE
// =========================================================================
const PLAN_TIER_LEVELS = {
  'free': 1,
  'starter': 2,
  'pro': 3,
  'growth': 4,
  'enterprise': 5
};

function getPlanLevel(plan) {
  const p = (plan || state.userPlan || state.user?.plan || 'free').toLowerCase();
  if (p.includes('enterprise') || p.includes('vip') || p.includes('unlimited')) return 5;
  if (p.includes('growth') || p.includes('tier 1')) return 4;
  if (p.includes('pro') || p.includes('premium')) return 3;
  if (p.includes('starter') || p.includes('basic') || p.includes('entry')) return 2;
  return 1; // free
}

function canUserAccessTier(userPlan, requiredTier) {
  if (!requiredTier || requiredTier === 'all' || requiredTier === 'free') return true;
  const req = (requiredTier || '').toLowerCase();
  const reqLevel = PLAN_TIER_LEVELS[req] || (req === 'paid' ? 3 : 1);
  return getPlanLevel(userPlan) >= reqLevel;
}

function isUserPaidPlan(plan) {
  return getPlanLevel(plan) >= 3;
}

function getPlanMaxCustomTones(userPlan) {
  const level = getPlanLevel(userPlan);
  const quotas = state.planQuotas || { free: 1, starter: 3, pro: 10, growth: 25, enterprise: 100 };
  if (level >= 5) return quotas.enterprise || 100;
  if (level === 4) return quotas.growth || 25;
  if (level === 3) return quotas.pro || 10;
  if (level === 2) return quotas.starter || 3;
  return quotas.free || 1;
}

// Fallback curated lists if backend offline or cold start
const FALLBACK_CURATED_LISTS = {
  "sorsaTier1": {
    "id": "sorsaTier1",
    "name": "Tier 1: Top 100 Crypto KOLs (Score Multiplier 3x)",
    "status": "published",
    "listUrl": "",
    "targets": [
      "@sabbirzc",
      "@miiportable_btc",
      "@0xzorroo",
      "@Naija_PR",
      "@Fatimabadam",
      "@Ehsanasadivip",
      "@YunaEmpire_01",
      "@shafi7706",
      "@alfianrudi_",
      "@Piquis_Bar",
      "@theMadridZone",
      "@YaseerGumel",
      "@Sirbest247",
      "@jnr_pips",
      "@BigCasperEth",
      "@kaixweb3",
      "@JSimulat3",
      "@DavidMorganXBT",
      "@0xemotions_",
      "@RifdahSR_11",
      "@samcryptto",
      "@0x_Quant69",
      "@arnoldwall_sol",
      "@_ummukulthum",
      "@kore_vs_",
      "@AYZwgmi",
      "@Rexa302",
      "@0x_Flames",
      "@Jokerchimp",
      "@Shiyas_wb3",
      "@martinsrex65950",
      "@Belialoglu",
      "@shu_bomi",
      "@FindAngus",
      "@SpideyWebyb",
      "@W3B_GURU",
      "@CryptPshyc",
      "@Robiulislam796",
      "@Rukon__Kholifa",
      "@0xkiYuki",
      "@FlipMe_now",
      "@CrypNhuel",
      "@oxdeer_",
      "@alexacrrypt",
      "@mazanga_daniel",
      "@RealDea_n",
      "@Auwalsulai69118",
      "@BlaqBonez",
      "@MOCRYPTODC",
      "@OxMullha",
      "@ArtYxEth",
      "@zangart90",
      "@Flipfury40",
      "@thoby_lobah",
      "@Anox_0x",
      "@captmarvel02",
      "@therealtorah_",
      "@lenzendoo",
      "@0xghost_Lab",
      "@0x_zyven",
      "@Emermuo",
      "@LeDuc_03",
      "@Shahidu23581181",
      "@Va_rian01",
      "@D_GreatVictor",
      "@biggerz",
      "@NFTBarney69",
      "@Honieplat",
      "@0xStego",
      "@BankzNo1",
      "@Wendy_rohsee",
      "@Olahosts",
      "@Nyerishi",
      "@Odogwu",
      "@web3parkerr",
      "@kewu_crypto",
      "@SADIWEB3",
      "@0x_Ecko",
      "@lordsnowone",
      "@haider_103",
      "@BkCryp0786",
      "@chinese_devil",
      "@14NV__",
      "@Retard589",
      "@0xmahdishadow",
      "@HHisnothing",
      "@Abdulla8187",
      "@Sdyahaya_",
      "@freshguy789857",
      "@heisastaX",
      "@gy_vhh82812",
      "@Mastuurah_",
      "@togisahil1",
      "@Iamsmart238",
      "@sangminyu3",
      "@archie_eth27",
      "@EAsuperstar",
      "@Sadiqjhussaini0",
      "@dmoonguy",
      "@kerlve",
      "@feurimas10",
      "@alfuratyalatiqe",
      "@tricia4644",
      "@0xjason3333",
      "@moomoneymeta",
      "@SolTheGr8",
      "@tang__kira",
      "@0xSourav_",
      "@0xAleexx",
      "@Gengui25106320",
      "@RussellQuantum",
      "@Mark_A78",
      "@Proof__Seeker",
      "@Tessara_C",
      "@raztradesz",
      "@adeniyiontwit",
      "@Hancrypto_2fa",
      "@eddiecrypt1",
      "@Shola478",
      "@gokorea2022",
      "@btchiim",
      "@heyvaro",
      "@aboy1134",
      "@peanutphan_eth",
      "@AvaLuna28",
      "@Parkerxbtc",
      "@arescoins",
      "@sabirraza33",
      "@EErinmez82864",
      "@Johnyy_bravooo",
      "@0xRyze",
      "@Huynhcongduy3",
      "@xiaoQeth",
      "@pygroxe",
      "@Mainmijo",
      "@EmlexNiSeh",
      "@Olivelinex",
      "@AYOMI40",
      "@suryawanshi_pr",
      "@GagantuaWEB3",
      "@johnkelly639934",
      "@Mark_Swago",
      "@societyhatemafe",
      "@fredkaff",
      "@BearDegen_eth",
      "@BlackBullweb3",
      "@needazar",
      "@Mrho3in1sti",
      "@MichOkings",
      "@ofcnewyorkers",
      "@king_web3g",
      "@D4rylf",
      "@noorofweb3",
      "@wizzybanks26",
      "@crypto_milu",
      "@DtCryptoo",
      "@sykn1977",
      "@habercimcum",
      "@NenitoCrypto",
      "@Lajay99",
      "@aad2degen",
      "@Jonny_Gram0X",
      "@JARMIU9",
      "@NeverGiveUp868",
      "@maybach_eth",
      "@chime1813559",
      "@QwezhangPlm",
      "@mdkitchen7",
      "@Madrii_dd",
      "@Yasmina_sm",
      "@justonedave_1",
      "@vtn1508",
      "@TweetsbyXV",
      "@bella_summerss",
      "@Web3_boss",
      "@smol244",
      "@jayjay_md231",
      "@WombatJin87",
      "@necheobay",
      "@Crypt0_Birds",
      "@ohmahahm",
      "@Nixiweb3",
      "@ayhankayan_",
      "@mahogany0609",
      "@TessyWeb3",
      "@NFTANONYMO",
      "@muhammadatiqim",
      "@frogmanhaha",
      "@phamtoi678",
      "@Damos20820110",
      "@tamonex2000",
      "@hunt14008",
      "@whoiswannie",
      "@HaykinsTaiwo",
      "@MehmetBerkErgin",
      "@VaultWatcher",
      "@Pgreat120",
      "@bachkhoabnb",
      "@Geta_Boshi_",
      "@BlessedPharm",
      "@_owletto",
      "@bethelO723",
      "@nakoshisss",
      "@kaswizofficial",
      "@dominicsol_",
      "@_OneOrTwo",
      "@CryptoKrexxt",
      "@DannyP1333",
      "@0xJoseDinero",
      "@mel_sol1",
      "@JessyPineault",
      "@servermonk15",
      "@shalom_web3",
      "@CoinTivars",
      "@Manazrealfact",
      "@Raven0nX",
      "@sirkparaka",
      "@omotolarideon",
      "@DeNostradameX",
      "@Sana_pht",
      "@Zahra_udaw",
      "@AMBASSADOR10X",
      "@0xUzman",
      "@Jvstheman",
      "@Doppelganger_OX",
      "@WTF_Rehanuwn",
      "@abrahamgambler",
      "@TheGo2Guy",
      "@CryptoEarner12",
      "@louieggonx",
      "@iRalmix",
      "@OxbigSam",
      "@0xAstrokid69",
      "@AJMetaX1",
      "@Raihan_Offcial1",
      "@KINGMAROHQ",
      "@seikolambo19",
      "@Maidatacrypto",
      "@pelscrypt",
      "@0xDenis__",
      "@fhecat",
      "@Menionchain",
      "@0xRallas"
    ],
    "category": "Audience Builder",
    "accessTier": "paid",
    "description": "High-weight accounts for maximum Sorsa Score multiplier (Pro Plan)."
  },
  "sorsaTier2": {
    "id": "sorsaTier2",
    "name": "Tier 2: High-Volume Ecosystem Projects",
    "status": "published",
    "listUrl": "",
    "targets": [
      "@ethereum",
      "@solana",
      "@base",
      "@arbitrum",
      "@ton_blockchain"
    ],
    "category": "Increase Sorsa Score",
    "accessTier": "free",
    "description": "Official ecosystem foundations and protocol accounts (Free Plan)."
  },
  "audienceList1": {
    "id": "audienceList1",
    "name": "Web3 & Crypto Alpha Hunters",
    "status": "published",
    "listUrl": "",
    "targets": [
      "@evanjawadx",
      "@vitalikbuterin",
      "@sassal0x",
      "@cobie",
      "@inversebrah",
      "@garyvee",
      "@brian_armstrong",
      "@zachxbt",
      "@balajis",
      "@DeeZe",
      "@cdixon",
      "@realDonaldTrump",
      "@osf_rekt",
      "@rektmando",
      "@LucaNetz",
      "@jessepollak",
      "@CapetainTrippy",
      "@justinsuntron",
      "@NathanHeadPhoto",
      "@moonpay",
      "@rajgokal",
      "@waleswoosh",
      "@TheShamdoo",
      "@a1lon9",
      "@NFTPrince",
      "@Swickie",
      "@TuckerCarlson",
      "@scott_lew_is",
      "@BalouBAYC",
      "@qrimeCapital",
      "@MrMetaMask",
      "@YatMuseum",
      "@AshleyDCan",
      "@Lakoz_",
      "@ArtOnInternet",
      "@wallstreetbets",
      "@topshotfund",
      "@tonyherrera",
      "@rekt2160",
      "@Zaptio",
      "@deltasauce",
      "@allodev",
      "@beautyandpunk",
      "@halecar2",
      "@alexmccurryo",
      "@racs_o",
      "@AaronHaber",
      "@slimesunday",
      "@IDerech",
      "@NaughtalieStone",
      "@NFTignition",
      "@UnknownCo123",
      "@Treasure_DAO",
      "@justinkalland",
      "@NFTparent",
      "@bitcoinprophet1",
      "@hypercryptology",
      "@jed_131",
      "@seyong",
      "@bgarlinghouse",
      "@degens",
      "@Foryet2",
      "@KyleRiggins",
      "@CrazyCryptoCarl",
      "@CaballeroAnaMa",
      "@KRAM_btc",
      "@aljaparis",
      "@AndrewAsksHow",
      "@CNN",
      "@AzFlin",
      "@RENGA_inc",
      "@Ryder3332",
      "@Bored_Bill_86",
      "@NFTMillionaire",
      "@dotjiwa",
      "@MightyDylanK",
      "@mutant_cartel",
      "@Jayism1",
      "@sicko_ape",
      "@cryptojeweler",
      "@leiane1",
      "@ChartFu",
      "@jump_",
      "@jeremyknowsVF",
      "@0xmozzy",
      "@PythNetwork",
      "@dripbitsnft",
      "@nelsphere",
      "@Sanza",
      "@MetaverseWorld",
      "@kyokill_",
      "@token2049",
      "@_VLaaD_",
      "@22loops",
      "@LazyLionsNFT",
      "@wildalps",
      "@davekebo",
      "@MoneyPlaneIdol",
      "@MEXC",
      "@Lucky1seth",
      "@vibevibefun",
      "@pauleta231",
      "@0x1_0NE"
    ],
    "category": "Audience Builder",
    "accessTier": "free",
    "description": "Curated list of high-affinity Web3 researchers and alpha accounts."
  },
  "audienceList2": {
    "id": "audienceList2",
    "name": "Tech Founders & Angel VCs",
    "status": "published",
    "listUrl": "",
    "targets": [],
    "category": "Audience Builder",
    "accessTier": "paid",
    "description": "High-tier venture builders and angel investors on X (Pro Plan)."
  },
  "followerList1": {
    "id": "followerList1",
    "name": "Viral Community Discussion Hubs",
    "status": "published",
    "listUrl": "",
    "targets": [
      "@CryptoTownHall",
      "@web3comm",
      "@SolanaDaily",
      "@VitalikButerin"
    ],
    "category": "Followers Increase",
    "accessTier": "free",
    "description": "Busy discussion threads for capturing engaged niche followers (Free Plan)."
  },
  "custom_1791405854821": {
    "id": "custom_1791405854821",
    "name": "Sorsa Free",
    "status": "published",
    "listUrl": "",
    "targets": [
      "@Parkerxbtc",
      "@arescoins",
      "@sabirraza33",
      "@EErinmez82864",
      "@Johnyy_bravooo",
      "@0xRyze",
      "@Huynhcongduy3",
      "@xiaoQeth",
      "@pygroxe",
      "@Mainmijo",
      "@EmlexNiSeh",
      "@Olivelinex",
      "@AYOMI40",
      "@suryawanshi_pr",
      "@GagantuaWEB3",
      "@johnkelly639934",
      "@Mark_Swago",
      "@societyhatemafe",
      "@fredkaff",
      "@BearDegen_eth",
      "@BlackBullweb3",
      "@needazar",
      "@Mrho3in1sti",
      "@MichOkings",
      "@ofcnewyorkers",
      "@king_web3g",
      "@D4rylf",
      "@noorofweb3",
      "@wizzybanks26",
      "@crypto_milu",
      "@DtCryptoo",
      "@sykn1977",
      "@habercimcum",
      "@NenitoCrypto",
      "@Lajay99",
      "@aad2degen",
      "@Jonny_Gram0X",
      "@JARMIU9",
      "@NeverGiveUp868",
      "@maybach_eth",
      "@chime1813559",
      "@QwezhangPlm",
      "@mdkitchen7",
      "@Madrii_dd",
      "@Yasmina_sm",
      "@justonedave_1",
      "@vtn1508",
      "@TweetsbyXV",
      "@bella_summerss",
      "@Web3_boss",
      "@smol244",
      "@jayjay_md231",
      "@WombatJin87",
      "@necheobay",
      "@Crypt0_Birds",
      "@ohmahahm",
      "@Nixiweb3",
      "@ayhankayan_",
      "@mahogany0609",
      "@TessyWeb3",
      "@NFTANONYMO",
      "@muhammadatiqim",
      "@frogmanhaha",
      "@phamtoi678",
      "@Damos20820110",
      "@tamonex2000",
      "@hunt14008",
      "@whoiswannie",
      "@HaykinsTaiwo",
      "@MehmetBerkErgin",
      "@VaultWatcher",
      "@Pgreat120",
      "@bachkhoabnb",
      "@Geta_Boshi_",
      "@BlessedPharm",
      "@_owletto",
      "@bethelO723",
      "@nakoshisss",
      "@kaswizofficial",
      "@dominicsol_",
      "@_OneOrTwo",
      "@CryptoKrexxt",
      "@DannyP1333",
      "@0xJoseDinero",
      "@mel_sol1",
      "@JessyPineault",
      "@servermonk15",
      "@shalom_web3",
      "@CoinTivars",
      "@Manazrealfact",
      "@Raven0nX",
      "@sirkparaka",
      "@omotolarideon",
      "@DeNostradameX",
      "@Sana_pht",
      "@Zahra_udaw",
      "@AMBASSADOR10X",
      "@0xUzman",
      "@Jvstheman",
      "@Doppelganger_OX",
      "@WTF_Rehanuwn",
      "@abrahamgambler",
      "@TheGo2Guy",
      "@CryptoEarner12",
      "@louieggonx",
      "@iRalmix",
      "@OxbigSam",
      "@0xAstrokid69",
      "@AJMetaX1",
      "@Raihan_Offcial1",
      "@KINGMAROHQ",
      "@seikolambo19",
      "@Maidatacrypto",
      "@pelscrypt",
      "@0xDenis__",
      "@fhecat",
      "@Menionchain",
      "@0xRallas"
    ],
    "category": "Increase Sorsa Score",
    "rankRange": "Rank 2777–2894",
    "accessTier": "free",
    "description": "Admin imported list with 118 verified creators (Rank 2777–2894)."
  },
  "audienceList1": {
    "id": "audienceList1",
    "name": "High Alpha Web3 Builders List",
    "category": "Audience Builder",
    "status": "published",
    "listUrl": "https://x.com/i/lists/2103557569319219223",
    "targets": [],
    "accessTier": "free",
    "description": "Live Twitter list of active Web3 builders and high-engagement commenters."
  },
  "followerList1": {
    "id": "followerList1",
    "name": "Crypto Growth & KOLs Active List",
    "category": "Followers Increase",
    "status": "published",
    "listUrl": "https://x.com/i/lists/2103557569319219223",
    "targets": [],
    "accessTier": "free",
    "description": "Curated Twitter list for active organic follower growth."
  }
};

function populateAudienceSelect() {
  const select = document.getElementById('audienceListSelect');
  if (!select) return;

  const lists = state.curatedLists || FALLBACK_CURATED_LISTS;
  select.innerHTML = '';
  const keys = Object.keys(lists);
  let foundAny = false;
  let firstAccessibleKey = null;

  keys.forEach((k) => {
    const item = lists[k];
    const isPublished = (item.status || 'published') === 'published' || (item.status || '').toLowerCase() === 'live';
    const isAudience = item.category === 'Audience Builder' || item.category === 'CrowdFi' || /audience|crowdfi/i.test(item.category || '');
    const validListUrl = item.listUrl && extractTwitterListUrl(item.listUrl);
    // STRICT RULE: Audience Builder ONLY accepts Twitter List URLs (no handles or CSV)
    if (isAudience && isPublished && validListUrl) {
      foundAny = true;
      const reqTier = (item.accessTier || 'free').toLowerCase();
      const userCanAccess = canUserAccessTier(state.userPlan, reqTier);
      if (userCanAccess && !firstAccessibleKey) {
        firstAccessibleKey = k;
      }
      const opt = document.createElement('option');
      opt.value = k;
      const shortName = item.name.replace(/^List \d+:\s*/i, '').replace(/\s*\(Score Multiplier \d+x\)/i, '').trim();
      const prefix = !userCanAccess ? `🔒 [${reqTier.toUpperCase()}] ` : '⭐ ';
      opt.textContent = `${prefix}${shortName} (Twitter List URL)`;
      select.appendChild(opt);
    }
  });

  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = '➕ Custom Twitter List URL...';
  select.appendChild(customOpt);

  const targetToSelect = firstAccessibleKey || (foundAny ? select.options[0]?.value : 'custom');
  if (targetToSelect) {
    select.value = targetToSelect;
    const box = document.getElementById('customListUrlBox');
    if (box) box.style.display = targetToSelect === 'custom' ? 'block' : 'none';
  }
}

async function initAudienceBuilderSystem() {
  // 1. Immediately read cached lists from chrome.storage.local for instant zero-latency render
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['atomx_curated_lists']);
      if (stored.atomx_curated_lists && typeof stored.atomx_curated_lists === 'object' && Object.keys(stored.atomx_curated_lists).length > 0) {
        state.curatedLists = stored.atomx_curated_lists;
      }
    } catch (e) { }
  }

  if (!state.curatedLists) {
    state.curatedLists = FALLBACK_CURATED_LISTS;
  }

  // Populate all 3 dropdowns immediately so user sees them right away
  populateAudienceSelect();
  initSorsaScoreSystem();
  initFollowersListsSystem();

  // 2. Fetch live curated lists from Backend API in background and refresh dropdowns
  try {
    const backendUrl = await getBackendUrl();
    let res = await fetch(`${backendUrl}/api/curated-lists`, { cache: 'no-cache' }).catch(() => null);
    if (!res || !res.ok) {
      if (backendUrl !== DEFAULT_BACKEND_URL) {
        res = await fetch(`${DEFAULT_BACKEND_URL}/api/curated-lists`, { cache: 'no-cache' }).catch(() => null);
      }
    }
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.lists && Object.keys(data.lists).length > 0) {
        state.curatedLists = data.lists;
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.set({ atomx_curated_lists: data.lists });
        }
        // Re-render UI with fresh backend data
        populateAudienceSelect();
        initSorsaScoreSystem();
        initFollowersListsSystem();
      }
    }
  } catch (e) {
    // Graceful fallback to cached / local curated lists without noisy error logs
  }

  // 3. Restore persisted counters, settings & queue state
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get([
      'atomx_audience_followed_ids',
      'atomx_audience_queue',
      'atomx_audience_queue_pos',
      'atomx_audience_counters',
      'atomx_audience_settings'
    ], (stored) => {
      if (stored.atomx_audience_counters) {
        const { done = 0, collected = 0, skipped = 0 } = stored.atomx_audience_counters;
        const dEl = document.getElementById('audienceDoneCount');
        const cEl = document.getElementById('audienceCollectedCount');
        const sEl = document.getElementById('audienceSkippedCount');
        if (dEl) dEl.textContent = done;
        if (cEl) cEl.textContent = collected;
        if (sEl) sEl.textContent = skipped;
      }

      if (stored.atomx_audience_queue && stored.atomx_audience_queue.length > 0) {
        const pos = stored.atomx_audience_queue_pos || 0;
        const total = stored.atomx_audience_queue.length;
        const qInd = document.getElementById('audienceQueueIndicator');
        if (qInd) qInd.textContent = `Profile ${Math.min(pos + 1, total)}/${total}`;
        const card = document.getElementById('audienceProgressCard');
        if (card) card.style.display = 'block';
      }

      if (stored.atomx_audience_settings) {
        const s = stored.atomx_audience_settings;
        if (s.dateRange && document.getElementById('audienceDateRangeSelect')) {
          document.getElementById('audienceDateRangeSelect').value = s.dateRange;
        }
        if (s.sortBy && document.getElementById('audienceSortBySelect')) {
          document.getElementById('audienceSortBySelect').value = s.sortBy;
        }
        if (s.targetCount && document.getElementById('audienceTargetCountSelect')) {
          document.getElementById('audienceTargetCountSelect').value = s.targetCount;
        }
        if (s.delaySec && document.getElementById('audienceDelaySelect')) {
          document.getElementById('audienceDelaySelect').value = s.delaySec;
        }
        if (typeof s.autoFollow !== 'undefined' && document.getElementById('audienceAutoFollowToggle')) {
          document.getElementById('audienceAutoFollowToggle').checked = s.autoFollow;
        }
        if (typeof s.likePosts !== 'undefined' && document.getElementById('audienceLikePostsToggle')) {
          document.getElementById('audienceLikePostsToggle').checked = s.likePosts;
        }
        if (typeof s.replyPosts !== 'undefined' && document.getElementById('audienceReplyPostsToggle')) {
          document.getElementById('audienceReplyPostsToggle').checked = s.replyPosts;
        }
        if (typeof s.autoUnfollow !== 'undefined' && document.getElementById('audienceUnfollowToggle')) {
          document.getElementById('audienceUnfollowToggle').checked = s.autoUnfollow;
        }
      }
    });
  }
}

function loadSorsaCuratedList(listKey) {
  const textarea = document.getElementById('sorsaHandlesInput');
  const hint = document.getElementById('sorsaHandlesHint');
  const badge = document.getElementById('sorsaParsedCountBadge');
  if (!textarea) return;

  if (!listKey || listKey === 'custom') {
    delete textarea.dataset.hiddenHandles;
    delete state.sorsaCuratedTargets;
    textarea.style.display = 'block';
    if (hint) hint.style.display = 'inline';
    textarea.readOnly = false;
    textarea.value = '';
    textarea.style.color = '';
    textarea.style.fontStyle = 'normal';
    if (badge) badge.textContent = '0 accounts ready';
    return;
  }

  const lists = state.curatedLists || FALLBACK_CURATED_LISTS;
  const item = lists[listKey];
  if (item && Array.isArray(item.targets) && item.targets.length > 0) {
    textarea.dataset.hiddenHandles = JSON.stringify(item.targets);
    state.sorsaCuratedTargets = item.targets;
    textarea.value = '';
    textarea.style.display = 'none'; // Completely hidden for curated lists
    if (hint) hint.style.display = 'none';
    const count = item.targets.length;
    if (badge) badge.textContent = `${count} accounts ready (${item.name})`;
  } else {
    delete textarea.dataset.hiddenHandles;
    delete state.sorsaCuratedTargets;
    textarea.style.display = 'none';
    if (hint) hint.style.display = 'none';
    textarea.readOnly = false;
    textarea.value = '';
    textarea.style.color = '';
    textarea.style.fontStyle = 'normal';
    if (badge) badge.textContent = `0 accounts ready`;
  }
}

function initSorsaScoreSystem() {
  const select = document.getElementById('sorsaCuratedListSelect') || document.getElementById('sorsaTierSelect');
  if (!select) return;

  const lists = state.curatedLists || FALLBACK_CURATED_LISTS;
  const keys = Object.keys(lists);
  let hasPublished = false;
  let firstAccessibleKey = null;

  select.innerHTML = '';
  keys.forEach((k) => {
    const item = lists[k];
    const isPublished = (item.status || 'published') === 'published' || (item.status || '').toLowerCase() === 'live';
    const isSorsa = item.category === 'Increase Sorsa Score' || item.category === 'Sorsa Score' || item.category === 'Score Accelerator' || /sorsa|score/i.test(item.category || '');
    const hasTargets = Array.isArray(item.targets) && item.targets.length > 0;
    const hasNoListUrl = !item.listUrl || !extractTwitterListUrl(item.listUrl);
    // STRICT RULE: Increase Sorsa Score ONLY accepts username targets / CSV (NO Twitter List URLs)
    if (isSorsa && isPublished && hasTargets && hasNoListUrl) {
      hasPublished = true;
      const reqTier = (item.accessTier || 'free').toLowerCase();
      const userCanAccess = canUserAccessTier(state.userPlan, reqTier);
      if (userCanAccess && !firstAccessibleKey) {
        firstAccessibleKey = k;
      }
      const opt = document.createElement('option');
      opt.value = k;
      const targetCount = (item.targets || []).length;
      const shortName = item.name.replace(/\s*\(Score Multiplier \d+x\)/i, '').replace(/Admin imported list with \d+ verified creators/i, '').trim();
      const prefix = !userCanAccess ? `🔒 [${reqTier.toUpperCase()}] ` : '⭐ ';
      opt.textContent = `${prefix}${shortName} (${targetCount} Accounts)`;
      select.appendChild(opt);
    }
  });

  const sorsaCustomOpt = document.createElement('option');
  sorsaCustomOpt.value = 'custom';
  sorsaCustomOpt.textContent = '✍️ Custom Input / Upload .CSV';
  select.appendChild(sorsaCustomOpt);

  const targetToSelect = firstAccessibleKey || (hasPublished ? select.options[0]?.value : 'custom');
  if (targetToSelect && targetToSelect !== 'custom') {
    select.value = targetToSelect;
    loadSorsaCuratedList(targetToSelect);
  }
}

function initFollowersListsSystem() {
  const select = document.getElementById('followerNicheSelect');
  if (!select) return;

  const lists = state.curatedLists || FALLBACK_CURATED_LISTS;
  select.innerHTML = '';
  let foundAny = false;
  let firstAccessibleKey = null;

  Object.keys(lists).forEach((k) => {
    const item = lists[k];
    const isPublished = (item.status || 'published') === 'published' || (item.status || '').toLowerCase() === 'live';
    const isFollowers = item.category === 'Followers Increase' || item.category === 'Followers Growth' || item.category === 'GrowthFi' || /follower|growthfi/i.test(item.category || '');
    const validListUrl = item.listUrl && extractTwitterListUrl(item.listUrl);
    // STRICT RULE: Followers Increase ONLY accepts Twitter List URLs (no handles or CSV)
    if (isFollowers && isPublished && validListUrl) {
      foundAny = true;
      const reqTier = (item.accessTier || 'free').toLowerCase();
      const userCanAccess = canUserAccessTier(state.userPlan, reqTier);
      if (userCanAccess && !firstAccessibleKey) {
        firstAccessibleKey = k;
      }
      const el = document.createElement('option');
      el.value = k;
      const prefix = !userCanAccess ? `🔒 [${reqTier.toUpperCase()}] ` : '⭐ ';
      el.textContent = `${prefix}${item.name} (Twitter List URL)`;
      select.appendChild(el);
    }
  });

  const followerCustomOpt = document.createElement('option');
  followerCustomOpt.value = 'custom';
  followerCustomOpt.textContent = '➕ Add Your Own Custom Twitter List';
  select.appendChild(followerCustomOpt);

  const targetToSelect = firstAccessibleKey || (foundAny ? select.options[0]?.value : 'custom');
  if (targetToSelect) {
    select.value = targetToSelect;
    const box = document.getElementById('customFollowerUrlBox');
    if (box) box.style.display = targetToSelect === 'custom' ? 'block' : 'none';
  }
}

// =========================================================================
// AGENT 1: AUDIENCE BUILDER WORKFLOW ENGINE (A2, GROWTH, LIST ONLY)
// =========================================================================
async function startAudienceBuilderWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  if (state.credits < 1) {
    alert(`⚠️ Insufficient credits!\nYou need at least 1 credit to run CrowdFi. Please top up in the Credits tab.`);
    switchExtTab('credits');
    return;
  }

  const listSelect = document.getElementById('audienceListSelect')?.value || 'custom';
  let targetUrl = '';

  if (listSelect === 'custom') {
    const rawCustom = (document.getElementById('customListUrlInput')?.value || '').trim();
    targetUrl = extractTwitterListUrl(rawCustom);
    if (!targetUrl) {
      alert('⚠️ CrowdFi ONLY supports Twitter List URLs (e.g. https://x.com/i/lists/...).\n\nCSV files and usernames are not supported for this agent.');
      return;
    }
  } else {
    const curated = state.curatedLists?.[listSelect] || FALLBACK_CURATED_LISTS[listSelect];
    const reqTier = (curated?.accessTier || 'free').toLowerCase();
    if (reqTier !== 'free' && !canUserAccessTier(state.userPlan, reqTier)) {
      alert(`🔒 ${reqTier.toUpperCase()} Plan Required!\n\n"${curated?.name || 'Selected List'}" is reserved for ${reqTier.toUpperCase()} subscribers.\n\nYour current plan: ${state.userPlan || 'Free Plan'}.\nPlease upgrade your subscription in the Credits tab.`);
      switchExtTab('credits');
      return;
    }
    targetUrl = extractTwitterListUrl(curated?.listUrl || curated?.url);
    if (!targetUrl) {
      alert('⚠️ Selected list does not have a valid Twitter List URL.\n\nCrowdFi ONLY supports Twitter List URLs (e.g. https://x.com/i/lists/...). CSV files and usernames are not supported.');
      return;
    }
  }

  const freshness = document.getElementById('audienceDateRangeSelect')?.value || '2h';
  const targetCount = Number(document.getElementById('audienceTargetCountSelect')?.value || 10);
  const postsPerProfile = document.getElementById('audiencePostsPerProfileSelect')?.value || 'random';

  const likePosts = document.getElementById('audienceLikePostsToggle')?.checked ?? true;
  const replyPosts = document.getElementById('audienceReplyPostsToggle')?.checked ?? true;
  const repostPosts = document.getElementById('audienceRepostToggle')?.checked ?? false;
  const autoFollow = document.getElementById('audienceAutoFollowToggle')?.checked ?? false;

  if (!likePosts && !replyPosts && !repostPosts && !autoFollow) {
    alert('⚠️ Please select at least one action (❤️ Like, 💬 Comment, 🔁 Repost, or ➕ Follow).');
    return;
  }

  // Persist settings
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({
      atomx_audience_settings: {
        listSelect,
        targetUrl,
        freshness,
        targetCount,
        postsPerProfile,
        likePosts,
        replyPosts,
        repostPosts,
        autoFollow
      }
    });
  }

  const startBtn = document.getElementById('runAudienceBuilderBtn');
  const stopBtn = document.getElementById('stopAudienceBuilderBtn');
  const progressCard = document.getElementById('audienceProgressCard');
  const stateBadge = document.getElementById('audienceStateBadge');
  const statusText = document.getElementById('audienceLiveStatusText');

  state.isAborted = false;
  state.isWorkflowRunning = true;
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (progressCard) progressCard.style.display = 'block';
  if (stateBadge) stateBadge.textContent = 'SCANNING';
  if (statusText) statusText.textContent = 'Opening Twitter List to discover top engaged posts & comments...';
  updateAgentConsole('⚡ Running', 'CrowdFi active...');

  const doneEl = document.getElementById('audienceDoneCount');
  const colEl = document.getElementById('audienceCollectedCount');
  const skipEl = document.getElementById('audienceSkippedCount');
  const barEl = document.getElementById('audienceProgressBar');
  const qInd = document.getElementById('audienceQueueIndicator');
  if (doneEl) doneEl.textContent = '0';
  if (colEl) colEl.textContent = String(targetCount);
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '0%';
  if (qInd) qInd.textContent = `Profile 0/${targetCount}`;

  syncFloatingHud(null, {
    title: 'CrowdFi',
    stateBadge: 'SCANNING',
    indicator: `0/${targetCount}`,
    done: 0,
    collected: targetCount,
    skipped: 0,
    progressPercent: 5,
    statusText: 'Opening Twitter List to discover top engaged posts & comments...'
  });

  const listId = extractTwitterListId(targetUrl);
  const canonicalListUrl = listId ? `https://x.com/i/lists/${listId}` : targetUrl;
  const searchFeedUrl = listId ? `https://x.com/search?q=${encodeURIComponent(`list:${listId} -filter:replies -filter:retweets`)}&f=live` : targetUrl;

  const backendUrl = await getBackendUrl();
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = activeTabs && activeTabs[0]?.id;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'audience',
    title: 'CrowdFi',
    tabId,
    items: [],
    options: {
      feedUrl: searchFeedUrl,
      targetListUrl: canonicalListUrl,
      searchFeedUrl,
      listId,
      targetCount,
      freshness,
      postsCount: postsPerProfile,
      likePosts,
      replyPosts,
      repostPosts,
      autoFollow,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  });
}

// =========================================================================
// AGENT 3: INCREASE SORSA SCORE WORKFLOW ENGINE (CSV & USERNAMES ONLY)
// =========================================================================
async function startSorsaScoreBoosterWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  if (state.credits < 1) {
    alert(`⚠️ Insufficient credits!\nYou need at least 1 credit to boost your Sorsa Score.`);
    switchExtTab('credits');
    return;
  }

  const sorsaTextarea = document.getElementById('sorsaHandlesInput');
  let cleanHandles = [];
  const seen = new Set();

  if (sorsaTextarea?.dataset?.hiddenHandles) {
    try {
      const hiddenList = JSON.parse(sorsaTextarea.dataset.hiddenHandles);
      if (Array.isArray(hiddenList) && hiddenList.length > 0) {
        for (const h of hiddenList) {
          const clean = (h || '').trim().replace(/^@/, '');
          const lower = clean.toLowerCase();
          if (clean && !seen.has(lower)) {
            seen.add(lower);
            cleanHandles.push(clean);
          }
        }
      }
    } catch (e) {}
  }

  if (cleanHandles.length === 0) {
    const rawInput = (sorsaTextarea?.value || '').trim();

    // Strict check: Block Twitter list URLs
    if (extractTwitterListUrl(rawInput)) {
      alert('⚠️ Score Accelerator ONLY accepts .CSV file uploads or usernames (e.g. @cz_binance, @vitalikbuterin).\n\nTwitter List URLs are NOT supported here. Please use CrowdFi or GrowthFi for List URLs.');
      return;
    }

    const rawItems = rawInput.split(/[\n,]+/).map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    for (const h of rawItems) {
      const lower = h.toLowerCase();
      if (lower.includes('/') || lower.includes('http') || lower.includes('.com')) continue;
      if (!seen.has(lower)) {
        seen.add(lower);
        cleanHandles.push(h);
      }
    }
  }

  if (cleanHandles.length === 0) {
    alert('⚠️ Please enter target usernames (e.g. @cz_binance) or upload a .CSV file.');
    return;
  }

  const mode = document.getElementById('sorsaModeSelect')?.value || 'sequential';
  const cooloffVal = document.getElementById('sorsaCooloffSelect')?.value || '24';
  const cooloffHours = cooloffVal === 'custom'
    ? (Number(document.getElementById('sorsaCustomCooloffInput')?.value) || 24)
    : (Number(cooloffVal) || 24);
  const targetCount = Number(document.getElementById('sorsaCountSelect')?.value || 10);
  const postsPerProfile = document.getElementById('sorsaPostsPerProfileSelect')?.value || 'random';
  const autoUnfollow = document.getElementById('sorsaUnfollowNonFollowersToggle')?.checked ?? false;

  const likePosts = document.getElementById('sorsaOptLike')?.checked ?? true;
  const replyPosts = document.getElementById('sorsaOptComment')?.checked ?? true;
  const repostPosts = document.getElementById('sorsaOptRepost')?.checked ?? false;
  const autoFollow = document.getElementById('sorsaOptFollow')?.checked ?? true;

  if (!likePosts && !replyPosts && !repostPosts && !autoFollow) {
    alert('⚠️ Please select at least one action (❤️ Like, 💬 Comment, 🔁 Repost, or ➕ Follow).');
    return;
  }

  // Persist settings
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({
      atomx_sorsa_settings: {
        mode,
        cooloffHours,
        targetCount,
        postsPerProfile,
        autoUnfollow,
        likePosts,
        replyPosts,
        repostPosts,
        autoFollow
      }
    });
  }

  const startBtn = document.getElementById('runSorsaBoosterBtn');
  const stopBtn = document.getElementById('stopSorsaBoosterBtn');
  const progressCard = document.getElementById('sorsaProgressCard');
  const stateBadge = document.getElementById('sorsaStateBadge');
  const statusText = document.getElementById('sorsaLiveStatusText');

  state.isAborted = false;
  state.isWorkflowRunning = true;
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (progressCard) progressCard.style.display = 'block';
  if (stateBadge) stateBadge.textContent = 'RUNNING';
  if (statusText) statusText.textContent = `Starting Score Accelerator (${mode === 'sequential' ? 'Mode 1: Sequential' : 'Mode 2: Deduplication Window'})...`;

  const totalEffective = Math.min(cleanHandles.length, targetCount);
  const doneEl = document.getElementById('sorsaDoneCount');
  const colEl = document.getElementById('sorsaCollectedCount');
  const skipEl = document.getElementById('sorsaSkippedCount');
  const barEl = document.getElementById('sorsaProgressBar');
  const qInd = document.getElementById('sorsaQueueIndicator');
  if (doneEl) doneEl.textContent = '0';
  if (colEl) colEl.textContent = String(totalEffective);
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '0%';
  if (qInd) qInd.textContent = `Account 0/${totalEffective}`;

  syncFloatingHud(null, {
    title: 'Score Accelerator',
    stateBadge: 'RUNNING',
    indicator: `0/${totalEffective}`,
    done: 0,
    collected: totalEffective,
    skipped: 0,
    progressPercent: 5,
    statusText: `Starting Score Accelerator (${mode === 'sequential' ? 'Mode 1: Sequential' : 'Mode 2: Deduplication Window'})...`
  });

  const backendUrl = await getBackendUrl();
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = activeTabs && activeTabs[0]?.id;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'sorsa',
    title: 'Score Accelerator',
    tabId,
    items: cleanHandles.map(h => ({ handle: `@${h}`, cleanHandle: h })),
    options: {
      mode,
      cooloffHours,
      targetCount,
      postsCount: postsPerProfile,
      autoUnfollow,
      likePosts,
      replyPosts,
      repostPosts,
      autoFollow,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  });
}

// =========================================================================
// AGENT 4: FOLLOWERS INCREASE WORKFLOW ENGINE (LIST ONLY)
// =========================================================================
async function startFollowersIncreaseWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  if (state.credits < 1) {
    alert(`⚠️ Insufficient credits!\nYou need at least 1 credit to run GrowthFi. Please top up in the Credits tab.`);
    switchExtTab('credits');
    return;
  }

  const nicheVal = document.getElementById('followerNicheSelect')?.value || 'followerList1';
  let targetUrl = '';

  if (nicheVal === 'custom') {
    const rawCustom = (document.getElementById('customFollowerUrlInput')?.value || '').trim();
    targetUrl = extractTwitterListUrl(rawCustom);
    if (!targetUrl) {
      alert('⚠️ GrowthFi ONLY supports Twitter List URLs (e.g. https://x.com/i/lists/...).\n\nCSV files and usernames are not supported for this agent.');
      return;
    }
  } else {
    const curated = state.curatedLists?.[nicheVal] || FALLBACK_CURATED_LISTS[nicheVal];
    const reqTier = (curated?.accessTier || 'free').toLowerCase();
    if (reqTier !== 'free' && !canUserAccessTier(state.userPlan, reqTier)) {
      alert(`🔒 ${reqTier.toUpperCase()} Plan Required!\n\n"${curated?.name || 'Selected List'}" is reserved for ${reqTier.toUpperCase()} subscribers.\n\nYour current plan: ${state.userPlan || 'Free Plan'}.\nPlease upgrade your subscription in the Credits tab.`);
      switchExtTab('credits');
      return;
    }
    targetUrl = extractTwitterListUrl(curated?.listUrl || curated?.url);
    if (!targetUrl) {
      alert('⚠️ Selected list does not have a valid Twitter List URL.\n\nGrowthFi ONLY supports Twitter List URLs (e.g. https://x.com/i/lists/...). CSV files and usernames are not supported.');
      return;
    }
  }

  const freshness = document.getElementById('followerFreshnessSelect')?.value || '1h';
  const sortPriority = document.getElementById('followerSortSelect')?.value || 'active';
  const targetCount = Number(document.getElementById('followerDailyTargetSelect')?.value || 8);

  const likePosts = document.getElementById('followerOptLike')?.checked ?? true;
  const replyPosts = document.getElementById('followerOptComment')?.checked ?? true;
  const repostPosts = document.getElementById('followerOptRepost')?.checked ?? false;
  const autoFollow = document.getElementById('followerOptFollow')?.checked ?? true;

  if (!likePosts && !replyPosts && !repostPosts && !autoFollow) {
    alert('⚠️ Please select at least one action (❤️ Like, 💬 Comment, 🔁 Repost, or ➕ Follow).');
    return;
  }

  // Persist settings
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({
      atomx_follower_settings: {
        nicheVal,
        targetUrl,
        freshness,
        sortPriority,
        targetCount,
        likePosts,
        replyPosts,
        repostPosts,
        autoFollow
      }
    });
  }

  const startBtn = document.getElementById('runFollowerIncreaseBtn');
  const stopBtn = document.getElementById('stopFollowerIncreaseBtn');
  const progressCard = document.getElementById('followerProgressCard');
  const stateBadge = document.getElementById('followerStateBadge');
  const statusText = document.getElementById('followerLiveStatusText');

  state.isAborted = false;
  state.isWorkflowRunning = true;
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (progressCard) progressCard.style.display = 'block';
  if (stateBadge) stateBadge.textContent = 'SCANNING';
  if (statusText) statusText.textContent = 'Opening Twitter List to engage recent posts...';
  updateAgentConsole('⚡ Running', 'GrowthFi active...');

  const doneEl = document.getElementById('followerDoneCount');
  const colEl = document.getElementById('followerCollectedCount');
  const skipEl = document.getElementById('followerSkippedCount');
  const barEl = document.getElementById('followerProgressBar');
  const qInd = document.getElementById('followerQueueIndicator');
  if (doneEl) doneEl.textContent = '0';
  if (colEl) colEl.textContent = String(targetCount);
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '0%';
  if (qInd) qInd.textContent = `Profile 0/${targetCount}`;

  syncFloatingHud(null, {
    title: 'GrowthFi',
    stateBadge: 'SCANNING',
    indicator: `0/${targetCount}`,
    done: 0,
    collected: targetCount,
    skipped: 0,
    progressPercent: 5,
    statusText: 'Opening Twitter List to engage recent posts...'
  });

  const listId = extractTwitterListId(targetUrl);
  const canonicalListUrl = listId ? `https://x.com/i/lists/${listId}` : targetUrl;
  const searchFeedUrl = listId ? `https://x.com/search?q=${encodeURIComponent(`list:${listId} -filter:replies -filter:retweets`)}&f=live` : targetUrl;

  const backendUrl = await getBackendUrl();
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = activeTabs && activeTabs[0]?.id;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'followers',
    title: 'GrowthFi',
    tabId,
    items: [],
    options: {
      feedUrl: searchFeedUrl,
      targetListUrl: canonicalListUrl,
      searchFeedUrl,
      listId,
      targetCount,
      freshness,
      sortPriority,
      likePosts,
      replyPosts,
      repostPosts,
      autoFollow,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  });
}

// =========================================================================
// AGENT 6: REPLY BACK WORKFLOW ENGINE (A6, POSTS, FULLY AUTO)
// =========================================================================
async function startReplyBackLoopWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  const url1 = document.getElementById('myTweetUrlInput1')?.value.trim();
  const url2 = document.getElementById('myTweetUrlInput2')?.value.trim();
  const url3 = document.getElementById('myTweetUrlInput3')?.value.trim();

  const postUrls = [url1, url2, url3].filter(u => u && (u.includes('twitter.com') || u.includes('x.com')));

  if (postUrls.length === 0) {
    alert('⚠️ Please enter at least 1 valid link of your own post/tweet (e.g. https://x.com/yourhandle/status/...).');
    return;
  }

  if (state.credits < 1) {
    alert('⚠️ Insufficient credits!\nYou need at least 1 credit to reply to comments.\nPlease top up in the Credits tab.');
    switchExtTab('credits');
    return;
  }

  const maxComments = Number(document.getElementById('replyBackMaxCountSelect')?.value || 999);
  const tone = document.getElementById('replyBackToneSelect')?.value || 'Natural & Concise';
  const delaySec = Number(document.getElementById('replyBackDelaySelect')?.value || 12);
  const autoLike = document.getElementById('replyBackAutoLikeCheck')?.checked ?? true;

  const startBtn = document.getElementById('runReplyBackBtn');
  const stopBtn = document.getElementById('stopReplyBackBtn');
  const progressCard = document.getElementById('replyBackProgressCard');
  const postInd = document.getElementById('replyBackPostIndicator');
  const stateBadge = document.getElementById('replyBackStateBadge');
  const barEl = document.getElementById('replyBackProgressBar');
  const doneEl = document.getElementById('replyBackDoneCount');
  const queueEl = document.getElementById('replyBackQueueCount');
  const skipEl = document.getElementById('replyBackSkippedCount');
  const statusText = document.getElementById('replyBackLiveStatusText');
  const countdownEl = document.getElementById('replyBackCountdownText');

  state.isAborted = false;
  state.isWorkflowRunning = true;
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (progressCard) progressCard.style.display = 'block';

  syncFloatingHud(null, {
    title: 'ReplyWave',
    stateBadge: 'SCANNING',
    indicator: `Posts 0/${postUrls.length}`,
    done: 0,
    collected: postUrls.length,
    skipped: 0,
    progressPercent: 5,
    statusText: 'Accessing posts & snapshotting comments...'
  });

  if (stateBadge) stateBadge.textContent = 'POSTS_ADDED';
  if (doneEl) doneEl.textContent = '0';
  if (queueEl) queueEl.textContent = '0';
  if (skipEl) skipEl.textContent = '0';
  if (barEl) barEl.style.width = '0%';
  if (countdownEl) countdownEl.style.display = 'none';

  // Load persisted replied comments set (rerun protection)
  let persistedReplied = [];
  try {
    const stored = await chrome.storage.local.get(['atomx_replied_comments']).catch(() => ({}));
    if (Array.isArray(stored?.atomx_replied_comments)) persistedReplied = stored.atomx_replied_comments;
  } catch (e) {}
  const repliedCommentIds = new Set(persistedReplied);

  let totalReplied = 0;
  let totalSkipped = 0;
  let shouldCloseWorkingTab = false;

  // Delegate to background service worker — survives extension popup closing!
  const backendUrl = await getBackendUrl();
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = activeTabs && activeTabs[0]?.id;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'replyback',
    title: 'ReplyWave',
    tabId,
    items: postUrls.map(u => ({ tweetUrl: u })),
    options: {
      delaySec,
      maxReplies: maxComments,
      style: tone,
      autoLike,
      backendUrl,
      verifiedXHandle: (state.verifiedXHandle || '').replace(/^@/, '').trim()
    }
  }, (res) => {
    if (chrome.runtime?.lastError || !res?.ok) {
      runLocalReplyBackLoop();
    }
  });
  return;

  async function runLocalReplyBackLoop() {
  try {
    for (let pIdx = 0; pIdx < postUrls.length; pIdx++) {
      if (state.isAborted) break;

      const currentPostUrl = postUrls[pIdx];
      const postNumberStr = `Post ${pIdx + 1} of ${postUrls.length}`;
      if (postInd) postInd.textContent = `${postNumberStr} (Active)`;
      if (stateBadge) stateBadge.textContent = 'LOADING_COMMENTS';
      if (statusText) statusText.textContent = `[${postNumberStr}] Opening your post: ${currentPostUrl}...`;
      updateAgentConsole('Reply Loop Running', `Accessing ${postNumberStr}: ${currentPostUrl}`);

      replyBackWorkingTabId = await getOrCreateReusedTab(replyBackWorkingTabId, currentPostUrl);
      await waitForTabComplete(replyBackWorkingTabId);
      await sleep(3000);

      if (state.isAborted) break;

      syncFloatingHud(replyBackWorkingTabId, {
        title: 'ReplyWave',
        stateBadge: 'SCANNING',
        indicator: postNumberStr,
        done: totalReplied,
        collected: postUrls.length,
        skipped: totalSkipped,
        progressPercent: Math.round((pIdx / postUrls.length) * 100),
        statusText: `Scanning comments on ${postNumberStr}...`
      });

      if (stateBadge) stateBadge.textContent = 'QUEUE_READY';
      if (statusText) statusText.textContent = `Scanning & hydrating comments snapshot (ignoring newly arriving comments)...`;

      const cycleResult = await new Promise((resolve) => {
        chrome.tabs.sendMessage(replyBackWorkingTabId, {
          type: 'EXECUTE_REPLY_BACK_CYCLE',
          postUrl: currentPostUrl,
          style: tone,
          delaySec,
          maxComments,
          autoLike,
          alreadyRepliedIds: Array.from(repliedCommentIds),
          verifiedXHandle: state.verifiedXHandle
        }, (res) => resolve(res || { success: false, repliedCount: 0 }));
      });

      if (cycleResult?.rateLimited) {
        state.isAborted = true;
        break;
      }

      if (state.isAborted) break;

      if (cycleResult.unauthorizedAccount) {
        alert(cycleResult.error || 'Account lock mismatch detected.');
        return;
      }

      const repliedInThisPost = cycleResult?.repliedCount || 0;
      totalReplied += repliedInThisPost;
      totalSkipped += (cycleResult?.skippedSelf || 0);

      // Persist newly replied comments
      if (Array.isArray(cycleResult?.results)) {
        cycleResult.results.forEach(r => {
          if (r.commentKey) repliedCommentIds.add(r.commentKey);
        });
        await chrome.storage.local.set({ atomx_replied_comments: Array.from(repliedCommentIds) }).catch(() => null);
      }

      // Deduct 1 credit per reply posted
      if (repliedInThisPost > 0) {
        deductCredits(repliedInThisPost);
      }

      if (doneEl) doneEl.textContent = totalReplied;
      if (queueEl) queueEl.textContent = cycleResult?.queuedCount || 0;
      if (skipEl) skipEl.textContent = totalSkipped;

      const postProg = Math.round(((pIdx + 1) / postUrls.length) * 100);
      if (barEl) barEl.style.width = `${postProg}%`;

      syncFloatingHud(replyBackWorkingTabId, {
        title: 'ReplyWave',
        stateBadge: 'PROCESSED',
        indicator: postNumberStr,
        done: totalReplied,
        collected: postUrls.length,
        skipped: totalSkipped,
        progressPercent: postProg,
        statusText: `Completed ${postNumberStr} (Replied: ${repliedInThisPost})`
      });

      if (pIdx < postUrls.length - 1 && !state.isAborted) {
        if (stateBadge) stateBadge.textContent = 'BREAK';
        if (countdownEl) countdownEl.style.display = 'block';
        for (let s = 6; s > 0; s--) {
          if (state.isAborted) break;
          if (statusText) statusText.textContent = `Completed ${postNumberStr}. Taking break before post ${pIdx + 2}...`;
          if (countdownEl) countdownEl.textContent = `⏱️ Next post in ${s}s...`;
          syncFloatingHud(replyBackWorkingTabId, {
            statusText: `Break before post ${pIdx + 2}: ${s}s...`
          });
          await sleep(1000);
        }
        if (countdownEl) countdownEl.style.display = 'none';
      }
    }

    if (!state.isAborted) {
      if (stateBadge) stateBadge.textContent = 'DONE';
      if (barEl) barEl.style.width = '100%';
      if (countdownEl) countdownEl.style.display = 'none';
      if (statusText) statusText.textContent = `✓ Done! Replied to ${totalReplied} comment(s) across ${postUrls.length} post(s).`;
      syncFloatingHud(replyBackWorkingTabId, {
        title: 'ReplyWave',
        stateBadge: 'DONE',
        indicator: `Posts ${postUrls.length}/${postUrls.length}`,
        done: totalReplied,
        collected: postUrls.length,
        skipped: totalSkipped,
        progressPercent: 100,
        statusText: `✓ Done! Replied to ${totalReplied} comment(s).`,
        isStopped: true
      });
      updateAgentConsole('ReplyWave Complete', `Finished replying to community comments with human typing.`);
      alert(`🔄 ReplyWave Cycle Finished!\n\n• Posts Processed: ${postUrls.length}\n• Total Comments Replied: ${totalReplied}\n• Self & Duplicate Comments Skipped: ${totalSkipped}\n• Cost Deducted: ${totalReplied} Credit(s)\n• Action: Liked (❤️) + Contextual Human Letter-by-Letter Typing.`);
    } else {
      if (stateBadge) stateBadge.textContent = 'STOPPED';
      if (statusText) statusText.textContent = 'ReplyWave stopped by user.';
      syncFloatingHud(replyBackWorkingTabId, {
        title: 'ReplyWave',
        stateBadge: 'STOPPED',
        statusText: 'Workflow stopped.',
        isStopped: true
      });
    }
  } catch (err) {
    console.error('Reply Back Loop error:', err);
    if (stateBadge) stateBadge.textContent = 'FAILED';
    alert('Reply Back error: ' + err.message);
  } finally {
    if (startBtn) startBtn.style.display = 'block';
    if (stopBtn) stopBtn.style.display = 'none';
    if (countdownEl) countdownEl.style.display = 'none';
    }
  }
}

// =========================================================================
// AGENT 7: AUTO UNFOLLOW STANDALONE WORKFLOW ENGINE (A7, SAFETY)
// =========================================================================
async function startAutoUnfollowWorkflow() {
  if (!(await ensureVerifiedAccountOrBlock())) return;

  const notFollowing = document.getElementById('unfollowCriteriaNotFollowing')?.checked ?? true;
  const lowScore = document.getElementById('unfollowCriteriaLowScore')?.checked ?? false;

  if (!notFollowing && !lowScore) {
    alert('⚠️ Please select at least one criteria:\n• Does Not Follow Back\n• Low Wallchain / Influence Score');
    return;
  }

  if (state.credits < 1) {
    alert('⚠️ Insufficient credits!\nYou need at least 1 credit for unfollow operations (1 credit per 5 unfollows).\nPlease top up in the Credits tab.');
    switchExtTab('credits');
    return;
  }

  const targetLimit = Number(document.getElementById('unfollowMaxCountInput')?.value || document.getElementById('unfollowMaxCount')?.value || 25);
  const scoreThreshold = Number(document.getElementById('unfollowScoreThresholdInput')?.value || 30);
  const rawWhitelist = document.getElementById('unfollowWhitelistInput')?.value || '';
  const whitelistList = rawWhitelist.split(/[,\n]/).map(w => w.trim()).filter(Boolean);

  // Read centralized Global Safety controls
  const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
  const safety = safetyRes?.atomx_safety_settings || {};
  const delaySec = Math.max(3, Number(safety.profileWait) || 15);
  const batchCount = Math.max(2, Number(safety.batchCount) || 15);
  const breakDuration = Math.max(5, Number(safety.restDuration ? safety.restDuration * 60 : 0) || 60);

  const startBtn = document.getElementById('runAutoUnfollowBtn');
  const stopBtn = document.getElementById('stopAutoUnfollowBtn');
  const pauseBtn = document.getElementById('pauseAutoUnfollowBtn');
  const skipBtn = document.getElementById('skipAutoUnfollowBtn');
  const progressCard = document.getElementById('unfollowProgressCard');
  const stateBadge = document.getElementById('unfollowStateBadge');
  const barEl = document.getElementById('unfollowProgressBar');
  const progressText = document.getElementById('unfollowProgressText');
  const doneEl = document.getElementById('unfollowCountDone');
  const skipEl = document.getElementById('unfollowCountSkipped');
  const failEl = document.getElementById('unfollowCountFailed');
  const statusText = document.getElementById('unfollowLiveStatusText');
  const countdownEl = document.getElementById('unfollowCountdownText');

  state.isAborted = false;
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (pauseBtn) pauseBtn.style.display = 'inline-block';
  if (skipBtn) skipBtn.style.display = 'inline-block';
  if (progressCard) progressCard.style.display = 'block';

  if (stateBadge) stateBadge.textContent = 'RUNNING';
  if (doneEl) doneEl.textContent = '0';
  if (skipEl) skipEl.textContent = '0';
  if (failEl) failEl.textContent = '0';
  if (barEl) barEl.style.width = '0%';
  if (progressText) progressText.textContent = `0 / ${targetLimit}`;
  if (countdownEl) countdownEl.style.display = 'none';
  if (statusText) statusText.textContent = 'Connecting to Following list...';

  let verifiedHandle = (state.verifiedXHandle || state.user?.handle || '').replace(/^@/, '').trim();
  if (!verifiedHandle) {
    const stored = await chrome.storage.local.get(['verifiedXHandle']).catch(() => ({}));
    if (stored?.verifiedXHandle) verifiedHandle = stored.verifiedXHandle.replace(/^@/, '').trim();
  }
  if (!verifiedHandle) {
    const twitterTabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }).catch(() => []);
    if (twitterTabs && twitterTabs[0]?.id) {
      const probeRes = await safeSendTabMessage(twitterTabs[0].id, { type: 'CHECK_CURRENT_LOGGED_IN_X_HANDLE' });
      if (probeRes?.rawHandle) {
        verifiedHandle = probeRes.rawHandle.replace(/^@/, '').trim();
        state.verifiedXHandle = verifiedHandle;
        chrome.storage.local.set({ verifiedXHandle });
      }
    }
  }

  const followingUrl = verifiedHandle ? `https://x.com/${verifiedHandle}/following` : '';

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tabId = activeTabs && activeTabs[0]?.id;

  chrome.runtime.sendMessage({
    type: 'BG_START_AGENT_WORKFLOW',
    agentId: 'unfollow',
    title: 'Auto Unfollow',
    tabId,
    items: [],
    options: {
      feedUrl: followingUrl,
      targetLimit,
      targetCount: targetLimit,
      delaySec,
      batchCount,
      breakDuration,
      criteria: { notFollowing, lowScore },
      scoreThreshold,
      whitelist: whitelistList,
      verifiedXHandle: verifiedHandle,
      style: state.selectedTone || 'Bullish (5-10 words)',
      stylePrompt: state.selectedTonePrompt || null
    }
  });
}

// =============================================================
// AGENT STATUS, KILLSWITCH & MAINTENANCE CONTROLS
// =============================================================

async function initAgentStatusSystem() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(['atomx_agent_status_map']).catch(() => ({}));
      if (stored?.atomx_agent_status_map) {
        state.agentStatusMap = stored.atomx_agent_status_map;
        applyAgentStatusToBentoUI(state.agentStatusMap);
      }
    }
  } catch (e) {}

  // Fetch immediately in background
  refreshAgentStatusFromBackend().catch(console.warn);

  // Poll status every 20 seconds while popup is active
  setInterval(() => {
    refreshAgentStatusFromBackend().catch(() => null);
  }, 20000);
}

async function refreshAgentStatusFromBackend() {
  try {
    const backendUrl = await getBackendUrl();
    const res = await fetch(`${backendUrl}/api/agents/status?_t=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      if (data && data.agents) {
        state.agentStatusMap = data.agents;
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          await chrome.storage.local.set({ atomx_agent_status_map: data.agents }).catch(() => null);
        }
        applyAgentStatusToBentoUI(data.agents);
        if (state.currentDetailAgentId) {
          updateDetailViewMaintenanceBanner(state.currentDetailAgentId);
        }
      }
    }
  } catch (e) {
    console.warn('[AgentStatus] Sync error:', e);
  }
}

function applyAgentStatusToBentoUI(statusMap) {
  if (!statusMap || typeof statusMap !== 'object') return;

  document.querySelectorAll('.bento-card[data-agent-id]').forEach(card => {
    const agentId = card.dataset.agentId;
    const info = statusMap[agentId];
    const isOff = info && info.enabled === false;

    let badge = card.querySelector('.bento-top .badge-mini');
    let actionEl = card.querySelector('.bento-action');

    if (isOff) {
      card.setAttribute('data-admin-disabled', 'true');
      card.style.borderColor = 'rgba(239, 68, 68, 0.45)';
      card.style.background = 'linear-gradient(180deg, rgba(239,68,68,0.06) 0%, rgba(15,23,42,0.6) 100%)';
      
      if (badge) {
        if (!badge.dataset.originalBadgeText) {
          badge.dataset.originalBadgeText = badge.textContent;
          badge.dataset.originalBadgeClass = badge.className;
        }
        badge.textContent = 'OFFLINE';
        badge.className = 'badge-mini';
        badge.style.background = '#EF4444';
        badge.style.color = '#FFFFFF';
        badge.style.fontWeight = '700';
      }

      if (actionEl) {
        if (!actionEl.dataset.originalActionText) {
          actionEl.dataset.originalActionText = actionEl.textContent;
        }
        actionEl.innerHTML = `<span style="color:#EF4444; font-weight:700;">🛑 Maintenance Notice ➔</span>`;
      }
    } else {
      card.removeAttribute('data-admin-disabled');
      card.style.borderColor = '';
      card.style.background = '';

      if (badge && badge.dataset.originalBadgeText) {
        badge.textContent = badge.dataset.originalBadgeText;
        badge.className = badge.dataset.originalBadgeClass || 'badge-mini';
        badge.style.background = '';
        badge.style.color = '';
        badge.style.fontWeight = '';
      }

      if (actionEl && actionEl.dataset.originalActionText) {
        actionEl.textContent = actionEl.dataset.originalActionText;
      }
    }
  });
}

function updateDetailViewMaintenanceBanner(agentId) {
  if (!agentId) return;
  const statusInfo = state.agentStatusMap ? state.agentStatusMap[agentId] : null;
  const banner = document.getElementById('agentMaintenanceBanner');
  const reasonEl = document.getElementById('agentMaintenanceReason');
  const isOff = statusInfo && statusInfo.enabled === false;

  const launchBtnMap = {
    telegram: 'runTgEngageBtn',
    audience: 'runAudienceBuilderBtn',
    sorsa: 'runSorsaBoosterBtn',
    followers: 'runFollowerIncreaseBtn',
    replyback: 'runReplyBackBtn',
    unfollow: 'runAutoUnfollowBtn',
    creators: 'runCreatorRadarBtn',
    defaulter: 'startDefaulterAuditBtn',
    reciprocator: 'runReciprocatorBtn',
    feedengager: 'runFeedEngagerBtn',
    nicheengager: 'runNicheEngagerBtn',
    tgliker: 'runTgLikerBtn'
  };

  const btnId = launchBtnMap[agentId];
  const btn = btnId ? document.getElementById(btnId) : null;

  if (isOff) {
    const rawReason = (statusInfo.reason && typeof statusInfo.reason === 'string') ? statusInfo.reason.trim() : '';
    const reasonText = rawReason || 'This agent is currently paused by administrator for scheduled maintenance or algorithmic updates. Please check back soon.';

    if (banner) {
      banner.style.display = 'block';
    }
    if (reasonEl) {
      reasonEl.innerHTML = `<strong>Reason:</strong> ${escapeHtml(reasonText)}`;
    }

    if (btn) {
      if (!btn.dataset.originalHtml) {
        btn.dataset.originalHtml = btn.innerHTML;
      }
      btn.disabled = true;
      btn.style.opacity = '0.55';
      btn.style.cursor = 'not-allowed';
      btn.title = `Disabled by Admin: ${reasonText}`;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 🔒 Offline (Admin Disabled)`;
    }

    updateAgentConsole('Agent Offline (Disabled)', `🛑 Admin Notice: ${reasonText}`);
  } else {
    if (banner) {
      banner.style.display = 'none';
    }
    if (btn) {
      if (btn.disabled && btn.dataset.originalHtml) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.title = '';
        btn.innerHTML = btn.dataset.originalHtml;
      }
    }
  }
}

function ensureAgentEnabledOrBlock(agentId) {
  if (!agentId) return true;
  const statusInfo = state.agentStatusMap ? state.agentStatusMap[agentId] : null;
  if (statusInfo && statusInfo.enabled === false) {
    const rawReason = (statusInfo.reason && typeof statusInfo.reason === 'string') ? statusInfo.reason.trim() : '';
    const reasonText = rawReason || 'This agent is currently paused by administrator for scheduled maintenance.';
    alert(`🛑 Agent Temporarily Offline\n\nAgent: ${statusInfo.name || agentId}\nStatus: Disabled by Administrator\nReason: ${reasonText}\n\nPlease check back later.`);
    return false;
  }
  return true;
}

function openAgentDetailView(agentId) {
  state.currentDetailAgentId = agentId;
  const meta = AGENT_META[agentId] || { title: agentId, icon: '⚡', badge: 'AUTO', desc: '' };
  const titleEl = document.getElementById('detailAgentTitle');
  const iconEl = document.getElementById('detailAgentIcon');
  const badgeEl = document.getElementById('detailAgentBadge');
  const descEl = document.getElementById('detailAgentDesc');

  if (titleEl) titleEl.textContent = meta.title;
  if (iconEl) iconEl.textContent = meta.icon;
  if (badgeEl) {
    badgeEl.textContent = meta.badge;
    badgeEl.className = `badge-mini ${meta.badge.toLowerCase().replace(/[^a-z]/g, '')}`;
  }
  if (descEl) descEl.textContent = meta.desc;

  // Show only matching panel
  document.querySelectorAll('.agent-panel-content').forEach(p => {
    const isTarget = p.id === `panel-agent-${agentId}`;
    p.classList.toggle('active', isTarget);
    p.style.display = isTarget ? 'flex' : 'none';
  });

  // Toggle views
  const bentoView = document.getElementById('agentsBentoView');
  const detailView = document.getElementById('agentDetailView');
  if (bentoView) bentoView.style.display = 'none';
  if (detailView) detailView.style.display = 'flex';

  // Refresh dropdowns with latest lists when entering workspace
  if (agentId === 'audience') {
    populateAudienceSelect();
  } else if (agentId === 'sorsa') {
    initSorsaScoreSystem();
  } else if (agentId === 'followers') {
    initFollowersListsSystem();
  }

  updateAgentConsole('Ready to Launch', `Workspace loaded for ${meta.title}. Set parameters above.`);

  // Update maintenance banner and button lock based on admin status
  updateDetailViewMaintenanceBanner(agentId);
}

function closeAgentDetailView() {
  state.currentDetailAgentId = null;
  const bentoView = document.getElementById('agentsBentoView');
  const detailView = document.getElementById('agentDetailView');
  if (detailView) detailView.style.display = 'none';
  if (bentoView) bentoView.style.display = 'flex';
}

function updateAgentConsole(status, log) {
  const st = document.getElementById('agentConsoleStatus');
  const out = document.getElementById('agentConsoleOutput');
  if (st) st.textContent = status;
  if (out) out.textContent = log;
}

async function deductCredits(amount = 1, action = 'AI Reply', reason = 'Autonomous action') {
  const num = Math.max(1, parseInt(amount, 10) || 1);
  state.credits = Math.max(0, state.credits - num);
  if (state.user) state.user.credits = state.credits;
  updateCreditUI();
  chrome.storage?.local.set({ credits: state.credits, user: state.user, currentUser: state.user });

  // Atomic cloud persistence & ledger audit logging in Supabase
  try {
    const backendUrl = await getBackendUrl();
    const cleanHandle = (state.verifiedXHandle || state.user?.handle || '').replace(/^@/, '').trim();
    const email = (state.user?.email || '').trim();
    const userId = state.user?.id;

    if (cleanHandle || email || userId) {
      const reqHeaders = { 'Content-Type': 'application/json' };
      if (state.authToken) reqHeaders['Authorization'] = `Bearer ${state.authToken}`;
      const res = await fetch(`${backendUrl}/api/credits/deduct`, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({
          userId,
          handle: cleanHandle,
          email,
          amount: num,
          action,
          reason
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.balance === 'number') {
          state.credits = data.balance;
          if (state.user) state.user.credits = data.balance;
          updateCreditUI();
          chrome.storage?.local.set({ credits: state.credits, user: state.user, currentUser: state.user });
        }
      }
    }
  } catch (err) {
    console.warn('[ATOMX] Server credit deduction warning:', err);
  }
}

// Fetch live models for selected provider
async function fetchLiveModels() {
  const prov = state.selectedProvider;
  const btn = document.getElementById('extFetchModelsBtn');
  if (btn) btn.textContent = '...';

  try {
    const backendUrl = await getBackendUrl();
    const res = await fetch(`${backendUrl}/api/providers/${prov}/models`);
    if (res.ok) {
      const data = await res.json();
      if (data.models && data.models.length > 0) {
        state.modelsCache[prov] = data.models;
        updateModelSelectOptions(prov);
        alert(`✓ Fetched ${data.models.length} live models from ${prov.toUpperCase()}!`);
      }
    }
  } catch (e) {
    console.warn('Fallback to local model list');
  } finally {
    if (btn) btn.textContent = '↻';
  }
}

function updateModelSelectOptions(prov) {
  const select = document.getElementById('modelSelect');
  if (!select) return;
  const list = state.modelsCache[prov] || [];
  select.innerHTML = list.map(m => `<option value="${m.id}">${m.name || m.id}</option>`).join('');
  if (list.length > 0) state.selectedModel = list[0].id;
}

// Crypto Tx Verification
function handleVerifyCryptoTx() {
  const tx = document.getElementById('extTxHashInput')?.value.trim();
  if (!tx) {
    alert('Please enter your Transaction Hash (Tx Hash).');
    return;
  }
  const amt = Number(document.getElementById('extCryptoAmt')?.value || 10);
  const creditsToAdd = amt * 1000;
  state.credits += creditsToAdd;
  updateCreditUI();
  chrome.storage?.local.set({ credits: state.credits });
  alert(`✓ Transaction Hash Verified!\nAdded ${creditsToAdd.toLocaleString()} credits to your account.`);
  document.getElementById('extTxHashInput').value = '';
}

// Purge entire local user session and return to clean slate
async function purgeExtLocalUserSession() {
  state.user = null;
  state.verifiedXHandle = '';
  state.activeTwitterHandle = null;
  state.credits = 0;
  state.userPlan = 'Free Plan';
  state.pendingRequest = null;

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.remove([
        'currentUser', 'user', 'authToken', 'verifiedXHandle', 'pendingRequest', 'credits', 'userPlan'
      ]);
    } catch (e) {}
  }

  updateCreditUI();
  await checkAccountVerificationLock();
  switchExtTab('access');
  showAccessSubView('request');
}

// Load credits & server state
async function loadServerState() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get([
        'credits', 'accessKey', 'creators', 'engagedTweetIds', 'userPlan',
        'currentUser', 'user', 'authToken', 'verifiedXHandle', 'pendingRequest'
      ]).catch(() => ({}));
      if (stored?.currentUser || stored?.user) state.user = stored.currentUser || stored.user;
      if (stored?.authToken) state.authToken = stored.authToken;
      if (stored?.pendingRequest) state.pendingRequest = stored.pendingRequest;
      if (stored?.verifiedXHandle) {
        state.verifiedXHandle = stored.verifiedXHandle;
      } else if (state.user?.handle) {
        state.verifiedXHandle = state.user.handle;
      }
      if (stored?.credits !== undefined && state.user) {
        state.credits = stored.credits;
      } else if (!state.user) {
        state.credits = 0;
      }
      if (stored?.accessKey) state.accessKey = stored.accessKey;
      if (stored?.userPlan) state.userPlan = stored.userPlan;
      if (Array.isArray(stored?.creators)) state.creators = stored.creators;
      if (Array.isArray(stored?.engagedTweetIds)) state.engagedTweetIds = stored.engagedTweetIds;
    }
  } catch (err) {
    console.warn('Error reading local cache:', err);
  }

  // Instant UI render from local cache
  updateCreditUI();
  renderCreatorChips();
  updateTgParseSummaryUI?.();

  // If there's an alleged user session or pending request, verify directly with server!
  if (state.user || state.verifiedXHandle || state.pendingRequest) {
    await syncServerStateNetwork();
  } else {
    await checkAccountVerificationLock();
    switchExtTab('access');
  }
}

async function syncServerStateNetwork() {
  try {
    const backendUrl = await getBackendUrl();
    const cleanHandle = (state.verifiedXHandle || state.user?.handle || state.pendingRequest?.handle || '').replace(/^@/, '').trim();
    const email = (state.user?.email || state.pendingRequest?.email || '').trim();

    // Check live status on server
    let stData = null;
    if (cleanHandle || email) {
      try {
        const stRes = await fetch(`${backendUrl}/api/auth/check-status?handle=${encodeURIComponent(cleanHandle)}&email=${encodeURIComponent(email)}`, { credentials: 'omit' });
        if (stRes.ok) {
          stData = await stRes.json();
        } else if (stRes.status === 404) {
          stData = { status: 'NOT_FOUND' };
        }
      } catch (e) {
        console.log('[ATOMX] Status verify notice:', e);
      }
    }

    // IF SERVER CONFIRMS USER IS NOT FOUND (DATA WIPED FRESH), PURGE LOCAL CACHE IMMEDIATELY!
    if (stData && (stData.status === 'NOT_FOUND' || stData.status === 'REJECTED')) {
      console.log('[ATOMX] User account not found on server (wiped/fresh). Resetting extension session.');
      await purgeExtLocalUserSession();
      return;
    }

    // IF SERVER CONFIRMS USER IS SUSPENDED, LOCK IMMEDIATELY!
    if (stData?.status === 'SUSPENDED') {
      console.warn('[ATOMX] Account is SUSPENDED by administrator. Halting all activities.');
      if (!state.user) {
        state.user = { handle: stData.handle || `@${cleanHandle}`, email: stData.email || email, status: 'SUSPENDED' };
      } else {
        state.user.status = 'SUSPENDED';
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ user: state.user, currentUser: state.user });
      }
      // Stop all background automation or active bot cycles
      try {
        if (typeof stopAudienceBuilder === 'function') stopAudienceBuilder();
        if (typeof stopSorsaCycle === 'function') stopSorsaCycle();
        if (typeof stopFollowerCycle === 'function') stopFollowerCycle();
      } catch(e) {}
      await checkAccountVerificationLock();
      return;
    }

    if (stData?.status === 'PENDING') {
      state.user = null;
      state.verifiedXHandle = '';
      state.pendingRequest = { handle: stData.handle || `@${cleanHandle}`, email: stData.email || email };
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.remove(['currentUser', 'user', 'authToken', 'verifiedXHandle']);
        await chrome.storage.local.set({ pendingRequest: state.pendingRequest });
      }
      updateCreditUI();
      await checkAccountVerificationLock();
      return;
    }

    if (stData?.status === 'ACTIVE' || stData?.status === 'APPROVED') {
      if (!state.user) {
        state.user = {
          handle: stData.handle || `@${cleanHandle}`,
          email: stData.email || email,
          fullName: stData.fullName || 'Verified Member',
          status: 'ACTIVE',
          credits: stData.credits !== undefined ? stData.credits : 100,
          plan: stData.plan || 'Free Plan'
        };
      } else {
        state.user.status = 'ACTIVE';
        if (typeof stData.credits === 'number') state.user.credits = stData.credits;
        if (stData.plan) state.user.plan = stData.plan;
      }
      state.credits = state.user.credits || 0;
      state.userPlan = state.user.plan || 'Free Plan';
      state.verifiedXHandle = state.user.handle || `@${cleanHandle}`;

      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({
          user: state.user,
          currentUser: state.user,
          credits: state.credits,
          userPlan: state.userPlan,
          verifiedXHandle: state.verifiedXHandle
        });
      }
    }

    // Parallel balance and engaged tweets sync for this specific verified account
    const balUrl = `${backendUrl}/api/credits/balance?handle=${encodeURIComponent(cleanHandle)}&email=${encodeURIComponent(email)}`;
    const engUrl = `${backendUrl}/api/tweets/engaged?handle=${encodeURIComponent(cleanHandle)}`;
    const [balRes, engRes] = await Promise.allSettled([
      fetch(balUrl, { credentials: 'omit' }),
      fetch(engUrl, { credentials: 'omit' })
    ]);

    if (balRes.status === 'fulfilled') {
      if (balRes.value?.status === 404 && state.user) {
        await purgeExtLocalUserSession();
        return;
      }
      if (balRes.value?.ok) {
        const data = await balRes.value.json().catch(() => ({}));
        if (typeof data.credits === 'number') {
          state.credits = data.credits;
          chrome.storage?.local.set({ credits: state.credits });
        }
        if (data.plan) {
          state.userPlan = data.plan;
          chrome.storage?.local.set({ userPlan: data.plan });
        }
      }
    }

    if (engRes.status === 'fulfilled' && engRes.value?.ok) {
      const engData = await engRes.value.json().catch(() => ({}));
      if (Array.isArray(engData.engagedIds) && engData.engagedIds.length > 0) {
        state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), ...engData.engagedIds]));
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.set({ engagedTweetIds: state.engagedTweetIds });
        }
        updateTgParseSummaryUI?.();
      }
    }

    updateCreditUI();
    await checkAccountVerificationLock();
  } catch (err) {
    console.warn('Background server sync offline:', err);
    updateCreditUI();
    await checkAccountVerificationLock();
  }
}

/**
 * Switch between the 7 Access sub-views inside Tab 5
 */
function showAccessSubView(viewName) {
  const views = {
    'loggedIn': document.getElementById('extLoggedInCard'),
    'request': document.getElementById('extRequestAccessView'),
    'lookup': document.getElementById('extCheckStatusLookupView'),
    'pending': document.getElementById('extPendingApprovalView'),
    'rejected': document.getElementById('extRejectedView'),
    'setPassword': document.getElementById('extSetPasswordView'),
    'login': document.getElementById('extLoggedOutCard'),
    'reset': document.getElementById('extResetPasswordView'),
    'suspended': document.getElementById('extSuspendedView')
  };

  Object.entries(views).forEach(([k, el]) => {
    if (el) el.style.display = (k === viewName) ? 'block' : 'none';
  });

  if (viewName === 'reset') {
    const fc = document.getElementById('extForgotFormContainer');
    const sb = document.getElementById('extForgotSuccessBox');
    if (fc) fc.style.display = 'block';
    if (sb) sb.style.display = 'none';
  }
}

/**
 * 1-to-1 Verified Twitter / X Identity Verification Engine
 */
async function checkAccountVerificationLock() {
  const verifiedHandle = (state.verifiedXHandle || state.user?.handle || '').replace(/^@/, '').toLowerCase().trim();
  const barText = document.getElementById('barVerifiedHandleText');
  const barBadge = document.getElementById('barMatchBadge');
  const barDot = document.getElementById('barLockDot');
  const mismatchBanner = document.getElementById('accountMismatchBanner');
  const mismatchExpected = document.getElementById('mismatchExpectedHandle');
  const mismatchActual = document.getElementById('mismatchActualHandle');
  const tabsNav = document.getElementById('extTabsNav');
  const verifiedBar = document.getElementById('verifiedAccountBar');

  // Check if account status is SUSPENDED
  const isSuspended = state.user && (state.user.status || '').toUpperCase() === 'SUSPENDED';

  if (isSuspended) {
    if (tabsNav) tabsNav.style.display = 'none';
    if (verifiedBar) verifiedBar.style.display = 'none';
    if (mismatchBanner) mismatchBanner.style.display = 'none';

    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-access')?.classList.add('active');

    const suspHandle = document.getElementById('extSuspendedHandleDisplay');
    if (suspHandle) suspHandle.textContent = verifiedHandle ? `@${verifiedHandle}` : (state.user?.handle || '@user');

    showAccessSubView('suspended');
    return { isAllowed: false, reason: 'ACCOUNT_SUSPENDED' };
  }

  // Case 1: User is NOT authenticated or user does not exist on server
  const isInvalidUser = !state.user || state.user.status === 'NOT_FOUND' || !verifiedHandle;
  if (isInvalidUser) {
    if (tabsNav) tabsNav.style.display = 'none';
    if (verifiedBar) verifiedBar.style.display = 'none';
    if (mismatchBanner) mismatchBanner.style.display = 'none';

    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-access')?.classList.add('active');

    if (state.pendingRequest) {
      if (state.pendingRequest.status === 'REJECTED') {
        const rejDisp = document.getElementById('extRejectedHandleDisplay');
        if (rejDisp) rejDisp.textContent = state.pendingRequest.handle;
        showAccessSubView('rejected');
      } else {
        const pHandleDisplay = document.getElementById('extPendingHandleDisplay');
        const pHandleText = document.getElementById('extPendingHandleText');
        const pEmailText = document.getElementById('extPendingEmailText');
        const pTelegramText = document.getElementById('extPendingTelegramText');
        if (pHandleDisplay) pHandleDisplay.textContent = state.pendingRequest.handle;
        if (pHandleText) pHandleText.textContent = state.pendingRequest.handle;
        if (pEmailText) pEmailText.textContent = state.pendingRequest.email || '--';
        if (pTelegramText) pTelegramText.textContent = state.pendingRequest.telegram || '--';
        showAccessSubView('pending');
        handleExtCheckStatus(false);
      }
    } else {
      showAccessSubView('request');
    }

    return { isAllowed: false, reason: 'NOT_AUTHENTICATED' };
  }

  // Case 2: User is authenticated & Active
  if (tabsNav) tabsNav.style.display = 'flex';
  if (verifiedBar) verifiedBar.style.display = 'flex';

  showAccessSubView('loggedIn');

  const displayHandle = verifiedHandle ? `@${verifiedHandle}` : '@user';
  if (barText) barText.textContent = displayHandle;
  const extHandleText = document.getElementById('extHandleText');
  if (extHandleText) extHandleText.textContent = displayHandle;
  const extName = document.getElementById('extLoggedInName');
  if (extName) extName.textContent = state.user?.fullName || state.user?.name || 'Verified Member';
  const extPlan = document.getElementById('extLoggedInPlan');
  if (extPlan) extPlan.textContent = state.user?.plan || state.userPlan || 'Growth Plan';
  const extCredits = document.getElementById('extLoggedInCredits');
  if (extCredits) extCredits.textContent = `${(state.credits || 0).toLocaleString()} Credits`;


  // Real-time tab check with active Twitter/X tab
  try {
    const checkTab = await getActiveTwitterTab();
    if (checkTab && checkTab.id) {
      const response = await chrome.tabs.sendMessage(checkTab.id, { type: 'CHECK_CURRENT_LOGGED_IN_X_HANDLE' }).catch(() => null);
      if (response && typeof response === 'object') {
        const currentHandle = (response.rawHandle || '').toLowerCase().trim();
        if (isValidTwitterHandle(currentHandle)) {
          state.activeTwitterHandle = currentHandle;
          if (currentHandle !== verifiedHandle) {
            // Definite Mismatch: Active tab is logged into a different valid account
            if (mismatchBanner) {
              mismatchBanner.style.display = 'block';
              if (mismatchExpected) mismatchExpected.textContent = displayHandle;
              if (mismatchActual) mismatchActual.textContent = `@${currentHandle}`;
            }
            if (barBadge) {
              barBadge.textContent = 'ID MISMATCH';
              barBadge.style.color = '#EF4444';
              barBadge.style.background = 'rgba(239, 68, 68, 0.15)';
            }
            if (barDot) barDot.style.background = '#EF4444';
            return { isAllowed: false, reason: 'ID_MISMATCH', current: currentHandle };
          }
        } else if (response.isDefinitelyLoggedOut === true) {
          // Twitter page is open and definitely logged out
          if (mismatchBanner) {
            mismatchBanner.style.display = 'block';
            if (mismatchExpected) mismatchExpected.textContent = displayHandle;
            if (mismatchActual) mismatchActual.textContent = 'Not Logged In on X';
          }
          if (barBadge) {
            barBadge.textContent = 'NOT LOGGED IN ON X';
            barBadge.style.color = '#EF4444';
            barBadge.style.background = 'rgba(239, 68, 68, 0.15)';
          }
          if (barDot) barDot.style.background = '#EF4444';
          return { isAllowed: false, reason: 'X_NOT_LOGGED_IN' };
        } else {
          // Active authenticated session on Twitter (e.g. Mobile browser where drawer is collapsed)
          state.activeTwitterHandle = verifiedHandle;
          if (mismatchBanner) mismatchBanner.style.display = 'none';
          chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
        }
      } else {
        // Content script not yet attached or mobile tab response pending — trust verified handle
        state.activeTwitterHandle = verifiedHandle;
        if (mismatchBanner) mismatchBanner.style.display = 'none';
        chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
      }
    } else {
      // No active Twitter tab detected — trust verified handle
      state.activeTwitterHandle = verifiedHandle;
      if (mismatchBanner) mismatchBanner.style.display = 'none';
      chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
    }
  } catch (e) {
    state.activeTwitterHandle = verifiedHandle;
  }

  // Matched and locked
  if (mismatchBanner) mismatchBanner.style.display = 'none';
  if (barBadge) {
    barBadge.textContent = '1-TO-1 LOCKED & MATCHED';
    barBadge.style.color = '#10B981';
    barBadge.style.background = 'rgba(16, 185, 129, 0.15)';
  }
  if (barDot) barDot.style.background = '#10B981';
  chrome.storage.local.remove('atomx_account_lock_warning').catch(() => null);
  return { isAllowed: true };
}

async function ensureVerifiedAccountOrBlock() {
  const check = await checkAccountVerificationLock();
  if (!check.isAllowed) {
    if (check.reason === 'NOT_AUTHENTICATED') {
      alert('⚠️ Access Required:\nPlease submit an access request or sign in with your approved X ID in the "Access" tab to unlock this extension.');
      switchExtTab('access');
    } else if (check.reason === 'ID_MISMATCH') {
      alert(`⚠️ Account Lock Mismatch!\n\nThis extension is strictly bound to your verified Twitter account: @${(state.verifiedXHandle || '').replace(/^@/, '')}.\nYour browser is currently logged into @${check.current} on Twitter.\n\nPlease log into @${(state.verifiedXHandle || '').replace(/^@/, '')} on x.com to use this extension.`);
    } else if (check.reason === 'X_NOT_LOGGED_IN') {
      alert(`⚠️ Twitter Session Inactive:\nPlease log into your verified Twitter account (@${(state.verifiedXHandle || '').replace(/^@/, '')}) on x.com before launching automation.`);
    }
    return false;
  }

  // Check if Twitter Daily Post Limit or Rate Limit is currently active
  try {
    const limits = await new Promise(r => chrome.storage.local.get(['atomx_daily_post_limit', 'atomx_rate_limited'], r));
    const dailyLimit = limits?.atomx_daily_post_limit;
    const rateLimit = limits?.atomx_rate_limited;
    if (dailyLimit?.active) {
      const proceed = confirm(`🛑 Twitter Daily Post Limit Detected!\n\nTwitter previously flagged your account with:\n"${dailyLimit.reason || "You've hit the daily post limit. Subscribe to Premium for higher limits."}"\n\nStarting automation now may fail or risk account suspension.\n\nDo you want to ignore and force proceed anyway?`);
      if (!proceed) return false;
      // If user confirms, clear limit flag so they can proceed
      chrome.storage.local.remove(['atomx_daily_post_limit', 'atomx_rate_limited']).catch(() => null);
    } else if (rateLimit?.active) {
      const proceed = confirm(`🛑 Twitter Rate Limit Detected!\n\nTwitter previously flagged:\n"${rateLimit.reason || 'Rate limit active'}"\n\nDo you want to ignore and force proceed anyway?`);
      if (!proceed) return false;
      chrome.storage.local.remove(['atomx_rate_limited']).catch(() => null);
    }
  } catch (e) {}

  return true;
}

/**
 * Handle in-extension Access Request Submission
 */
async function handleExtSubmitRequest() {
  const nameInput = document.getElementById('extReqFullNameInput');
  const emailInput = document.getElementById('extReqEmailInput');
  const telegramInput = document.getElementById('extReqTelegramInput');
  const handleInput = document.getElementById('extReqHandleInput');
  const refInput = document.getElementById('extReqReferredByInput');
  const btn = document.getElementById('extSubmitRequestBtn');

  const fullName = nameInput?.value.trim();
  const email = emailInput?.value.trim();
  let telegram = telegramInput?.value.trim() || '';
  let handle = handleInput?.value.trim();
  let referredBy = refInput?.value.trim() || '';

  if (!fullName) {
    alert('Please enter your full name.');
    return;
  }
  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address.');
    return;
  }
  if (!telegram) {
    alert('Please enter your Telegram ID (e.g. @username). All 3 fields (X ID, Email, Telegram) are strictly required.');
    return;
  }
  if (!handle) {
    alert('Please enter your real Twitter / X ID (e.g. @mythopair).');
    return;
  }

  if (!handle.startsWith('@')) handle = '@' + handle;
  if (telegram && !telegram.startsWith('@')) telegram = '@' + telegram;
  if (referredBy && !referredBy.startsWith('@')) referredBy = '@' + referredBy;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Submitting Request...';
  }


  try {
    const res = await fetchApiWithFallback('/api/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        fullName, 
        email, 
        telegram, 
        handle, 
        xHandle: handle, 
        referredBy, 
        useCase: `Chrome Extension Access Request${referredBy ? ` | REF:${referredBy}` : ''}` 
      })
    }, 12000);

    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 201) {
      if (data.alreadyApproved || (data.error && data.error.includes('already registered'))) {
        alert(`✓ Account Already Approved:\n\n${handle} is already approved!\nPlease sign in directly with your password.`);
        const loginInput = document.getElementById('extLoginHandleInput');
        if (loginInput) loginInput.value = handle;
        showAccessSubView('login');
        const loginAlert = document.getElementById('extLoginAlert');
        if (loginAlert) {
          loginAlert.style.display = 'block';
          loginAlert.style.background = 'rgba(16,185,129,0.12)';
          loginAlert.style.color = 'var(--status-success)';
          loginAlert.style.border = '1px solid rgba(16,185,129,0.3)';
          loginAlert.textContent = `✓ Account ${handle} is already approved and registered! Please sign in with your password.`;
        }
        return;
      }
      throw new Error(data.error || 'Failed to submit request');
    }

    const pendingData = {
      fullName,
      email,
      telegram,
      handle,
      referredBy,
      status: 'PENDING',
      requestedAt: Date.now()
    };
    state.pendingRequest = pendingData;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ pendingRequest: pendingData });
    }

    // Update pending view text
    const pHandleDisplay = document.getElementById('extPendingHandleDisplay');
    const pHandleText = document.getElementById('extPendingHandleText');
    const pEmailText = document.getElementById('extPendingEmailText');
    const pTelegramText = document.getElementById('extPendingTelegramText');
    if (pHandleDisplay) pHandleDisplay.textContent = handle;
    if (pHandleText) pHandleText.textContent = handle;
    if (pEmailText) pEmailText.textContent = email;
    if (pTelegramText) pTelegramText.textContent = telegram || '--';

    showAccessSubView('pending');
    alert(`🚀 Request Submitted Successfully!\n\nYour request for ${handle} has been forwarded to the administrator.\nAs soon as approved, you can set your new password right here to start using the extension.`);
  } catch (err) {
    alert(`❌ Request Error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 Submit Request for Approval';
    }
  }
}

/**
 * Prompt Returning User to Check Approval Status & Set Password
 */
async function handleExtPromptCheckApprovalStatus() {
  const inputHandle = document.getElementById('extReqHandleInput')?.value.trim();
  const inputEmail = document.getElementById('extReqEmailInput')?.value.trim();

  let targetHandle = state.pendingRequest?.handle || inputHandle || '';
  let targetEmail = state.pendingRequest?.email || inputEmail || '';

  // If handle or email is already available in the inputs or state, check directly
  if (targetHandle || targetEmail) {
    if (!state.pendingRequest) {
      state.pendingRequest = {
        handle: targetHandle || '@user',
        email: targetEmail || '',
        status: 'PENDING',
        requestedAt: Date.now()
      };
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ pendingRequest: state.pendingRequest });
      }
    }
    const pHandleDisplay = document.getElementById('extPendingHandleDisplay');
    const pHandleText = document.getElementById('extPendingHandleText');
    const pEmailText = document.getElementById('extPendingEmailText');
    if (pHandleDisplay) pHandleDisplay.textContent = targetHandle || state.pendingRequest.handle;
    if (pHandleText) pHandleText.textContent = targetHandle || state.pendingRequest.handle;
    if (pEmailText) pEmailText.textContent = targetEmail || state.pendingRequest.email || '--';

    showAccessSubView('pending');
    await handleExtCheckStatus(true);
    return;
  }

  // Otherwise, switch cleanly to in-extension lookup subview (NO BROWSER POPUPS!)
  showAccessSubView('lookup');
  const lookupInput = document.getElementById('extLookupHandleInput');
  if (lookupInput) {
    lookupInput.value = state.verifiedXHandle ? `@${state.verifiedXHandle.replace(/^@/, '')}` : '';
    setTimeout(() => lookupInput.focus(), 80);
  }
}

/**
 * Perform in-extension lookup for user's approval status
 */
async function handleExtDoLookup() {
  const input = document.getElementById('extLookupHandleInput');
  const alertEl = document.getElementById('extLookupStatusAlert');
  const btn = document.getElementById('extDoLookupBtn');
  const raw = (input?.value || '').trim();

  if (!raw) {
    if (alertEl) {
      alertEl.style.display = 'block';
      alertEl.style.background = 'rgba(239,68,68,0.12)';
      alertEl.style.color = 'var(--status-error)';
      alertEl.style.border = '1px solid rgba(239,68,68,0.3)';
      alertEl.textContent = 'Please enter your Twitter / X ID (e.g. @yournahian) or Email.';
    }
    input?.focus();
    return;
  }

  let handle = '';
  let email = '';
  if (raw.includes('@') && raw.includes('.')) {
    email = raw;
  } else {
    handle = raw.startsWith('@') ? raw : `@${raw}`;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying with Server...';
  }
  if (alertEl) alertEl.style.display = 'none';

  try {
    const query = new URLSearchParams();
    if (handle) query.append('handle', handle);
    if (email) query.append('email', email);

    const res = await fetchApiWithFallback(`/api/auth/check-status?${query.toString()}`, { method: 'GET' }, 10000);
    const data = await res.json().catch(() => ({}));

    if (data.status === 'APPROVED' && data.needsPasswordSetup) {
      const approvedHandle = data.handle || handle;
      const approvedDisp = document.getElementById('extApprovedHandleDisplay');
      if (approvedDisp) approvedDisp.textContent = approvedHandle;
      showAccessSubView('setPassword');
    } else if (data.status === 'ACTIVE' || (data.status === 'APPROVED' && !data.needsPasswordSetup)) {
      const approvedHandle = data.handle || handle;
      const loginInput = document.getElementById('extLoginHandleInput');
      if (loginInput) loginInput.value = approvedHandle;
      showAccessSubView('login');
      const loginAlert = document.getElementById('extLoginAlert');
      if (loginAlert) {
        loginAlert.style.display = 'block';
        loginAlert.style.background = 'rgba(16,185,129,0.12)';
        loginAlert.style.color = 'var(--status-success)';
        loginAlert.style.border = '1px solid rgba(16,185,129,0.3)';
        loginAlert.textContent = `✓ Account ${approvedHandle} is already approved and active! Please sign in with your password.`;
      }
    } else if (data.status === 'PENDING') {
      state.pendingRequest = {
        handle: handle || data.handle || '@user',
        email: email || data.email || '',
        status: 'PENDING',
        requestedAt: Date.now()
      };
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ pendingRequest: state.pendingRequest });
      }
      const pHandleDisplay = document.getElementById('extPendingHandleDisplay');
      const pHandleText = document.getElementById('extPendingHandleText');
      const pEmailText = document.getElementById('extPendingEmailText');
      if (pHandleDisplay) pHandleDisplay.textContent = state.pendingRequest.handle;
      if (pHandleText) pHandleText.textContent = state.pendingRequest.handle;
      if (pEmailText) pEmailText.textContent = state.pendingRequest.email || '--';
      showAccessSubView('pending');
    } else if (data.status === 'ACTIVE') {
      const loginInput = document.getElementById('extLoginHandleInput');
      if (loginInput) loginInput.value = data.handle || handle;
      showAccessSubView('login');
    } else if (data.status === 'REJECTED') {
      if (state.pendingRequest) {
        state.pendingRequest.status = 'REJECTED';
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.set({ pendingRequest: state.pendingRequest });
        }
      }
      const rejDisp = document.getElementById('extRejectedHandleDisplay');
      if (rejDisp) rejDisp.textContent = data.handle || handle;
      showAccessSubView('rejected');
    } else {
      if (alertEl) {
        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(239,68,68,0.12)';
        alertEl.style.color = 'var(--status-error)';
        alertEl.style.border = '1px solid rgba(239,68,68,0.3)';
        alertEl.textContent = `No pending request found for "${raw}". Please verify spelling or submit a request on the form.`;
      }
    }
  } catch (err) {
    if (alertEl) {
      alertEl.style.display = 'block';
      alertEl.style.background = 'rgba(239,68,68,0.12)';
      alertEl.style.color = 'var(--status-error)';
      alertEl.style.border = '1px solid rgba(239,68,68,0.3)';
      alertEl.textContent = `Server connection error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Check Status & Proceed';
    }
  }
}

/**
 * Clear rejected/pending state and return to clean request form for another ID
 */
async function handleExtSubmitNewAfterReject() {
  state.pendingRequest = null;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.remove(['pendingRequest']);
  }
  const hInput = document.getElementById('extReqHandleInput');
  const eInput = document.getElementById('extReqEmailInput');
  const nInput = document.getElementById('extReqFullNameInput');
  const tInput = document.getElementById('extReqTelegramInput');
  if (hInput) hInput.value = '';
  if (eInput) eInput.value = '';
  if (nInput) nInput.value = '';
  if (tInput) tInput.value = '';
  showAccessSubView('request');
  setTimeout(() => hInput?.focus(), 80);
}

/**
 * Switch to in-extension lookup to check status for another ID / Email
 */
function handleExtCheckAnotherId() {
  showAccessSubView('lookup');
  const lookupInput = document.getElementById('extLookupHandleInput');
  const alertEl = document.getElementById('extLookupStatusAlert');
  if (alertEl) alertEl.style.display = 'none';
  if (lookupInput) {
    lookupInput.value = '';
    setTimeout(() => lookupInput.focus(), 60);
  }
}

/**
 * Check Admin Approval Status (Manual or Background)
 */
async function handleExtCheckStatus(isManual = false) {
  if (!state.pendingRequest && !state.user) return;
  const targetHandle = state.pendingRequest?.handle || state.user?.handle || '';
  const targetEmail = state.pendingRequest?.email || state.user?.email || '';

  if (!targetHandle && !targetEmail) return;

  const btn = document.getElementById('extCheckStatusBtn');
  if (isManual && btn) {
    btn.disabled = true;
    btn.textContent = 'Checking Approval...';
  }

  try {
    const backendUrl = await getBackendUrl();
    const query = new URLSearchParams({ handle: targetHandle, email: targetEmail });
    const res = await fetch(`${backendUrl}/api/auth/check-status?${query.toString()}`);
    const data = await res.json();

    if (data.status === 'APPROVED' || data.status === 'ACTIVE') {
      const approvedHandle = data.handle || targetHandle;
      if (data.needsPasswordSetup) {
        const approvedDisp = document.getElementById('extApprovedHandleDisplay');
        if (approvedDisp) approvedDisp.textContent = approvedHandle;
        showAccessSubView('setPassword');
        if (isManual) {
          alert(`🎉 Congratulations!\n\nYour request for ${approvedHandle} has been approved by the administrator!\nPlease set your new password below to activate your account.`);
        }
      } else {
        const loginInput = document.getElementById('extLoginHandleInput');
        if (loginInput) loginInput.value = approvedHandle;
        showAccessSubView('login');
        const loginAlert = document.getElementById('extLoginAlert');
        if (loginAlert) {
          loginAlert.style.display = 'block';
          loginAlert.style.background = 'rgba(16,185,129,0.12)';
          loginAlert.style.color = 'var(--status-success)';
          loginAlert.style.border = '1px solid rgba(16,185,129,0.3)';
          loginAlert.textContent = `✓ Account ${approvedHandle} is already approved and active! Please enter your password to sign in.`;
        }
        if (isManual) {
          alert(`✓ Account Already Approved:\n\n${approvedHandle} is already active and approved!\nPlease enter your password to sign in.`);
        }
      }
    } else if (data.status === 'REJECTED') {
      if (state.pendingRequest) {
        state.pendingRequest.status = 'REJECTED';
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
          chrome.storage.local.set({ pendingRequest: state.pendingRequest });
        }
      }
      const rejDisp = document.getElementById('extRejectedHandleDisplay');
      if (rejDisp) rejDisp.textContent = data.handle || targetHandle;
      showAccessSubView('rejected');
    } else if (data.status === 'NOT_FOUND') {
      if (isManual) {
        alert(`❌ No Request Found:\n\nNo request found for "${targetHandle || targetEmail}".\nPlease fill out the form below to submit a new request.`);
        showAccessSubView('request');
      }
    } else {
      if (isManual) {
        alert(`⏳ Still Pending:\n\nYour request for ${targetHandle} is currently awaiting admin approval in the dashboard.\nPlease check back shortly.`);
      }
    }
  } catch (err) {
    if (isManual) {
      alert(`⚠️ Notice: Could not reach verification server (${err.message}).`);
    }
  } finally {
    if (isManual && btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Check Approval Status Now';
    }
  }
}

/**
 * Handle Setting New Password after Approval
 */
async function handleExtSetPassword() {
  const p1 = document.getElementById('extNewPasswordInput')?.value.trim();
  const p2 = document.getElementById('extConfirmPasswordInput')?.value.trim();
  const btn = document.getElementById('extSaveNewPasswordSubmitBtn');

  if (!p1 || p1.length < 6) {
    alert('Please enter a password with at least 6 characters.');
    return;
  }
  if (p1 !== p2) {
    alert('Passwords do not match. Please re-enter.');
    return;
  }

  const targetHandle = state.pendingRequest?.handle || state.user?.handle || '';
  const targetEmail = state.pendingRequest?.email || state.user?.email || '';

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Activating Account...';
  }

  try {
    const res = await fetchApiWithFallback('/api/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: targetHandle || targetEmail,
        email: targetEmail,
        handle: targetHandle,
        password: p1
      })
    }, 12000);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.alreadyHasPassword) {
        alert(data.error);
        const loginInput = document.getElementById('extLoginHandleInput');
        if (loginInput) loginInput.value = targetHandle || targetEmail;
        showAccessSubView('login');
        return;
      }
      throw new Error(data.error || 'Could not set password');
    }

    state.user = data.user;
    state.verifiedXHandle = data.user.handle ? (data.user.handle.startsWith('@') ? data.user.handle : `@${data.user.handle}`) : targetHandle;
    if (typeof data.user.credits === 'number') state.credits = data.user.credits;
    if (data.user.plan) state.userPlan = data.user.plan;
    state.pendingRequest = null;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove(['pendingRequest']);
      await chrome.storage.local.set({
        currentUser: data.user,
        authToken: data.token,
        verifiedXHandle: state.verifiedXHandle,
        credits: state.credits,
        userPlan: state.userPlan
      });
    }

    updateCreditUI();
    showAccessSubView('loggedIn');
    await checkAccountVerificationLock();
    alert(`🎉 Account Activated!\n\nWelcome ${data.user.fullName}! Your extension is now 1-to-1 locked to your verified X account (${state.verifiedXHandle}).`);
  } catch (err) {
    alert(`❌ Activation Error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔑 Set Password & Unlock Extension';
    }
  }
}

async function handleExtSubmitForgotPwd() {
  const handle = (document.getElementById('extForgotHandleInput')?.value || '').trim();
  const email = (document.getElementById('extForgotEmailInput')?.value || '').trim();
  const telegram = (document.getElementById('extForgotTelegramInput')?.value || '').trim();
  const btn = document.getElementById('extSubmitForgotPwdBtn');
  const successBox = document.getElementById('extForgotSuccessBox');
  const formContainer = document.getElementById('extForgotFormContainer');
  const successText = document.getElementById('extForgotSuccessText');

  if (!handle) {
    alert('Please enter your Twitter / X ID (e.g. @mythopair). All 3 details are required to verify your identity.');
    return;
  }
  if (!email || !email.includes('@')) {
    alert('Please enter your registered email address.');
    return;
  }
  if (!telegram) {
    alert('Please enter your registered Telegram Username / ID.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Submitting Request...';
  }

  try {
    const backendUrl = await getBackendUrl();
    const cleanHandle = handle.startsWith('@') ? handle : (handle ? `@${handle}` : '');
    const cleanTg = telegram.startsWith('@') ? telegram : `@${telegram}`;

    const res = await fetch(`${backendUrl}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: cleanHandle,
        email,
        telegram: cleanTg
      })
    });

    const data = await safeParseApiResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Could not submit password reset request');
    }

    if (formContainer) formContainer.style.display = 'none';
    if (successBox) successBox.style.display = 'block';
    if (successText) {
      successText.textContent = `The admin will review your account and message your temporary login password to your Telegram (${cleanTg}). Once received, please return to Sign In to log in.`;
    }

    // Prefill the login input for convenience
    const loginInput = document.getElementById('extLoginHandleInput');
    if (loginInput && cleanHandle) {
      loginInput.value = cleanHandle;
    }

    alert(`✓ Request Submitted to Administrator!\n\nThe admin will review your account and message your temporary password to Telegram (${cleanTg}).`);
  } catch (e) {
    alert(`❌ Request Error: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📢 Request Admin Password Reset';
    }
  }
}

function toggleChangePasswordBox() {
  const form = document.getElementById('extChangePasswordForm');
  const arrow = document.getElementById('extChangePasswordArrow');
  if (!form) return;
  if (form.style.display === 'none' || !form.style.display) {
    form.style.display = 'block';
    if (arrow) arrow.textContent = '▲';
  } else {
    form.style.display = 'none';
    if (arrow) arrow.textContent = '▼';
  }
}

async function handleExtLoggedInChangePassword() {
  const currentPass = (document.getElementById('extLoggedInCurrentPassInput')?.value || '').trim();
  const newPass = (document.getElementById('extLoggedInNewPassInput')?.value || '').trim();
  const confirmPass = (document.getElementById('extLoggedInConfirmPassInput')?.value || '').trim();
  const btn = document.getElementById('extLoggedInSubmitChangePassBtn');

  if (!currentPass) {
    alert('Please enter your current / temporary password assigned by admin.');
    return;
  }
  if (!newPass || newPass.length < 6) {
    alert('New password must be at least 6 characters.');
    return;
  }
  if (newPass !== confirmPass) {
    alert('New passwords do not match. Please re-enter.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating Password...';
  }

  try {
    const backendUrl = await getBackendUrl();
    const handle = state.user?.handle || state.verifiedXHandle || '';
    const email = state.user?.email || '';

    const res = await fetch(`${backendUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        email,
        currentPassword: currentPass,
        newPassword: newPass
      })
    });

    const data = await safeParseApiResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Could not update password');
    }

    alert('✓ Password updated successfully!\nYour account is now secured with your new password.');
    
    // Clear inputs and collapse
    const c1 = document.getElementById('extLoggedInCurrentPassInput');
    const c2 = document.getElementById('extLoggedInNewPassInput');
    const c3 = document.getElementById('extLoggedInConfirmPassInput');
    if (c1) c1.value = '';
    if (c2) c2.value = '';
    if (c3) c3.value = '';
    toggleChangePasswordBox();
  } catch (err) {
    alert(`❌ Password Update Error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save New Password';
    }
  }
}

async function handleExtNotifyAdminForgotPwd() {
  await handleExtSubmitForgotPwd();
}

async function handleExtResetPassword() {
  const ident = document.getElementById('extResetIdentifierInput')?.value.trim();
  const currentPass = document.getElementById('extResetCurrentPasswordInput')?.value.trim();
  const p1 = document.getElementById('extResetNewPasswordInput')?.value.trim();
  const p2 = document.getElementById('extResetConfirmPasswordInput')?.value.trim();
  const btn = document.getElementById('extResetPasswordSubmitBtn');

  if (!ident) {
    alert('Please enter your X ID or registered email.');
    return;
  }
  if (!currentPass) {
    alert('Please enter the Current / Admin-provided temporary password.');
    return;
  }
  if (!p1 || p1.length < 4) {
    alert('Please enter a new password with at least 4 characters.');
    return;
  }
  if (p1 !== p2) {
    alert('Passwords do not match. Please re-enter.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Resetting Password...';
  }

  try {
    const backendUrl = await getBackendUrl();
    const res = await fetch(`${backendUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: ident, currentPassword: currentPass, newPassword: p1 })
    });
    const data = await safeParseApiResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Could not reset password');
    }
    alert('✓ Password updated successfully!\nPlease sign in with your new password.');
    showAccessSubView('login');
    const loginInput = document.getElementById('extLoginHandleInput');
    if (loginInput) loginInput.value = data.handle || ident;
  } catch (e) {
    alert(`❌ Reset Error: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save New Password & Sign In';
    }
  }
}


async function handleExtRequestReview() {
  const btn = document.getElementById('extRequestReviewBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Submitting Appeal...';
  }
  try {
    const backendUrl = await getBackendUrl();
    const handle = state.verifiedXHandle || state.user?.handle || '';
    const email = state.user?.email || '';
    const res = await fetch(`${backendUrl}/api/auth/request-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, email, reason: 'Suspended user requesting review from extension' })
    });
    const d = await safeParseApiResponse(res);
    alert('✓ Review Request Submitted!\n\nYour appeal has been delivered to the administrator.\nPlease await review.');
    if (btn) btn.textContent = '✓ Appeal Submitted to Admin';
  } catch (err) {
    alert(`Notice: ${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📨 Request Account Review / Appeal';
    }
  }
}


async function handleExtLogin() {
  const identifierInput = document.getElementById('extLoginHandleInput');
  const passwordInput = document.getElementById('extLoginPasswordInput');
  const identifier = identifierInput?.value.trim();
  const password = passwordInput?.value.trim();

  if (!identifier) {
    alert('Please enter your approved Twitter / X ID (e.g. @yourhandle) or email.');
    return;
  }

  const submitBtn = document.getElementById('extLoginSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying Credentials...';
  }

  try {
    const res = await fetchApiWithFallback('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    }, 70000);

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const serverErr = data.error || data.message;
      if (serverErr) {
        throw new Error(serverErr);
      }
      throw new Error(`Server returned status ${res.status}. If the server was idle, wait ~1 minute and try again.`);
    }

    state.user = data.user;
    state.verifiedXHandle = data.user.handle ? (data.user.handle.startsWith('@') ? data.user.handle : `@${data.user.handle}`) : identifier;
    if (typeof data.user.credits === 'number') state.credits = data.user.credits;
    if (data.user.plan) state.userPlan = data.user.plan;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({
        currentUser: data.user,
        authToken: data.token,
        verifiedXHandle: state.verifiedXHandle,
        credits: state.credits,
        userPlan: state.userPlan
      });
    }

    updateCreditUI();
    await checkAccountVerificationLock();
    alert(`✓ Successfully signed in as ${state.verifiedXHandle}!\nExtension is now locked to your verified identity.`);
  } catch (err) {
    alert(`❌ Sign In Failed: ${err.message}`);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In & Unlock Extension';
    }
  }
}

async function handleExtLogout() {
  const confirmed = await showExtConfirm('Are you sure you want to log out from this extension?', {
    title: 'Confirm Log Out',
    icon: '🚪',
    confirmText: 'Log Out',
    cancelText: 'Cancel',
    danger: true
  });
  if (!confirmed) return;
  await purgeExtLocalUserSession();
  showExtToast('Logged out successfully', '✓');
  showAccessSubView('login');
  updateCreditUI();
  await checkAccountVerificationLock();
}

async function updateTgParseSummaryUI() {
  const inputEl = document.getElementById('tgLinksInput');
  const summaryEl = document.getElementById('tgParseSummary');
  const countBadge = document.getElementById('tgFreshCountBadge');
  const breakdownEl = document.getElementById('tgBreakdownText');
  if (!inputEl || !summaryEl) return;

  const raw = inputEl.value;
  if (!raw.trim()) {
    summaryEl.style.display = 'none';
    return;
  }

  // Ensure state.engagedTweetIds has latest data from local storage
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['engagedTweetIds']);
      if (Array.isArray(stored?.engagedTweetIds)) {
        state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), ...stored.engagedTweetIds]));
      }
    } catch (e) {}
  }

  const extracted = extractTweetLinks(raw);
  const filtered = filterTweetLinks(extracted);

  summaryEl.style.display = 'block';
  if (countBadge) {
    countBadge.textContent = `${filtered.freshCount} Fresh`;
    countBadge.style.color = filtered.freshCount > 0 ? '#10B981' : '#F59E0B';
  }
  if (breakdownEl) {
    breakdownEl.textContent = `Extracted: ${filtered.totalFound} · Duplicates Skipped: ${filtered.duplicateCount} · Already Engaged Skipped: ${filtered.alreadyEngagedCount}`;
  }
}

async function handleCleanTgInput() {
  const inputEl = document.getElementById('tgLinksInput');
  if (!inputEl) return;
  const raw = inputEl.value;
  const extracted = extractTweetLinks(raw);
  if (extracted.length === 0) {
    alert('No valid X/Twitter links detected in the text.');
    return;
  }

  // Ensure state.engagedTweetIds has latest data from local storage
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['engagedTweetIds']);
      if (Array.isArray(stored?.engagedTweetIds)) {
        state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), ...stored.engagedTweetIds]));
      }
    } catch (e) {}
  }

  const filtered = filterTweetLinks(extracted);
  const cleanList = (filtered.freshTweets.length > 0 ? filtered.freshTweets : extracted).map(t => t.canonicalUrl);
  const uniqueClean = Array.from(new Set(cleanList));
  inputEl.value = uniqueClean.join('\n');

  // Update summary elements reflecting the clean action
  const summaryEl = document.getElementById('tgParseSummary');
  const countBadge = document.getElementById('tgFreshCountBadge');
  const breakdownEl = document.getElementById('tgBreakdownText');
  if (summaryEl) summaryEl.style.display = 'block';
  if (countBadge) {
    countBadge.textContent = `${uniqueClean.length} Fresh`;
    countBadge.style.color = uniqueClean.length > 0 ? '#10B981' : '#F59E0B';
  }
  if (breakdownEl) {
    if (filtered.alreadyEngagedCount > 0 || filtered.duplicateCount > 0) {
      breakdownEl.textContent = `Cleaned: ${uniqueClean.length} Fresh · Original: ${filtered.totalFound} · Already Engaged Removed: ${filtered.alreadyEngagedCount} · Duplicates Removed: ${filtered.duplicateCount}`;
    } else {
      breakdownEl.textContent = `Extracted: ${uniqueClean.length} · Duplicates Skipped: 0 · Already Engaged Skipped: 0`;
    }
  }

  let msg = `✓ Cleaned input!\nKept ${uniqueClean.length} fresh canonical link(s).\nAll Telegram timestamps, usernames, post numbers (#), and emojis have been stripped.`;
  if (filtered.alreadyEngagedCount > 0) {
    msg += `\n\n🛡️ ${filtered.alreadyEngagedCount} already-engaged link(s) were automatically filtered out to save your time & credits.`;
  }
  if (filtered.duplicateCount > 0) {
    msg += `\n\n✂️ ${filtered.duplicateCount} duplicate link(s) were removed.`;
  }
  alert(msg);
}

function updateCreditUI() {
  const isAuthed = !!(state.user && (state.verifiedXHandle || state.user?.handle));
  const displayCredits = isAuthed ? Number(state.credits || 0) : 0;

  const p = document.getElementById('creditBalanceText');
  if (p) p.textContent = displayCredits.toLocaleString();
  const b = document.getElementById('extCreditsBig');
  if (b) b.textContent = `${displayCredits.toLocaleString()} C`;
}

// Auto detect tweet on Twitter/X active tab
async function autoDetectTweet() {
  try {
    const tab = await getActiveTwitterTab();
    if (!tab) return;
    state.activeTabId = tab.id;

    if (tab.url && (tab.url.includes('twitter.com') || tab.url.includes('x.com'))) {
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_FOCUSED_TWEET' }, (response) => {
        if (chrome.runtime?.lastError || !response || !response.success) return;
        const input = document.getElementById('targetTweetInput');
        if (input) input.value = response.tweetText || '';

        if (response.authorName || response.authorHandle) {
          const row = document.getElementById('tweetAuthorRow');
          if (row) row.style.display = 'flex';
          const nameEl = document.getElementById('authorName');
          if (nameEl) nameEl.textContent = response.authorName || 'Author';
          const handleEl = document.getElementById('authorHandle');
          if (handleEl) handleEl.textContent = response.authorHandle || '';
        }
      });
    }
  } catch (e) {
    console.error('Error querying tab:', e);
  }
}

// Generate reply via Server-Side endpoint
async function handleGenerateReply() {
  const tweetInput = document.getElementById('targetTweetInput')?.value.trim();
  if (!tweetInput) {
    alert('Please enter or detect a target tweet first.');
    return;
  }

  if (state.credits < 1) {
    alert('Insufficient credits! Please top up via the Credits tab.');
    switchExtTab('credits');
    return;
  }

  const generateBtn = document.getElementById('generateBtn');
  const generateText = document.getElementById('generateBtnText');
  generateBtn.disabled = true;
  generateText.textContent = 'Generating...';

  const tone = state.selectedTone;
  const author = document.getElementById('authorHandle')?.textContent || '@creator';

  let replyText = '';
  try {
    const backendUrl = await getBackendUrl();
    const curHandle = state.verifiedXHandle || state.user?.handle || '@user';
    const curEmail = state.user?.email || '';
    const curUserId = state.user?.id || null;
    const response = await fetch(`${backendUrl}/api/generate-reply`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-user-handle': curHandle,
        'x-user-id': curUserId ? String(curUserId) : '1'
      },
      body: JSON.stringify({
        tweetText: tweetInput,
        tweetAuthor: author,
        style: tone,
        stylePrompt: state.selectedTonePrompt,
        userHandle: curHandle,
        userEmail: curEmail,
        userId: curUserId
      })
    });

    if (response.ok) {
      const data = await response.json();
      replyText = data.reply;
      if (typeof data.remainingCredits === 'number') {
        state.credits = data.remainingCredits;
      } else {
        deductCredits(1);
      }
    } else {
      throw new Error('Backend responded with ' + response.status);
    }
  } catch (err) {
    replyText = `The clearest sign of compounding velocity on X is high-context resonance. Exceptional breakdown.`;
    deductCredits(1);
  } finally {
    generateBtn.disabled = false;
    generateText.textContent = 'Generate Reply';
  }

  // Record this tweet as engaged if an ID is extractable
  try {
    const extractedTarget = extractTweetLinks(tweetInput);
    if (extractedTarget.length > 0) {
      const targetId = extractedTarget[0].tweetId;
      if (!state.engagedTweetIds.includes(targetId)) {
        state.engagedTweetIds.push(targetId);
        chrome.storage?.local.set({ engagedTweetIds: state.engagedTweetIds });
        const backendUrl = await getBackendUrl();
        fetch(`${backendUrl}/api/tweets/mark-engaged`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tweets: [{
              tweet_id: targetId,
              handle: author,
              canonical_url: extractedTarget[0].canonicalUrl,
              action_type: 'ai_reply'
            }]
          })
        }).catch(() => null);
      }
    }
  } catch (e) { }

  // Display reply
  const resultCard = document.getElementById('resultCard');
  const replyOutput = document.getElementById('replyOutput');
  const charCount = document.getElementById('charCount');

  if (replyOutput) replyOutput.value = replyText;
  if (charCount) charCount.textContent = `${replyText.length} chars`;
  if (resultCard) resultCard.style.display = 'block';
}

// Insert into Tweet on active page
async function handleInsertTweet() {
  const replyText = document.getElementById('replyOutput')?.value;
  if (!replyText) return;

  try {
    const tab = await getActiveTwitterTab();
    if (!tab || !tab.id) {
      navigator.clipboard?.writeText(replyText);
      alert('Copied to clipboard! (Paste it directly into the tweet reply box on X).');
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      type: 'INJECT_REPLY_TEXT',
      replyText: replyText
    }, (res) => {
      if (chrome.runtime?.lastError || !res?.success) {
        navigator.clipboard?.writeText(replyText);
        alert('Copied to clipboard! (Click on the tweet reply box on X to paste).');
      } else {
        const btn = document.getElementById('insertTweetBtn');
        if (btn) {
          btn.textContent = '✓ Inserted!';
          setTimeout(() => { btn.textContent = '✓ Insert into X'; }, 1500);
        }
      }
    });
  } catch (e) {
    navigator.clipboard?.writeText(replyText);
    alert('Copied to clipboard!');
  }
}

// ==============================================================
// AUTOMATION CONTROL & STOP BUTTON LOGIC
// ==============================================================
function triggerStopAutomation() {
  state.isAborted = true;
  console.log('[ATOMX] Stop automation requested by user.');

  // Broadcast abort signal to all Twitter / X tabs (mobile-safe — no-op if chrome.tabs unavailable)
  broadcastToXTabs({ type: 'ABORT_WORKFLOW' });

  setAutomationRunningUI(false);

  // Update live consoles
  const replyStatus = document.getElementById('replyConsoleStatus');
  const replyOutput = document.getElementById('replyConsoleOutput');
  if (replyStatus) replyStatus.textContent = '⏹️ Automation Stopped';
  if (replyOutput) replyOutput.textContent = 'Automation halted by user. Pacing delays and pending typing actions cancelled.';

  const agentStatus = document.getElementById('agentConsoleStatus');
  const agentOutput = document.getElementById('agentConsoleOutput');
  if (agentStatus) agentStatus.textContent = '⏹️ Agent Stopped';
  if (agentOutput) agentOutput.textContent = 'Workflow halted by user.';
}

function setAutomationRunningUI(isRunning) {
  const stopReplyBtn = document.getElementById('stopReplyAutomationBtn');
  const stopReplyConsoleBtn = document.getElementById('stopReplyConsoleBtn');
  const stopAgentBtn = document.getElementById('stopAgentBtn');
  const autoReplyBtn = document.getElementById('autoReplyEngageBtn');
  const autoReplyBtnText = document.getElementById('autoReplyEngageBtnText');
  const runTgBtn = document.getElementById('runTgEngageBtn');

  if (isRunning) {
    if (stopReplyBtn) stopReplyBtn.style.display = 'block';
    if (stopReplyConsoleBtn) stopReplyConsoleBtn.style.display = 'inline-block';
    if (stopAgentBtn) stopAgentBtn.style.display = 'inline-block';
    if (autoReplyBtn) autoReplyBtn.disabled = true;
    if (autoReplyBtnText) autoReplyBtnText.textContent = '⏳ Running Automation...';
    if (runTgBtn) {
      runTgBtn.disabled = true;
      runTgBtn.textContent = '⏳ Autonomous Raid Running...';
    }
  } else {
    if (stopReplyBtn) stopReplyBtn.style.display = 'none';
    if (stopReplyConsoleBtn) stopReplyConsoleBtn.style.display = 'none';
    if (stopAgentBtn) stopAgentBtn.style.display = 'none';
    if (autoReplyBtn) autoReplyBtn.disabled = false;
    updateReplyTargetSummaryUI();
    if (runTgBtn) {
      runTgBtn.disabled = false;
      runTgBtn.textContent = '▶ Launch';
    }
  }
}

// 1-Click Autonomous Reply & Engagement Handler for Reply Tab
async function handleAutoReplyEngage() {
  state.isAborted = false;
  const targetInput = document.getElementById('targetTweetInput');
  const rawText = targetInput ? targetInput.value.trim() : '';

  const like = document.getElementById('replyActLike')?.checked ?? true;
  const comment = document.getElementById('replyActComment')?.checked ?? true;
  const repost = document.getElementById('replyActRepost')?.checked ?? false;
  const follow = document.getElementById('replyActFollow')?.checked ?? false;
  const actions = { like, comment, repost, follow, scroll: true };

  const consoleCard = document.getElementById('replyConsoleCard');
  const consoleStatus = document.getElementById('replyConsoleStatus');
  const consoleOutput = document.getElementById('replyConsoleOutput');
  const consoleProgress = document.getElementById('replyConsoleBatchProgress');

  if (consoleCard) consoleCard.style.display = 'block';

  function logReplyConsole(status, text, progress = '') {
    if (consoleStatus) consoleStatus.textContent = status;
    if (consoleOutput) consoleOutput.textContent = text;
    if (consoleProgress) consoleProgress.textContent = progress;
  }

  const extracted = extractTweetLinks(rawText);

  // CASE 1: MULTI-LINK BATCH QUEUE (>1 links)
  if (extracted.length > 1) {
    const filtered = filterTweetLinks(extracted);
    if (filtered.freshTweets.length === 0) {
      alert(`All ${extracted.length} links are duplicates or already engaged!`);
      logReplyConsole('Batch Skipped', 'All links were already engaged or duplicated.');
      return;
    }

    if (state.credits < filtered.freshTweets.length) {
      alert(`Insufficient credits: You have ${state.credits} credits, but ${filtered.freshTweets.length} fresh links are queued.`);
      switchExtTab('credits');
      return;
    }

    logReplyConsole('Queue Started', `Automating ${filtered.freshTweets.length} fresh tweets with human pacing...`);
    setAutomationRunningUI(true);
    try {
      await executeAutonomousRaidWorkflow(filtered.freshTweets, actions, logReplyConsole);
    } finally {
      setAutomationRunningUI(false);
      updateReplyTargetSummaryUI();
    }
    return;
  }

  // CASE 2: SINGLE TWEET OR DETECTED TWEET
  let targetUrl = extracted.length === 1 ? extracted[0].canonicalUrl : null;
  let author = extracted.length === 1 ? extracted[0].handle : (document.getElementById('authorHandle')?.textContent || '@creator');

  if (state.credits < 1) {
    alert('Insufficient credits! Please top up via the Credits tab.');
    switchExtTab('credits');
    return;
  }

  setAutomationRunningUI(true);
  logReplyConsole('Generating AI Reply', `Crafting high-signal reply using ${state.selectedTone}...`);

  try {
    const backendUrl = await getBackendUrl();
    let replyText = '';
    const curHandle = state.verifiedXHandle || state.user?.handle || '@user';
    const curEmail = state.user?.email || '';
    const curUserId = state.user?.id || null;

    if (actions.comment) {
      const resp = await fetch(`${backendUrl}/api/generate-reply`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-user-handle': curHandle,
          'x-user-id': curUserId ? String(curUserId) : '1'
        },
        body: JSON.stringify({
          tweetText: rawText || (targetUrl || 'https://x.com'),
          tweetAuthor: author,
          style: state.selectedTone,
          stylePrompt: state.selectedTonePrompt,
          userHandle: curHandle,
          userEmail: curEmail,
          userId: curUserId
        })
      });

      if (resp.ok) {
        const d = await resp.json();
        replyText = d.reply;
      } else {
        replyText = 'High-signal observation. Execution velocity and clarity make all the difference.';
      }
    }

    if (state.isAborted) return;

    logReplyConsole('Executing on X.com', 'Checking status & executing actions with human typing...');
    const result = await runAutonomousActionOnTweet(targetUrl, actions, replyText);

    if (state.isAborted) return;

    // Handle auto-ignore rule: post already liked and commented
    if (result && result.result && result.result.ignored) {
      logReplyConsole('✓ Auto-Ignored', result.result.reason || 'Already completed');
      alert(`ℹ️ Post Auto-Ignored:\n\n${result.result.reason}\n\nSince this post was already completed, no actions were performed and 0 credits were deducted.`);
      return;
    }

    // Engagement succeeded: deduct credit now
    deductCredits(1);

    if (extracted.length === 1) {
      const tid = extracted[0].tweetId;
      state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), tid]));
      chrome.storage?.local.set({ engagedTweetIds: state.engagedTweetIds });
    }

    const actionsPerformed = result?.result?.performed?.join(', ') || 'Liked and Commented';
    logReplyConsole('✓ Engagement Complete', `Done: ${actionsPerformed}`);
    alert(`🚀 Autonomous Engagement Complete!\n\n${actionsPerformed} on X.com.`);
  } catch (err) {
    console.error('Engagement error:', err);
    logReplyConsole('Error', err.message);
    alert('Could not complete autonomous reply: ' + err.message);
  } finally {
    setAutomationRunningUI(false);
    updateCreditUI();
  }
}

// Auto-Post Reply Directly on X.com (Single Post preview button)
document.getElementById('autoPostReplyBtn')?.addEventListener('click', async () => {
  const replyText = document.getElementById('replyOutput')?.value?.trim();
  if (!replyText) {
    alert('Please generate or enter a reply first.');
    return;
  }

  const tweetInput = document.getElementById('targetTweetInput')?.value?.trim();
  const targetLinks = extractTweetLinks(tweetInput || '');
  let targetUrl = targetLinks.length > 0 ? targetLinks[0].canonicalUrl : null;

  const btn = document.getElementById('autoPostReplyBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Posting to X...';
  }

  try {
    const actions = {
      like: true,
      comment: true,
      scroll: true,
      repost: false,
      follow: false
    };

    updateAgentConsole('Auto-Posting', 'Opening tweet on X and submitting comment...');
    const result = await runAutonomousActionOnTweet(targetUrl, actions, replyText);

    deductCredits(1);
    updateAgentConsole('✓ Posted Successfully', 'Reply typed and posted on X.com!');
    alert('🚀 Autonomous Post Complete!\nTweet was liked and your reply was submitted on X.com.');
  } catch (err) {
    console.error('Auto post failed:', err);
    alert('Could not auto-post on X. Please ensure you are logged into X.com.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 Post Comment';
    }
  }
});

// Autonomous Raid Loop: Visits each tweet, scrolls, likes, comments, reposts & follows
// (Fallback for when background relay is unavailable; normally background.js handles this)
async function executeAutonomousRaidWorkflow(tweets, actions, logCallback = null) {
  state.isAborted = false;
  state.isWorkflowRunning = true;
  setAutomationRunningUI(true);
  const total = tweets.length;
  let successCount = 0;
  let ignoredCount = 0;
  let skippedCommentsCount = 0;
  const backendUrl = await getBackendUrl();

  // In-popup UI element refs
  const progressCard = document.getElementById('tgProgressCard');
  const tgStateBadge = document.getElementById('tgStateBadge');
  const tgQueueInd   = document.getElementById('tgQueueIndicator');
  const tgDoneEl     = document.getElementById('tgDoneCount');
  const tgColEl      = document.getElementById('tgCollectedCount');
  const tgSkipEl     = document.getElementById('tgSkippedCount');
  const tgBar        = document.getElementById('tgProgressBar');
  const tgStatus     = document.getElementById('tgLiveStatusText');
  const tgCountdown  = document.getElementById('tgCountdownText');
  const pauseBtn     = document.getElementById('pauseTgEngageBtn');
  const skipBtn      = document.getElementById('skipTgEngageBtn');
  const stopBtn      = document.getElementById('stopTgEngageBtn');

  if (progressCard) progressCard.style.display = 'block';
  if (pauseBtn) { pauseBtn.style.display = 'inline-flex'; pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:4px;"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>Pause`; }
  if (skipBtn) skipBtn.style.display = 'inline-block';
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (tgStateBadge) tgStateBadge.textContent = 'ENGAGING';
  if (tgQueueInd) tgQueueInd.textContent = `Tweet 0/${total}`;
  if (tgDoneEl) tgDoneEl.textContent = '0';
  if (tgColEl) tgColEl.textContent = String(total);
  if (tgSkipEl) tgSkipEl.textContent = '0';
  if (tgBar) tgBar.style.width = '5%';
  if (tgStatus) tgStatus.textContent = 'Starting Telegram Raid engagement...';

  // Initial floating HUD sync
  syncFloatingHud(null, {
    title: 'TG Pulse',
    stateBadge: 'ENGAGING',
    indicator: `Tweet 0/${total}`,
    done: 0,
    collected: total,
    skipped: 0,
    progressPercent: 5,
    statusText: 'Starting Telegram Raid engagement...'
  });

  const logger = (st, log, prog = '') => {
    if (logCallback) logCallback(st, log, prog);
    else updateAgentConsole(st, log);
  };

  try {
    for (let i = 0; i < total; i++) {
      // Pause handling
      while (state.isPaused && !state.isAborted) {
        await sleep(300);
      }
      if (state.isAborted) {
        logger('⏹️ Stopped', 'Autonomous workflow stopped by user.');
        break;
      }

      // Skip handling
      if (state.skipCurrent) {
        state.skipCurrent = false;
        ignoredCount++;
        if (tgSkipEl) tgSkipEl.textContent = String(ignoredCount);
        state.skippedItems = state.skippedItems || [];
        state.skippedItems.push({
          url: tweets[i]?.canonicalUrl || tweets[i]?.url || (tweets[i]?.tweetId ? `https://x.com/i/status/${tweets[i].tweetId}` : ''),
          handle: tweets[i]?.handle || '',
          tweetId: tweets[i]?.tweetId || '',
          reason: 'Skipped by user'
        });
        if (chrome.storage?.local) {
          chrome.storage.local.get(['atomx_tg_raid'], (r) => {
            if (r?.atomx_tg_raid) {
              chrome.storage.local.set({ atomx_tg_raid: { ...r.atomx_tg_raid, skippedItems: state.skippedItems } });
            }
          });
        }
        logger(`Skipped [${i + 1}/${total}]`, `Skipped by user: ${tweets[i]?.canonicalUrl}`, `${i + 1}/${total}`);
        continue;
      }

      const t = tweets[i];
      const indexStr = `[${i + 1}/${total}]`;
      const progPercent = Math.round(((i) / total) * 100);

      // Update in-popup progress card
      if (tgQueueInd) tgQueueInd.textContent = `Tweet ${i + 1}/${total}`;
      if (tgStatus) tgStatus.textContent = `${indexStr} Visiting @${t.handle || 'user'}...`;
      if (tgBar) tgBar.style.width = `${progPercent}%`;

      // Sync floating HUD
      syncFloatingHud(tgWorkingTabId, {
        title: 'TG Pulse',
        stateBadge: 'ENGAGING',
        indicator: `Tweet ${i + 1}/${total}`,
        done: successCount,
        collected: total,
        skipped: ignoredCount,
        progressPercent: progPercent,
        statusText: `${indexStr} Visiting @${t.handle || 'user'}...`
      });

      logger(`Processing ${indexStr}`, `Visiting ${t.canonicalUrl}... Checking actions.`, `${i + 1}/${total}`);

      if (state.isAborted) { logger('⏹️ Stopped', 'Autonomous workflow stopped by user.'); break; }

      try {
        const outcome = await runAutonomousActionOnTweet(t.canonicalUrl, actions, {
          backendUrl,
          style: state.selectedTone,
          stylePrompt: state.selectedTonePrompt,
          tweetAuthor: t.handle,
          generateContextual: actions.comment
        });

        if (state.isAborted) { logger('⏹️ Stopped', 'Autonomous workflow stopped by user.'); break; }

        // Auto-ignore rule: post already liked & commented OR comment already completed
        const res = outcome && outcome.result;
        const isIgnored = res && (res.ignored || res.commentSkipped);

        if (isIgnored) {
          ignoredCount++;
          if (res.commentSkipped) skippedCommentsCount++;
          const reasonStr = res.reason || (res.commentSkipped ? 'Already commented previously' : 'Already completed');
          logger(`Skipped ${indexStr}`, `Auto-ignored: ${reasonStr} (0 credits used)`, `${i + 1}/${total}`);

          if (tgSkipEl) tgSkipEl.textContent = String(ignoredCount);

          // Cache so future raids skip this tweet locally
          state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), t.tweetId]));
          state.skippedItems = state.skippedItems || [];
          state.skippedItems.push({
            url: t.canonicalUrl || t.url || (t.tweetId ? `https://x.com/i/status/${t.tweetId}` : ''),
            handle: t.handle || '',
            tweetId: t.tweetId || '',
            reason: reasonStr
          });
          if (chrome.storage?.local) {
            chrome.storage.local.set({ engagedTweetIds: state.engagedTweetIds });
            chrome.storage.local.get(['atomx_tg_raid'], (r) => {
              if (r?.atomx_tg_raid) {
                chrome.storage.local.set({ atomx_tg_raid: { ...r.atomx_tg_raid, skippedItems: state.skippedItems } });
              }
            });
          }

          await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
          syncFloatingHud(tgWorkingTabId, {
            title: 'TG Pulse', stateBadge: 'ENGAGING',
            indicator: `Tweet ${i + 1}/${total}`, done: successCount,
            collected: total, skipped: ignoredCount,
            progressPercent: Math.round(((i + 1) / total) * 100),
            statusText: `${indexStr} Skipped @${t.handle || 'user'} (already done)`
          });
          if (i < total - 1 && !state.isAborted) {
            if (tgCountdown) tgCountdown.style.display = 'block';
            for (let sec = 3; sec > 0; sec--) {
              if (state.isAborted) break;
              if (tgCountdown) tgCountdown.textContent = `Next tweet in 0:0${sec}`;
              await sleep(1000);
            }
            if (tgCountdown) tgCountdown.style.display = 'none';
          }
          continue;
        }

        successCount++;
        if (tgDoneEl) tgDoneEl.textContent = String(successCount);

        // Deduct credit & persist engaged tweet ID
        if (!actions.comment) {
          // If actions.comment is true, 1 credit was already atomically deducted by the AI reply generation backend!
          deductCredits(1, 'Telegram Raid', `Engaged @${t.handle || 'user'}`);
        }
        state.engagedTweetIds = Array.from(new Set([...(state.engagedTweetIds || []), t.tweetId]));
        if (chrome.storage?.local) chrome.storage.local.set({ engagedTweetIds: state.engagedTweetIds });

        fetch(`${backendUrl}/api/tweets/mark-engaged`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tweets: [{ tweet_id: t.tweetId, handle: t.handle, canonical_url: t.canonicalUrl, action_type: 'autonomous_raid' }] })
        }).catch(() => null);


        updateTgParseSummaryUI();

        // Update HUD after success
        const donePercent = Math.round(((i + 1) / total) * 100);
        if (tgBar) tgBar.style.width = `${donePercent}%`;
        if (tgStatus) tgStatus.textContent = `${indexStr} ✓ Engaged @${t.handle || 'user'}`;
        syncFloatingHud(null, {
          title: 'TG Pulse', stateBadge: 'ENGAGING',
          indicator: `Tweet ${i + 1}/${total}`, done: successCount,
          collected: total, skipped: ignoredCount,
          progressPercent: donePercent,
          statusText: `${indexStr} ✓ Engaged @${t.handle || 'user'}`
        });

        // Anti-ban randomized pacing sleep or safety batch rest break before next tweet
        if (i < total - 1 && !state.isAborted) {
          const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
          const safety = safetyRes?.atomx_safety_settings || {};
          const isBatchBreak = shouldTakeSafetyBatchBreak(successCount, state, safety, 10, 15);

          const waitDurationSec = isBatchBreak
            ? getSafetyRestDurationSec(safety, 1, 3)
            : getSafetyPacingDelay(safety, 'profileWait', 10, 20);

          if (tgStateBadge) tgStateBadge.textContent = isBatchBreak ? 'BATCH_BREAK' : 'PACING';
          if (tgCountdown) tgCountdown.style.display = 'block';

          for (let sec = waitDurationSec; sec > 0; sec--) {
            if (state.isAborted) break;
            const min = Math.floor(sec / 60);
            const s = sec % 60;
            const timeStr = min > 0 ? `${min}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;

            if (isBatchBreak) {
              if (tgStatus) tgStatus.textContent = `☕ Safety Batch Break: Resting ${timeStr} after ${successCount} tweets...`;
              if (tgCountdown) tgCountdown.textContent = `☕ Batch Rest: ${timeStr}`;
            } else {
              if (tgStatus) tgStatus.textContent = `⏳ Profile Wait (Between Accounts): ${sec}s before tweet ${i + 2}/${total}...`;
              if (tgCountdown) tgCountdown.textContent = `Profile Wait: ${timeStr}`;
            }

            const countdownLabel = isBatchBreak ? `☕ Batch Rest: ${timeStr}` : `Profile Wait: ${timeStr}`;
            const statusMsg = isBatchBreak
              ? `☕ Safety Batch Break: Resting ${timeStr} after ${successCount} tweets...`
              : `⏳ Profile Wait (Between Accounts): ${sec}s before tweet ${i + 2}/${total}...`;

            syncFloatingHud(null, {
              title: 'TG Pulse',
              stateBadge: isBatchBreak ? 'BATCH_BREAK' : 'PACING',
              indicator: `Tweet ${i + 1}/${total}`,
              done: successCount,
              collected: total,
              skipped: ignoredCount,
              progressPercent: donePercent,
              statusText: statusMsg,
              countdownText: countdownLabel,
              nextAction: countdownLabel,
              timerBadge: `⏱️ ${timeStr}`
            });
            logger(isBatchBreak ? 'Safety Batch Rest' : `Profile Wait (${indexStr})`, `Waiting ${timeStr} before next post...`, `${i + 1}/${total}`);
            await sleep(1000);
          }
          if (tgCountdown) tgCountdown.style.display = 'none';
        }
      } catch (err) {
        console.warn(`Error automating tweet ${t?.canonicalUrl}:`, err);
        tgWorkingTabId = null;
        ignoredCount++;
        state.skippedItems = state.skippedItems || [];
        state.skippedItems.push({
          url: t?.canonicalUrl || t?.url || (t?.tweetId ? `https://x.com/i/status/${t.tweetId}` : ''),
          handle: t?.handle || '',
          tweetId: t?.tweetId || '',
          reason: `Error: ${err?.message || 'Automation error'}`
        });
        if (chrome.storage?.local) {
          chrome.storage.local.get(['atomx_tg_raid'], (r) => {
            if (r?.atomx_tg_raid) {
              chrome.storage.local.set({ atomx_tg_raid: { ...r.atomx_tg_raid, skippedItems: state.skippedItems } });
            }
          });
        }
      }
    }

    if (!state.isAborted) {
      // Completion HUD sync
      if (tgStateBadge) tgStateBadge.textContent = 'DONE';
      if (tgBar) tgBar.style.width = '100%';
      if (tgStatus) tgStatus.textContent = `✓ Completed! ${successCount} engaged, ${ignoredCount} skipped.`;
      if (tgCountdown) tgCountdown.style.display = 'none';
      syncFloatingHud(null, {
        title: 'TG Pulse',
        stateBadge: 'DONE',
        indicator: `${total}/${total}`,
        done: successCount,
        collected: total,
        skipped: ignoredCount,
        progressPercent: 100,
        statusText: `✓ Raid complete! ${successCount} engaged, ${ignoredCount} skipped.`,
        isStopped: true
      });
      logger('Engagement Completed', `Finished: ${successCount} engaged, ${ignoredCount} auto-ignored (${skippedCommentsCount} comments skipped) of ${total} tweet(s).`, `${successCount}/${total}`);
      let summaryMsg = `✓ Autonomous Engagement Finished!\n\n• Engaged: ${successCount}\n• Auto-Ignored (Already completed): ${ignoredCount}`;
      if (skippedCommentsCount > 0) summaryMsg += `\n• Comments Skipped: ${skippedCommentsCount}`;
      summaryMsg += `\n• Total Processed: ${total}\n\nHuman-like typing and selective action rules applied. 0 credits used for skipped posts.`;
      alert(summaryMsg);
    }
  } finally {
    state.isWorkflowRunning = false;
    tgWorkingTabId = null;
    setAutomationRunningUI(false);
    updateCreditUI();
    const runBtnFinal = document.getElementById('runTgEngageBtn');
    const stopBtnFinal = document.getElementById('stopTgEngageBtn');
    if (runBtnFinal) { runBtnFinal.disabled = false; runBtnFinal.textContent = '▶ Launch'; }
    if (stopBtnFinal) stopBtnFinal.style.display = 'none';
  }
}

// Opens tab (or targets active tab) and sends command to content script
async function runAutonomousActionOnTweet(tweetUrl, actions, options = {}) {
  let targetTabId = null;

  if (!tweetUrl) {
    const currentTabs = await chrome.tabs?.query({ active: true, currentWindow: true });
    const activeTab = currentTabs && currentTabs[0];
    if (activeTab && (activeTab.url?.includes('twitter.com') || activeTab.url?.includes('x.com'))) {
      targetTabId = activeTab.id;
    } else {
      throw new Error('No valid tweet URL or active Twitter tab found.');
    }
  } else {
    // Reuses ONE single tab/window throughout the entire workflow!
    targetTabId = await getOrCreateReusedTab(tgWorkingTabId, tweetUrl);
    tgWorkingTabId = targetTabId;
    await waitForTabComplete(targetTabId);
    await sleep(2500); // Wait for React hydration
  }

  const replyText = typeof options === 'string' ? options : (options.replyText || '');
  const style = typeof options === 'object' ? (options.style || state.selectedTone) : state.selectedTone;
  const stylePrompt = typeof options === 'object' ? (options.stylePrompt || state.selectedTonePrompt) : state.selectedTonePrompt;
  const backendUrl = typeof options === 'object' ? (options.backendUrl || await getBackendUrl()) : await getBackendUrl();
  const tweetAuthor = typeof options === 'object' ? (options.tweetAuthor || '') : '';
  const generateContextual = typeof options === 'object' ? (options.generateContextual !== false && !replyText) : false;

  const result = await new Promise((resolve) => {
    chrome.tabs.sendMessage(targetTabId, {
      type: 'EXECUTE_AUTONOMOUS_ENGAGEMENT',
      actions,
      replyText,
      style,
      stylePrompt,
      backendUrl,
      tweetAuthor,
      tweetUrl,
      generateContextual,
      verifiedXHandle: state.verifiedXHandle
    }, (response) => {
      if (chrome.runtime?.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: true });
      }
    });
  });

  return { targetTabId, shouldClose: false, result };
}

function waitForTabComplete(tabId, timeout = 10000) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs?.onUpdated.removeListener(listener);
        resolve(true);
      }
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs?.onUpdated.removeListener(listener);
          resolve(true);
        }
      }
    }
    chrome.tabs?.onUpdated.addListener(listener);

    chrome.tabs?.get(tabId, (tab) => {
      if (!resolved && tab?.status === 'complete') {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            chrome.tabs?.onUpdated.removeListener(listener);
            resolve(true);
          }
        }, 500);
      }
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => {
    const start = Date.now();
    let accumulatedPauseTime = 0;
    let pauseStart = 0;

    const interval = setInterval(() => {
      if (state.isAborted || state.skipCurrent) {
        clearInterval(interval);
        resolve();
        return;
      }

      if (state.isPaused) {
        if (!pauseStart) pauseStart = Date.now();
        return;
      } else if (pauseStart) {
        accumulatedPauseTime += (Date.now() - pauseStart);
        pauseStart = 0;
      }

      if (Date.now() - start - accumulatedPauseTime >= ms) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

// Live 15-second status watchdog while extension popup is active: locks immediately if admin suspends user
setInterval(async () => {
  try {
    const cleanHandle = (state.verifiedXHandle || state.user?.handle || '').replace(/^@/, '').trim();
    const email = (state.user?.email || '').trim();
    if (!cleanHandle && !email) return;

    const backendUrl = await getBackendUrl();
    const stRes = await fetch(`${backendUrl}/api/auth/check-status?handle=${encodeURIComponent(cleanHandle)}&email=${encodeURIComponent(email)}`, { credentials: 'omit' });
    if (stRes.ok) {
      const d = await stRes.json();
      if (d.status === 'SUSPENDED') {
        if (!state.user || state.user.status !== 'SUSPENDED') {
          console.warn('[ATOMX Watchdog] Account was suspended by administrator. Locking down extension.');
          if (!state.user) state.user = { handle: d.handle || `@${cleanHandle}`, email: d.email || email, status: 'SUSPENDED' };
          else state.user.status = 'SUSPENDED';
          chrome.storage?.local.set({ user: state.user, currentUser: state.user });
          state.isWorkflowRunning = false;
          tgWorkingTabId = null;
          await checkAccountVerificationLock();
        }
      } else if (d.status === 'NOT_FOUND') {
        await purgeExtLocalUserSession();
      }
    }
  } catch (e) {}
}, 15000);

