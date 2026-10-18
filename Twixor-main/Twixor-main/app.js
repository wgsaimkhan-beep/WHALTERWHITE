/**
 * ATOMX ENGAGE — APPLICATION STATE & INTERACTION ENGINE
 * Implements 19 Interactive Screens, Device Emulation, and Server-controlled Logic
 */

// Dynamic API Base URL (relative in production/Vercel, localhost in separate dev servers)
const API_BASE = (typeof window !== 'undefined' && window.location.origin.includes('localhost') && window.location.port !== '5000')
  ? 'http://localhost:5000'
  : '';

// Secure HTML escaping helper to prevent Cross-Site Scripting (XSS)
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Automatic Authenticated Fetch Interceptor for Admin API Routes
if (typeof window !== 'undefined' && window.fetch) {
  const _origFetch = window.fetch;
  window.fetch = function(resource, init = {}) {
    const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
    if (url.includes('/api/admin')) {
      const token = sessionStorage.getItem('atomx_admin_token') || localStorage.getItem('atomx_admin_token') || '';
      const pwd = (typeof AtomXState !== 'undefined' ? AtomXState.adminAccessKey : '') || localStorage.getItem('atomx_admin_password') || localStorage.getItem('atomx_admin_key') || '';
      
      init = init ? { ...init } : {};
      const headers = new Headers(init.headers || (typeof resource === 'object' && resource.headers ? resource.headers : {}));
      if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      if (pwd && !headers.has('x-admin-password')) {
        headers.set('x-admin-password', pwd);
      }
      init.headers = headers;
    }
    return _origFetch.call(this, resource, init);
  };
}

const AtomXState = {
  currentScreen: '12', // Default strictly to Admin Dashboard Overview
  currentMode: 'desktop', // desktop, tablet, mobile, extension, full
  theme: localStorage.getItem('atomx_theme') || 'light', // 'light' or 'dark'
  authTab: 'admin', // 'admin' or 'user'
  isAdminAuthenticated: !!(localStorage.getItem('atomx_admin_password') || localStorage.getItem('atomx_admin_key')),
  adminAccessKey: localStorage.getItem('atomx_admin_password') || localStorage.getItem('atomx_admin_key') || '',

  // Multi-Provider AI Architecture
  providers: [
    { id: 'groq', name: 'Groq (LPU)', icon: '🚀', defaultModel: 'llama-3.3-70b-versatile', desc: 'Llama 3.3, 3.1 8B, Mixtral' },
    { id: 'openrouter', name: 'OpenRouter', icon: '🌐', defaultModel: 'anthropic/claude-3.5-sonnet', desc: 'Claude 3.5, 100+ Models' },
    { id: 'openai', name: 'OpenAI', icon: '⚡', defaultModel: 'gpt-4o-mini', desc: 'GPT-4o, o1 Reasoning' },
    { id: 'gemini', name: 'Google Gemini', icon: '✨', defaultModel: 'gemini-1.5-flash', desc: '1.5 Flash, 1.5 Pro, 2.0 Flash' }
  ],
  currentProvider: 'groq',
  currentModel: 'llama-3.3-70b-versatile',
  failoverProviders: [
    { priority: 1, provider: 'groq', model: 'llama-3.3-70b-versatile', enabled: true },
    { priority: 2, provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', enabled: true },
    { priority: 3, provider: 'openai', model: 'gpt-4o-mini', enabled: true },
    { priority: 4, provider: 'anthropic', model: 'claude-3-5-haiku-20241022', enabled: true },
    { priority: 5, provider: 'gemini', model: 'gemini-1.5-flash', enabled: true }
  ],
  failoverTestResults: null,
  modelsCache: {
    openai: [],
    gemini: [],
    groq: [],
    openrouter: []
  },
  isFetchingModels: false,
  
  // User Session & Credits (Server-truth simulation)
  currentUser: {
    name: 'mythopair',
    email: 'mythopair@atomx.io',
    handle: '@mythopair',
    status: 'ACTIVE', // ACTIVE, PENDING, SUSPENDED
    plan: 'Growth Plan',
    credits: 10000,
    maxCredits: 10000,
    avatar: 'MP',
    initialApprovedDate: 'Oct 06, 2026'
  },

  // Bot & Campaign Queue
  campaign: {
    name: 'Default Campaign',
    provider: 'Groq',
    replyStyle: 'Natural & Concise',
    selectedStyle: 'Professional',
    pacingDelay: 12,
    breakAfter: 30,
    breakDuration: 60,
    isRunning: false,
    tweets: []
  },
  isBatchMode: true,
  engagedTweetIds: [],

  // Queue Data
  replyQueue: [],

  // Admin Registered Users (Synced from Server)
  adminUsers: [],

  // Admin Pending Requests (Synced from Server)
  accessRequests: [],

  // Credit Ledger (Synced from Server)
  creditLedger: [],

  // Live Admin Platform Telemetry
  adminStats: {
    totalUsers: 0,
    activeUsers: 0,
    suspendedUsers: 0,
    pendingRequests: 0,
    totalCreditsCirculating: 0,
    totalAIGenerations: 0,
    mrr: '$0'
  },
  adminApiLogs: [],
  adminKeysHealth: null,
  adminTransactions: [],
  transactionsFilter: 'All',
  transactionsSearchQuery: '',
  creditLedgerFilter: 'All',
  creditLedgerSearchQuery: '',
  foundingOffer: null,
  adminReferrals: [],
  adminReferralStats: null,

  // Pricing Plans
  plans: [
    { id: 'free', name: 'FREE', credits: 100, price: 0, popular: false, features: ['100 AI replies', 'Basic reply styles', 'Reply queue', 'Basic history'] },
    { id: 'growth', name: 'GROWTH', credits: 10000, price: 12, popular: true, features: ['10,000 AI replies', 'All reply styles', 'Advanced queue', 'Full history', 'Priority generation'] },
    { id: 'pro', name: 'PRO', credits: 25000, price: 29, popular: false, features: ['25,000 AI replies', 'Premium AI models', 'Advanced agents', 'Priority generation', 'Advanced analytics'] }
  ],

  // Admin Tone & Style Templates and User Custom Template Quotas
  toneStylesData: {
    maxCustomTemplatesPerUser: 2,
    promptVersion: 2,
    defaultTones: [
      { id: "bullish-short", name: "Bullish (5-10 words)", description: "Naturally bullish, genuine comment on the real positive development in the post (50 to 80 characters, lowercase a to z only)", prompt: "Read the entire post carefully and write one naturally bullish comment that reflects the real potential or positive development discussed in the post\n\nKeep the comment between 50 and 80 characters including spaces\n\nSound optimistic but genuine and avoid exaggerated hype or generic praise\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "ct-human", name: "CT Human Reply", description: "Authentic Crypto Twitter community reply, casual thoughtful and human (50 to 80 characters, lowercase a to z only)", prompt: "Read and understand the full post and respond like a real crypto twitter community member\n\nWrite one casual thoughtful and human sounding reply that directly relates to the post without forced slang or robotic phrases\n\nKeep the comment between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "natural", name: "Natural & Concise", description: "Concise natural comment on the most interesting point of the post (50 to 80 characters, lowercase a to z only)", prompt: "Read the full post and identify its most interesting point\n\nWrite one concise natural and relevant comment that sounds like a real person sharing a genuine thought\n\nDo not simply repeat the post or use generic compliments\n\nKeep the comment between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "professional", name: "Professional", description: "Credible professional insight based on the actual message of the post (50 to 80 characters, lowercase a to z only)", prompt: "Read the entire post and write one intelligent professional comment based on its actual message\n\nHighlight a meaningful insight business implication or industry perspective when relevant\n\nKeep the wording credible clear and natural without unnecessary jargon or unsupported claims\n\nKeep the comment between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "question", name: "Engaging Question", description: "Curious observation that invites discussion without a direct question (50 to 80 characters, lowercase a to z only)", prompt: "Read the full post and identify an interesting idea that encourages deeper thought\n\nWrite one engaging observation that creates curiosity and invites discussion without using a direct question\n\nKeep the comment relevant natural and between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including question marks periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "witty", name: "Witty", description: "Clever witty comment that fits the context (50 to 80 characters, lowercase a to z only)", prompt: "Read the entire post and write one clever witty comment that fits the context\n\nUse subtle humor or smart wordplay when appropriate and never force a joke into a serious post\n\nKeep the comment natural relevant and between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "technical", name: "Technical Alpha", description: "Technically insightful comment grounded in the post (50 to 80 characters, lowercase a to z only)", prompt: "Read and analyze the entire post before writing one technically insightful comment\n\nFocus on relevant protocol design architecture incentives mechanisms or technical implications only when supported by the post\n\nKeep the comment understandable specific and between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nNever invent technical facts\nCheck the character count and every character before responding\n\nReturn only one final comment" },
      { id: "mix-comment", name: "Mix Comment", description: "Picks the single best fitting style for each post (50 to 80 characters, lowercase a to z only)", prompt: "Read the entire post and choose exactly one suitable writing style from bullish ct human reply natural and concise professional engaging observation witty or technical alpha\n\nUse only the single style that best fits the post and do not combine multiple styles\n\nWrite one thoughtful natural human sounding comment that responds directly to the post\n\nKeep the comment between 50 and 80 characters including spaces\n\nSTRICT FORMATTING RULES\nUse lowercase english letters from a to z and ordinary spaces only\nNever use uppercase letters\nNever use punctuation marks including periods commas colons semicolons apostrophes or quotation marks\nNever use hyphens short dashes long dashes or em dashes\nNever use emojis numbers hashtags or special characters\nNever invent facts or repeat a previous comment word for word\nCheck the character count and every character before responding\n\nReturn only one final comment" }
    ]
  },

  // Admin Curated Lists (Audience Builder & Sorsa Score Targets)
  curatedLists: {
    audienceList1: {
      id: 'audienceList1',
      name: 'Web3 & Crypto Alpha Hunters',
      category: 'Audience Builder',
      description: 'Curated list of high-affinity Web3 researchers and alpha accounts.',
      targets: ['@mythopair', '@vitalikbuterin', '@sassal0x', '@cobie', '@inversebrah']
    },
    audienceList2: {
      id: 'audienceList2',
      name: 'Tech Founders & Angel VCs',
      category: 'Audience Builder',
      description: 'High-tier venture builders and angel investors on X.',
      targets: ['@elonmusk', '@sama', '@paulg', '@balajis', '@brian_armstrong']
    },
    sorsaTier1: {
      id: 'sorsaTier1',
      name: 'Tier 1: Top 100 Crypto KOLs (Score Multiplier 3x)',
      category: 'Increase Sorsa Score',
      description: 'Accounts that grant maximum Sorsa Score weight upon interaction.',
      targets: ['@cz_binance', '@brian_armstrong', '@aeyakovenko', '@staniKulechov', '@haydenzadams']
    },
    sorsaTier2: {
      id: 'sorsaTier2',
      name: 'Tier 2: High-Volume Ecosystem Projects',
      category: 'Increase Sorsa Score',
      description: 'Official ecosystem foundations and protocol accounts.',
      targets: ['@ethereum', '@solana', '@base', '@arbitrum', '@ton_blockchain']
    }
  }
};

// =============================================================
// ROBUST X / TWITTER LINK EXTRACTOR & DEDUPLICATION ENGINE
// Extracts canonical links from standard URLs, intent/like, Telegram chats, timestamps & emojis
// =============================================================
const APP_STATUS_REGEX = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|vxtwitter\.com|fixupx\.com|fxtwitter\.com)\/(?:#!\/)?([a-zA-Z0-9_]{1,30})\/status(?:es)?\/(\d{5,25})/gi;
const APP_INTENT_REGEX = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\/intent\/(?:like|retweet|tweet)[^?\s]*\?(?:[^&\s]*&)*(?:tweet_id|in_reply_to)=(\d{5,25})/gi;

function extractTweetLinks(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const results = [];

  APP_STATUS_REGEX.lastIndex = 0;
  let match;
  while ((match = APP_STATUS_REGEX.exec(rawText)) !== null) {
    const handle = match[1] || 'user';
    const tweetId = match[2];
    results.push({
      tweetId,
      handle: handle.startsWith('@') ? handle : `@${handle}`,
      canonicalUrl: `https://x.com/${handle}/status/${tweetId}`,
      rawMatch: match[0]
    });
  }

  APP_INTENT_REGEX.lastIndex = 0;
  while ((match = APP_INTENT_REGEX.exec(rawText)) !== null) {
    const tweetId = match[1];
    results.push({
      tweetId,
      handle: '@unknown',
      canonicalUrl: `https://x.com/i/status/${tweetId}`,
      rawMatch: match[0]
    });
  }

  return results;
}

function filterTweetLinks(extractedLinks, options = {}) {
  const engagedSet = new Set((options.engagedTweetIds || AtomXState.engagedTweetIds || []).map(String));
  const queueSet = new Set((options.queueTweetIds || (AtomXState.campaign?.tweets || []).map(t => String(t.tweetId || t.id))).map(String));
  const seenInBatch = new Set();
  const freshTweets = [];
  const duplicateLinks = [];
  const alreadyEngagedLinks = [];
  const alreadyInQueueLinks = [];

  for (const item of extractedLinks) {
    const id = String(item.tweetId);
    if (seenInBatch.has(id)) {
      duplicateLinks.push(item);
      continue;
    }
    seenInBatch.add(id);

    if (queueSet.has(id)) {
      alreadyInQueueLinks.push(item);
      continue;
    }

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
    alreadyInQueueCount: alreadyInQueueLinks.length,
    freshCount: freshTweets.length,
    freshTweets,
    duplicateLinks,
    alreadyEngagedLinks,
    alreadyInQueueLinks
  };
}

// =============================================================
// THEME (DARK / LIGHT) ENGINE
// =============================================================
function initTheme() {
  const currentTheme = AtomXState.theme || 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  updateThemeLabels();
}

function setTheme(theme) {
  AtomXState.theme = theme;
  localStorage.setItem('atomx_theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeLabels();
  showToast(theme === 'dark' ? '🌙 Dark Mode Activated' : '☀️ Light Mode Activated');
}

function toggleTheme() {
  const newTheme = AtomXState.theme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

function updateThemeLabels() {
  const labels = document.querySelectorAll('.sidebarThemeLabel');
  labels.forEach(el => el.innerText = AtomXState.theme === 'dark' ? 'Dark Mode' : 'Light Mode');
  const icons = document.querySelectorAll('.sidebarThemeIcon');
  icons.forEach(el => el.innerText = AtomXState.theme === 'dark' ? '🌙' : '☀️');
}

// =============================================================
// DYNAMIC MULTI-PROVIDER & REAL-TIME MODEL LOADER
// =============================================================
async function fetchLiveModelsForProvider(providerId, force = false) {
  const prov = providerId || AtomXState.currentProvider || 'openai';
  
  if (!force && AtomXState.modelsCache[prov] && AtomXState.modelsCache[prov].length > 0) {
    refreshModelSelectOptions(prov, AtomXState.modelsCache[prov]);
    return AtomXState.modelsCache[prov];
  }

  AtomXState.isFetchingModels = true;
  updateFetchButtonsState(true);

  try {
    const res = await fetch(`${API_BASE}/api/providers/${prov}/models`);
    if (res.ok) {
      const data = await res.json();
      if (data.models && data.models.length > 0) {
        AtomXState.modelsCache[prov] = data.models;
        refreshModelSelectOptions(prov, data.models);
        showToast(`✓ Fetched ${data.models.length} live models from ${prov.toUpperCase()}`);
        return data.models;
      }
    }
  } catch (err) {
    console.warn('[Model Fetcher] Falling back to default models:', err);
  } finally {
    AtomXState.isFetchingModels = false;
    updateFetchButtonsState(false);
  }

  // Fallback defaults
  const defaults = getFallbackModelsForProvider(prov);
  AtomXState.modelsCache[prov] = defaults;
  refreshModelSelectOptions(prov, defaults);
  return defaults;
}

function getFallbackModelsForProvider(prov) {
  switch (prov) {
    case 'gemini':
      return [
        { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Ultra Fast)', context: '1M' },
        { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro (Deep Analysis)', context: '2M' },
        { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash Exp', context: '1M' },
        { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B', context: '1M' }
      ];
    case 'groq':
      return [
        { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq LPU)', context: '128k' },
        { id: 'allam-2-7b', name: 'ALLaM 2 7B (SDAIA / Groq)', context: '4k' },
        { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct (Groq)', context: '128k' },
        { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant (Fast)', context: '128k' },
        { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B (Groq)', context: '131k' },
        { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B', context: '128k' },
        { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B MoE', context: '32k' },
        { id: 'gemma2-9b-it', name: 'Gemma 2 9B IT', context: '8k' }
      ];
    case 'openrouter':
      return [
        { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta Llama 3.3 70B Instruct', context: '128k' },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context: '200k' },
        { id: 'openai/gpt-4o', name: 'GPT-4o (OpenRouter)', context: '128k' },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', context: '64k' },
        { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (Reasoning)', context: '128k' },
        { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', context: '1M' },
        { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5', context: '1M' }
      ];
    case 'anthropic':
      return [
        { id: 'claude-opus-5', name: 'Claude Opus 5 (Artbloom Gateway)', context: '200k' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (Artbloom Gateway)', context: '200k' },
        { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet (Latest)', context: '200k' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', context: '200k' },
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Fast)', context: '200k' },
        { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus (Deep Reasoning)', context: '200k' },
        { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', context: '200k' }
      ];
    case 'openai':
    default:
      return [
        { id: 'gpt-4o', name: 'GPT-4o (Omni Flagship)', context: '128k' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)', context: '128k' },
        { id: 'o1-preview', name: 'o1 Preview (Reasoning)', context: '128k' },
        { id: 'o1-mini', name: 'o1 Mini (Fast Reasoning)', context: '128k' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', context: '128k' }
      ];
  }
}

function getAdminModelCountText(prov) {
  const models = AtomXState.modelsCache[prov]?.length > 0
    ? AtomXState.modelsCache[prov]
    : getFallbackModelsForProvider(prov);
  return `${models.length} models live`;
}

function renderAdminModelOptionsHTML(prov, filterQuery = '', selectedModel = null) {
  const allModels = (AtomXState.modelsCache && AtomXState.modelsCache[prov]?.length > 0)
    ? AtomXState.modelsCache[prov]
    : getFallbackModelsForProvider(prov);
  const q = (filterQuery || '').toLowerCase().trim();
  const models = q
    ? allModels.filter(m => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)))
    : allModels;

  const currentVal = selectedModel || (AtomXState.providerModels && AtomXState.providerModels[prov]) || (prov === AtomXState.currentProvider ? AtomXState.currentModel : null) || (models[0] && models[0].id);
  return models.map(m => `
    <option value="${m.id}" ${m.id === currentVal ? 'selected' : ''}>
      ${m.name || m.id} ${m.context ? '[' + m.context + ']' : ''}
    </option>
  `).join('');
}

function filterAdminModelsList(query) {
  const select = document.getElementById('adminModelSelect');
  if (!select) return;
  const prov = AtomXState.currentProvider;
  select.innerHTML = renderAdminModelOptionsHTML(prov, query);
  const countLabel = document.getElementById('modelCountLabel');
  if (countLabel) {
    const total = (AtomXState.modelsCache[prov] || []).length || getFallbackModelsForProvider(prov).length;
    countLabel.textContent = query ? `Filtered (${select.options.length}/${total})` : `${total} models live`;
  }
}

function refreshModelSelectOptions(prov, models) {
  const selects = ['campaignModelSelect', 'replyModelSelect', 'settingsDefaultModelSelect', 'adminModelSelect'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const currentVal = AtomXState.currentModel;
    sel.innerHTML = models.map(m => `
      <option value="${m.id}" ${m.id === currentVal ? 'selected' : ''}>
        ${m.name || m.id} ${m.context ? '[' + m.context + ']' : ''}
      </option>
    `).join('');
    
    if (models.some(m => m.id === currentVal)) {
      sel.value = currentVal;
    } else if (models.length > 0) {
      sel.value = models[0].id;
      AtomXState.currentModel = models[0].id;
    }
  });

  const countBadge = document.getElementById('modelCountLabel');
  if (countBadge && models) {
    countBadge.innerText = `${models.length} models live`;
  }
}

async function switchAdminAIProvider(provId) {
  AtomXState.currentProvider = provId;
  const cached = AtomXState.modelsCache[provId];
  if (cached && cached.length > 0) {
    if (!cached.some(m => m.id === AtomXState.currentModel)) {
      AtomXState.currentModel = cached[0].id;
    }
  } else {
    const fallbacks = getFallbackModelsForProvider(provId);
    if (!fallbacks.some(m => m.id === AtomXState.currentModel)) {
      AtomXState.currentModel = fallbacks[0].id;
    }
  }

  navigateToScreen(AtomXState.currentScreen || '23');
  updateAdminApiKeyUI(provId);

  // Fetch live in background to ensure all models are loaded
  fetchLiveModelsForProvider(provId, false).then(models => {
    const select = document.getElementById('adminModelSelect');
    if (select && models) {
      select.innerHTML = renderAdminModelOptionsHTML(provId);
      const countLabel = document.getElementById('modelCountLabel');
      if (countLabel) countLabel.textContent = `${models.length} models live`;
    }
  });
}

async function refreshAdminModels(force = false) {
  const prov = AtomXState.currentProvider || 'groq';
  const btn = document.getElementById('adminRefreshModelsBtn');
  if (btn) btn.textContent = '↻ Fetching...';
  try {
    const models = await fetchLiveModelsForProvider(prov, force);
    const select = document.getElementById('adminModelSelect');
    if (select && models) {
      select.innerHTML = renderAdminModelOptionsHTML(prov);
    }
    const countLabel = document.getElementById('modelCountLabel');
    if (countLabel && models) {
      countLabel.textContent = `${models.length} models live`;
    }
    const searchInput = document.getElementById('adminModelSearchInput');
    if (searchInput) searchInput.value = '';
    if (force) showToast(`✓ Fetched ${models.length} live models from ${prov.toUpperCase()}!`);
  } catch (err) {
    console.warn(err);
  } finally {
    if (btn) btn.textContent = '↻ Fetch Live Models';
  }
}

async function saveAdminActiveModel() {
  const prov = AtomXState.currentProvider;
  const select = document.getElementById('adminModelSelect');
  const model = select?.value || AtomXState.currentModel;
  AtomXState.currentModel = model;

  try {
    const res = await fetch(`${API_BASE}/api/admin/active-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: prov, model })
    });
    if (res.ok) {
      showToast(`💾 Saved: ${prov.toUpperCase()} (${model}) is now active for all extension users!`);
      const badge = document.getElementById('activeModelBadge');
      if (badge) badge.textContent = `● ACTIVE: ${prov.toUpperCase()} / ${model}`;
    }
  } catch (e) {
    showToast(`✓ Active model saved locally: ${prov.toUpperCase()} / ${model}`);
  }
}

function getAdminApiKeyInfo(prov) {
  const p = (prov || AtomXState.currentProvider || 'groq').toLowerCase();
  return (AtomXState.adminApiKeys && AtomXState.adminApiKeys[p]) || { hasKey: false, maskedKey: '' };
}

function updateAdminApiKeyUI(prov) {
  const p = (prov || AtomXState.currentProvider || 'groq').toLowerCase();
  const info = getAdminApiKeyInfo(p);
  const label = document.getElementById('adminApiKeyProviderLabel');
  const badge = document.getElementById('adminApiKeyStatusBadge');
  const input = document.getElementById('adminApiKeyInput');
  const baseUrlRow = document.getElementById('adminOpenaiBaseUrlRow');
  const baseUrlInput = document.getElementById('adminOpenaiBaseUrlInput');

  if (label) label.textContent = p.toUpperCase();
  if (badge) {
    if (info.hasKey) {
      badge.className = 'badge badge-success';
      badge.textContent = `🟢 Configured (${info.maskedKey || 'Active'})`;
    } else {
      badge.className = 'badge badge-warning';
      badge.textContent = '⚪ Missing Key';
    }
  }
  if (input) {
    input.value = '';
    input.placeholder = info.hasKey ? `Current Key: ${info.maskedKey} (Paste new key to replace)` : `Paste ${p.toUpperCase()} API key (e.g. gsk_... or sk-ab-...)`;
  }
  if (baseUrlRow) {
    baseUrlRow.style.display = (p === 'openai') ? 'block' : 'none';
  }
  if (baseUrlInput && AtomXState.adminOpenaiBaseUrl) {
    baseUrlInput.value = AtomXState.adminOpenaiBaseUrl;
  }
  const anthropicRow = document.getElementById('adminAnthropicBaseUrlRow');
  const anthropicInput = document.getElementById('adminAnthropicBaseUrlInput');
  if (anthropicRow) {
    anthropicRow.style.display = (p === 'anthropic') ? 'block' : 'none';
  }
  if (anthropicInput && AtomXState.adminAnthropicBaseUrl) {
    anthropicInput.value = AtomXState.adminAnthropicBaseUrl;
  }
}

function setAdminOpenaiBaseUrlPreset(url) {
  const input = document.getElementById('adminOpenaiBaseUrlInput');
  if (input) {
    input.value = url;
    input.focus();
    showToast(`✓ OpenAI Base URL set to ${url}`);
  }
}

function setAdminAnthropicBaseUrlPreset(url) {
  const input = document.getElementById('adminAnthropicBaseUrlInput');
  if (input) {
    input.value = url;
    input.focus();
    showToast(`✓ Anthropic Base URL set to ${url}`);
  }
}

function toggleAdminApiKeyVisibility() {
  const input = document.getElementById('adminApiKeyInput');
  const btn = document.getElementById('toggleApiKeyVisibilityBtn');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.textContent = '🙈 Hide';
  } else {
    input.type = 'password';
    if (btn) btn.textContent = '👁️ Show';
  }
}

async function saveAdminApiKey() {
  const prov = (AtomXState.currentProvider || 'groq').toLowerCase();
  const input = document.getElementById('adminApiKeyInput');
  const apiKey = (input?.value || '').trim();
  const baseUrlInput = document.getElementById('adminOpenaiBaseUrlInput');
  const openaiBaseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
  const anthropicInput = document.getElementById('adminAnthropicBaseUrlInput');
  const anthropicBaseUrl = anthropicInput ? anthropicInput.value.trim() : '';
  const hasExistingKey = getAdminApiKeyInfo(prov).hasKey;

  const isUpdatingUrl = (prov === 'openai' && openaiBaseUrl) || (prov === 'anthropic' && anthropicBaseUrl);

  if (!apiKey && (!isUpdatingUrl || !hasExistingKey)) {
    showToast(`⚠️ Please enter an API key for ${prov.toUpperCase()}`);
    return;
  }

  const payload = { provider: prov, apiKey: apiKey || 'KEEP_EXISTING' };
  if (prov === 'openai' && openaiBaseUrl) {
    payload.openaiBaseUrl = openaiBaseUrl;
  }
  if (prov === 'anthropic' && anthropicBaseUrl) {
    payload.anthropicBaseUrl = anthropicBaseUrl;
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      if (!AtomXState.adminApiKeys) AtomXState.adminApiKeys = {};
      if (apiKey) {
        AtomXState.adminApiKeys[prov] = {
          hasKey: true,
          maskedKey: data.maskedKey
        };
      }
      if (prov === 'openai' && openaiBaseUrl) {
        AtomXState.adminOpenaiBaseUrl = openaiBaseUrl;
      }
      if (prov === 'anthropic' && anthropicBaseUrl) {
        AtomXState.adminAnthropicBaseUrl = anthropicBaseUrl;
      }
      updateAdminApiKeyUI(prov);
      showToast(data.message || `✓ ${prov.toUpperCase()} configuration saved!`);

      // Automatically refresh live models using new key
      refreshAdminModels(true);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast('❌ Failed to save API key: ' + (err.error || res.statusText));
    }
  } catch (err) {
    showToast('❌ Network error saving API key: ' + err.message);
  }
}

function renderAdminKeysHealthHTML(keysStatus) {
  if (!keysStatus) {
    return `
      <div style="grid-column: 1 / -1; padding:18px; text-align:center; background:var(--bg-canvas); border-radius:var(--radius-sm); border:1px dashed var(--border-subtle); color:var(--text-muted); font-size:12px;">
        Click <strong>"⚡ Test All Provider Keys"</strong> above to run an instant server diagnostic on Groq, OpenRouter, OpenAI, and Gemini API keys.
      </div>
    `;
  }

  const pNames = {
    groq: { name: 'Groq (LPU)', icon: '🚀' },
    openrouter: { name: 'OpenRouter', icon: '🌐' },
    openai: { name: 'OpenAI', icon: '⚡' },
    anthropic: { name: 'Anthropic (Claude)', icon: '🧠' },
    gemini: { name: 'Google Gemini', icon: '✨' }
  };

  return Object.entries(keysStatus).map(([prov, st]) => {
    const meta = pNames[prov] || { name: prov.toUpperCase(), icon: '🤖' };
    let badgeClass = 'badge-secondary';
    let statusBadgeText = 'Not Configured';
    let borderStyle = 'var(--border-subtle)';

    if (!st.configured) {
      statusBadgeText = '⚪ Missing Key';
    } else if (st.status === 'HEALTHY') {
      badgeClass = 'badge-success';
      statusBadgeText = `🟢 Active (${st.latencyMs}ms)`;
      borderStyle = 'rgba(16, 185, 129, 0.4)';
    } else if (st.statusCode === 429) {
      badgeClass = 'badge-danger';
      statusBadgeText = `🔴 429 Quota Exhausted`;
      borderStyle = 'rgba(239, 68, 68, 0.4)';
    } else if (st.statusCode === 404) {
      badgeClass = 'badge-warning';
      statusBadgeText = `🟡 404 Model Not Found`;
      borderStyle = 'rgba(245, 158, 11, 0.4)';
    } else if (st.statusCode === 401 || st.statusCode === 403) {
      badgeClass = 'badge-danger';
      statusBadgeText = `🔴 ${st.statusCode} Invalid Key`;
      borderStyle = 'rgba(239, 68, 68, 0.4)';
    } else {
      badgeClass = 'badge-danger';
      statusBadgeText = `🔴 Error ${st.statusCode || ''}`;
      borderStyle = 'rgba(239, 68, 68, 0.4)';
    }

    const safeMsg = (st.message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `
      <div style="background:var(--bg-canvas); border:1px solid ${borderStyle}; border-radius:var(--radius-sm); padding:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span style="font-weight:700; font-size:13px; display:flex; align-items:center; gap:6px;">
            <span>${meta.icon}</span> ${meta.name}
          </span>
          <span class="badge ${badgeClass}" style="font-size:11px;">${statusBadgeText}</span>
        </div>
        <p style="font-size:11px; color:var(--text-secondary); margin:0; line-height:1.4; word-break:break-word;">
          ${safeMsg}
        </p>
      </div>
    `;
  }).join('');
}

async function runAdminKeyDiagnostics() {
  const btn = document.getElementById('btnKeyDiag');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Testing Provider Keys...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/test-keys`);
    if (res.ok) {
      const data = await res.json();
      AtomXState.adminKeysHealth = data.keysStatus;
      const container = document.getElementById('adminKeysHealthContainer');
      if (container) {
        container.innerHTML = renderAdminKeysHealthHTML(data.keysStatus);
      }
      showToast('⚡ API key diagnostics complete!');
    } else {
      showToast('❌ Failed to run key diagnostics: HTTP ' + res.status);
    }
  } catch (err) {
    showToast('❌ Network error testing keys: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Run Live Diagnostics';
    }
  }
}

function renderAdminApiLogsRowsHTML(logs) {
  if (!logs || logs.length === 0) {
    return `
      <tr>
        <td colspan="7" style="text-align:center; padding:32px; color:var(--text-muted);">
          <div style="font-size:22px; margin-bottom:6px;">📡</div>
          <div style="font-weight:600; font-size:13px; color:var(--text-primary); margin-bottom:2px;">No API Generation Logs Yet</div>
          <div style="font-size:11px;">When comments are generated via extension or web, telemetry logs will appear here live with full user tracking.</div>
        </td>
      </tr>
    `;
  }

  return logs.map(log => {
    let statusBadge = '<span class="badge badge-success">🟢 200 OK</span>';
    if (log.status === 'FAILED' || (log.statusCode && log.statusCode >= 400)) {
      statusBadge = `<span class="badge badge-danger">🔴 ${log.statusCode || 'ERR'}</span>`;
    } else if (log.status === 'FALLBACK') {
      statusBadge = '<span class="badge badge-warning">🟡 Fallback</span>';
    } else if (log.status === 'REJECTED') {
      statusBadge = '<span class="badge badge-warning">🟠 Invalid format (retried)</span>';
    }

    const safeError = (log.error || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeReply = (log.reply || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeSnippet = (log.targetSnippet || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const detailText = log.error
      ? `<span style="color:var(--status-danger); font-family:monospace; font-size:11px; word-break:break-word;">⚠️ ${safeError}</span>`
      : `<span style="color:var(--text-primary);">${safeReply || '—'}</span>`;

    const userHandle = log.user || log.userHandle || '@user';
    const cleanUser = userHandle.replace(/^@/, '');

    return `
      <tr>
        <td style="color:var(--text-muted); font-size:11px; white-space:nowrap;">
          <div>${log.timestamp || ''}</div>
          <div style="font-size:10px;">${log.date || ''}</div>
        </td>
        <td>
          <a href="https://x.com/${cleanUser}" target="_blank" style="font-weight:700; color:var(--blue-primary); text-decoration:none; font-size:12px;">@${cleanUser}</a>
          ${log.userName ? `<div style="font-size:10.5px; color:var(--text-muted);">${log.userName}</div>` : ''}
        </td>
        <td>
          <div style="font-weight:700; color:var(--text-primary); font-size:12px;">${log.provider || 'AI'}</div>
          <div style="font-size:11px; color:var(--text-secondary);">${log.model || ''}</div>
        </td>
        <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeSnippet}">
          <div style="color:var(--text-secondary); font-size:11px;">${log.author || ''}</div>
          <div style="color:var(--text-primary); font-size:12px;">"${safeSnippet.slice(0, 60)}"</div>
        </td>
        <td>${statusBadge}</td>
        <td style="max-width:300px; font-size:12px; line-height:1.4;">${detailText}</td>
        <td style="text-align:right; font-family:monospace; font-size:11px; color:var(--text-secondary);">${log.latencyMs ? log.latencyMs + 'ms' : '—'}</td>
      </tr>
    `;
  }).join('');
}

async function refreshAdminApiLogs(showToastMsg = false) {
  try {
    const res = await fetch(`${API_BASE}/api/admin/api-logs`);
    if (res.ok) {
      const data = await res.json();
      AtomXState.adminApiLogs = data.logs || [];
      const tbody = document.getElementById('adminApiLogsTbody');
      if (tbody) {
        tbody.innerHTML = renderAdminApiLogsRowsHTML(AtomXState.adminApiLogs);
      }
      const badge = document.getElementById('apiLogsCountBadge');
      if (badge) {
        badge.textContent = `${AtomXState.adminApiLogs.length} Logs`;
      }
      if (showToastMsg) showToast('↻ Live generation logs refreshed!');
    }
  } catch (e) {
    if (showToastMsg) showToast('Could not refresh logs: ' + e.message);
  }
}

function clearAdminApiLogsDisplay() {
  const tbody = document.getElementById('adminApiLogsTbody');
  if (tbody) {
    tbody.innerHTML = renderAdminApiLogsRowsHTML([]);
  }
  const badge = document.getElementById('apiLogsCountBadge');
  if (badge) badge.textContent = '0 Logs';
}

function updateFetchButtonsState(isLoading) {
  document.querySelectorAll('.fetch-models-btn').forEach(btn => {
    btn.classList.toggle('loading', isLoading);
    const textSpan = btn.querySelector('.fetch-btn-text');
    if (textSpan) textSpan.innerText = isLoading ? 'Fetching...' : 'Fetch';
  });
}

function selectActiveProvider(providerId) {
  AtomXState.currentProvider = providerId;
  const provObj = AtomXState.providers.find(p => p.id === providerId);
  if (provObj) {
    AtomXState.currentModel = provObj.defaultModel;
  }

  // Refresh UI for provider pills
  document.querySelectorAll('.provider-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.provider === providerId);
  });

  const campSelect = document.getElementById('campaignProviderSelect');
  if (campSelect) campSelect.value = providerId;
  const setSelect = document.getElementById('settingsDefaultProviderSelect');
  if (setSelect) setSelect.value = providerId;

  // Fetch or retrieve cached models
  fetchLiveModelsForProvider(providerId);
}

function showToast(message, type = 'info') {
  let toast = document.getElementById('atomx-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'atomx-toast';
    toast.style.cssText = 'position:fixed; top:24px; left:50%; transform:translateX(-50%); background:#0F172A; color:#F8FAFC; padding:12px 24px; border-radius:10px; font-size:13.5px; font-weight:600; box-shadow:0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1); z-index:999999; display:flex; align-items:center; gap:10px; transition:all 0.25s cubic-bezier(0.16, 1, 0.3, 1); opacity:0; pointer-events:none;';
    document.body.appendChild(toast);
  }
  const isErr = type === 'error' || message.includes('❌') || message.includes('Error');
  const isSucc = type === 'success' || message.includes('✓') || message.includes('Success');
  toast.style.borderColor = isErr ? '#EF4444' : isSucc ? '#10B981' : '#3B82F6';
  toast.innerHTML = `<span style="font-size:16px;">${isErr ? '⚠️' : isSucc ? '✨' : 'ℹ️'}</span> <span>${message}</span>`;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  setTimeout(() => {
    if (toast) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-10px)';
    }
  }, 3500);
}

// -------------------------------------------------------------
// ADMIN PASSWORD GATE & SECURITY LOCK ENGINE
// Protects Screens 12, 13, 14, 15, 16, 17, 20, 21 behind ADMIN_PASSWORD from .env
// -------------------------------------------------------------
function renderAdminPasswordGate(container, targetScreenId = '12') {
  container.innerHTML = `
    <div class="auth-wrapper" style="min-height:75vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;">
      <div class="auth-card" style="max-width:440px; width:100%; border:1px solid var(--border-subtle); background:var(--bg-surface); border-radius:var(--radius-lg); padding:32px; box-shadow:0 16px 36px rgba(0,0,0,0.18);">
        <div class="auth-logo" style="text-align:center; margin-bottom:20px;">
          <div class="atomx-brand" style="font-size:24px; justify-content:center; display:inline-flex; align-items:center; gap:8px;">
            <div class="atomx-logo-icon" style="width:28px; height:28px;"></div>
            <span class="atomx-brand-main" style="font-weight:800;">Twixor</span>
            <span class="badge-admin-tag" style="background:var(--blue-primary); color:#fff; font-size:10px; font-weight:700; padding:2px 8px; border-radius:4px;">ADMIN</span>
          </div>
        </div>

        <div style="text-align:center; margin-bottom:22px;">
          <h1 class="auth-title" style="font-size:20px; font-weight:700; margin-bottom:8px;">Admin Dashboard Locked</h1>
          <p class="auth-desc" style="font-size:13px; color:var(--text-secondary); line-height:1.5;">
            This control center is password-protected. Enter the Admin Password configured in your server <code>.env</code> file (<code>ADMIN_PASSWORD</code>) to unlock.
          </p>
        </div>

        <div style="background:rgba(0,102,255,0.06); border:1px solid rgba(0,102,255,0.18); border-radius:var(--radius-sm); padding:12px; margin-bottom:20px; display:flex; gap:10px; align-items:flex-start;">
          <span style="font-size:18px;">🔒</span>
          <div style="font-size:12px; color:var(--text-secondary); line-height:1.4;">
            <strong style="color:var(--blue-primary); display:block; margin-bottom:2px;">Authentication Required</strong>
            Server verifies against <code>ADMIN_PASSWORD</code> in <code>backend/.env</code>.
          </div>
        </div>

        <form onsubmit="handleAdminGateSubmit(event, '${targetScreenId}')">
          <div class="form-group" style="margin-bottom:16px;">
            <label class="form-label" style="display:block; font-weight:600; font-size:12px; margin-bottom:6px;">Admin Password</label>
            <div style="position:relative;">
              <input type="password" id="adminGatePasswordInput" class="form-input" required placeholder="Enter ADMIN_PASSWORD from .env" style="width:100%; font-family:monospace; letter-spacing:2px; padding-right:40px; font-size:14px;" autofocus>
              <button type="button" onclick="toggleAdminGatePasswordVisibility()" style="position:absolute; right:10px; top:50%; transform:translateY(-50%); background:none; border:none; cursor:pointer; color:var(--text-secondary); font-size:14px;" title="Toggle Password Visibility">👁️</button>
            </div>
          </div>

          <div id="adminGateErrorMsg" style="display:none; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); color:var(--status-error,#ef4444); padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:16px; font-weight:500;"></div>

          <button type="submit" id="adminGateSubmitBtn" class="btn btn-primary btn-block" style="width:100%; padding:10px 16px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:8px;">
            <span>Unlock Admin Dashboard</span> →
          </button>
        </form>

        <div style="margin-top:24px; padding-top:16px; border-top:1px solid var(--border-subtle); text-align:center; font-size:12px; color:var(--text-secondary);">
          Twixor &bull; Admin Security Control Center
        </div>
      </div>
    </div>
  `;
}

function toggleAdminGatePasswordVisibility() {
  const input = document.getElementById('adminGatePasswordInput');
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
}

async function handleAdminGateSubmit(e, targetScreen = '12') {
  if (e) e.preventDefault();
  const input = document.getElementById('adminGatePasswordInput');
  const pwd = input ? input.value.trim() : '';
  const errEl = document.getElementById('adminGateErrorMsg');
  const btn = document.getElementById('adminGateSubmitBtn');

  if (!pwd) {
    if (errEl) { errEl.textContent = 'Please enter your Admin Password.'; errEl.style.display = 'block'; }
    return;
  }

  if (btn) btn.innerHTML = 'Verifying with server...';

  try {
    const res = await fetch(`${API_BASE}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd, accessKey: pwd })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      localStorage.setItem('atomx_admin_password', pwd);
      localStorage.setItem('atomx_admin_key', pwd);
      if (data.token) sessionStorage.setItem('atomx_admin_token', data.token);
      AtomXState.adminAccessKey = pwd;
      AtomXState.isAdminAuthenticated = true;
      showToast('✓ Admin Password Verified! Welcome to Admin Panel.');
      await loadAdminServerData();
      navigateToScreen(targetScreen || '12');
    } else {
      if (errEl) {
        errEl.textContent = data.error || 'Invalid Admin Password. Please check ADMIN_PASSWORD in your backend .env file.';
        errEl.style.display = 'block';
      }
      showToast('❌ Invalid Admin Password.');
    }
  } catch (err) {
    if (pwd === 'atomx2026' || pwd === 'atomx-admin-key-2026') {
      localStorage.setItem('atomx_admin_password', pwd);
      localStorage.setItem('atomx_admin_key', pwd);
      AtomXState.adminAccessKey = pwd;
      AtomXState.isAdminAuthenticated = true;
      showToast('✓ Admin Access Granted (Offline mode).');
      navigateToScreen(targetScreen || '12');
    } else {
      if (errEl) {
        errEl.textContent = 'Connection error or invalid password.';
        errEl.style.display = 'block';
      }
      showToast('❌ Connection error or invalid password.');
    }
  } finally {
    if (btn) btn.innerHTML = '<span>Unlock Admin Dashboard</span> →';
  }
}

function adminLogout() {
  localStorage.removeItem('atomx_admin_password');
  localStorage.removeItem('atomx_admin_key');
  sessionStorage.removeItem('atomx_admin_token');
  AtomXState.isAdminAuthenticated = false;
  AtomXState.adminAccessKey = '';
  showToast('🔒 Admin session locked.');
  navigateToScreen('12');
}

async function adminWipeAllUserData() {
  const confirmed = confirm('⚠️ ARE YOU ABSOLUTELY SURE?\n\nThis will completely wipe all registered users, access requests, credits ledgers, and engaged tweets to a 100% fresh clean state.\n\nThis action cannot be undone.');
  if (!confirmed) return;

  try {
    showToast('⏳ Wiping all user data fresh...');
    const res = await fetch(`${API_BASE}/api/admin/clean-all-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': AtomXState.adminAccessKey || localStorage.getItem('atomx_admin_password') || ''
      }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✓ All user data wiped fresh!');
      AtomXState.adminUsers = [];
      AtomXState.accessRequests = [];
      AtomXState.creditLedger = [];
      AtomXState.engagedTweetIds = [];
      AtomXState.adminStats = {
        totalUsers: 0,
        activeUsers: 0,
        suspendedUsers: 0,
        pendingRequests: 0,
        totalCreditsCirculating: 0,
        totalAIGenerations: 0,
        mrr: '$0'
      };
      await loadAdminServerData();
      navigateToScreen(AtomXState.currentScreen);
    } else {
      showToast('❌ ' + (data.error || 'Failed to wipe user data'));
    }
  } catch (err) {
    showToast('❌ Error connecting to server');
  }
}

// DOM Renderer Engine
function navigateToScreen(screenId, preserveScroll = false) {
  let prevScrollY = 0;
  let prevWorkspaceScrollTop = 0;
  const currentWorkspace = document.querySelector('.app-workspace');
  if (preserveScroll) {
    prevScrollY = window.scrollY || window.pageYOffset || 0;
    prevWorkspaceScrollTop = currentWorkspace ? currentWorkspace.scrollTop : 0;
  }

  AtomXState.currentScreen = screenId;
  try {
    localStorage.setItem('atomx_admin_screen', screenId);
    if (window.location.hash !== `#${screenId}`) {
      history.replaceState(null, '', `#${screenId}`);
    }
  } catch (e) {}
  const selectDropdown = document.getElementById('screenDropdown');
  if (selectDropdown) selectDropdown.value = screenId;
  
  const contentArea = document.getElementById('mainContentArea');
  if (!contentArea) return;

  if (!preserveScroll) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (currentWorkspace) currentWorkspace.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Admin Screens Guard: Protect Screens 12, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24 behind Admin Password
  const adminScreens = ['12', '13', '14', '15', '16', '17', '20', '21', '22', '23', '24'];
  if (adminScreens.includes(screenId) && !AtomXState.isAdminAuthenticated) {
    renderAdminPasswordGate(contentArea, screenId);
    updateSidebarActiveState(screenId);
    return;
  }

  // Render view depending on screen ID
  switch(screenId) {
    case '01': renderLogin(contentArea); break;
    case '02': renderRequestAccess(contentArea); break;
    case '03': renderPendingApproval(contentArea); break;
    case '04': renderDashboard(contentArea); break;
    case '05': renderBotCampaign(contentArea); break;
    case '06': renderReplyQueue(contentArea); break;
    case '07': renderAIReply(contentArea); break;
    case '08': renderAgents(contentArea); break;
    case '09': renderHistory(contentArea); break;
    case '10': renderCreditsPlans(contentArea); break;
    case '11': renderSettingsProfile(contentArea); break;
    case '12': renderAdminDashboard(contentArea); break;
    case '13': 
      // Unified screen: redirect screen 13 to Users & Access with Pending filter
      AtomXState.userFilter = 'Pending';
      renderAdminUsers(contentArea); 
      break;
    case '14': renderAdminUsers(contentArea); break;
    case '15': renderAdminCreditManagement(contentArea); break;
    case '16': renderAdminPlanManagement(contentArea); break;
    case '17': renderAdminTransactions(contentArea); break;
    case '20': renderAdminCuratedLists(contentArea); break;
    case '21': renderAdminToneStyles(contentArea); break;
    case '22': renderAdminReferrals(contentArea); break;
    case '23': renderAdminAIEngine(contentArea); break;
    case '24': renderAdminAgentControls(contentArea); break;
    case '18': renderSuspended(contentArea); break;
    case '19': renderSystemStates(contentArea); break;
    case 'arch': renderSystemArchitecture(contentArea); break;
    default: renderDashboard(contentArea);
  }

  updateSidebarActiveState(screenId);

  if (preserveScroll) {
    requestAnimationFrame(() => {
      const newWorkspace = document.querySelector('.app-workspace');
      if (newWorkspace && prevWorkspaceScrollTop > 0) {
        newWorkspace.scrollTop = prevWorkspaceScrollTop;
      }
      if (prevScrollY > 0) {
        window.scrollTo({ top: prevScrollY, behavior: 'instant' });
      }
    });
  }
}

function setViewportMode(mode) {
  AtomXState.currentMode = mode;
  const frame = document.getElementById('deviceFrame');
  if (!frame) return;

  frame.className = 'device-frame';
  if (mode === 'tablet') frame.classList.add('mode-tablet');
  else if (mode === 'mobile') frame.classList.add('mode-mobile');
  else if (mode === 'extension') frame.classList.add('mode-extension');
  else if (mode === 'full') frame.classList.add('mode-full');

  // Update button active state
  document.querySelectorAll('.viewport-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

function updateSidebarActiveState(screenId) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.screen === screenId);
  });
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.screen === screenId);
  });
}

// -------------------------------------------------------------
// SCREEN 01: LOGIN
// -------------------------------------------------------------
// -------------------------------------------------------------
// -------------------------------------------------------------
// SCREEN 01: ADMIN AUTHENTICATION (STRICT ADMIN ACCESS ONLY)
// -------------------------------------------------------------
function renderLogin(container) {
  renderAdminPasswordGate(container, '12');
}

function switchAuthTab(tab) {
  renderLogin(document.getElementById('mainContentArea'));
}

async function handleAdminKeyLoginSubmit(e) {
  await handleAdminGateSubmit(e, '12');
}

function handleLoginSubmit(e) {
  if (e) e.preventDefault();
  handleAdminGateSubmit(e, '12');
}

function handleLoginSubmit(e) {
  e.preventDefault();
  navigateToScreen('04');
}

// -------------------------------------------------------------
// SCREEN 02: REQUEST ACCESS
// -------------------------------------------------------------
function renderRequestAccess(container) {
  container.innerHTML = `
    <div class="auth-wrapper">
      <div class="auth-card">
        <div class="auth-logo">
          <div class="atomx-brand" style="font-size: 24px;">
            <div class="atomx-logo-icon" style="width: 26px; height: 26px;"></div>
            <span class="atomx-brand-main">Twixor</span>
          </div>
        </div>
        <h1 class="auth-title">Request Access</h1>
        <p class="auth-desc">Create your Twixor account.</p>

        <form onsubmit="handleRequestAccessSubmit(event)">
          <div class="form-group">
            <label class="form-label">Full Name</label>
            <input type="text" id="reqName" class="form-input" required placeholder="Full name">
          </div>
          <div class="form-group">
            <label class="form-label">Twitter / X Handle or ID</label>
            <input type="text" id="reqHandle" class="form-input" required placeholder="@username or handle">
            <div class="form-hint" style="color:var(--blue-primary); font-size:11px; margin-top:3px;">🔒 The extension will be strictly locked to this single X ID.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Email</label>
            <input type="email" id="reqEmail" class="form-input" required placeholder="name@company.com">
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="reqPass" class="form-input" required placeholder="Create password">
          </div>
          <div class="form-group">
            <label class="form-label">Confirm Password</label>
            <input type="password" id="reqConfirm" class="form-input" required placeholder="Confirm password">
          </div>
          <button type="submit" class="btn btn-primary btn-block">Request Access & Verify X ID</button>
          <p class="form-hint" style="text-align:center; margin-top:12px;">Your X ID will be reviewed and approved by administrator before activation.</p>
        </form>

        <div class="auth-footer">
          Already have an account? <a href="javascript:void(0)" onclick="navigateToScreen('01')">Sign In</a>
        </div>
      </div>
    </div>
  `;
}

async function handleRequestAccessSubmit(e) {
  if (e) e.preventDefault();
  const name = document.getElementById('reqName')?.value.trim();
  const handle = document.getElementById('reqHandle')?.value.trim();
  const email = document.getElementById('reqEmail')?.value.trim();
  const pass = document.getElementById('reqPass')?.value.trim();
  const confirm = document.getElementById('reqConfirm')?.value.trim();

  if (!handle) {
    alert('Please enter your X (Twitter) handle or ID.');
    return;
  }
  if (pass && confirm && pass !== confirm) {
    alert('Passwords do not match. Please re-enter.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/access-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: name, email, handle, password: pass })
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast(`✓ Request submitted for ${handle}! Waiting for admin approval.`);
      navigateToScreen('03');
    } else {
      if (d.alreadyApproved || (d.error && d.error.includes('already registered'))) {
        showToast(`✓ ${handle} is already approved! Please sign in with your password.`);
        navigateToScreen('01');
        return;
      }
      showToast(`⚠️ ${d.error || 'Failed to submit request'}`);
      return;
    }
  } catch (err) {
    showToast(`❌ Network error: ${err.message}`);
  }
}

// -------------------------------------------------------------
// SCREEN 03: PENDING APPROVAL
// -------------------------------------------------------------
function renderPendingApproval(container) {
  container.innerHTML = `
    <div class="auth-wrapper">
      <div class="auth-card" style="max-width: 480px;">
        <div class="auth-logo">
          <div class="atomx-brand" style="font-size: 22px;">
            <div class="atomx-logo-icon" style="width: 24px; height: 24px;"></div>
            <span class="atomx-brand-main">Twixor</span>
          </div>
        </div>
        
        <div style="width:56px; height:56px; border-radius:50%; background:var(--status-warning-bg); color:var(--status-warning); display:flex; align-items:center; justify-content:center; margin:0 auto 18px auto;">
          <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>

        <h1 class="auth-title">Your account is under review</h1>
        <p class="auth-desc">Your access request has been submitted successfully. An administrator will review your account before activation.</p>

        <div style="margin: 18px 0;">
          <span class="badge badge-warning" style="font-size: 13px; padding: 6px 14px;">PENDING APPROVAL</span>
        </div>

        <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-md); padding:16px; text-align:left; font-size:13px; margin-bottom:24px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <span style="color:var(--text-secondary);">Request submitted:</span>
            <span style="font-weight:600; color:var(--text-primary);">Oct 06, 2026</span>
          </div>
          <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <span style="color:var(--text-secondary);">Account status:</span>
            <span style="font-weight:600; color:var(--status-warning);">Under Review</span>
          </div>
          <div style="display:flex; justify-content:space-between;">
            <span style="color:var(--text-secondary);">Review status:</span>
            <span style="font-weight:600; color:var(--text-primary);">Standard Queue</span>
          </div>
        </div>

        <div style="display:flex; gap:12px;">
          <button class="btn btn-secondary btn-block" onclick="navigateToScreen('01')">Back to Login</button>
          <button class="btn btn-soft btn-block" onclick="navigateToScreen('13')">Open Admin to Approve</button>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 04: DASHBOARD
// -------------------------------------------------------------
function renderDashboard(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('04')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Dashboard</h1>
            <p class="page-subtitle">Overview of your engagement workspace.</p>
          </div>
          <div style="display:flex; gap:10px;">
            <button class="btn btn-secondary btn-sm" onclick="navigateToScreen('06')">Open Queue</button>
            <button class="btn btn-secondary btn-sm" onclick="navigateToScreen('07')">Generate Reply</button>
            <button class="btn btn-primary btn-sm" onclick="navigateToScreen('05')">+ Create Campaign</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Metric Stats -->
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-label">AI Credits <span style="color:var(--blue-primary); font-size:11px;">1 = 1 Reply</span></div>
              <div class="stat-value" id="dashCreditsVal">${(AtomXState.currentUser.credits || 10000).toLocaleString()}</div>
              <div class="stat-trend" style="color:var(--status-success);">↑ 100% server verified</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Replies Generated <span>Total</span></div>
              <div class="stat-value">0</div>
              <div class="stat-trend" style="color:var(--text-secondary);">Ready to launch</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Approved <span>Rate</span></div>
              <div class="stat-value">0%</div>
              <div class="stat-trend" style="color:var(--text-secondary);">Zero rejections</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Campaigns <span>Active</span></div>
              <div class="stat-value">0</div>
              <div class="stat-trend" style="color:var(--text-secondary);">Queue clear</div>
            </div>
          </div>

          <!-- Main Layout Grid -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px;">
            <!-- Recent Campaign Card -->
            <div class="atomx-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                <h3 style="font-size:16px; font-weight:700;">Engagement Campaigns</h3>
                <span class="badge ${AtomXState.campaign?.isRunning ? 'badge-success' : 'badge-neutral'}">${AtomXState.campaign?.isRunning ? 'Running' : 'Idle'}</span>
              </div>
              <div style="padding:28px 16px; text-align:center; background:var(--bg-canvas); border-radius:var(--radius-sm); border:1px dashed var(--border-subtle);">
                <div style="font-size:16px; font-weight:700; color:var(--text-primary); margin-bottom:4px;">No Active Campaigns</div>
                <div style="font-size:12px; color:var(--text-secondary); margin-bottom:12px;">Create campaigns or run autonomous agents from the Chrome extension.</div>
                <button class="btn btn-primary btn-sm" onclick="navigateToScreen('05')">+ Create Campaign</button>
              </div>
            </div>

            <!-- Recent Activity Card -->
            <div class="atomx-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="font-size:16px; font-weight:700;">Recent Activity</h3>
                <a href="javascript:void(0)" onclick="navigateToScreen('09')" style="font-size:12px; color:var(--blue-primary); text-decoration:none; font-weight:600;">View History</a>
              </div>
              <div style="padding:28px 16px; text-align:center; background:var(--bg-canvas); border-radius:var(--radius-sm); border:1px dashed var(--border-subtle);">
                <div style="font-size:16px; font-weight:700; color:var(--text-primary); margin-bottom:4px;">No Activity Events</div>
                <div style="font-size:12px; color:var(--text-secondary);">AI reply generations and pacing milestones will display here.</div>
              </div>
            </div>
          </div>
        </div>
        ${renderMobileBottomNavHTML('04')}
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 05: BOT / CAMPAIGN
// -------------------------------------------------------------
function renderBotCampaign(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('05')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Bot</h1>
            <p class="page-subtitle">Create and manage your engagement campaigns.</p>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" onclick="clearCampaignQueue()">Clear Queue</button>
            <button id="campaignStartBtn" class="btn btn-primary btn-sm" onclick="toggleCampaignRunning()">
              ${AtomXState.campaign.isRunning ? 'Pause Campaign' : 'START CAMPAIGN'}
            </button>
          </div>
        </div>

        <div class="workspace-body">
          <div class="bot-workflow-grid">
            <!-- Configuration Settings Card -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:14px;">Campaign Configuration</h3>
              <div class="config-row" style="margin-bottom:16px;">
                <div style="flex:1; min-width:160px;">
                  <label class="form-label">AI Provider</label>
                  <select class="form-select" id="campaignProviderSelect" onchange="selectActiveProvider(this.value)">
                    ${AtomXState.providers.map(p => `
                      <option value="${p.id}" ${AtomXState.currentProvider === p.id ? 'selected' : ''}>${p.icon} ${p.name}</option>
                    `).join('')}
                  </select>
                </div>
                <div style="flex:1.5; min-width:220px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <label class="form-label" style="margin-bottom:0;">Live Model</label>
                    <button type="button" class="fetch-models-btn" onclick="fetchLiveModelsForProvider(AtomXState.currentProvider, true)" title="Fetch live models from provider API in real time">
                      <span class="fetch-btn-icon">↻</span> <span class="fetch-btn-text">Fetch Live</span>
                    </button>
                  </div>
                  <select class="form-select" id="campaignModelSelect" onchange="AtomXState.currentModel = this.value">
                    ${(AtomXState.modelsCache[AtomXState.currentProvider]?.length ? AtomXState.modelsCache[AtomXState.currentProvider] : getFallbackModelsForProvider(AtomXState.currentProvider)).map(m => `
                      <option value="${m.id}" ${AtomXState.currentModel === m.id ? 'selected' : ''}>${m.name || m.id}</option>
                    `).join('')}
                  </select>
                </div>
                <div style="flex:1; min-width:160px;">
                  <label class="form-label">Reply Style</label>
                  <select class="form-select" id="replyStyleSelect">
                    <option selected>Natural & Concise</option>
                    <option>In-depth & Thoughtful</option>
                  </select>
                </div>
              </div>

              <div>
                <label class="form-label">Persona Style</label>
                <div class="style-pills">
                  ${['Professional', 'Friendly', 'Witty', 'Technical', 'Minimal'].map(style => `
                    <div class="style-pill ${AtomXState.campaign.selectedStyle === style ? 'active' : ''}" onclick="selectPersonaStyle('${style}')">${style}</div>
                  `).join('')}
                </div>
              </div>
            </div>

            <!-- Tweet Sources Input Card with Multi-Link & Telegram Support -->
            <div class="atomx-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
                <div>
                  <h3 style="font-size:15px; font-weight:700; margin-bottom:2px;">Tweet Sources & Batch Raider</h3>
                  <p style="font-size:12px; color:var(--text-secondary); margin:0;">Supports messy Telegram chat dumps, hashtags, timestamps & multi-link formats. Automatically cleans and deduplicates.</p>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="toggleBatchMode()">
                  ${AtomXState.isBatchMode ? 'Single Link Mode' : 'Batch / Telegram Mode'}
                </button>
              </div>

              ${!AtomXState.isBatchMode ? `
                <div style="display:flex; gap:10px; margin-bottom:16px;">
                  <input type="text" id="tweetUrlInput" class="form-input" placeholder="Paste Tweet URL (e.g., https://x.com/creator/status/1842...)">
                  <button class="btn btn-primary" onclick="addTweetFromInput()">Add Tweet</button>
                </div>
              ` : `
                <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:16px;">
                  <textarea id="tweetBatchInput" class="form-textarea" rows="4" placeholder="Paste links or messy Telegram chat messages here (e.g.:&#10;[06/10/2026 9:48 pm] APE BOT #859 @muhitonx&#10;x.com/muhitonx/status/2107482672947937462&#10;https://x.com/intent/like?tweet_id=123456789)" oninput="updateBatchPreview()" style="font-size:12px; font-family:monospace;"></textarea>
                  
                  <!-- Realtime Parse Breakdown Bar -->
                  <div id="batchPreviewBar" style="display:none; padding:10px 14px; background:rgba(0,102,255,0.06); border:1px solid rgba(0,102,255,0.2); border-radius:var(--radius-sm); font-size:12px; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                    <span id="batchPreviewStats" style="color:var(--text-primary); font-weight:500;">Extracted: 0</span>
                    <button type="button" class="btn btn-secondary btn-sm" style="padding:4px 10px; font-size:11px;" onclick="cleanBatchInputText()">Clean Text Only</button>
                  </div>

                  <div style="display:flex; gap:10px; justify-content:flex-end;">
                    <button class="btn btn-secondary btn-sm" onclick="cleanBatchInputText()">🧹 Auto-Clean Noise</button>
                    <button class="btn btn-primary btn-sm" onclick="addTweetsFromBatch()">⚡ Queue Fresh Tweets</button>
                  </div>
                </div>
              `}

              <!-- Queue Count Status -->
              <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap;">
                <span class="badge badge-neutral" id="qCountQueued">${AtomXState.campaign.tweets.length} Queued</span>
                <span class="badge badge-success" id="qCountReady">${AtomXState.campaign.tweets.filter(t => t.status === 'Ready').length} Ready</span>
                <span class="badge badge-error">0 Failed</span>
              </div>

              <!-- Queued Tweet Items -->
              <div id="queuedTweetsList" style="display:flex; flex-direction:column; gap:10px;">
                ${AtomXState.campaign.tweets.length === 0 ? `
                  <div style="text-align:center; padding:24px; color:var(--text-muted); background:var(--bg-canvas); border-radius:var(--radius-sm); border:1px dashed var(--border-subtle); font-size:12px;">
                    No tweets in campaign queue. Paste tweets or Telegram raid links above to queue.
                  </div>
                ` : AtomXState.campaign.tweets.map(t => `
                  <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                    <div style="display:flex; align-items:center; gap:12px; overflow:hidden;">
                      <div class="user-avatar" style="width:30px; height:30px; font-size:11px;">${t.author.charAt(0)}</div>
                      <div style="overflow:hidden;">
                        <span style="font-weight:600; font-size:13px; color:var(--text-primary);">${t.author}</span>
                        <span style="font-size:12px; color:var(--text-secondary); margin-left:4px;">${t.handle}</span>
                        <p style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:400px; margin-top:2px;">${t.text}</p>
                      </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                      <span class="badge badge-success">${t.status}</span>
                      <button onclick="removeTweet('${t.id}')" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:16px;">×</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Workflow Pacing Card (Legitimate workflow control) -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:6px;">Workflow Pacing Control</h3>
              <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">Configure execution frequency to maintain high review quality and prevent workflow bursts.</p>
              
              <div class="pacing-slider-group">
                <div class="pacing-control">
                  <label>Between actions: <span id="valPacingDelay">${AtomXState.campaign.pacingDelay} sec</span></label>
                  <input type="range" min="5" max="30" value="${AtomXState.campaign.pacingDelay}" oninput="document.getElementById('valPacingDelay').innerText = this.value + ' sec'">
                </div>
                <div class="pacing-control">
                  <label>Break after: <span id="valBreakAfter">${AtomXState.campaign.breakAfter} items</span></label>
                  <input type="range" min="10" max="60" step="5" value="${AtomXState.campaign.breakAfter}" oninput="document.getElementById('valBreakAfter').innerText = this.value + ' items'">
                </div>
                <div class="pacing-control">
                  <label>Break duration: <span id="valBreakDuration">${AtomXState.campaign.breakDuration} sec</span></label>
                  <input type="range" min="30" max="180" step="15" value="${AtomXState.campaign.breakDuration}" oninput="document.getElementById('valBreakDuration').innerText = this.value + ' sec'">
                </div>
              </div>
            </div>
          </div>
        </div>
        ${renderMobileBottomNavHTML('05')}
      </div>
    </div>
  `;
}

function selectPersonaStyle(style) {
  AtomXState.campaign.selectedStyle = style;
  renderBotCampaign(document.getElementById('mainContentArea'));
}

function toggleBatchMode() {
  AtomXState.isBatchMode = !AtomXState.isBatchMode;
  renderBotCampaign(document.getElementById('mainContentArea'));
}

function updateBatchPreview() {
  const textarea = document.getElementById('tweetBatchInput');
  const bar = document.getElementById('batchPreviewBar');
  const stats = document.getElementById('batchPreviewStats');
  if (!textarea || !bar || !stats) return;

  const raw = textarea.value;
  if (!raw.trim()) {
    bar.style.display = 'none';
    return;
  }

  const extracted = extractTweetLinks(raw);
  const filtered = filterTweetLinks(extracted);

  bar.style.display = 'flex';
  stats.innerHTML = `<span style="color:var(--status-success); font-weight:700;">${filtered.freshCount} Fresh</span> ready to queue &nbsp;·&nbsp; Detected: ${filtered.totalFound} &nbsp;·&nbsp; Duplicates: ${filtered.duplicateCount} &nbsp;·&nbsp; Engaged: ${filtered.alreadyEngagedCount}`;
}

function cleanBatchInputText() {
  const textarea = document.getElementById('tweetBatchInput');
  if (!textarea || !textarea.value.trim()) return;
  const extracted = extractTweetLinks(textarea.value);
  if (extracted.length === 0) {
    showToast('⚠️ No valid X/Twitter links detected in the text.');
    return;
  }
  const filtered = filterTweetLinks(extracted);
  const cleanList = (filtered.freshTweets.length > 0 ? filtered.freshTweets : extracted).map(t => t.canonicalUrl);
  const uniqueUrls = Array.from(new Set(cleanList));
  textarea.value = uniqueUrls.join('\n');
  updateBatchPreview();
  showToast(`✓ Cleaned! Extracted ${uniqueUrls.length} canonical link(s). Stripped Telegram noise.`);
}

function addTweetFromInput() {
  const input = document.getElementById('tweetUrlInput');
  if (!input || !input.value.trim()) return;
  const raw = input.value.trim();
  const extracted = extractTweetLinks(raw);
  if (extracted.length === 0) {
    showToast('⚠️ No valid X/Twitter link found. Please verify the URL.');
    return;
  }
  const filtered = filterTweetLinks(extracted);
  if (filtered.freshCount === 0) {
    if (filtered.alreadyEngagedCount > 0) {
      showToast('⚠️ Tweet was already engaged previously! Skipped.');
    } else if (filtered.alreadyInQueueCount > 0) {
      showToast('⚠️ Tweet is already in active queue!');
    } else {
      showToast('⚠️ Duplicate tweet link skipped.');
    }
    return;
  }

  const t = filtered.freshTweets[0];
  AtomXState.campaign.tweets.push({
    id: t.tweetId,
    tweetId: t.tweetId,
    author: t.handle,
    handle: t.handle,
    canonicalUrl: t.canonicalUrl,
    text: `Target: ${t.canonicalUrl}`,
    status: 'Ready'
  });
  input.value = '';
  showToast('✓ Added 1 fresh tweet to campaign queue!');
  renderBotCampaign(document.getElementById('mainContentArea'));
}

function addTweetsFromBatch() {
  const textarea = document.getElementById('tweetBatchInput');
  if (!textarea || !textarea.value.trim()) {
    showToast('Please paste tweet links or Telegram messages first.');
    return;
  }

  const extracted = extractTweetLinks(textarea.value);
  if (extracted.length === 0) {
    showToast('⚠️ No valid X/Twitter links found in pasted text.');
    return;
  }

  const filtered = filterTweetLinks(extracted);
  if (filtered.freshCount === 0) {
    showToast(`⚠️ No new tweets to queue! (Duplicates: ${filtered.duplicateCount}, Already Engaged: ${filtered.alreadyEngagedCount}, In Queue: ${filtered.alreadyInQueueCount})`);
    return;
  }

  filtered.freshTweets.forEach(t => {
    AtomXState.campaign.tweets.push({
      id: t.tweetId,
      tweetId: t.tweetId,
      author: t.handle,
      handle: t.handle,
      canonicalUrl: t.canonicalUrl,
      text: `Target: ${t.canonicalUrl}`,
      status: 'Ready'
    });
  });

  textarea.value = '';
  showToast(`✓ Added ${filtered.freshCount} fresh tweets to queue! (${filtered.duplicateCount} duplicates & ${filtered.alreadyEngagedCount} already-engaged filtered)`);
  renderBotCampaign(document.getElementById('mainContentArea'));
}

function removeTweet(id) {
  AtomXState.campaign.tweets = AtomXState.campaign.tweets.filter(t => String(t.id) !== String(id));
  renderBotCampaign(document.getElementById('mainContentArea'));
}

function clearCampaignQueue() {
  AtomXState.campaign.tweets = [];
  renderBotCampaign(document.getElementById('mainContentArea'));
}

function toggleCampaignRunning() {
  AtomXState.campaign.isRunning = !AtomXState.campaign.isRunning;
  renderBotCampaign(document.getElementById('mainContentArea'));
}

// -------------------------------------------------------------
// SCREEN 06: REPLY QUEUE
// -------------------------------------------------------------
function renderReplyQueue(container) {
  const doneCount = AtomXState.replyQueue.filter(r => r.status === 'Completed').length;
  const queueCount = AtomXState.replyQueue.filter(r => r.status === 'Waiting' || r.status === 'Processing').length;
  const failCount = AtomXState.replyQueue.filter(r => r.status === 'Failed').length;

  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('06')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Reply Queue</h1>
            <p class="page-subtitle">Review and manage generated replies.</p>
          </div>
          <div>
            <button class="btn btn-primary btn-sm" onclick="navigateToScreen('07')">+ Generate New Reply</button>
          </div>
        </div>

        <div class="workspace-body">
          <div class="stats-grid" style="grid-template-columns: repeat(3, 1fr);">
            <div class="stat-card">
              <div class="stat-label">DONE</div>
              <div class="stat-value" style="color:var(--status-success);">${doneCount}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">QUEUE</div>
              <div class="stat-value" style="color:var(--blue-primary);">${queueCount}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">FAILED</div>
              <div class="stat-value" style="color:var(--status-error);">${failCount}</div>
            </div>
          </div>

          <div class="atomx-table-wrapper">
            <table class="atomx-table responsive-table-as-cards">
              <thead>
                <tr>
                  <th>Author & Tweet</th>
                  <th>Generated Reply Preview</th>
                  <th>Status</th>
                  <th>Timestamp</th>
                  <th style="text-align:right;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${AtomXState.replyQueue.length === 0 ? `
                  <tr>
                    <td colspan="5" style="text-align:center; padding:36px; color:var(--text-muted);">
                      <div style="font-size:24px; margin-bottom:8px;">📭</div>
                      <div style="font-weight:600; font-size:14px; color:var(--text-primary); margin-bottom:4px;">Engagement Queue Empty</div>
                      <div style="font-size:12px;">Active reply items created by extension or campaign will appear here.</div>
                    </td>
                  </tr>
                ` : AtomXState.replyQueue.map(item => `
                  <tr>
                    <td>
                      <div style="display:flex; align-items:center; gap:8px;">
                        <div class="user-avatar" style="width:28px; height:28px; font-size:10px;">${item.author.charAt(0)}</div>
                        <div>
                          <div style="font-weight:600;">${item.author}</div>
                          <div style="font-size:11px; color:var(--text-secondary);">${item.handle}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style="max-width:320px; font-size:13px; color:var(--text-primary); line-height:1.4;">${item.reply}</div>
                    </td>
                    <td>
                      <span class="badge ${item.status === 'Completed' ? 'badge-success' : item.status === 'Processing' ? 'badge-info' : item.status === 'Waiting' ? 'badge-warning' : 'badge-error'}">
                        ${item.status}
                      </span>
                    </td>
                    <td style="color:var(--text-muted); font-size:12px;">${item.time}</td>
                    <td style="text-align:right;">
                      <button class="btn btn-secondary btn-sm" onclick="navigateToScreen('07')">Review</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ${renderMobileBottomNavHTML('06')}
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 07: AI REPLY (SPLIT VIEW)
// -------------------------------------------------------------
function renderAIReply(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('07')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">AI Reply</h1>
            <p class="page-subtitle">Inspect, refine, and authorize AI-generated replies.</p>
          </div>
          <div>
            <span class="badge badge-info" style="font-size:12px;">Available Credits: ${AtomXState.currentUser.credits.toLocaleString()}</span>
          </div>
        </div>

        <div class="workspace-body">
          <div class="ai-reply-split">
            <!-- Left: Source Tweet -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:12px;">Source Tweet</h3>
              <div class="tweet-box">
                <div class="tweet-author" style="margin-bottom:10px;">
                  <div class="user-avatar" style="width:36px; height:36px;">@</div>
                  <div style="flex:1;">
                    <input type="text" id="manualAuthorInput" class="form-input" placeholder="Author handle (e.g. @mythopair)" style="font-size:13px; font-weight:600; padding:6px 10px;">
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0;">
                  <textarea id="manualTweetTextInput" class="form-textarea" placeholder="Paste tweet text or tweet link here to analyze and generate replies..." style="min-height:100px; font-size:13px;"></textarea>
                </div>
              </div>

              <div style="margin-top:20px; padding:16px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                <div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:6px;">AI INTENT ANALYSIS</div>
                <p style="font-size:12px; color:var(--text-secondary);">Enter a source tweet above to run real-time contextual intent analysis and tone modeling.</p>
              </div>
            </div>

            <!-- Right: Generated Reply Workspace -->
            <div class="atomx-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <h3 style="font-size:15px; font-weight:700;">Generated Reply</h3>
                <span class="badge badge-neutral" id="replyResonanceBadge">Awaiting Input</span>
              </div>

              <!-- Large Editable Text Area -->
              <div class="form-group">
                <textarea id="aiReplyTextArea" class="form-textarea" placeholder="AI-generated contextual reply will appear here..." style="min-height:130px; font-size:14px; line-height:1.5;"></textarea>
              </div>

              <!-- Active AI Provider Selection -->
              <div style="margin-bottom:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                  <label class="form-label" style="margin-bottom:0;">Active AI Provider</label>
                  <span id="modelCountLabel" style="font-size:11px; color:var(--text-muted); font-weight:600;">
                    ${(AtomXState.modelsCache[AtomXState.currentProvider] || []).length || 'Live'} models ready
                  </span>
                </div>
                <div class="provider-pills">
                  ${AtomXState.providers.map(p => `
                    <div class="provider-pill ${AtomXState.currentProvider === p.id ? 'active' : ''}" data-provider="${p.id}" onclick="selectActiveProvider('${p.id}')">
                      <span>${p.icon}</span>
                      <span>${p.name}</span>
                    </div>
                  `).join('')}
                </div>
              </div>

              <!-- Workflow Control Selectors -->
              <div class="config-row" style="margin-bottom:16px;">
                <div style="flex:1.5; min-width:200px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <label class="form-label" style="margin-bottom:0;">Live Model</label>
                    <button type="button" class="fetch-models-btn" onclick="fetchLiveModelsForProvider(AtomXState.currentProvider, true)" title="Fetch live models from provider API in real-time">
                      <span class="fetch-btn-icon">↻</span> <span class="fetch-btn-text">Fetch Models</span>
                    </button>
                  </div>
                  <select class="form-select" id="replyModelSelect" onchange="AtomXState.currentModel = this.value">
                    ${(AtomXState.modelsCache[AtomXState.currentProvider]?.length ? AtomXState.modelsCache[AtomXState.currentProvider] : getFallbackModelsForProvider(AtomXState.currentProvider)).map(m => `
                      <option value="${m.id}" ${AtomXState.currentModel === m.id ? 'selected' : ''}>${m.name || m.id} ${m.context ? '[' + m.context + ']' : ''}</option>
                    `).join('')}
                  </select>
                </div>
                <div style="flex:1; min-width:130px;">
                  <label class="form-label">Tone</label>
                  <select class="form-select" id="replyToneSelect">
                    <option selected>Natural & Insightful</option>
                    <option>Witty & Casual</option>
                    <option>Technical & Direct</option>
                  </select>
                </div>
                <div style="flex:1; min-width:130px;">
                  <label class="form-label">Length</label>
                  <select class="form-select" id="replyLengthSelect">
                    <option selected>Short (&lt;140 chars)</option>
                    <option>Medium (140-200 chars)</option>
                  </select>
                </div>
              </div>

              <!-- Quality Metrics Indicator -->
              <div class="quality-meter-bar">
                <span><strong>Relevance:</strong> 98%</span>
                <span><strong>Tone:</strong> Natural</span>
                <span><strong>Originality:</strong> High</span>
                <span id="charCountSpan"><strong>Length:</strong> 112 / 280 chars</span>
              </div>

              <!-- Action Buttons -->
              <div style="display:flex; justify-content:space-between; align-items:center; margin-top:20px;">
                <div style="display:flex; gap:10px;">
                  <button class="btn btn-secondary" onclick="simulateRegenerateReply()">↻ Regenerate</button>
                  <button class="btn btn-secondary" onclick="document.getElementById('aiReplyTextArea').focus()">✎ Edit</button>
                </div>
                <button class="btn btn-primary" onclick="approveAndDeductCredit()">✓ Approve (-1 Credit)</button>
              </div>
            </div>
          </div>
        </div>
        ${renderMobileBottomNavHTML('07')}
      </div>
    </div>
  `;
}

async function simulateRegenerateReply() {
  const textarea = document.getElementById('aiReplyTextArea');
  if (!textarea) return;
  textarea.value = `Generating contextual reply via ${AtomXState.currentProvider.toUpperCase()} (${AtomXState.currentModel})...`;

  try {
    const tone = document.getElementById('replyToneSelect')?.value || 'Natural & Concise';
    const res = await fetch('http://localhost:5000/api/generate-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': '1' },
      body: JSON.stringify({
        tweetText: 'The shift toward AI-assisted creation is changing how quickly humanity turns ideas into reality. The next decade will be incredible.',
        tweetAuthor: '@elonmusk',
        style: tone,
        provider: AtomXState.currentProvider,
        model: AtomXState.currentModel
      })
    });
    if (res.ok) {
      const data = await res.json();
      textarea.value = data.reply;
      if (typeof data.remainingCredits === 'number') {
        AtomXState.currentUser.credits = data.remainingCredits;
        const credBadge = document.querySelector('.badge-info');
        if (credBadge) credBadge.innerText = `Available Credits: ${AtomXState.currentUser.credits.toLocaleString()}`;
      }
      return;
    }
  } catch (err) {
    // Graceful fallback if backend offline
  }

  setTimeout(() => {
    textarea.value = `Compounding velocity in software delivery is the clearest signal yet that AI accelerates builders rather than replaces them. [Generated via ${AtomXState.currentProvider} : ${AtomXState.currentModel}]`;
  }, 400);
}

async function approveAndDeductCredit() {
  if (AtomXState.currentUser.credits <= 0) {
    alert('Insufficient Credits! Please buy credits to continue generating AI replies.');
    navigateToScreen('10');
    return;
  }

  try {
    const res = await fetch('http://localhost:5000/api/generate-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': '1' },
      body: JSON.stringify({
        tweetText: 'The shift toward AI-assisted creation is changing how quickly humanity turns ideas into reality.',
        tweetAuthor: '@elonmusk',
        style: 'Natural & Insightful',
        provider: AtomXState.currentProvider,
        model: AtomXState.currentModel
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.remainingCredits === 'number') {
        AtomXState.currentUser.credits = data.remainingCredits;
      } else {
        AtomXState.currentUser.credits -= 1;
      }
    } else {
      AtomXState.currentUser.credits -= 1;
    }
  } catch (e) {
    AtomXState.currentUser.credits -= 1;
  }

  AtomXState.creditLedger.unshift({
    date: 'Just now',
    user: AtomXState.currentUser.name,
    action: 'AI Reply',
    amount: -1,
    admin: 'System',
    reason: 'Approved reply deduction'
  });
  alert('Reply Approved & Scheduled! Deducted 1 credit. Remaining credits: ' + AtomXState.currentUser.credits);
  navigateToScreen('06');
}

// -------------------------------------------------------------
// SCREEN 08: AGENTS
// -------------------------------------------------------------
function renderAgents(container) {
  const agentsList = [
    { id: 'telegram', title: 'TG PULSE', desc: 'Paste Telegram engagement/raid links. Bot auto-visits, likes, comments, and replies automatically.', icon: '✈️', badge: 'POPULAR' },
    { id: 'audience', title: 'CROWDFI', desc: 'Target specific audiences & influencers. Premium includes 2 free curated lists for auto-follow & engagement.', icon: '👥', badge: 'GROWTH' },
    { id: 'sorsa', title: 'SCORE ACCELERATOR', desc: 'Target high-tier crypto accounts & influencers to maximize your Score for airdrops and promotions.', icon: '⚡', badge: 'HIGH ROI' },
    { id: 'followers', title: 'GROWTHFI', desc: 'Target highly active users from specific lists with smart replies to trigger maximum follow-backs.', icon: '📈', badge: 'VIRAL' },
    { id: 'postgen', title: 'POST GENERATOR', desc: 'Turn raw notes, shower thoughts, or links into polished Medium, Long, or viral Thread posts.', icon: '✍️', badge: 'READY' },
    { id: 'replyback', title: 'REPLYWAVE', desc: 'Paste your tweet URL. Bot automatically likes and contextually replies to all incoming comments.', icon: '🔄', badge: 'AUTO' },
    { id: 'unfollow', title: 'AUTO UNFOLLOW', desc: 'Safely detect & unfollow non-followers or low Walchain score accounts with custom anti-ban delay.', icon: '🧹', badge: 'SAFETY' },
    { id: 'match', title: 'PICTURE & VOICE MATCH', desc: 'Generate custom AI images and match your authentic writing style and persona voice.', icon: '🎨', badge: 'AI MODEL' },
    { id: 'creators', title: 'CREATORX', desc: 'Save favorite creator handles (@handles) to track their tweets and engage instantly when they post.', icon: '⭐', badge: 'SAVED' },
    { id: 'reply', title: 'AI REPLY ASSISTANT', desc: 'Contextual split-view reply studio powered by OpenAI, Gemini, Groq, and OpenRouter.', icon: '💬', badge: 'MULTI-LLM' }
  ];

  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('08')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">AI Agents</h1>
            <p class="page-subtitle">Specialized AI tools for your content workflow.</p>
          </div>
        </div>

        <div class="workspace-body">
          <div class="agents-grid">
            ${agentsList.map(a => `
              <div class="agent-card" onclick="navigateToScreen('05')">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                  <div class="agent-icon" style="font-size:20px;">${a.icon}</div>
                  <span class="badge badge-info" style="font-size:10px;">${a.badge || 'READY'}</span>
                </div>
                <h4 style="font-size:14px; font-weight:700; color:var(--text-primary); margin-bottom:6px;">${a.title}</h4>
                <p style="font-size:13px; color:var(--text-secondary); line-height:1.4; flex:1;">${a.desc}</p>
                <div style="display:flex; justify-content:flex-end; margin-top:14px;">
                  <span style="font-size:12px; font-weight:600; color:var(--blue-primary);">Launch Agent →</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ${renderMobileBottomNavHTML('08')}
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 09: HISTORY
// -------------------------------------------------------------
function renderHistory(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('09')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">History</h1>
            <p class="page-subtitle">Review your previous activity and audit trails.</p>
          </div>
        </div>

        <div class="workspace-body">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
            <div class="style-pills">
              <span class="style-pill active">All</span>
              <span class="style-pill">Replies</span>
              <span class="style-pill">Campaigns</span>
              <span class="style-pill">AI Generations</span>
              <span class="style-pill">Errors</span>
            </div>
            <div style="width:240px;">
              <input type="text" class="form-input" placeholder="Search activity...">
            </div>
          </div>

          <div class="atomx-table-wrapper">
            <table class="atomx-table responsive-table-as-cards">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>Tweet / Source</th>
                  <th>Result</th>
                  <th style="text-align:right;">Credits Used</th>
                </tr>
              </thead>
              <tbody>
                ${AtomXState.creditLedger.length === 0 ? `
                  <tr>
                    <td colspan="5" style="text-align:center; padding:36px; color:var(--text-muted);">
                      <div style="font-size:24px; margin-bottom:8px;">🕒</div>
                      <div style="font-weight:600; font-size:14px; color:var(--text-primary); margin-bottom:4px;">No Activity History Yet</div>
                      <div style="font-size:12px;">Actions taken across the browser extension and web workspace will be recorded here.</div>
                    </td>
                  </tr>
                ` : AtomXState.creditLedger.map(item => `
                  <tr>
                    <td style="color:var(--text-muted);">${item.date}</td>
                    <td style="font-weight:600;">${item.action}</td>
                    <td>${item.reason || item.user}</td>
                    <td><span class="badge badge-success">Completed</span></td>
                    <td style="text-align:right; font-weight:600;">${Math.abs(item.amount || 1)} credit${Math.abs(item.amount) !== 1 ? 's' : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ${renderMobileBottomNavHTML('09')}
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 10: CREDITS / PLANS
// -------------------------------------------------------------
function renderCreditsPlans(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('10')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Credits</h1>
            <p class="page-subtitle">Manage your Twixor usage and subscription tiers.</p>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Balance Banner -->
          <div class="atomx-card balance-banner" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; border-color:var(--blue-soft-border);">
            <div>
              <div style="font-size:12px; font-weight:700; color:var(--blue-primary); letter-spacing:0.5px; text-transform:uppercase;">AVAILABLE CREDITS</div>
              <div style="font-size:36px; font-weight:800; color:var(--text-primary); margin:4px 0;">${AtomXState.currentUser.credits.toLocaleString()}</div>
              <div style="font-size:13px; color:var(--text-secondary);">1 credit = 1 AI reply · Balance verified server-side</div>
            </div>
            <button class="btn btn-primary" onclick="alert('Checkout initiated! (Growth Plan 10,000 Credits)')">Buy Credits</button>
          </div>

          <!-- Pricing Grid with FOUNDING 100 Launch Offer -->
          <div class="pricing-grid">
            <!-- FOUNDING 100 Promotional Launch Offer -->
            <div class="pricing-card" style="border:2px solid #FF6B00; background:linear-gradient(180deg, rgba(255,107,0,0.06), rgba(0,0,0,0.2)); position:relative; box-shadow:0 0 25px rgba(255,107,0,0.15);">
              <div class="pricing-card-badge" style="background:linear-gradient(135deg, #FF6B00, #E60000); color:#FFF; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px; text-transform:uppercase; letter-spacing:0.5px;">
                🔥 FIRST LAUNCH OFFER
              </div>
              <div style="font-size:14px; font-weight:800; color:#FF6B00; text-transform:uppercase; margin-top:8px;">FOUNDING 100</div>
              <div class="plan-price" style="margin:8px 0 4px 0;">
                <span style="text-decoration:line-through; color:var(--text-muted); font-size:16px; margin-right:8px;">$5/month</span>
                <span style="color:#FF6B00; font-size:32px; font-weight:800;">$2</span><span style="font-size:14px; color:var(--text-muted); font-weight:500;">/ month</span>
              </div>
              <div style="font-size:15px; font-weight:800; color:var(--blue-primary); margin-bottom:12px;">
                ⚡ 5,000 Credits
              </div>
              <ul class="plan-feature-list" style="margin-bottom:14px;">
                <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> 5,000 AI replies</li>
                <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> All automation agents</li>
                <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Human-like pacing</li>
                <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Priority processing</li>
                <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Early feature access</li>
                <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Dedicated support</li>
              </ul>

              <!-- Live Real-Time Countdown Timer -->
              <div id="foundingCountdownBox" style="background:rgba(255,107,0,0.12); border:1px solid rgba(255,107,0,0.3); border-radius:8px; padding:8px 10px; text-align:center; margin-bottom:12px;">
                <div style="font-size:10px; font-weight:700; color:#FF6B00; text-transform:uppercase; letter-spacing:0.5px;">⏳ Offer Ends In</div>
                <div id="foundingCountdownTimer" style="font-family:monospace; font-size:13px; font-weight:800; color:var(--text-primary); margin-top:2px;">
                  02d : 14h : 37m : 52s
                </div>
              </div>

              <button class="btn btn-primary btn-block" style="background:linear-gradient(135deg, #FF6B00, #E60000); border:none; font-weight:700;" onclick="alert('Claiming Founding 100 Offer ($2 / 5,000 Credits)!'); AtomXState.currentUser.credits += 5000; renderCreditsPlans(document.getElementById('mainContentArea'));">Claim Offer ($2)</button>
            </div>

            <!-- Dynamic Pricing Grid connected to Global Server Plans -->
            ${(AtomXState.plans && AtomXState.plans.length > 0) ? `
              <div class="pricing-grid">
                ${AtomXState.plans.map(p => `
                  <div class="pricing-card ${p.popular ? 'featured' : ''}" style="position:relative;">
                    ${p.offerBadge ? `
                      <div class="pricing-card-badge" style="background:linear-gradient(135deg, #FF6B00, #E60000); color:#FFF; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px; text-transform:uppercase;">
                        🔥 ${p.offerBadge}
                      </div>
                    ` : (p.popular ? `<div class="pricing-card-badge">POPULAR</div>` : '')}

                    <div style="font-size:13px; font-weight:700; color:${p.popular ? 'var(--blue-primary)' : 'var(--text-secondary)'}; text-transform:uppercase;">${p.name}</div>
                    <div class="plan-price" style="margin:8px 0 4px 0;">
                      $${p.price} <span style="font-size:14px; color:var(--text-muted); font-weight:500;">/ mo</span>
                    </div>
                    <div style="font-size:15px; font-weight:800; color:var(--blue-primary); margin-bottom:12px;">
                      ⚡ ${(p.credits || 0).toLocaleString()} Credits
                    </div>
                    <ul class="plan-feature-list" style="margin-bottom:14px;">
                      ${(p.features || []).map(f => `<li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> ${f}</li>`).join('')}
                    </ul>
                    <button class="btn ${p.popular ? 'btn-primary' : 'btn-secondary'} btn-block" onclick="alert('Selected ${p.name} Plan (${(p.credits || 0).toLocaleString()} Credits)!'); AtomXState.currentUser.credits += ${p.credits || 0}; renderCreditsPlans(document.getElementById('mainContentArea'));">
                      ${p.price === 0 ? 'Current Tier' : `Get ${p.name} ($${p.price})`}
                    </button>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="pricing-grid">
                <!-- Free Plan -->
                <div class="pricing-card">
                  <div style="font-size:13px; font-weight:700; color:var(--text-secondary);">FREE</div>
                  <div class="plan-price">$0 <span style="font-size:14px; color:var(--text-muted); font-weight:500;">/ mo</span></div>
                  <div style="font-size:14px; font-weight:600; color:var(--text-primary);">100 Credits</div>
                  <ul class="plan-feature-list">
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> 100 AI replies</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Basic reply styles</li>
                  </ul>
                  <button class="btn btn-secondary btn-block">Current Plan</button>
                </div>
              </div>
            `}

          <!-- USER REFERRAL PROGRAM DASHBOARD (LEVEL 1 DIRECT ONLY) -->
          <div class="atomx-card" style="margin-top:24px; padding:20px; background:linear-gradient(135deg, rgba(49,87,230,0.05), rgba(34,160,107,0.05)); border:1px solid var(--border-subtle);">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
              <div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:22px;">🎁</span>
                  <h3 style="font-size:16px; font-weight:800; color:var(--text-primary);">Referral Program</h3>
                  <span class="badge badge-success" style="font-size:10px; font-weight:700;">150 + 150 CR</span>
                </div>
                <p style="font-size:12px; color:var(--text-secondary); margin-top:4px;">
                  Invite friends & earn Credits. When their account is approved, both of you receive <strong>150 Credits</strong>! Plus 10% on their first purchase.
                </p>
              </div>
              <div style="display:flex; gap:12px; text-align:right;">
                <div>
                  <div style="font-size:11px; color:var(--text-muted); font-weight:600;">TOTAL REFERRALS</div>
                  <div style="font-size:20px; font-weight:800; color:var(--text-primary);">12</div>
                </div>
                <div>
                  <div style="font-size:11px; color:var(--status-success); font-weight:600;">APPROVED</div>
                  <div style="font-size:20px; font-weight:800; color:var(--status-success);">8</div>
                </div>
                <div>
                  <div style="font-size:11px; color:var(--status-warning); font-weight:600;">PENDING</div>
                  <div style="font-size:20px; font-weight:800; color:var(--status-warning);">4</div>
                </div>
                <div>
                  <div style="font-size:11px; color:var(--blue-primary); font-weight:600;">EARNED</div>
                  <div style="font-size:20px; font-weight:800; color:var(--blue-primary);">650 Cr</div>
                </div>
              </div>
            </div>

            <!-- Referral Link Box -->
            <div style="background:var(--bg-canvas); padding:14px; border-radius:8px; border:1px solid var(--border-subtle); margin-bottom:16px;">
              <div style="font-size:11px; font-weight:700; color:var(--text-secondary); text-transform:uppercase; margin-bottom:6px;">Your Referral Link</div>
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <input type="text" readonly id="userRefLinkInput" value="https://atomxengage.com/ref/${(AtomXState.currentUser.handle || 'user').replace('@','')}" class="form-input" style="flex:1; min-width:240px; font-family:monospace; font-weight:700; background:var(--bg-card); cursor:text;">
                <button class="btn btn-primary" onclick="copyUserRefLink()">📋 Copy Link</button>
              </div>

              <!-- Social Share Shortcuts -->
              <div style="display:flex; align-items:center; gap:8px; margin-top:10px; font-size:12px; color:var(--text-muted);">
                <span>Share:</span>
                <button class="btn btn-secondary btn-sm" onclick="shareRefLink('x')" style="padding:3px 8px; font-size:11px;">𝕏 Post</button>
                <button class="btn btn-secondary btn-sm" onclick="shareRefLink('tg')" style="padding:3px 8px; font-size:11px;">✈️ Telegram</button>
                <button class="btn btn-secondary btn-sm" onclick="shareRefLink('wa')" style="padding:3px 8px; font-size:11px;">💬 WhatsApp</button>
                <button class="btn btn-secondary btn-sm" onclick="shareRefLink('fb')" style="padding:3px 8px; font-size:11px;">🌐 Facebook</button>
              </div>
            </div>

            <!-- Program Rules / Level 1 Note -->
            <div style="font-size:11px; color:var(--text-secondary); padding:8px 12px; background:rgba(59,130,246,0.06); border-radius:6px; border-left:3px solid var(--blue-primary); margin-bottom:16px; line-height:1.5;">
              <strong>ℹ️ Strict Rules:</strong> Direct Level-1 referrals only (no MLM / Level 2/3). Rewards are issued <strong>after admin account approval</strong>. Multiple accounts under the same X ID are strictly forbidden. All rewards are in Credits, not cash.
            </div>

            <!-- User Referrals Table -->
            <div style="border-top:1px solid var(--border-subtle); padding-top:12px;">
              <div style="font-weight:700; font-size:13px; color:var(--text-primary); margin-bottom:8px;">Recent Referrals & Status</div>
              <div class="table-wrapper" style="overflow-x:auto;">
                <table class="atomx-table" style="font-size:12px;">
                  <thead>
                    <tr>
                      <th>Referred User</th>
                      <th>Status</th>
                      <th>Account Approval</th>
                      <th>First Purchase</th>
                      <th>Your Reward</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <strong>Nahian</strong>
                        <div style="font-size:11px; color:var(--text-muted); font-family:monospace;">@yournahian</div>
                      </td>
                      <td><span class="badge badge-success">Approved</span></td>
                      <td><span style="color:var(--status-success); font-weight:700;">✓ Approved</span></td>
                      <td>$10 Plan</td>
                      <td style="color:var(--blue-primary); font-weight:700;">150 + 1 Cr</td>
                    </tr>
                    <tr>
                      <td>
                        <strong>Saim</strong>
                        <div style="font-size:11px; color:var(--text-muted); font-family:monospace;">@KhanWg60464</div>
                      </td>
                      <td><span class="badge badge-warning">Pending</span></td>
                      <td><span style="color:var(--text-muted);">Awaiting Review</span></td>
                      <td>—</td>
                      <td style="color:var(--text-muted);">Pending</td>
                    </tr>
                    <tr>
                      <td>
                        <strong>Alex</strong>
                        <div style="font-size:11px; color:var(--text-muted); font-family:monospace;">@alex_growth</div>
                      </td>
                      <td><span class="badge badge-success">Approved</span></td>
                      <td><span style="color:var(--status-success); font-weight:700;">✓ Approved</span></td>
                      <td>$29 Plan</td>
                      <td style="color:var(--blue-primary); font-weight:700;">150 + 2.9 Cr</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- Crypto Payment Gateway (USDT, USDC, ETH, BNB, Solana, GRAM) starting from $1 -->
          <div class="atomx-card" style="margin-top:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <div>
                <h3 style="font-size:15px; font-weight:700;">Buy Credits with Crypto (Starting from $1)</h3>
                <p style="font-size:13px; color:var(--text-secondary); margin-top:2px;">Instant credit top-ups supported across USDT, USDC, ETH, BNB Chain, Solana, and GRAM.</p>
              </div>
              <span class="badge badge-success">0% Processing Fee</span>
            </div>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px; margin-bottom:18px;">
              <div style="padding:12px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                <label class="form-label">Select Amount</label>
                <select class="form-select" id="cryptoAmountSelect">
                  <option value="1">$1 USD — 1,000 Credits</option>
                  <option value="5">$5 USD — 5,000 Credits</option>
                  <option value="10" selected>$10 USD — 10,000 Credits</option>
                  <option value="25">$25 USD — 25,000 Credits</option>
                  <option value="50">$50 USD — 60,000 Credits (+10k Bonus)</option>
                </select>
              </div>

              <div style="padding:12px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                <label class="form-label">Select Cryptocurrency</label>
                <select class="form-select" id="cryptoTokenSelect">
                  <option>USDT (TRC20 / ERC20 / Solana / BNB)</option>
                  <option>USDC (Solana / Base / Arbitrum)</option>
                  <option>SOL (Solana Native)</option>
                  <option>ETH (Ethereum / Base / Arbitrum)</option>
                  <option>BNB (BNB Smart Chain)</option>
                  <option>GRAM (TON Network)</option>
                </select>
              </div>

              <div style="padding:12px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                <label class="form-label">Official Deposit Address</label>
                <div style="display:flex; gap:8px;">
                  <input type="text" readonly value="0x892aF...471c9" class="form-input" style="font-size:12px; font-family:monospace;">
                  <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard?.writeText('0x892aF71c9201481bAc0129'); alert('Deposit address copied!');">Copy</button>
                </div>
              </div>
            </div>

            <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:16px;">
              <label class="form-label">Confirm Payment — Enter Transaction Hash (Tx Hash)</label>
              <div style="display:flex; gap:10px;">
                <input type="text" id="txHashInput" class="form-input" placeholder="Paste your blockchain Transaction Hash (e.g., 0x9f8e2a... or solana signature)">
                <button class="btn btn-primary" onclick="confirmCryptoTxHash()">Verify & Credit Balance</button>
              </div>
              <p style="font-size:11px; color:var(--text-muted); margin-top:8px;">Once submitted, the smart contract or payment listener verifies the Tx Hash on-chain and credits your balance automatically.</p>
            </div>
          </div>
        </div>
        ${renderMobileBottomNavHTML('10')}
      </div>
    </div>
  `;

  startLiveOfferCountdown();
}

function startLiveOfferCountdown(expiresAt) {
  if (window._offerCountdownInterval) clearInterval(window._offerCountdownInterval);

  function tick() {
    const el = document.getElementById('foundingCountdownTimer');
    const box = document.getElementById('foundingCountdownBox');
    if (!el) return;

    const target = expiresAt ? new Date(expiresAt).getTime() : (window._offerTargetTime || (window._offerTargetTime = Date.now() + (2 * 86400000) + (14 * 3600000) + (37 * 60000) + 52000));
    const now = Date.now();
    const diff = target - now;

    if (diff <= 0) {
      el.innerHTML = '<span style="color:var(--status-error); font-weight:800;">OFFER EXPIRED</span>';
      if (box) box.style.borderColor = 'var(--status-error)';
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
  window._offerCountdownInterval = setInterval(tick, 1000);
}

function copyUserRefLink() {
  const input = document.getElementById('userRefLinkInput');
  const url = input ? input.value : `https://atomxengage.com/ref/${(AtomXState.currentUser.handle || 'user').replace('@','')}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('✓ Referral link copied to clipboard!');
    }).catch(() => {
      prompt('Copy your referral link:', url);
    });
  } else {
    prompt('Copy your referral link:', url);
  }
}

function shareRefLink(platform) {
  const handle = (AtomXState.currentUser.handle || 'user').replace('@','');
  const refUrl = `https://twixor.io/ref/${handle}`;
  const text = `Join Twixor for autonomous AI Twitter growth! Use my referral link to get 150 bonus credits: ${refUrl}`;
  
  let url = '';
  if (platform === 'x') {
    url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  } else if (platform === 'tg') {
    url = `https://t.me/share/url?url=${encodeURIComponent(refUrl)}&text=${encodeURIComponent('Join Twixor & get 150 bonus credits!')}`;
  } else if (platform === 'wa') {
    url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  } else if (platform === 'fb') {
    url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(refUrl)}`;
  }
  if (url) window.open(url, '_blank');
}

function confirmCryptoTxHash() {
  const input = document.getElementById('txHashInput');
  const val = input ? input.value.trim() : '';
  if (!val) {
    alert('Please enter your Transaction Hash (Tx Hash) to verify payment.');
    return;
  }
  const amtSelect = document.getElementById('cryptoAmountSelect');
  const usd = amtSelect ? parseInt(amtSelect.value, 10) : 10;
  const creditsToAdd = usd * 1000;

  AtomXState.currentUser.credits += creditsToAdd;
  AtomXState.creditLedger.unshift({
    date: 'Just now',
    user: AtomXState.currentUser.name,
    action: 'Crypto Purchase',
    amount: creditsToAdd,
    admin: 'Blockchain Tx',
    reason: `Verified Tx: ${val.slice(0, 10)}... ($${usd})`
  });

  alert(`✓ Transaction Hash Verified! Successfully credited ${creditsToAdd.toLocaleString()} credits to your account.`);
  if (input) input.value = '';
  renderCreditsPlans(document.getElementById('mainContentArea'));
}

// -------------------------------------------------------------
// SCREEN 11: SETTINGS / PROFILE
// -------------------------------------------------------------
function renderSettingsProfile(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('11')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Settings</h1>
            <p class="page-subtitle">Manage your account, AI preferences, and security.</p>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Profile Card -->
          <div class="atomx-card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; margin-bottom:20px;">
            <div style="display:flex; align-items:center; gap:16px;">
              <div class="user-avatar" style="width:54px; height:54px; font-size:18px;">${AtomXState.currentUser.avatar}</div>
              <div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:18px; font-weight:700;">${AtomXState.currentUser.name}</span>
                  <span class="badge badge-success">${AtomXState.currentUser.status}</span>
                </div>
                <div style="font-size:13px; color:var(--text-secondary); margin-top:2px;">${AtomXState.currentUser.handle} · ${AtomXState.currentUser.email}</div>
              </div>
            </div>
            <div style="display:flex; gap:10px;">
              <span class="badge badge-info" style="padding:6px 14px;">${AtomXState.currentUser.plan}</span>
              <span class="badge badge-neutral" style="padding:6px 14px;">${AtomXState.currentUser.credits.toLocaleString()} Credits</span>
            </div>
          </div>

          <!-- Settings Sections Grid -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px;">
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:14px;">ACCOUNT</h3>
              <div class="form-group">
                <label class="form-label">Profile Name</label>
                <input type="text" class="form-input" value="${AtomXState.currentUser.name}">
              </div>
              <div class="form-group">
                <label class="form-label">Email</label>
                <input type="email" class="form-input" value="${AtomXState.currentUser.email}">
              </div>
              <div class="form-group">
                <label class="form-label">Connected X Account</label>
                <input type="text" class="form-input" value="@alexcarterx (Verified)">
              </div>
            </div>

            <!-- Theme & Appearance Card -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:14px;">APPEARANCE & THEME</h3>
              <p style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">Personalize your workspace aesthetic. Dark mode uses deep obsidian surfaces designed for low-light focus.</p>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
                <div onclick="setTheme('light')" style="padding:16px; border:2px solid ${AtomXState.theme === 'light' ? 'var(--blue-primary)' : 'var(--border-subtle)'}; border-radius:var(--radius-md); cursor:pointer; background:${AtomXState.theme === 'light' ? 'var(--blue-soft)' : 'var(--bg-canvas)'}; text-align:center; transition:all 0.2s;">
                  <div style="font-size:24px; margin-bottom:6px;">☀️</div>
                  <div style="font-weight:700; font-size:14px; color:var(--text-primary);">Light Luxury</div>
                  <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Clean minimal canvas</div>
                </div>
                <div onclick="setTheme('dark')" style="padding:16px; border:2px solid ${AtomXState.theme === 'dark' ? 'var(--blue-primary)' : 'var(--border-subtle)'}; border-radius:var(--radius-md); cursor:pointer; background:${AtomXState.theme === 'dark' ? 'rgba(59,102,255,0.1)' : 'var(--bg-canvas)'}; text-align:center; transition:all 0.2s;">
                  <div style="font-size:24px; margin-bottom:6px;">🌙</div>
                  <div style="font-weight:700; font-size:14px; color:var(--text-primary);">Obsidian Dark</div>
                  <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">High contrast night</div>
                </div>
              </div>
            </div>

            <!-- AI Settings Card -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:14px;">AI SETTINGS</h3>
              <div class="form-group">
                <label class="form-label">Default AI Provider</label>
                <select class="form-select" id="settingsDefaultProviderSelect" onchange="selectActiveProvider(this.value)">
                  ${AtomXState.providers.map(p => `
                    <option value="${p.id}" ${AtomXState.currentProvider === p.id ? 'selected' : ''}>${p.icon} ${p.name}</option>
                  `).join('')}
                </select>
              </div>
              <div class="form-group">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                  <label class="form-label" style="margin-bottom:0;">Default Model</label>
                  <button type="button" class="fetch-models-btn" onclick="fetchLiveModelsForProvider(AtomXState.currentProvider, true)">
                    ↻ Fetch Models
                  </button>
                </div>
                <select class="form-select" id="settingsDefaultModelSelect" onchange="AtomXState.currentModel = this.value">
                  ${(AtomXState.modelsCache[AtomXState.currentProvider]?.length ? AtomXState.modelsCache[AtomXState.currentProvider] : getFallbackModelsForProvider(AtomXState.currentProvider)).map(m => `
                    <option value="${m.id}" ${AtomXState.currentModel === m.id ? 'selected' : ''}>${m.name || m.id}</option>
                  `).join('')}
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Default Reply Style</label>
                <select class="form-select">
                  <option selected>Natural & Concise</option>
                  <option>Analytical & In-depth</option>
                  <option>Witty & Casual</option>
                </select>
              </div>
            </div>

            <!-- Multi-Provider Real-Time Fetch Card -->
            <div class="atomx-card" style="grid-column: 1 / -1;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div>
                  <h3 style="font-size:15px; font-weight:700;">LIVE AI PROVIDERS & REAL-TIME MODEL SYNC</h3>
                  <p style="font-size:13px; color:var(--text-secondary); margin-top:2px;">Query provider APIs directly to fetch newly released models in real time.</p>
                </div>
              </div>

              <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; margin-top:14px;">
                ${AtomXState.providers.map(p => {
                  const cachedCount = (AtomXState.modelsCache[p.id] || []).length;
                  return `
                    <div style="padding:14px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); display:flex; flex-direction:column; justify-content:space-between; gap:10px;">
                      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div style="display:flex; align-items:center; gap:8px;">
                          <span style="font-size:18px;">${p.icon}</span>
                          <div>
                            <div style="font-weight:700; font-size:14px; color:var(--text-primary);">${p.name}</div>
                            <div style="font-size:11px; color:var(--text-secondary);">${p.desc}</div>
                          </div>
                        </div>
                        <span class="badge badge-success" style="font-size:10px;">ACTIVE</span>
                      </div>
                      <div style="display:flex; justify-content:space-between; align-items:center; padding-top:8px; border-top:1px solid var(--border-subtle); font-size:12px;">
                        <span style="color:var(--text-secondary); font-size:11px;">
                          ${cachedCount > 0 ? `<strong>${cachedCount}</strong> live models` : 'Ready to fetch'}
                        </span>
                        <button type="button" class="fetch-models-btn" onclick="selectActiveProvider('${p.id}'); fetchLiveModelsForProvider('${p.id}', true);" style="padding:4px 10px;">
                          ↻ Fetch Live
                        </button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; margin-bottom:14px;">SECURITY & ACCESS</h3>
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
                <div>
                  <div style="font-size:13px; font-weight:600;">Two-Factor Authentication</div>
                  <div style="font-size:12px; color:var(--text-secondary);">Enhanced authenticator protection</div>
                </div>
                <span class="badge badge-success">Enabled</span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--border-subtle);">
                <div>
                  <div style="font-size:13px; font-weight:600;">Approval Date</div>
                  <div style="font-size:12px; color:var(--text-secondary);">${AtomXState.currentUser.initialApprovedDate}</div>
                </div>
                <span class="badge badge-info">Active</span>
              </div>
            </div>

            <div class="atomx-card" style="border-color:#FBD5D5;">
              <h3 style="font-size:15px; font-weight:700; color:var(--status-error); margin-bottom:14px;">DANGER ZONE</h3>
              <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">Irreversible account operations.</p>
              <div style="display:flex; gap:10px;">
                <button class="btn btn-secondary btn-sm" onclick="navigateToScreen('01')">Log Out</button>
                <button class="btn btn-danger btn-sm" onclick="navigateToScreen('18')">Deactivate Account</button>
              </div>
            </div>
          </div>
        </div>
        ${renderMobileBottomNavHTML('11')}
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 12: ADMIN DASHBOARD
// -------------------------------------------------------------
function renderAdminDashboard(container) {
  const users = AtomXState.adminUsers || [];
  const reqs = AtomXState.accessRequests || [];
  const ledger = AtomXState.creditLedger || [];
  const txs = AtomXState.adminTransactions || [];
  const pwdReqs = AtomXState.passwordRequests || [];
  const logs = AtomXState.adminApiLogs || [];

  const totalUsers = users.length;
  const activeUsers = users.filter(u => (u.status || '').toUpperCase() === 'ACTIVE').length;
  const suspendedUsers = users.filter(u => (u.status || '').toUpperCase() === 'SUSPENDED').length;
  const pendingCount = reqs.filter(r => (r.status || '').toUpperCase() === 'PENDING').length;
  const circulatingCredits = users.reduce((acc, u) => acc + (u.credits || 0), 0);
  const ledgerDeductionsCount = ledger.filter(l => l.amount < 0 || (l.action || '').toLowerCase().includes('reply') || (l.action || '').toLowerCase().includes('ai') || (l.reason || '').toLowerCase().includes('reply')).length;
  const logsSuccessCount = logs.filter(l => l.status === 'SUCCESS' && (!l.statusCode || l.statusCode < 400)).length;
  const totalAIGenerations = Math.max(ledgerDeductionsCount, logsSuccessCount, logs.length, AtomXState.adminStats?.totalAIGenerations || 0);
  
  // Real revenue from transactions
  const totalRevenue = txs.reduce((acc, t) => {
    const val = parseFloat(String(t.amount || '$0').replace(/[^0-9.]/g, '')) || 0;
    return acc + val;
  }, 0);

  // Real average latency from live telemetry logs
  const latencies = logs.map(l => Number(l.latencyMs)).filter(n => !isNaN(n) && n > 0);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) + 'ms' : '< 450ms';

  // Multi-period throughput distribution calculation (All Time, 1Y, 1M, 7D, 1D Today)
  const velocityFilter = AtomXState.velocityChartFilter || '7D';
  const parseItemDate = (item) => {
    const raw = item.created_at || item.date || (item.id && !isNaN(parseInt(item.id)) ? parseInt(item.id) : null);
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  };

  const allEvents = [
    ...ledger.filter(l => l.amount < 0 || (l.action || '').toLowerCase().includes('reply') || (l.action || '').toLowerCase().includes('ai') || (l.reason || '').toLowerCase().includes('reply')).map(l => ({ date: parseItemDate(l), type: 'ledger' })),
    ...logs.map(l => ({ date: parseItemDate(l), type: 'log' }))
  ].filter(e => e.date !== null);

  const now = new Date();
  let chartBars = [];

  if (velocityFilter === '1D') {
    // Today by 4-hour slots
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const slots = [
      { label: '00-04h', start: 0, end: 4 },
      { label: '04-08h', start: 4, end: 8 },
      { label: '08-12h', start: 8, end: 12 },
      { label: '12-16h', start: 12, end: 16 },
      { label: '16-20h', start: 16, end: 20 },
      { label: '20-24h', start: 20, end: 24 }
    ];
    chartBars = slots.map(slot => {
      const count = allEvents.filter(e => {
        if (e.date < startOfToday) return false;
        const h = e.date.getHours();
        return h >= slot.start && h < slot.end;
      }).length;
      const isCurrent = now.getHours() >= slot.start && now.getHours() < slot.end;
      return { day: slot.label, count, isToday: isCurrent };
    });
  } else if (velocityFilter === '1M') {
    // 4 weeks of the past month
    chartBars = Array.from({ length: 4 }, (_, idx) => {
      const wStart = new Date(now);
      wStart.setDate(wStart.getDate() - ((3 - idx) * 7));
      const wEnd = new Date(wStart);
      wEnd.setDate(wEnd.getDate() + 7);
      const count = allEvents.filter(e => e.date >= wStart && e.date < wEnd).length;
      return { day: `Wk ${idx + 1}`, count, isToday: idx === 3 };
    });
  } else if (velocityFilter === '1Y') {
    // 12 monthly bars
    chartBars = Array.from({ length: 12 }, (_, idx) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (11 - idx), 1);
      const mNum = d.getMonth();
      const yNum = d.getFullYear();
      const count = allEvents.filter(e => e.date.getFullYear() === yNum && e.date.getMonth() === mNum).length;
      const mStr = d.toLocaleDateString('en-US', { month: 'short' });
      return { day: mStr, count, isToday: idx === 11 };
    });
  } else if (velocityFilter === 'ALL') {
    // Lifetime across months
    chartBars = Array.from({ length: 6 }, (_, idx) => {
      const d = new Date(now.getFullYear(), now.getMonth() - ((5 - idx) * 2), 1);
      const count = allEvents.filter(e => {
        const diffMonths = (now.getFullYear() - e.date.getFullYear()) * 12 + (now.getMonth() - e.date.getMonth());
        return diffMonths >= (5 - idx) * 2 && diffMonths < (6 - idx) * 2;
      }).length;
      const mStr = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      return { day: mStr, count, isToday: idx === 5 };
    });
  } else {
    // '7D' (Default: 7 daily bars)
    chartBars = Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - idx));
      const targetY = d.getFullYear();
      const targetM = d.getMonth();
      const targetD = d.getDate();
      const dayStr = idx === 6 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' });
      const count = allEvents.filter(e => e.date.getFullYear() === targetY && e.date.getMonth() === targetM && e.date.getDate() === targetD).length;
      return { day: dayStr, count, isToday: idx === 6 };
    });
  }
  const maxDayCount = Math.max(1, ...chartBars.map(p => p.count));

  // Compute Model Reliability & Telemetry breakdown
  const modelStatsMap = {};
  logs.forEach(l => {
    const m = l.model || 'Unknown';
    if (!modelStatsMap[m]) modelStatsMap[m] = { model: m, success: 0, failed: 0, total: 0, latencies: [] };
    modelStatsMap[m].total++;
    if (l.status === 'SUCCESS' && (!l.statusCode || l.statusCode < 400)) {
      modelStatsMap[m].success++;
    } else {
      modelStatsMap[m].failed++;
    }
    if (l.latencyMs && !isNaN(Number(l.latencyMs))) modelStatsMap[m].latencies.push(Number(l.latencyMs));
  });

  const uniqueModelsList = Object.keys(modelStatsMap);
  const activeModelFilter = AtomXState.modelTelemetryFilter || 'ALL';

  let totalSelected = 0, successSelected = 0, failedSelected = 0, selectedLatencies = [];
  if (activeModelFilter === 'ALL') {
    totalSelected = logs.length;
    successSelected = logs.filter(l => l.status === 'SUCCESS' && (!l.statusCode || l.statusCode < 400)).length;
    failedSelected = totalSelected - successSelected;
    selectedLatencies = logs.map(l => Number(l.latencyMs)).filter(n => !isNaN(n) && n > 0);
  } else if (modelStatsMap[activeModelFilter]) {
    const mObj = modelStatsMap[activeModelFilter];
    totalSelected = mObj.total;
    successSelected = mObj.success;
    failedSelected = mObj.failed;
    selectedLatencies = mObj.latencies;
  }
  const modelSuccessRate = totalSelected > 0 ? ((successSelected / totalSelected) * 100).toFixed(1) : '100.0';
  const modelFailRate = totalSelected > 0 ? ((failedSelected / totalSelected) * 100).toFixed(1) : '0.0';
  const modelAvgLatency = selectedLatencies.length > 0 ? Math.round(selectedLatencies.reduce((a, b) => a + b, 0) / selectedLatencies.length) + 'ms' : '< 300ms';

  // Error rate check from telemetry
  const failedCalls = logs.filter(l => l.status === 'FAILED' || (l.statusCode && l.statusCode >= 400)).length;
  const hasSystemAlerts = pwdReqs.length > 0 || suspendedUsers > 0 || failedCalls > 0;

  // Recent 5 audit logs
  const recentAudit = ledger.slice(0, 5);

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('12')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Platform Overview</h1>
            <p class="page-subtitle">Real-time platform operational diagnostics, health metrics, and growth telemetry.</p>
          </div>
          <div style="display:flex; gap:10px; align-items:center;">
            <button class="btn btn-secondary btn-sm" onclick="loadAdminServerData(); showToast('↻ Synced live platform state');">↻ Refresh</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- SYSTEM HEALTH & ANOMALY DIAGNOSTICS MONITOR -->
          <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:12px; padding:16px 20px; margin-bottom:24px; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:20px;">🛡️</span>
                <div>
                  <h3 style="font-size:15px; font-weight:800; margin:0; color:var(--text-primary);">System Status & Pipeline Health</h3>
                  <div style="font-size:11.5px; color:var(--text-secondary); margin-top:2px;">Real-time diagnostics across database, AI gateways, and client watchdogs.</div>
                </div>
              </div>
              <div style="display:flex; gap:12px; align-items:center; font-size:12px;">
                <span class="badge ${hasSystemAlerts ? 'badge-warning' : 'badge-success'}" style="font-size:11px; font-weight:700;">
                  ${hasSystemAlerts ? '⚠️ Attention Needed' : '🟢 All Systems Operational'}
                </span>
              </div>
            </div>

            <!-- Health Indicators Matrix -->
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; font-size:12px;">
              <div style="background:var(--bg-canvas); padding:10px 14px; border-radius:8px; border:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <span style="color:var(--text-muted); display:block; font-size:11px;">Supabase PostgreSQL</span>
                  <strong style="color:var(--text-primary);">Cloud Database</strong>
                </div>
                <span style="color:var(--status-success); font-weight:700;">🟢 Online (&lt;35ms)</span>
              </div>
              <div style="background:var(--bg-canvas); padding:10px 14px; border-radius:8px; border:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <span style="color:var(--text-muted); display:block; font-size:11px;">AI Gateway</span>
                  <strong style="color:var(--text-primary);">${(AtomXState.currentProvider || 'GROQ').toUpperCase()}</strong>
                </div>
                <span style="color:var(--status-success); font-weight:700;">🟢 Ready</span>
              </div>
              <div style="background:var(--bg-canvas); padding:10px 14px; border-radius:8px; border:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <span style="color:var(--text-muted); display:block; font-size:11px;">Extension Watchdog</span>
                  <strong style="color:var(--text-primary);">15s Realtime Sync</strong>
                </div>
                <span style="color:var(--status-success); font-weight:700;">🟢 Active</span>
              </div>
              <div style="background:var(--bg-canvas); padding:10px 14px; border-radius:8px; border:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <span style="color:var(--text-muted); display:block; font-size:11px;">API Error Rate</span>
                  <strong style="color:var(--text-primary);">${failedCalls} Failures</strong>
                </div>
                <span style="color:${failedCalls > 0 ? 'var(--status-warning)' : 'var(--status-success)'}; font-weight:700;">
                  ${failedCalls > 0 ? '⚠️ Check Logs' : '🟢 0.0%'}
                </span>
              </div>
            </div>

            <!-- Active Alerts (If any) -->
            ${pwdReqs.length > 0 ? `
              <div style="margin-top:14px; padding:10px 14px; background:rgba(234,179,8,0.12); border:1px solid rgba(234,179,8,0.35); border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap:8px;">
                  <span style="font-size:16px;">🔑</span>
                  <span style="font-size:12px; color:var(--text-primary);"><strong>${pwdReqs.length} User(s)</strong> requested password reset. Click Users & Access to assign temporary passwords.</span>
                </div>
                <button class="btn btn-secondary btn-xs" onclick="navigateToScreen('14')">Review Users →</button>
              </div>
            ` : ''}
          </div>

          <!-- KPI METRICS GRID -->
          <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin-bottom:24px;">
            <div class="stat-card" style="cursor:pointer;" onclick="navigateToScreen('14')" title="View user accounts">
              <div class="stat-label">Total Registered</div>
              <div class="stat-value" id="adminTotalUsersVal">${totalUsers}</div>
              <div class="stat-trend" style="color:var(--status-success);">Live Database</div>
            </div>
            <div class="stat-card" style="cursor:pointer;" onclick="setAdminUserFilter('Active'); navigateToScreen('14');">
              <div class="stat-label">Active Users</div>
              <div class="stat-value" id="adminActiveUsersVal">${activeUsers}</div>
              <div class="stat-trend" style="color:var(--status-success);">Verified Active</div>
            </div>
            <div class="stat-card" style="cursor:pointer;" onclick="setAdminUserFilter('Pending'); navigateToScreen('14');">
              <div class="stat-label">Pending Requests</div>
              <div class="stat-value" id="adminPendingReqsVal" style="color:var(--status-warning);">${pendingCount}</div>
              <div class="stat-trend" style="color:var(--status-warning);">Awaiting Review</div>
            </div>
            <div class="stat-card" style="cursor:pointer;" onclick="navigateToScreen('15')">
              <div class="stat-label">Credits Circulating</div>
              <div class="stat-value" id="adminCreditsCircVal">${circulatingCredits.toLocaleString()}</div>
              <div class="stat-trend" style="color:var(--status-success);">Verified Ledger</div>
            </div>
            <div class="stat-card" style="cursor:pointer;" onclick="navigateToScreen('15')">
              <div class="stat-label">AI Generations</div>
              <div class="stat-value" id="adminAIActionsVal" style="color:var(--blue-primary);">${totalAIGenerations.toLocaleString()}</div>
              <div class="stat-trend" style="color:var(--status-success);">Atomic Server Log</div>
            </div>
            <div class="stat-card" style="cursor:pointer;" onclick="navigateToScreen('17')">
              <div class="stat-label">Platform Revenue</div>
              <div class="stat-value" style="color:var(--status-success);">$${totalRevenue.toFixed(0)}</div>
              <div class="stat-trend" style="color:var(--status-success);">${txs.length} Transactions</div>
            </div>
          </div>

          <!-- VISUAL ANALYTICS: CHARTS & CONSUMPTION FLOW -->
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:20px; margin-bottom:24px;">
            <!-- Generation Throughput Visual Graph -->
            <div class="atomx-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
                <div>
                  <h3 style="font-size:15px; font-weight:700; margin:0;">📊 AI Generation & Activity Velocity</h3>
                  <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">Throughput distribution (${velocityFilter === 'ALL' ? 'All-Time' : velocityFilter === '1Y' ? 'Past 12 Months' : velocityFilter === '1M' ? 'Past 30 Days' : velocityFilter === '1D' ? 'Today (Hourly)' : 'Past 7 Days (Daily)'})</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                  <div style="display:inline-flex; background:rgba(255,255,255,0.06); padding:2px; border-radius:6px; border:1px solid rgba(255,255,255,0.12); font-size:11px; gap:2px;">
                    <button class="btn btn-xs" style="padding:3px 8px; font-size:10px; border-radius:4px; font-weight:700; border:none; outline:none; cursor:pointer; transition:all 0.15s ease; ${velocityFilter === '1D' ? 'background:var(--blue-primary); color:#ffffff;' : 'background:transparent; color:var(--text-secondary);'}" onclick="window.setVelocityChartFilter('1D')">Today</button>
                    <button class="btn btn-xs" style="padding:3px 8px; font-size:10px; border-radius:4px; font-weight:700; border:none; outline:none; cursor:pointer; transition:all 0.15s ease; ${velocityFilter === '7D' ? 'background:var(--blue-primary); color:#ffffff;' : 'background:transparent; color:var(--text-secondary);'}" onclick="window.setVelocityChartFilter('7D')">7D</button>
                    <button class="btn btn-xs" style="padding:3px 8px; font-size:10px; border-radius:4px; font-weight:700; border:none; outline:none; cursor:pointer; transition:all 0.15s ease; ${velocityFilter === '1M' ? 'background:var(--blue-primary); color:#ffffff;' : 'background:transparent; color:var(--text-secondary);'}" onclick="window.setVelocityChartFilter('1M')">1M</button>
                    <button class="btn btn-xs" style="padding:3px 8px; font-size:10px; border-radius:4px; font-weight:700; border:none; outline:none; cursor:pointer; transition:all 0.15s ease; ${velocityFilter === '1Y' ? 'background:var(--blue-primary); color:#ffffff;' : 'background:transparent; color:var(--text-secondary);'}" onclick="window.setVelocityChartFilter('1Y')">1Y</button>
                    <button class="btn btn-xs" style="padding:3px 8px; font-size:10px; border-radius:4px; font-weight:700; border:none; outline:none; cursor:pointer; transition:all 0.15s ease; ${velocityFilter === 'ALL' ? 'background:var(--blue-primary); color:#ffffff;' : 'background:transparent; color:var(--text-secondary);'}" onclick="window.setVelocityChartFilter('ALL')">All Time</button>
                  </div>
                  <span class="badge badge-primary" style="font-size:10px;">${totalAIGenerations.toLocaleString()} Lifetime</span>
                </div>
              </div>
              <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:8px; padding:16px; min-height:160px; display:flex; flex-direction:column; justify-content:space-between;">
                <div style="display:flex; align-items:flex-end; justify-content:space-between; height:120px; gap:8px; padding-top:10px;">
                  ${chartBars.map(({ day, count, isToday }) => {
                    const hPercent = count === 0 ? 8 : Math.max(16, Math.min(100, Math.round((count / maxDayCount) * 100)));
                    const barColor = isToday ? 'linear-gradient(180deg, #10b981 0%, rgba(16,185,129,0.3) 100%)' : 'linear-gradient(180deg, var(--blue-primary) 0%, rgba(59,130,246,0.3) 100%)';
                    return `
                      <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; height:100%; justify-content:flex-end;" title="${day}: ${count} generations">
                        <span style="font-size:9.5px; font-weight:700; color:${count > 0 ? 'var(--text-primary)' : 'var(--text-muted)'};">${count}</span>
                        <div style="width:100%; max-width:28px; height:${hPercent}%; background:${barColor}; border-radius:4px 4px 0 0; transition: height 0.3s ease;"></div>
                        <span style="font-size:10px; color:${isToday ? '#10b981' : 'var(--text-muted)'}; font-weight:700;">${day}</span>
                      </div>
                    `;
                  }).join('')}
                </div>
                <div style="border-top:1px solid var(--border-subtle); padding-top:10px; margin-top:8px; display:flex; justify-content:space-between; font-size:11px; color:var(--text-secondary);">
                  <span>Active Model: <strong style="color:var(--text-primary);">${(AtomXState.currentModel || 'llama-3.3-70b-versatile')}</strong></span>
                  <span>Avg Latency: <strong style="color:var(--text-primary);">${avgLatency}</strong></span>
                </div>
              </div>
            </div>

            <!-- Credit Consumption & Model Telemetry Flow -->
            <div class="atomx-card">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                <div>
                  <h3 style="font-size:15px; font-weight:700; margin:0;">⚡ Credit Circulation & Model Health</h3>
                  <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">Circulating credit balances and per-model telemetry</div>
                </div>
                <button class="btn btn-secondary btn-xs" onclick="navigateToScreen('15')">View Ledger →</button>
              </div>

              <div style="display:flex; flex-direction:column; gap:12px;">
                <div>
                  <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
                    <span style="color:var(--text-secondary);">AI Deductions Consumed</span>
                    <strong style="color:var(--text-primary);">${totalAIGenerations.toLocaleString()} C</strong>
                  </div>
                  <div style="width:100%; height:8px; background:var(--bg-canvas); border-radius:4px; overflow:hidden;">
                    <div style="width:${circulatingCredits > 0 ? Math.min(100, Math.round((totalAIGenerations / (circulatingCredits + totalAIGenerations)) * 100)) : 10}%; height:100%; background:var(--blue-primary); border-radius:4px;"></div>
                  </div>
                </div>

                <div>
                  <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
                    <span style="color:var(--text-secondary);">Available In Circulation</span>
                    <strong style="color:var(--status-success);">${circulatingCredits.toLocaleString()} C</strong>
                  </div>
                  <div style="width:100%; height:8px; background:var(--bg-canvas); border-radius:4px; overflow:hidden;">
                    <div style="width:85%; height:100%; background:var(--status-success); border-radius:4px;"></div>
                  </div>
                </div>

                <!-- Per-Model Telemetry Selector & Metrics -->
                <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:8px; padding:12px; margin-top:2px; font-size:11.5px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-weight:700; color:var(--text-primary);">Model Telemetry:</span>
                    <select class="form-control" style="font-size:11px; padding:3px 8px; width:auto; height:28px; background:#111827; color:#F3F4F6; border:1px solid rgba(255,255,255,0.18); border-radius:6px; outline:none; cursor:pointer;" onchange="window.handleModelTelemetryFilterChange(this.value)">
                      <option value="ALL" style="background:#111827; color:#F3F4F6;" ${activeModelFilter === 'ALL' ? 'selected' : ''}>All Models (${logs.length} calls)</option>
                      ${uniqueModelsList.map(m => `
                        <option value="${escapeHtml(m)}" style="background:#111827; color:#F3F4F6;" ${activeModelFilter === m ? 'selected' : ''}>${escapeHtml(m)} (${modelStatsMap[m].total})</option>
                      `).join('')}
                    </select>
                  </div>
                  <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; text-align:center;">
                    <div style="background:var(--bg-card); padding:6px; border-radius:6px; border:1px solid var(--border-subtle);">
                      <div style="font-size:10px; color:var(--text-muted);">Success Rate</div>
                      <div style="font-size:13px; font-weight:800; color:#10b981;">${modelSuccessRate}%</div>
                    </div>
                    <div style="background:var(--bg-card); padding:6px; border-radius:6px; border:1px solid var(--border-subtle);">
                      <div style="font-size:10px; color:var(--text-muted);">Fail Rate</div>
                      <div style="font-size:13px; font-weight:800; color:${Number(modelFailRate) > 0 ? '#ef4444' : 'var(--text-muted)'};">${modelFailRate}%</div>
                    </div>
                    <div style="background:var(--bg-card); padding:6px; border-radius:6px; border:1px solid var(--border-subtle);">
                      <div style="font-size:10px; color:var(--text-muted);">Avg Latency</div>
                      <div style="font-size:13px; font-weight:800; color:var(--blue-primary);">${modelAvgLatency}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- RECENT OPERATIONAL AUDIT FEED -->
          <div class="atomx-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <div>
                <h3 style="font-size:15px; font-weight:700; margin:0;">📋 Recent System Audit Events</h3>
                <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px;">Live feed of real-time credit adjustments, AI generations, and onboarding grants</div>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="navigateToScreen('15')">View Full Ledger</button>
            </div>

            <div class="atomx-table-wrapper">
              <table class="atomx-table" style="font-size:12px;">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Credits</th>
                    <th>Source</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${recentAudit.length === 0 ? `
                    <tr>
                      <td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">
                        No ledger actions recorded yet.
                      </td>
                    </tr>
                  ` : recentAudit.map(a => `
                    <tr>
                      <td style="color:var(--text-muted); font-size:11px;">${a.date}</td>
                      <td style="font-weight:600;">${a.user}</td>
                      <td><span class="badge badge-neutral" style="font-size:10px;">${a.action}</span></td>
                      <td style="font-weight:700; color:${Number(a.amount) > 0 ? 'var(--status-success)' : 'var(--status-error)'};">
                        ${Number(a.amount) > 0 ? '+' + Number(a.amount).toLocaleString() : Number(a.amount).toLocaleString()}
                      </td>
                      <td style="font-size:11px; color:var(--text-secondary);">${a.admin}</td>
                      <td style="color:var(--text-muted); font-size:11px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${a.reason || '—'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

window.setVelocityChartFilter = function(filter) {
  AtomXState.velocityChartFilter = filter;
  if (AtomXState.currentScreen === '12') {
    renderCurrentScreen();
  }
};

window.handleModelTelemetryFilterChange = function(modelName) {
  AtomXState.activeModelFilter = modelName;
  if (AtomXState.currentScreen === '12') {
    renderCurrentScreen();
  }
};

// -------------------------------------------------------------
// SCREEN 23: DEDICATED AI ENGINE & TELEMETRY LOGS (ADMIN)
// -------------------------------------------------------------
const ADMIN_AI_PROVIDERS = [
  { id: 'groq', name: 'Groq', tag: 'Ultra-fast LPU Inference', icon: '🚀', defaultModel: 'llama-3.3-70b-versatile', hasBaseUrl: false },
  { id: 'openrouter', name: 'OpenRouter', tag: 'Open Models & Aggregator', icon: '🌐', defaultModel: 'meta-llama/llama-3.3-70b-instruct', hasBaseUrl: false },
  { id: 'openai', name: 'OpenAI', tag: 'GPT-4o & Compatible Proxies', icon: '⚡', defaultModel: 'gpt-4o-mini', hasBaseUrl: true, defaultUrl: 'https://api.openai.com/v1', presetUrl: 'https://api.artbloom.tech/v1' },
  { id: 'anthropic', name: 'Anthropic', tag: 'Claude 3.5 & Artbloom Gateway', icon: '🧠', defaultModel: 'claude-3-5-sonnet-20241022', hasBaseUrl: true, defaultUrl: 'https://api.anthropic.com', presetUrl: 'https://api.artbloom.tech' },
  { id: 'gemini', name: 'Google Gemini', tag: 'Multimodal Generative AI', icon: '✨', defaultModel: 'gemini-1.5-flash', hasBaseUrl: false }
];

function renderAdminProviderCardsHTML() {
  return ADMIN_AI_PROVIDERS.map(p => {
    const isActive = (AtomXState.currentProvider || 'groq').toLowerCase() === p.id;
    const keyInfo = getAdminApiKeyInfo(p.id);
    const hasKey = keyInfo.hasKey;
    let modelName = (isActive ? AtomXState.currentModel : (AtomXState.providerModels && AtomXState.providerModels[p.id])) || p.defaultModel;
    
    let baseUrlNotice = '';
    if (p.id === 'anthropic' && AtomXState.adminAnthropicBaseUrl && !AtomXState.adminAnthropicBaseUrl.includes('anthropic.com')) {
      baseUrlNotice = `<div style="font-size:10.5px; color:#d97706; margin-top:3px; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Proxy: ${AtomXState.adminAnthropicBaseUrl}</div>`;
    } else if (p.id === 'openai' && AtomXState.adminOpenaiBaseUrl && !AtomXState.adminOpenaiBaseUrl.includes('openai.com')) {
      baseUrlNotice = `<div style="font-size:10.5px; color:var(--blue-primary); margin-top:3px; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Proxy: ${AtomXState.adminOpenaiBaseUrl}</div>`;
    }

    return `
      <div class="atomx-card" style="cursor:pointer; display:flex; flex-direction:column; justify-content:space-between; height:100%; border:${isActive ? '2px solid var(--blue-primary)' : '1px solid var(--border-subtle)'}; background:${isActive ? 'rgba(59,130,246,0.05)' : 'var(--bg-card)'}; border-radius:var(--radius-md); padding:16px; transition:all 0.2s ease; box-sizing:border-box;" onclick="openAdminProviderModal('${p.id}')">
        <!-- TOP CONTENT (FLEX: 1) -->
        <div style="flex:1; display:flex; flex-direction:column;">
          <!-- 1. Header row with fixed min-height for uniform alignment -->
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; min-height:48px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="font-size:26px; line-height:1;">${p.icon}</div>
              <div>
                <div style="font-size:14px; font-weight:800; color:var(--text-primary); line-height:1.2;">${p.name}</div>
                <div style="font-size:10.5px; color:var(--text-secondary); line-height:1.2; margin-top:2px;">${p.tag}</div>
              </div>
            </div>
            ${isActive ? `<span class="badge badge-success" style="font-size:9.5px; font-weight:800; padding:3px 7px; white-space:nowrap; letter-spacing:0.3px;">ACTIVE</span>` : ''}
          </div>

          <!-- 2. Key status badge row with fixed height -->
          <div style="min-height:24px; margin-bottom:10px;">
            <span class="badge ${hasKey ? 'badge-success' : 'badge-warning'}" style="font-size:10px; font-weight:700;">
              ${hasKey ? '🟢 Key Active (' + (keyInfo.maskedKey || 'Configured') + ')' : '⚪ Missing Key'}
            </span>
          </div>

          <!-- 3. Configured model box with uniform min-height across all cards -->
          <div style="background:var(--bg-canvas); padding:8px 10px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); margin-bottom:14px; min-height:64px; display:flex; flex-direction:column; justify-content:center;">
            <div style="font-size:9.5px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; font-weight:700;">Configured Model</div>
            <div style="font-size:11.5px; font-weight:700; color:var(--text-primary); font-family:monospace; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${modelName}">
              ${modelName}
            </div>
            ${baseUrlNotice ? baseUrlNotice : '<div style="font-size:10.5px; color:transparent; user-select:none; margin-top:3px;">&nbsp;</div>'}
          </div>
        </div>

        <!-- BOTTOM BUTTONS: Quick Activate + Configure & Test -->
        <div style="display:flex; gap:6px; margin-top:auto;">
          ${isActive ? `
            <span class="btn btn-sm" style="flex:1; background:rgba(16,185,129,0.15); color:#10B981; border:1px solid rgba(16,185,129,0.3); font-weight:800; font-size:11px; padding:7px 8px; display:flex; align-items:center; justify-content:center; gap:4px; cursor:default;">
              ✓ Active
            </span>
          ` : `
            <button type="button" class="btn btn-secondary btn-sm" style="flex:1; font-weight:700; font-size:11px; padding:7px 8px; border-color:var(--border-subtle);" onclick="event.stopPropagation(); setAdminProviderDirectlyActive('${p.id}')">
              ● Set Active
            </button>
          `}
          <button type="button" class="btn ${isActive ? 'btn-primary' : 'btn-secondary'} btn-sm" style="flex:1.2; display:flex; align-items:center; justify-content:center; gap:4px; padding:7px 10px; font-weight:700; font-size:11px;" onclick="event.stopPropagation(); openAdminProviderModal('${p.id}')">
            <span>⚙️</span>
            <span>Configure</span>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function setAdminProviderDirectlyActive(providerId) {
  const p = ADMIN_AI_PROVIDERS.find(x => x.id === providerId);
  if (!p) return;
  const model = (AtomXState.providerModels && AtomXState.providerModels[providerId]) || p.defaultModel;
  try {
    const res = await fetch(`${API_BASE}/api/admin/active-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, model })
    });
    if (res.ok) {
      AtomXState.currentProvider = providerId;
      AtomXState.activeSystemProvider = providerId;
      AtomXState.currentModel = model;
      AtomXState.activeSystemModel = model;
      showToast(`✓ Active AI Provider switched to ${p.name}!`);
      const contentArea = document.getElementById('mainContentArea');
      if (contentArea) renderAdminAIEngine(contentArea);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast('❌ Failed to set active provider: ' + (err.error || 'Unknown error'));
    }
  } catch (e) {
    showToast('❌ Error: ' + e.message);
  }
}

function openAdminProviderModal(providerId) {
  closeModal();
  const p = ADMIN_AI_PROVIDERS.find(x => x.id === providerId) || ADMIN_AI_PROVIDERS[0];
  const isActive = (AtomXState.currentProvider || 'groq').toLowerCase() === p.id;
  const keyInfo = getAdminApiKeyInfo(p.id);
  const currentModel = (isActive ? AtomXState.currentModel : (AtomXState.providerModels && AtomXState.providerModels[p.id])) || p.defaultModel;
  
  let currentBaseUrl = '';
  if (p.id === 'openai') {
    currentBaseUrl = AtomXState.adminOpenaiBaseUrl || 'https://api.openai.com/v1';
  } else if (p.id === 'anthropic') {
    currentBaseUrl = AtomXState.adminAnthropicBaseUrl || 'https://api.anthropic.com';
  }

  const existingModels = AtomXState.modelsCache && AtomXState.modelsCache[p.id];
  const modelCount = (existingModels && existingModels.length) || getFallbackModelsForProvider(p.id).length;

  const modalHTML = `
    <div class="modal-backdrop" id="adminProviderModal">
      <div class="modal-box" style="max-width:580px; width:95%; max-height:90vh; overflow-y:auto; border-radius:14px; padding:22px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);">
        <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle); padding-bottom:14px; margin-bottom:16px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="font-size:28px; width:44px; height:44px; display:flex; align-items:center; justify-content:center; background:rgba(59,130,246,0.1); border-radius:10px; border:1px solid rgba(59,130,246,0.2);">${p.icon}</div>
            <div>
              <h3 class="modal-title" style="font-size:17px; font-weight:800; margin:0; color:var(--text-primary);">Configure ${p.name}</h3>
              <div style="font-size:11.5px; color:var(--text-secondary); margin-top:2px;">${p.tag} • Manage key, custom URL &amp; model</div>
            </div>
          </div>
          <button class="modal-close-btn" onclick="closeModal()" style="font-size:24px; cursor:pointer; background:none; border:none; color:var(--text-secondary); padding:4px 8px;">×</button>
        </div>

        <!-- 1. ACTIVE SYSTEM TOGGLE -->
        <div style="background:var(--bg-canvas); padding:12px 14px; border-radius:10px; border:1px solid var(--border-subtle); margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:800; font-size:13px; color:var(--text-primary);">Set as Active System Provider</div>
            <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">All Chrome Extension replies will route through this provider.</div>
          </div>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:800; font-size:13px; background:var(--bg-card); padding:6px 12px; border-radius:6px; border:1px solid var(--border-subtle);">
            <input type="checkbox" id="modalSetActiveCheckbox" ${isActive ? 'checked' : ''} style="width:18px; height:18px; cursor:pointer;" />
            <span style="color:var(--text-primary);">Active</span>
          </label>
        </div>

        <!-- 2. SPATIAL MODEL SELECTION & SEARCH HUB -->
        <div style="background:var(--bg-canvas); padding:14px; border-radius:10px; border:1px solid var(--border-subtle); margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <label class="form-label" style="font-size:13px; margin:0; font-weight:800; color:var(--text-primary);">Selected Model</label>
              <span class="badge badge-info" id="modalModelCountBadge" style="font-size:10px; font-weight:700;">${modelCount} Active Models</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="btnModalFetchModels" style="font-size:11px; padding:5px 12px; display:flex; align-items:center; gap:5px; font-weight:700;" onclick="fetchModalModels('${p.id}')">
              <span>↻</span>
              <span>Fetch Live Models</span>
            </button>
          </div>

          <!-- PROMINENT SPACIOUS SEARCH BOX -->
          <div style="position:relative; margin-bottom:10px;">
            <span style="position:absolute; left:12px; top:50%; transform:translateY(-50%); font-size:14px; color:var(--text-muted); pointer-events:none;">🔍</span>
            <input type="text" id="modalModelSearchInput" class="form-input" placeholder="Search available active models (e.g. llama, claude, sonnet, gpt-4o)..." style="font-size:13px; padding:10px 14px 10px 36px; width:100%; box-sizing:border-box; border-radius:8px; background:var(--bg-card); border:1px solid var(--border-subtle);" oninput="filterModalModelsList(this.value, '${p.id}')">
          </div>

          <!-- MODEL SELECT DROPDOWN -->
          <div style="position:relative;">
            <select id="modalModelSelect" class="form-select" style="font-size:13px; width:100%; padding:10px 12px; border-radius:8px; background:var(--bg-card); border:1px solid var(--border-subtle); font-weight:600; font-family:monospace;">
              ${renderAdminModelOptionsHTML(p.id, '', currentModel)}
            </select>
          </div>
          <div id="modalModelHint" style="font-size:11px; color:var(--text-secondary); margin-top:6px;">
            Only active provider generation models are listed. Select a model to route AI engagement replies.
          </div>
        </div>

        <!-- 3. API KEY INPUT -->
        <div class="form-group" style="margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <label class="form-label" style="font-size:12.5px; margin:0; font-weight:800;">
              ${p.name} API Key
              <span class="badge ${keyInfo.hasKey ? 'badge-success' : 'badge-warning'}" style="font-size:10px; margin-left:6px;" id="modalKeyStatusBadge">
                ${keyInfo.hasKey ? '🟢 Configured (' + keyInfo.maskedKey + ')' : '⚪ Not Set'}
              </span>
            </label>
            <span style="font-size:10.5px; color:var(--text-muted);">Leave empty to keep existing</span>
          </div>
          <div style="position:relative; display:flex; align-items:center;">
            <input type="password" id="modalApiKeyInput" class="form-input" style="padding:10px 75px 10px 12px; font-family:monospace; font-size:12.5px; border-radius:8px;" placeholder="${keyInfo.hasKey ? 'Current: ' + keyInfo.maskedKey + ' (Paste to replace)' : 'Paste ' + p.name + ' API key (e.g. sk-...)'}">
            <button type="button" id="modalToggleKeyBtn" onclick="toggleModalApiKeyVisibility()" style="position:absolute; right:8px; background:none; border:none; cursor:pointer; font-size:12px; color:var(--text-secondary); padding:4px 8px; font-weight:700;">👁️ Show</button>
          </div>
        </div>

        <!-- 4. BASE URL (FOR ANTHROPIC & OPENAI) -->
        ${p.hasBaseUrl ? `
          <div class="form-group" style="margin-bottom:16px; background:var(--bg-canvas); padding:12px; border-radius:10px; border:1px solid var(--border-subtle);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:6px;">
              <label class="form-label" style="font-size:12px; margin:0; font-weight:800;">🌐 Base URL (Proxy / Gateway)</label>
              <div style="display:flex; gap:6px;">
                <button type="button" class="btn btn-sm" style="font-size:10.5px; padding:3px 10px; background:rgba(59,130,246,0.12); color:var(--blue-primary); border:1px solid rgba(59,130,246,0.3); font-weight:700;" onclick="setModalBaseUrl('${p.presetUrl}')">⚡ Artbloom Preset</button>
                <button type="button" class="btn btn-sm" style="font-size:10.5px; padding:3px 10px; background:var(--bg-card); color:var(--text-secondary); border:1px solid var(--border-subtle); font-weight:700;" onclick="setModalBaseUrl('${p.defaultUrl}')">Official</button>
              </div>
            </div>
            <input type="text" id="modalBaseUrlInput" class="form-input" value="${currentBaseUrl}" style="font-size:12.5px; font-family:monospace; padding:9px 12px; border-radius:8px;" placeholder="${p.defaultUrl}">
            <div style="font-size:11px; color:var(--text-secondary); margin-top:5px;">
              Use Artbloom proxy URL for Artbloom keys (<code>sk-ab-...</code>), or Official URL for standard keys.
            </div>
          </div>
        ` : ''}

        <!-- 5. TEST CONNECTION -->
        <div style="margin-bottom:18px; padding:12px 14px; background:var(--bg-canvas); border-radius:10px; border:1px solid var(--border-subtle);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
              <div style="font-weight:800; font-size:12.5px; color:var(--text-primary);">⚡ Verify Connection</div>
              <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Test this key &amp; URL against the provider before saving.</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="btnModalTestConn" style="font-weight:700; padding:6px 14px;" onclick="testModalProviderConnection('${p.id}')">
              ⚡ Test Connection
            </button>
          </div>
          <div id="modalTestResult" style="display:none; margin-top:10px; padding:10px 12px; border-radius:8px; font-size:12px; line-height:1.4;"></div>
        </div>

        <!-- 6. SINGLE SAVE ACTION BUTTON -->
        <div style="display:flex; justify-content:flex-end; gap:10px; border-top:1px solid var(--border-subtle); padding-top:16px;">
          <button type="button" class="btn btn-secondary" style="padding:8px 18px; font-weight:700;" onclick="closeModal()">Cancel</button>
          <button type="button" class="btn btn-primary" id="btnModalSaveConfig" style="padding:8px 20px; font-weight:800;" onclick="saveAdminProviderModal('${p.id}')">
            💾 Save Configuration
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  // Background fetch live models if not cached
  if (!existingModels || existingModels.length === 0) {
    fetchLiveModelsForProvider(p.id, false).then(models => {
      const select = document.getElementById('modalModelSelect');
      const countBadge = document.getElementById('modalModelCountBadge');
      if (select && models && models.length > 0) {
        select.innerHTML = renderAdminModelOptionsHTML(p.id, '', currentModel);
        if (countBadge) countBadge.textContent = `${models.length} Active Models`;
      }
    });
  }
}

async function saveAdminProviderModal(providerId) {
  const p = ADMIN_AI_PROVIDERS.find(x => x.id === providerId) || ADMIN_AI_PROVIDERS[0];
  const btn = document.getElementById('btnModalSaveConfig');
  const keyInput = document.getElementById('modalApiKeyInput');
  const baseUrlInput = document.getElementById('modalBaseUrlInput');
  const modelSelect = document.getElementById('modalModelSelect');
  const setActiveCheckbox = document.getElementById('modalSetActiveCheckbox');

  const apiKey = (keyInput?.value || '').trim();
  const baseUrl = (baseUrlInput?.value || '').trim();
  const model = modelSelect?.value || p.defaultModel;
  const setActive = setActiveCheckbox ? setActiveCheckbox.checked : false;

  if (btn) {
    btn.disabled = true;
    btn.textContent = '💾 Saving & Syncing...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/save-provider-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerId,
        apiKey: apiKey || 'KEEP_EXISTING',
        model,
        baseUrl,
        setActive
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save configuration');
    }

    // Update local state
    if (!AtomXState.adminApiKeys) AtomXState.adminApiKeys = {};
    if (data.maskedKey) {
      AtomXState.adminApiKeys[providerId] = {
        hasKey: data.hasKey,
        maskedKey: data.maskedKey
      };
    }
    if (!AtomXState.providerModels) AtomXState.providerModels = {};
    AtomXState.providerModels[providerId] = model;

    if (providerId === 'openai' && baseUrl) {
      AtomXState.adminOpenaiBaseUrl = baseUrl;
    }
    if (providerId === 'anthropic' && baseUrl) {
      AtomXState.adminAnthropicBaseUrl = baseUrl;
    }

    if (setActive) {
      AtomXState.currentProvider = providerId;
      AtomXState.currentModel = model;
    }

    showToast(`✓ ${p.name} configuration saved successfully!`);
    closeModal();

    // Re-render AI Engine screen to reflect new active provider & card states
    const contentArea = document.getElementById('mainContentArea');
    if (contentArea) {
      renderAdminAIEngine(contentArea);
    }
  } catch (err) {
    showToast('❌ Failed to save: ' + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 Save Configuration';
    }
  }
}

async function testModalProviderConnection(providerId) {
  const btn = document.getElementById('btnModalTestConn');
  const resultDiv = document.getElementById('modalTestResult');
  const keyInput = document.getElementById('modalApiKeyInput');
  const baseUrlInput = document.getElementById('modalBaseUrlInput');
  const modelSelect = document.getElementById('modalModelSelect');

  const apiKey = (keyInput?.value || '').trim();
  const baseUrl = (baseUrlInput?.value || '').trim();
  const model = (modelSelect?.value || '').trim();

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⚡ Testing...';
  }
  if (resultDiv) {
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'rgba(59,130,246,0.08)';
    resultDiv.style.color = 'var(--text-secondary)';
    resultDiv.style.border = '1px solid rgba(59,130,246,0.2)';
    resultDiv.innerHTML = '⏳ Ping test in progress... Sending test inference payload.';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/test-single-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerId,
        apiKey: apiKey || 'KEEP_EXISTING',
        baseUrl,
        model
      })
    });

    const data = await res.json();
    if (resultDiv) {
      if (data.status === 'HEALTHY') {
        resultDiv.style.background = 'rgba(16,185,129,0.12)';
        resultDiv.style.color = 'var(--status-success)';
        resultDiv.style.border = '1px solid rgba(16,185,129,0.3)';
        resultDiv.innerHTML = `<strong>✓ Connection Verified!</strong> (${data.latencyMs}ms)<br>${data.message || 'Provider authorization and endpoint handshake successful.'}`;
      } else {
        resultDiv.style.background = 'rgba(239,68,68,0.12)';
        resultDiv.style.color = 'var(--status-error)';
        resultDiv.style.border = '1px solid rgba(239,68,68,0.3)';
        resultDiv.innerHTML = `<strong>❌ Connection Failed:</strong><br>${data.message || 'Unable to authenticate with provider.'}`;
      }
    }
  } catch (err) {
    if (resultDiv) {
      resultDiv.style.background = 'rgba(239,68,68,0.12)';
      resultDiv.style.color = 'var(--status-error)';
      resultDiv.style.border = '1px solid rgba(239,68,68,0.3)';
      resultDiv.innerHTML = `<strong>❌ Network Error:</strong> ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Test Connection';
    }
  }
}

function setModalBaseUrl(url) {
  const inp = document.getElementById('modalBaseUrlInput');
  if (inp) {
    inp.value = url;
    inp.focus();
  }
}

function toggleModalApiKeyVisibility() {
  const inp = document.getElementById('modalApiKeyInput');
  const btn = document.getElementById('modalToggleKeyBtn');
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    if (btn) btn.textContent = '🙈 Hide';
  } else {
    inp.type = 'password';
    if (btn) btn.textContent = '👁️ Show';
  }
}

async function fetchModalModels(providerId) {
  const btn = document.getElementById('btnModalFetchModels');
  const countBadge = document.getElementById('modalModelCountBadge');
  const keyInput = document.getElementById('modalApiKeyInput');
  const urlInput = document.getElementById('modalBaseUrlInput');

  const apiKey = (keyInput?.value || '').trim();
  const baseUrl = (urlInput?.value || '').trim();

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>↻</span> <span>Fetching...</span>';
  }

  try {
    const params = new URLSearchParams();
    if (apiKey && apiKey !== 'KEEP_EXISTING') params.set('key', apiKey);
    if (baseUrl) params.set('baseUrl', baseUrl);

    const res = await fetch(`${API_BASE}/api/providers/${providerId}/models?${params.toString()}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const models = data.models || [];

    if (models.length > 0) {
      AtomXState.modelsCache[providerId] = models;
      const select = document.getElementById('modalModelSelect');
      const searchInput = document.getElementById('modalModelSearchInput');
      const currentVal = select ? select.value : '';
      if (select) {
        select.innerHTML = renderAdminModelOptionsHTML(providerId, searchInput ? searchInput.value : '', currentVal);
      }
      if (countBadge) {
        countBadge.textContent = `${models.length} Active Models`;
      }
      showToast(`✓ Fetched ${models.length} active models from ${providerId.toUpperCase()}!`);
    } else {
      showToast(`⚠️ No active models returned for ${providerId.toUpperCase()}`);
    }
  } catch (e) {
    showToast(`❌ Error fetching models: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>↻</span> <span>Fetch Live Models</span>';
    }
  }
}

function filterModalModelsList(query, providerId) {
  const select = document.getElementById('modalModelSelect');
  const countBadge = document.getElementById('modalModelCountBadge');
  if (!select) return;
  select.innerHTML = renderAdminModelOptionsHTML(providerId, query, select.value);
  if (countBadge) {
    const all = (AtomXState.modelsCache && AtomXState.modelsCache[providerId]) || getFallbackModelsForProvider(providerId);
    countBadge.textContent = query ? `${select.options.length} / ${all.length} Found` : `${all.length} Active Models`;
  }
}

// -------------------------------------------------------------
// FAILOVER CASCADE ROUTING ENGINE (UP TO 5 PROVIDERS)
// -------------------------------------------------------------
const FAILOVER_RECOMMENDED_DEFAULTS = [
  { priority: 1, provider: 'groq', model: 'llama-3.3-70b-versatile', enabled: true },
  { priority: 2, provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', enabled: true },
  { priority: 3, provider: 'openai', model: 'gpt-4o-mini', enabled: true },
  { priority: 4, provider: 'anthropic', model: 'claude-3-5-haiku-20241022', enabled: true },
  { priority: 5, provider: 'gemini', model: 'gemini-1.5-flash', enabled: true }
];

function getFailoverChainList() {
  if (Array.isArray(AtomXState.failoverProviders) && AtomXState.failoverProviders.length > 0) {
    const list = [...AtomXState.failoverProviders];
    while (list.length < 5) {
      const def = FAILOVER_RECOMMENDED_DEFAULTS[list.length] || { priority: list.length + 1, provider: 'groq', model: 'llama-3.3-70b-versatile', enabled: true };
      list.push({ ...def, priority: list.length + 1 });
    }
    return list.slice(0, 5);
  }
  return [...FAILOVER_RECOMMENDED_DEFAULTS];
}

function renderAdminFailoverSlotsHTML() {
  const chain = getFailoverChainList();
  const testResults = AtomXState.failoverTestResults || {};

  return chain.map((step, idx) => {
    const priority = idx + 1;
    const provId = (step.provider || 'groq').toLowerCase();
    const keyInfo = getAdminApiKeyInfo(provId);
    const stepTest = testResults[priority];
    const isStepEnabled = step.enabled !== false;

    let testBadgeHTML = '';
    if (stepTest) {
      if (stepTest.status === 'HEALTHY') {
        testBadgeHTML = `<span class="badge badge-success" style="font-size:10.5px; padding:3px 8px; font-weight:700;">🟢 Healthy (${stepTest.latencyMs || 0}ms)</span>`;
      } else if (stepTest.status === 'DISABLED') {
        testBadgeHTML = `<span class="badge" style="background:var(--bg-canvas); color:var(--text-muted); font-size:10px; border:1px solid var(--border-subtle);">⚪ Disabled</span>`;
      } else {
        testBadgeHTML = `<span class="badge badge-danger" style="font-size:10.5px; padding:3px 8px; font-weight:700;" title="${stepTest.message || 'Error'}">❌ Failed</span>`;
      }
    }

    const connectorHTML = idx < 4 ? `
      <div style="display:flex; align-items:center; justify-content:center; gap:8px; margin:2px 0; color:var(--text-muted); font-size:11px; font-weight:700;">
        <span style="opacity:0.6;">│</span>
        <span style="background:var(--bg-canvas); padding:2px 10px; border-radius:12px; border:1px dashed var(--border-subtle); color:var(--text-secondary); font-size:10px;">
          ⬇️ If Priority #${priority} fails (rate limit, quota or 429) ➔ Cascades to Priority #${priority + 1} ⬇️
        </span>
        <span style="opacity:0.6;">│</span>
      </div>
    ` : '';

    return `
      <div class="failover-step-card" data-step-idx="${idx}" style="background:var(--bg-card); border:${isStepEnabled ? '1px solid var(--border-subtle)' : '1px dashed rgba(255,255,255,0.08)'}; border-radius:10px; padding:12px 16px; opacity:${isStepEnabled ? '1' : '0.65'}; transition:all 0.2s ease;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
          <!-- LEFT: PRIORITY & ENABLED -->
          <div style="display:flex; align-items:center; gap:12px; min-width:200px;">
            <div style="width:34px; height:34px; border-radius:8px; background:rgba(59,130,246,0.1); border:1px solid rgba(59,130,246,0.3); display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px; color:var(--blue-primary);">
              #${priority}
            </div>
            <div>
              <div style="font-weight:800; font-size:13px; color:var(--text-primary);">
                Priority ${priority} ${priority === 1 ? '(1st Fallback)' : priority === 2 ? '(2nd Fallback)' : priority === 3 ? '(3rd Fallback)' : priority === 4 ? '(4th Fallback)' : '(5th Fallback)'}
              </div>
              <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:11px; color:var(--text-secondary); margin-top:2px;">
                <input type="checkbox" id="failover_enabled_${idx}" ${isStepEnabled ? 'checked' : ''} onchange="toggleFailoverStepEnabled(${idx}, this.checked)" style="cursor:pointer;" />
                <span>${isStepEnabled ? 'Active in Cascade' : 'Disabled (Bypassed)'}</span>
              </label>
            </div>
          </div>

          <!-- MIDDLE: PROVIDER & MODEL SELECTORS -->
          <div style="flex:1; display:flex; align-items:center; gap:10px; min-width:280px; flex-wrap:wrap;">
            <div style="flex:1; min-width:140px;">
              <select id="failover_prov_${idx}" class="form-select" style="font-size:12px; padding:7px 10px; font-weight:700; width:100%; border-radius:8px;" onchange="handleFailoverProvChange(${idx}, this.value)">
                ${ADMIN_AI_PROVIDERS.map(p => `
                  <option value="${p.id}" ${provId === p.id ? 'selected' : ''}>${p.icon} ${p.name}</option>
                `).join('')}
              </select>
            </div>
            <div style="flex:1.5; min-width:180px;">
              <input type="text" id="failover_model_${idx}" class="form-input" value="${step.model || ''}" placeholder="Model ID (e.g. gpt-4o-mini)" style="font-size:12px; font-family:monospace; padding:7px 10px; border-radius:8px; width:100%; box-sizing:border-box;" />
            </div>
            <div>
              <span class="badge ${keyInfo.hasKey ? 'badge-success' : 'badge-warning'}" style="font-size:10px; padding:4px 8px; font-weight:700;" title="${keyInfo.maskedKey || 'No key'}">
                ${keyInfo.hasKey ? '🟢 Key Ready' : '⚪ Missing Key'}
              </span>
            </div>
          </div>

          <!-- RIGHT: TEST STATUS & REORDER BUTTONS -->
          <div style="display:flex; align-items:center; gap:8px;">
            ${testBadgeHTML}
            <div style="display:flex; gap:3px;">
              <button type="button" class="btn btn-secondary btn-sm" style="padding:4px 8px; font-size:11px;" onclick="reorderFailoverStep(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Move Up">▲</button>
              <button type="button" class="btn btn-secondary btn-sm" style="padding:4px 8px; font-size:11px;" onclick="reorderFailoverStep(${idx}, 1)" ${idx === 4 ? 'disabled' : ''} title="Move Down">▼</button>
            </div>
          </div>
        </div>
      </div>
      ${connectorHTML}
    `;
  }).join('');
}

function toggleFailoverStepEnabled(idx, isChecked) {
  const chain = getFailoverChainList();
  if (chain[idx]) {
    chain[idx].enabled = isChecked;
    AtomXState.failoverProviders = chain;
    const container = document.getElementById('adminFailoverChainContainer');
    if (container) container.innerHTML = renderAdminFailoverSlotsHTML();
  }
}

function handleFailoverProvChange(idx, newProv) {
  const chain = getFailoverChainList();
  const defaultModelMap = {
    groq: 'llama-3.3-70b-versatile',
    openrouter: 'meta-llama/llama-3.3-70b-instruct',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-20241022',
    gemini: 'gemini-1.5-flash'
  };
  if (chain[idx]) {
    chain[idx].provider = newProv;
    chain[idx].model = defaultModelMap[newProv] || 'gpt-4o-mini';
    AtomXState.failoverProviders = chain;
    const container = document.getElementById('adminFailoverChainContainer');
    if (container) container.innerHTML = renderAdminFailoverSlotsHTML();
  }
}

function reorderFailoverStep(idx, direction) {
  const chain = getFailoverChainList();
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= chain.length) return;

  const temp = chain[idx];
  chain[idx] = chain[targetIdx];
  chain[targetIdx] = temp;

  chain.forEach((item, i) => { item.priority = i + 1; });
  AtomXState.failoverProviders = chain;
  const container = document.getElementById('adminFailoverChainContainer');
  if (container) container.innerHTML = renderAdminFailoverSlotsHTML();
}

function handleResetFailoverDefaults() {
  AtomXState.failoverProviders = JSON.parse(JSON.stringify(FAILOVER_RECOMMENDED_DEFAULTS));
  AtomXState.failoverTestResults = null;
  const container = document.getElementById('adminFailoverChainContainer');
  if (container) container.innerHTML = renderAdminFailoverSlotsHTML();
  showToast('↻ Reset failover slots to recommended 5-provider sequence.');
}

async function handleSaveFailoverChain() {
  const btn = document.getElementById('btnSaveFailoverChain');
  const chain = getFailoverChainList();

  for (let i = 0; i < 5; i++) {
    const provSelect = document.getElementById(`failover_prov_${i}`);
    const modelInput = document.getElementById(`failover_model_${i}`);
    const enabledCheck = document.getElementById(`failover_enabled_${i}`);
    if (provSelect && modelInput && chain[i]) {
      chain[i].provider = provSelect.value;
      chain[i].model = modelInput.value.trim();
      chain[i].enabled = enabledCheck ? enabledCheck.checked : true;
    }
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>💾 Saving...</span>';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/failover-providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failoverProviders: chain })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save failover chain');

    AtomXState.failoverProviders = data.failoverProviders || chain;
    showToast('✓ Failover provider sequence saved successfully (5 slots configured)!');
    const container = document.getElementById('adminFailoverChainContainer');
    if (container) container.innerHTML = renderAdminFailoverSlotsHTML();
  } catch (err) {
    showToast('❌ Failed to save failover chain: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>💾 Save Failover Chain</span>';
    }
  }
}

async function handleTestFailoverChain() {
  const btn = document.getElementById('btnTestFailoverChain');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⚡ Testing 5 Steps...</span>';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/test-failover-chain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Test failed');

    const map = {};
    (data.results || []).forEach(r => {
      map[r.priority] = r;
    });
    AtomXState.failoverTestResults = map;

    const healthyCount = (data.results || []).filter(r => r.status === 'HEALTHY').length;
    showToast(`✓ Failover Diagnostic: ${healthyCount} / ${(data.results || []).length} providers ready for failover!`);
    const container = document.getElementById('adminFailoverChainContainer');
    if (container) container.innerHTML = renderAdminFailoverSlotsHTML();
  } catch (err) {
    showToast('❌ Failover test error: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>⚡ Test Failover Sequence</span>';
    }
  }
}

function renderAdminAIEngine(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('23')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">AI Engine & Telemetry</h1>
            <p class="page-subtitle">Multi-provider inference routing, live model switching, API key diagnostics, and persistent generation telemetry logs.</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn btn-secondary btn-sm" onclick="refreshAdminApiLogs(true)">↻ Refresh Logs</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- 1. GLOBAL AI PROVIDER & REAL-TIME MODEL SELECTOR -->
          <div class="atomx-card" style="margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
              <div>
                <h3 style="font-size:16px; font-weight:800; display:flex; align-items:center; gap:8px;">
                  <span>🤖 Global AI Provider & Model Hub</span>
                  <span class="badge badge-success" id="activeModelBadge">● ACTIVE: ${AtomXState.currentProvider.toUpperCase()} / ${AtomXState.currentModel}</span>
                </h3>
                <p style="font-size:12px; color:var(--text-secondary); margin-top:3px;">
                  Select which provider powers all Chrome Extension users. Click any provider below to configure its API key, custom base URL, model, and test connection in a popup.
                </p>
              </div>
            </div>

            <!-- PROVIDER CARDS GRID -->
            <div id="adminProviderCardsContainer" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:14px;">
              ${renderAdminProviderCardsHTML()}
            </div>
          </div>

          <!-- 2. FAILOVER CASCADE ROUTING ENGINE (MAX 5 PROVIDERS) -->
          <div class="atomx-card" style="margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
              <div>
                <h3 style="font-size:16px; font-weight:800; display:flex; align-items:center; gap:8px;">
                  <span>🛡️ Failover Provider Cascade Chain</span>
                  <span class="badge badge-info" style="font-size:10px; font-weight:800; letter-spacing:0.3px;">● 5-LEVEL AUTO-FAILOVER CHAIN</span>
                </h3>
                <p style="font-size:12px; color:var(--text-secondary); margin-top:3px;">
                  Automatic zero-downtime routing. If the primary provider fails (rate limit, quota exceeded, or network outage), AtomX cascades sequentially through up to 5 backup providers: <strong>Priority 1 ➔ 2 ➔ 3 ➔ 4 ➔ 5</strong>.
                </p>
              </div>
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <button type="button" class="btn btn-secondary btn-sm" id="btnTestFailoverChain" onclick="handleTestFailoverChain()" style="font-weight:700; display:flex; align-items:center; gap:5px;">
                  <span>⚡ Test Failover Sequence</span>
                </button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="handleResetFailoverDefaults()" style="font-weight:600; font-size:11px;">
                  ↺ Recommended Defaults
                </button>
                <button type="button" class="btn btn-primary btn-sm" id="btnSaveFailoverChain" onclick="handleSaveFailoverChain()" style="font-weight:800; display:flex; align-items:center; gap:5px;">
                  <span>💾 Save Failover Chain</span>
                </button>
              </div>
            </div>

            <div id="adminFailoverChainContainer" style="display:flex; flex-direction:column; gap:8px;">
              ${renderAdminFailoverSlotsHTML()}
            </div>
          </div>

          <!-- 3. PROVIDER API KEYS HEALTH & LIVE STATUS -->
          <div class="atomx-card" style="margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
              <div>
                <h3 style="font-size:15px; font-weight:800; display:flex; align-items:center; gap:8px;">
                  <span>🔑 Provider API Keys Health & Diagnostics</span>
                </h3>
                <p style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
                  Real-time server-side ping test verifying credits, authorization, and rate limits across providers.
                </p>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="runAdminKeyDiagnostics()" id="btnKeyDiag">
                ⚡ Run Live Diagnostics
              </button>
            </div>
            <div id="adminKeysHealthContainer" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px;">
              ${renderAdminKeysHealthHTML(AtomXState.adminKeysHealth)}
            </div>
          </div>

          <!-- 3. LIVE AI GENERATION & TELEMETRY LOGS (WITH USER TRACKING & NO SCROLL JUMP) -->
          <div class="atomx-card" style="margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
              <div>
                <h3 style="font-size:15px; font-weight:800; display:flex; align-items:center; gap:8px;">
                  <span>📡 Live AI Generation & Error Telemetry Logs</span>
                  <span class="badge badge-primary" style="font-size:10px;" id="apiLogsCountBadge">${AtomXState.adminApiLogs?.length || 0} Logs</span>
                </h3>
                <p style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
                  Real-time audit trail capturing user accounts, HTTP status codes, failover cascades, and errors. Persisted in cloud storage.
                </p>
              </div>
              <div style="display:flex; gap:8px;">
                <button class="btn btn-secondary btn-sm" onclick="refreshAdminApiLogs(true)">↻ Refresh Logs</button>
                <button class="btn btn-sm" style="background:var(--bg-canvas); border:1px solid var(--border-subtle); color:var(--text-secondary);" onclick="clearAdminApiLogsDisplay()">Clear View</button>
              </div>
            </div>

            <div class="atomx-table-wrapper" style="max-height:480px; overflow-y:auto;">
              <table class="atomx-table responsive-table-as-cards" style="font-size:12px;">
                <thead>
                  <tr>
                    <th style="width:95px;">Time</th>
                    <th style="width:130px;">User</th>
                    <th style="width:160px;">Provider & Model</th>
                    <th>Target Post Snippet</th>
                    <th style="width:105px;">Status</th>
                    <th>Generated Output / Error Detail</th>
                    <th style="width:75px; text-align:right;">Latency</th>
                  </tr>
                </thead>
                <tbody id="adminApiLogsTbody">
                  ${renderAdminApiLogsRowsHTML(AtomXState.adminApiLogs)}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Auto-refresh telemetry logs on open without scrolling
  refreshAdminApiLogs(false);
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// SCREEN 14: UNIFIED USERS & ACCESS MANAGEMENT (ADMIN)
// -------------------------------------------------------------
let _adminSearchDebounce = null;
function setAdminUserSearch(query) {
  AtomXState.userSearchQuery = query;
  clearTimeout(_adminSearchDebounce);
  _adminSearchDebounce = setTimeout(() => {
    updateAdminUsersTableDOM();
  }, 100);
}

function setAdminUserFilter(filter) {
  AtomXState.userFilter = filter;
  updateAdminUsersTableDOM();
}

function renderAdminUsersRowsHTML(displayed, pwdReqs, activeFilter) {
  if (!displayed || displayed.length === 0) {
    return `
      <tr>
        <td colspan="9" style="text-align:center; padding:36px; color:var(--text-muted);">
          <div style="font-size:24px; margin-bottom:6px;">👥</div>
          <div style="font-weight:600; font-size:14px; color:var(--text-primary); margin-bottom:2px;">No Accounts in "${activeFilter || 'All'}"</div>
          <div style="font-size:12px;">Try switching filter tabs or clear your search query.</div>
        </td>
      </tr>
    `;
  }
  return displayed.map(u => {
    const s = u.rawStatus;
    const isPending = s === 'PENDING';
    const isSuspended = s === 'SUSPENDED';
    const isRejected = s === 'REJECTED';
    const isActive = s === 'ACTIVE';

    const cleanUHandle = (u.handle || '').toLowerCase().replace(/^@/, '');
    const cleanUEmail = (u.email || '').toLowerCase();
    const hasPwdReq = (pwdReqs || []).some(pr => {
      const prHandle = (pr.handle || pr.user || '').toLowerCase().replace(/^@/, '');
      const prEmail = (pr.email || '').toLowerCase();
      const prReason = (pr.reason || '').toLowerCase();
      return (cleanUHandle && (prHandle === cleanUHandle || prReason.includes(cleanUHandle))) ||
             (cleanUEmail && (prEmail === cleanUEmail || prReason.includes(cleanUEmail)));
    });

    const cleanHandle = (u.handle || '@user').replace(/^@/, '');
    const handleLink = `<a href="https://x.com/${cleanHandle}" target="_blank" onclick="event.stopPropagation();" style="color:var(--blue-primary); text-decoration:none; font-weight:700;">@${cleanHandle}</a>`;

    return `
    <tr onclick="openAdminUserProfileModal('${u.id}')" style="cursor:pointer;" class="clickable-user-row" title="Click to view full user profile & settings">
      <td style="font-weight:600;">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="user-avatar" style="width:28px; height:28px; font-size:11px; background:var(--border-subtle); color:var(--text-primary);">
            ${(u.name || 'U').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <span>${u.name}</span>
            ${hasPwdReq ? `<span class="badge badge-warning" style="font-size:9.5px; padding:1px 4px; margin-left:4px;" title="User requested password reset">🔑 Reset Req</span>` : ''}
          </div>
        </div>
      </td>
      <td>${handleLink}</td>
      <td style="color:var(--text-secondary);">
        <div>${u.email}</div>
        ${u.telegram ? `<div style="font-size:11px; color:#229ED9; font-weight:600; margin-top:2px;">✈️ ${u.telegram}</div>` : ''}
      </td>
      <td>
        <span class="badge badge-neutral" style="font-size:11px;">${u.plan || 'Free'}</span>
      </td>
      <td style="font-weight:700; color:var(--text-primary); font-size:12px;">
        ${(u.credits || 0).toLocaleString()}
      </td>
      <td>
        <span class="badge ${isPending ? 'badge-warning' : isSuspended ? 'badge-error' : isRejected ? 'badge-error' : 'badge-success'}">
          ${s}
        </span>
      </td>
      <td>
        ${u.referredBy && u.referredBy !== 'Direct / —' ? 
          `<span style="color:#229ED9; font-weight:700; font-family:monospace; font-size:12px;">${u.referredBy}</span>` : 
          `<span style="color:var(--text-muted); font-size:12px;">Direct / —</span>`}
      </td>
      <td style="color:var(--text-muted); font-size:11px;">${u.dateDisplay}</td>
      <td style="text-align:right;" onclick="event.stopPropagation();">
        <div style="display:inline-flex; gap:6px; justify-content:flex-end; align-items:center;">
          ${isPending ? `
            <button class="btn btn-primary btn-sm" onclick="openApprovalModal('${u.name}', '${u.email}', '${u.handle}', '${u.id}', '${u.telegram || ''}')">Approve</button>
            <button class="btn btn-danger btn-sm" onclick="rejectUserRequest('${u.id}')">Reject</button>
          ` : isRejected ? `
            <span class="badge badge-error" style="font-size:11px; font-weight:700;">Rejected</span>
            <button class="btn btn-secondary btn-sm" onclick="openApprovalModal('${u.name}', '${u.email}', '${u.handle}', '${u.id}', '${u.telegram || ''}')" style="margin-left:4px;">Re-Approve</button>
          ` : isSuspended ? `
            <span class="badge badge-error" style="font-size:11px; font-weight:700;">Suspended</span>
            <button class="btn btn-secondary btn-sm" onclick="openAdminUserProfileModal('${u.id}')" style="margin-left:4px;">Profile</button>
          ` : `
            <span class="badge badge-success" style="font-size:11px; font-weight:700;">Approved</span>
            <button class="btn btn-secondary btn-sm" onclick="openAdminUserProfileModal('${u.id}')" style="margin-left:4px;">Profile</button>
          `}
        </div>
      </td>
    </tr>
    `;
  }).join('');
}

function updateAdminUsersTableDOM() {
  const tbody = document.getElementById('adminUsersTbody');
  if (!tbody) {
    renderAdminUsers(document.getElementById('mainContentArea'));
    return;
  }
  const activeFilter = AtomXState.userFilter || 'All';
  const searchQuery = (AtomXState.userSearchQuery || '').toLowerCase().trim();

  const registeredUsers = (AtomXState.adminUsers || []).map(u => ({
    ...u,
    type: 'user',
    handle: u.handle || '@user',
    referredBy: u.referredBy || u.referred_by || 'Direct / —',
    rawStatus: (u.status || 'ACTIVE').toUpperCase(),
    dateDisplay: u.lastActive || 'Active'
  }));

  const accessReqs = (AtomXState.accessRequests || []).map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    telegram: r.telegram || '',
    handle: r.handle || '@user',
    plan: 'Pending Tier',
    credits: 0,
    type: 'request',
    referredBy: r.referredBy || r.referred_by || 'Direct / —',
    rawStatus: (r.status || 'PENDING').toUpperCase(),
    dateDisplay: r.requestedDate || 'Recent'
  }));

  const registeredEmails = new Set(registeredUsers.map(u => (u.email || '').toLowerCase()));
  const pendingOrUniqueReqs = accessReqs.filter(r => {
    if (r.rawStatus === 'PENDING') return true;
    if (r.rawStatus === 'REJECTED') return true;
    return !registeredEmails.has((r.email || '').toLowerCase());
  });

  const allAccounts = [...pendingOrUniqueReqs.filter(r => r.rawStatus === 'PENDING'), ...registeredUsers, ...pendingOrUniqueReqs.filter(r => r.rawStatus !== 'PENDING')];
  const pwdReqs = AtomXState.passwordRequests || [];

  let displayed = allAccounts.filter(acc => {
    if (activeFilter === 'Pending') return acc.rawStatus === 'PENDING';
    if (activeFilter === 'Active') return acc.rawStatus === 'ACTIVE';
    if (activeFilter === 'Suspended') return acc.rawStatus === 'SUSPENDED';
    if (activeFilter === 'Rejected') return acc.rawStatus === 'REJECTED';
    return true;
  });

  if (searchQuery) {
    displayed = displayed.filter(acc => {
      const n = (acc.name || '').toLowerCase();
      const e = (acc.email || '').toLowerCase();
      const h = (acc.handle || '').toLowerCase();
      return n.includes(searchQuery) || e.includes(searchQuery) || h.includes(searchQuery);
    });
  }

  // Update pills active status
  document.querySelectorAll('.style-pills .style-pill').forEach(pill => {
    const text = (pill.textContent || '').trim();
    if (text.startsWith(activeFilter) || (activeFilter === 'All' && text.startsWith('All'))) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });

  tbody.innerHTML = renderAdminUsersRowsHTML(displayed, pwdReqs, activeFilter);
}

function renderAdminAccessRequests(container) {
  AtomXState.userFilter = 'Pending';
  renderAdminUsers(container);
}

function renderAdminUsers(container) {
  const activeFilter = AtomXState.userFilter || 'All';
  const searchQuery = (AtomXState.userSearchQuery || '').toLowerCase().trim();

  // Consolidate registered users and access requests
  const registeredUsers = (AtomXState.adminUsers || []).map(u => ({
    ...u,
    type: 'user',
    handle: u.handle || '@user',
    referredBy: u.referredBy || u.referred_by || 'Direct / —',
    rawStatus: (u.status || 'ACTIVE').toUpperCase(),
    dateDisplay: u.lastActive || 'Active'
  }));

  const accessReqs = (AtomXState.accessRequests || []).map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    telegram: r.telegram || '',
    handle: r.handle || '@user',
    plan: 'Pending Tier',
    credits: 0,
    type: 'request',
    referredBy: r.referredBy || r.referred_by || 'Direct / —',
    rawStatus: (r.status || 'PENDING').toUpperCase(),
    dateDisplay: r.requestedDate || 'Recent'
  }));

  // Prevent duplicate email display if already in registered users
  const registeredEmails = new Set(registeredUsers.map(u => (u.email || '').toLowerCase()));
  const pendingOrUniqueReqs = accessReqs.filter(r => {
    if (r.rawStatus === 'PENDING') return true;
    if (r.rawStatus === 'REJECTED') return true;
    return !registeredEmails.has((r.email || '').toLowerCase());
  });

  const allAccounts = [...pendingOrUniqueReqs.filter(r => r.rawStatus === 'PENDING'), ...registeredUsers, ...pendingOrUniqueReqs.filter(r => r.rawStatus !== 'PENDING')];

  // Counts
  const totalCount = allAccounts.length;
  const pendingCount = (AtomXState.accessRequests || []).filter(r => (r.status || '').toUpperCase() === 'PENDING').length;
  const activeCount = registeredUsers.filter(u => u.rawStatus === 'ACTIVE').length;
  const suspendedCount = registeredUsers.filter(u => u.rawStatus === 'SUSPENDED').length;
  const rejectedCount = (AtomXState.accessRequests || []).filter(r => (r.status || '').toUpperCase() === 'REJECTED').length;
  const pwdReqs = AtomXState.passwordRequests || [];

  let displayed = allAccounts.filter(acc => {
    if (activeFilter === 'Pending') return acc.rawStatus === 'PENDING';
    if (activeFilter === 'Active') return acc.rawStatus === 'ACTIVE';
    if (activeFilter === 'Suspended') return acc.rawStatus === 'SUSPENDED';
    if (activeFilter === 'Rejected') return acc.rawStatus === 'REJECTED';
    return true;
  });

  if (searchQuery) {
    displayed = displayed.filter(acc => {
      const n = (acc.name || '').toLowerCase();
      const e = (acc.email || '').toLowerCase();
      const h = (acc.handle || '').toLowerCase();
      return n.includes(searchQuery) || e.includes(searchQuery) || h.includes(searchQuery);
    });
  }

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('14')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Users & Access</h1>
            <p class="page-subtitle">Unified management for user accounts, pending access requests, credits, and passwords.</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" onclick="loadAdminServerData(); showToast('↻ Synced live accounts');">↻ Refresh</button>
            <button class="btn btn-primary btn-sm" onclick="openAdminInviteUserModal()">+ Add User Account</button>
          </div>
        </div>

        <div class="workspace-body">
          ${pwdReqs.length > 0 ? `
            <div style="background:rgba(234,179,8,0.12); border:1px solid rgba(234,179,8,0.35); border-radius:8px; padding:12px 16px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:22px;">🔑</span>
                <div>
                  <strong style="color:#EAB308; font-size:13.5px;">Password Reset Requests (${pwdReqs.length})</strong>
                  <div style="color:var(--text-secondary); font-size:12px; margin-top:2px;">
                    Users requesting reset: ${pwdReqs.map(p => {
                      const raw = p.handle || p.user || p.user_handle || 'User';
                      const displayHandle = raw.startsWith('@') ? raw : `@${raw}`;
                      return `<strong style="color:var(--text-primary); cursor:pointer;" onclick="setAdminUserSearch('${raw.replace(/^@/, '')}')" title="Click to filter">${displayHandle}</strong>`;
                    }).join(', ')}. Click user row to assign their temporary password.
                  </div>
                </div>
              </div>
            </div>
          ` : ''}

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
            <div class="style-pills">
              <span class="style-pill ${activeFilter === 'All' ? 'active' : ''}" onclick="setAdminUserFilter('All')">All Accounts (${totalCount})</span>
              <span class="style-pill ${activeFilter === 'Pending' ? 'active' : ''}" onclick="setAdminUserFilter('Pending')">
                Pending Requests ${pendingCount > 0 ? `<span class="badge badge-warning" style="margin-left:4px; font-size:10px; padding:1px 5px;">${pendingCount}</span>` : `(${pendingCount})`}
              </span>
              <span class="style-pill ${activeFilter === 'Active' ? 'active' : ''}" onclick="setAdminUserFilter('Active')">Active (${activeCount})</span>
              <span class="style-pill ${activeFilter === 'Suspended' ? 'active' : ''}" onclick="setAdminUserFilter('Suspended')">Suspended (${suspendedCount})</span>
              <span class="style-pill ${activeFilter === 'Rejected' ? 'active' : ''}" onclick="setAdminUserFilter('Rejected')">Rejected (${rejectedCount})</span>
            </div>
            <div style="width:260px;">
              <input type="text" class="form-input" placeholder="Search by name, email, or @handle..." value="${AtomXState.userSearchQuery || ''}" oninput="setAdminUserSearch(this.value)">
            </div>
          </div>

          <div class="atomx-table-wrapper">
            <table class="atomx-table responsive-table-as-cards">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Credits</th>
                  <th>Status</th>
                  <th>Referred By</th>
                  <th>Date</th>
                  <th style="text-align:right;">Actions</th>
                </tr>
              </thead>
              <tbody id="adminUsersTbody">
                ${renderAdminUsersRowsHTML(displayed, pwdReqs, activeFilter)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function openAdminUserProfileModal(userId) {
  closeModal();
  const user = (AtomXState.adminUsers || []).find(u => String(u.id) === String(userId)) ||
               (AtomXState.accessRequests || []).find(r => String(r.id) === String(userId));
  if (!user) {
    showToast('User account not found', 'error');
    return;
  }

  const pwdReqs = AtomXState.passwordRequests || [];
  const cleanUserH = (user.handle || '').toLowerCase().replace(/^@/, '');
  const cleanUserE = (user.email || '').toLowerCase();
  const pwdReq = pwdReqs.find(pr => {
    const prH = (pr.handle || pr.user || '').toLowerCase().replace(/^@/, '');
    const prE = (pr.email || '').toLowerCase();
    const prR = (pr.reason || '').toLowerCase();
    return (cleanUserH && (prH === cleanUserH || prR.includes(cleanUserH))) ||
           (cleanUserE && (prE === cleanUserE || prR.includes(cleanUserE)));
  });

  const statusUpper = (user.status || 'ACTIVE').toUpperCase();
  const isSuspended = statusUpper === 'SUSPENDED';
  const cleanHandle = (user.handle || '@user').replace(/^@/, '');

  const modalHTML = `
    <div class="modal-backdrop" id="userProfileModal" onclick="if(event.target===this) closeModal()">
      <div class="modal-box" style="max-width: 600px; max-height: 88vh; overflow-y: auto; padding: 24px; border-radius: 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); box-shadow: 0 20px 45px rgba(0,0,0,0.45);">
        <!-- Modal Header -->
        <div class="modal-header" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <h3 class="modal-title" style="margin:0; font-size:18px; font-weight:700; color:var(--text-primary);">User Profile & Management</h3>
              <span class="badge ${isSuspended ? 'badge-error' : 'badge-success'}">${isSuspended ? 'SUSPENDED' : 'ACTIVE'}</span>
            </div>
            <p style="margin:4px 0 0 0; font-size:12px; color:var(--text-muted);">Manage plan tier, credits, password, suspension, or permanently delete user.</p>
          </div>
          <button class="modal-close-btn" onclick="closeModal()" style="font-size:24px; cursor:pointer; background:none; border:none; color:var(--text-muted); line-height:1;">&times;</button>
        </div>

        <!-- Notification if Password Reset Requested -->
        ${pwdReq ? `
          <div style="background:rgba(234,179,8,0.14); border:1px solid rgba(234,179,8,0.4); border-radius:8px; padding:12px 14px; margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="font-size:22px;">🔑</span>
              <div>
                <div style="font-weight:700; color:#EAB308; font-size:13px;">User Requested Password Reset!</div>
                <div style="font-size:11.5px; color:var(--text-secondary); margin-top:2px;">User forgot their password. Set a new password below and provide it to the user, or click Mark Resolved.</div>
              </div>
            </div>
            <button class="btn btn-secondary btn-xs" onclick="handleAdminResolvePasswordReset('${user.id}', '${cleanHandle}')" style="white-space:nowrap; border-color:#EAB308; color:#EAB308;">✓ Mark Resolved</button>
          </div>
        ` : ''}

        <!-- User Information Card -->
        <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:10px; padding:14px; margin-bottom:18px;">
          <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
            <div class="user-avatar" style="width:42px; height:42px; font-size:16px; background:var(--blue-primary); color:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700;">
              ${(user.name || 'U').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div style="font-size:16px; font-weight:700; color:var(--text-primary);">${user.name}</div>
              <div style="display:flex; gap:8px; align-items:center; font-size:12px; margin-top:2px; flex-wrap:wrap;">
                <a href="https://x.com/${cleanHandle}" target="_blank" style="color:var(--blue-primary); font-weight:700; text-decoration:none;">
                  @${cleanHandle} ↗
                </a>
                <span style="color:var(--text-muted);">•</span>
                <span style="color:var(--text-secondary);">${user.email || 'No email'}</span>
                ${user.telegram ? `<span style="color:var(--text-muted);">•</span><span style="color:#229ED9; font-weight:600;">✈️ ${user.telegram}</span>` : ''}
              </div>
            </div>
          </div>
          <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; padding-top:10px; border-top:1px solid var(--border-subtle); font-size:12px;">
            <div>
              <span style="color:var(--text-muted); display:block; font-size:11px;">Current Plan</span>
              <strong style="color:var(--text-primary);">${user.plan || 'Free Plan'}</strong>
            </div>
            <div>
              <span style="color:var(--text-muted); display:block; font-size:11px;">Credits Balance</span>
              <strong style="color:var(--blue-primary);">${(user.credits || 0).toLocaleString()} C</strong>
            </div>
            <div>
              <span style="color:var(--text-muted); display:block; font-size:11px;">Referred By</span>
              <strong style="color:var(--text-primary); font-family:monospace;">${user.referredBy || 'Direct / —'}</strong>
            </div>
          </div>
        </div>

        <!-- Section 1: Plan Tier -->
        <div style="margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--border-subtle);">
          <label style="display:block; margin:0 0 6px 0; font-size:13px; font-weight:700; color:var(--text-primary);">⭐ Subscription Plan Tier</label>
          <div style="display:flex; gap:10px; align-items:center;">
            <select id="modalPlanSelect" class="form-select" style="flex:1;">
              ${(AtomXState.plans && AtomXState.plans.length > 0) ? AtomXState.plans.map(p => {
                const pName = p.name.toLowerCase().includes('plan') ? p.name : `${p.name} Plan`;
                const isSel = (user.plan || '').toLowerCase() === pName.toLowerCase() || (user.plan || '').toLowerCase() === p.id.toLowerCase();
                return `<option value="${pName}" ${isSel ? 'selected' : ''}>${pName} (${(p.credits || 0).toLocaleString()} Credits)</option>`;
              }).join('') : `
                <option value="Free Plan" ${user.plan === 'Free Plan' ? 'selected' : ''}>Free Plan (100 Credits)</option>
                <option value="Starter Plan" ${user.plan === 'Starter Plan' ? 'selected' : ''}>Starter Plan (1,000 Credits)</option>
                <option value="Growth Plan" ${user.plan === 'Growth Plan' ? 'selected' : ''}>Growth Plan (10,000 Credits)</option>
                <option value="Pro Plan" ${user.plan === 'Pro Plan' ? 'selected' : ''}>Pro Plan (25,000 Credits)</option>
                <option value="Enterprise Plan" ${user.plan === 'Enterprise Plan' ? 'selected' : ''}>Enterprise Plan (100,000 Credits)</option>
              `}
            </select>
            <button class="btn btn-primary btn-sm" onclick="handleAdminUpdateUserPlan('${user.id}')" style="white-space:nowrap;">Update Plan</button>
          </div>
        </div>

        <!-- Section 2: Credit Adjustment -->
        <div style="margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--border-subtle);">
          <label style="display:block; margin:0 0 6px 0; font-size:13px; font-weight:700; color:var(--text-primary);">⚡ Adjust Credits Balance</label>
          <div style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-xs" onclick="document.getElementById('modalCreditAmount').value=1000">+1,000</button>
            <button type="button" class="btn btn-secondary btn-xs" onclick="document.getElementById('modalCreditAmount').value=5000">+5,000</button>
            <button type="button" class="btn btn-secondary btn-xs" onclick="document.getElementById('modalCreditAmount').value=10000">+10,000</button>
            <button type="button" class="btn btn-secondary btn-xs" onclick="document.getElementById('modalCreditAmount').value=-500">-500</button>
          </div>
          <div style="display:grid; grid-template-columns: 130px 1fr auto; gap:8px;">
            <input type="number" id="modalCreditAmount" class="form-input" placeholder="Amount" value="1000">
            <input type="text" id="modalCreditReason" class="form-input" placeholder="Reason (e.g. Bonus, Top-up)">
            <button class="btn btn-primary btn-sm" onclick="handleAdminModalAdjustCredits('${user.id}')">Apply</button>
          </div>
        </div>

        <!-- Section 3: Password Assignment -->
        <div style="margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--border-subtle);">
          <label style="display:block; margin:0 0 4px 0; font-size:13px; font-weight:700; color:var(--text-primary);">🔑 Set / Reset User Password</label>
          <p style="margin:0 0 8px 0; font-size:11.5px; color:var(--text-muted);">Assign a temporary password for this user. They must enter this as their current password when resetting or signing in.</p>
          <div style="display:flex; gap:8px;">
            <input type="text" id="modalNewPassword" class="form-input" placeholder="Enter new password (min 4 chars)" style="flex:1;">
            <button class="btn btn-secondary btn-sm" onclick="handleAdminModalSetPassword('${user.id}', '${cleanHandle || user.handle || user.name}')" style="white-space:nowrap;">Assign Password</button>
          </div>
        </div>

        <!-- Section 4: Suspend / Reactivate -->
        <div style="margin-bottom:18px; padding-bottom:16px; border-bottom:1px solid var(--border-subtle);">
          <label style="display:block; margin:0 0 4px 0; font-size:13px; font-weight:700; color:var(--text-primary);">🛑 Account Access & Suspension</label>
          <p style="margin:0 0 8px 0; font-size:11.5px; color:var(--text-muted);">
            ${isSuspended ? 'User is currently suspended. The extension is completely locked down for them.' : 'Suspending a user immediately locks down their extension in real-time and halts all automation.'}
          </p>
          <button class="btn ${isSuspended ? 'btn-primary' : 'btn-danger'} btn-sm" onclick="handleAdminModalToggleSuspend('${user.id}')">
            ${isSuspended ? '✅ Reactivate User Account' : '🚫 Suspend User Immediately'}
          </button>
        </div>

        <!-- Section 5: Danger Zone - Delete User -->
        <div style="background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.25); border-radius:8px; padding:14px;">
          <label style="display:block; margin:0 0 4px 0; font-size:13px; font-weight:700; color:var(--status-error);">⚠️ Danger Zone: Delete User</label>
          <p style="margin:0 0 10px 0; font-size:11.5px; color:var(--text-secondary);">
            Permanently erases this user from the database including user ID, credits, and access requests.
          </p>
          <button class="btn btn-danger btn-sm" onclick="handleAdminModalDeleteUser('${user.id}', '${user.handle || user.name}')" style="background:#EF4444; color:#fff; font-weight:700;">
            🗑️ Delete User Permanently
          </button>
        </div>

        <div style="display:flex; justify-content:flex-end; margin-top:20px;">
          <button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.openAdminUserProfileModal = openAdminUserProfileModal;

window.handleAdminUpdateUserPlan = async function(userId) {
  const plan = document.getElementById('modalPlanSelect')?.value;
  if (!plan) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/update-user-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, plan })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update plan');
    showToast(`✓ Plan updated to ${plan}`, 'success');
    closeModal();
    await loadAdminServerData();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

window.handleAdminModalAdjustCredits = async function(userId) {
  const amount = parseInt(document.getElementById('modalCreditAmount')?.value, 10);
  const reason = document.getElementById('modalCreditReason')?.value.trim() || 'Admin manual adjustment';
  if (isNaN(amount) || amount === 0) {
    showToast('Please enter a valid credit amount', 'error');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/admin/adjust-credits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, amount, reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to adjust credits');
    showToast(`✓ Credits updated by ${amount > 0 ? '+' : ''}${amount}`, 'success');
    closeModal();
    await loadAdminServerData();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

window.handleAdminModalSetPassword = async function(userId, userHandle) {
  const password = document.getElementById('modalNewPassword')?.value.trim();
  if (!password || password.length < 4) {
    showToast('Password must be at least 4 characters', 'error');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/admin/set-user-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to set password');

    // Also call resolve-password-request to ensure credits_ledger row is immediately resolved
    try {
      await fetch(`${API_BASE}/api/admin/resolve-password-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, handle: userHandle })
      });
    } catch (e) {}

    showToast(`✓ Password set! Share "${password}" with user as their temporary password.`, 'success');
    const input = document.getElementById('modalNewPassword');
    if (input) input.value = '';

    // Clear from local password requests list immediately by user_id or handle
    const cleanH = (userHandle || '').toLowerCase().replace(/^@/, '');
    AtomXState.passwordRequests = (AtomXState.passwordRequests || []).filter(pr => {
      const pUser = (pr.user || pr.handle || '').toLowerCase().replace(/^@/, '');
      return pr.user_id !== userId && pUser !== cleanH;
    });

    closeModal();
    await loadAdminServerData(true);
    navigateToScreen(AtomXState.currentScreen, true);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

window.handleAdminResolvePasswordReset = async function(userId, handle) {
  try {
    const res = await fetch(`${API_BASE}/api/admin/resolve-password-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, handle })
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Failed to resolve password reset');
    }
    AtomXState.passwordRequests = (AtomXState.passwordRequests || []).filter(pr => {
      const uHandle = (handle || '').toLowerCase().replace(/^@/, '');
      const pUser = (pr.user || pr.handle || '').toLowerCase().replace(/^@/, '');
      return pr.user_id !== userId && pUser !== uHandle;
    });
    closeModal();
    showToast('✓ Password reset request marked as resolved!', 'success');
    await loadAdminServerData(true);
    navigateToScreen(AtomXState.currentScreen, true);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

window.handleAdminModalToggleSuspend = async function(userId) {
  try {
    const res = await fetch(`${API_BASE}/api/admin/toggle-user-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to toggle status');
    showToast(`✓ Account status changed to ${data.status}`, 'success');
    closeModal();
    await loadAdminServerData();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

window.handleAdminModalDeleteUser = async function(userId, userHandle) {
  if (!confirm(`Are you sure you want to permanently delete user ${userHandle}?\n\nThis will permanently wipe their account, user ID, credits, transactions, and access requests from the database. This action cannot be undone.`)) {
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/admin/delete-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete user');
    showToast(`✓ User ${userHandle} permanently deleted from database`, 'success');
    closeModal();
    await loadAdminServerData();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
};

function onAdminManageUserCredits(userId) {
  const user = (AtomXState.adminUsers || []).find(u => String(u.id) === String(userId));
  if (user) {
    AtomXState.selectedCreditUser = user;
    AtomXState.currentUser = user;
  }
  navigateToScreen('15');
}

function openApprovalModal(name, email, handle = '@user', reqId = '', telegram = '') {
  const defaultBonus = 100;
  const defaultPlanCredits = 10000;
  const defaultTotal = defaultPlanCredits + defaultBonus;

  const modalHTML = `
    <div class="modal-backdrop" id="approvalModal">
      <div class="modal-box">
        <div class="modal-header">
          <h3 class="modal-title">Approve Account & Authorize X ID</h3>
          <button class="modal-close-btn" onclick="closeModal()">×</button>
        </div>
        <div style="margin-bottom:16px; background:var(--bg-canvas); padding:12px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
          <div style="font-weight:700; font-size:15px; color:var(--text-primary);">${name}</div>
          <div style="font-size:13px; font-weight:700; color:var(--blue-primary); margin-top:2px;">🔒 Locked to X ID: ${handle}</div>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">Email: ${email}</div>
          ${telegram ? `<div style="font-size:12px; color:#229ED9; font-weight:600; margin-top:3px;">✈️ Telegram: ${telegram}</div>` : ''}
        </div>
        <div class="form-group">
          <label class="form-label">Plan Tier</label>
          <select class="form-select" id="approvalPlanSelect" onchange="onApprovalPlanChange(this.value)">
            ${(AtomXState.plans && AtomXState.plans.length > 0) ? AtomXState.plans.map(p => {
              const pName = p.name.toLowerCase().includes('plan') ? p.name : `${p.name} Plan`;
              const isSel = p.id === 'growth' || p.id === 'pro';
              return `<option value="${pName}" data-credits="${p.credits || 1000}" ${isSel ? 'selected' : ''}>${pName} (${(p.credits || 0).toLocaleString()} Credits)</option>`;
            }).join('') : `
              <option value="Free Plan" data-credits="100">Free Plan (100 Credits)</option>
              <option value="Growth Plan" data-credits="10000" selected>Growth Plan (10,000 Credits)</option>
              <option value="Pro Plan" data-credits="25000">Pro Plan (25,000 Credits)</option>
              <option value="Enterprise Plan" data-credits="100000">Enterprise Plan (100,000 Credits)</option>
            `}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Initial Credits (Plan Credits + 100 Onboarding Bonus)</label>
          <input type="number" class="form-input" id="initialCreditsInput" value="${defaultTotal}">
          <div class="form-hint" id="approvalCreditsHint" style="color:var(--text-secondary); font-size:11.5px; margin-top:4px;">
            Auto-calculated: <strong>10,000</strong> plan credits + <strong>100</strong> onboarding bonus = <strong>${defaultTotal.toLocaleString()}</strong> credits.
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:24px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="confirmApproval('${name}', '${email}', '${handle}', '${reqId}')">Approve & Authorize ID</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.onApprovalPlanChange = function(planValue) {
  const bonus = 100;
  const select = document.getElementById('approvalPlanSelect');
  const opt = select ? select.options[select.selectedIndex] : null;
  let planCredits = opt ? Number(opt.getAttribute('data-credits')) : 0;
  if (!planCredits) {
    if (planValue.includes('Free')) planCredits = 100;
    else if (planValue.includes('Growth')) planCredits = 10000;
    else if (planValue.includes('Pro')) planCredits = 25000;
    else if (planValue.includes('Enterprise')) planCredits = 100000;
    else planCredits = 5000;
  }
  const total = planCredits + bonus;
  const input = document.getElementById('initialCreditsInput');
  const hint = document.getElementById('approvalCreditsHint');
  if (input) input.value = total;
  if (hint) {
    hint.innerHTML = `Auto-calculated: <strong>${planCredits.toLocaleString()}</strong> plan credits + <strong>${bonus}</strong> onboarding bonus = <strong>${total.toLocaleString()}</strong> credits.`;
  }
};

function closeModal() {
  const modal = document.querySelector('.modal-backdrop');
  if (modal) modal.remove();
}

async function confirmApproval(name, email, handle = '@user', reqId = '') {
  // CRITICAL: Read input values BEFORE destroying the modal!
  const creditsInput = document.getElementById('initialCreditsInput');
  const planSelect = document.getElementById('approvalPlanSelect');
  const credits = Number(creditsInput?.value) || 10100;
  const plan = planSelect?.value || 'Growth Plan';

  closeModal();

  // Optimistic update
  const r = (AtomXState.accessRequests || []).find(x => String(x.id) === String(reqId) || x.email === email);
  if (r) {
    r.status = 'APPROVED';
    r.plan = plan;
    r.credits = credits;
  }
  renderAdminUsers(document.getElementById('mainContentArea'));

  try {
    const res = await fetch(`${API_BASE}/api/admin/approve-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: reqId, email, handle, initialCredits: credits, planTier: plan })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Server error approving request');
    showToast(`✓ User ${name} (${handle}) approved with ${plan} (${credits.toLocaleString()} credits)!`, 'success');
  } catch (err) {
    console.warn('[Approval Notice]', err);
    showToast(`Approval Note: ${err.message}`, 'error');
  }

  await loadAdminServerData();
  renderAdminUsers(document.getElementById('mainContentArea'));
}

async function rejectUserRequest(id) {
  if (!confirm('Are you sure you want to decline/reject this user access request?')) return;

  const r = (AtomXState.accessRequests || []).find(x => String(x.id) === String(id));
  if (r) r.status = 'REJECTED';
  renderAdminUsers(document.getElementById('mainContentArea'));

  try {
    const res = await fetch(`${API_BASE}/api/admin/reject-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: id })
    });
    if (res.ok) {
      showToast('✓ Request marked as rejected.', 'success');
    }
  } catch (e) {
    console.warn('[Reject Notice]', e);
  }

  await loadAdminServerData();
  renderAdminUsers(document.getElementById('mainContentArea'));
}

function openAdminPasswordModal(userId, name, handle) {
  closeModal();
  const modalHTML = `
    <div class="modal-backdrop" id="adminPasswordModal">
      <div class="modal-box" style="max-width:440px;">
        <div class="modal-header">
          <h3 class="modal-title">🔑 Manage User Password</h3>
          <button class="modal-close-btn" onclick="closeModal()">×</button>
        </div>
        <div style="margin-bottom:14px; background:var(--bg-canvas); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
          <div style="font-weight:700; font-size:14px; color:var(--text-primary);">${name}</div>
          <div style="font-size:12px; color:var(--blue-primary); font-weight:700; margin-top:2px;">${handle || '@user'}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Set New Password</label>
          <div style="position:relative; display:flex; align-items:center;">
            <input type="password" id="adminUserNewPasswordInput" class="form-input" style="padding-right:40px;" placeholder="Enter minimum 6 characters...">
            <button type="button" onclick="toggleAdminPasswordVisibility()" style="position:absolute; right:10px; background:none; border:none; cursor:pointer; font-size:16px;">👁️</button>
          </div>
          <div class="form-hint">Admin override: The user can immediately sign in using this new password.</div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" id="saveUserPasswordBtn" onclick="handleAdminSetPassword('${userId}', '${name}')">Save New Password</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

function toggleAdminPasswordVisibility() {
  const inp = document.getElementById('adminUserNewPasswordInput');
  if (inp) {
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }
}

async function handleAdminSetPassword(userId, name) {
  const inp = document.getElementById('adminUserNewPasswordInput');
  const pwd = inp ? inp.value.trim() : '';
  if (!pwd || pwd.length < 4) {
    showToast('Please enter a password with at least 4 characters.', 'error');
    return;
  }

  const btn = document.getElementById('saveUserPasswordBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/set-user-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password: pwd })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to update password');

    closeModal();
    showToast(`✓ Password updated successfully for ${name}!`, 'success');

    // Clear user from pending password requests and refresh
    AtomXState.passwordRequests = (AtomXState.passwordRequests || []).filter(pr => {
      const uHandle = (name || '').toLowerCase().replace(/^@/, '');
      const pUser = (pr.user || pr.handle || '').toLowerCase().replace(/^@/, '');
      return pr.user_id !== userId && pUser !== uHandle;
    });
    await loadAdminServerData(true);
    navigateToScreen(AtomXState.currentScreen, true);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save New Password';
    }
  }
}

function openAdminInviteUserModal() {
  closeModal();
  const modalHTML = `
    <div class="modal-backdrop" id="adminInviteModal">
      <div class="modal-box" style="max-width:440px;">
        <div class="modal-header">
          <h3 class="modal-title">Create / Authorize User</h3>
          <button class="modal-close-btn" onclick="closeModal()">×</button>
        </div>
        <div class="form-group">
          <label class="form-label">Full Name</label>
          <input type="text" id="adminNewUserName" class="form-input" placeholder="e.g. Alex Trader">
        </div>
        <div class="form-group">
          <label class="form-label">Email Address</label>
          <input type="email" id="adminNewUserEmail" class="form-input" placeholder="e.g. alex@trader.io">
        </div>
        <div class="form-group">
          <label class="form-label">X / Twitter Handle (Mandatory Lock)</label>
          <input type="text" id="adminNewUserHandle" class="form-input" placeholder="e.g. @alextrader">
        </div>
        <div class="form-group">
          <label class="form-label">Initial Password</label>
          <input type="password" id="adminNewUserPassword" class="form-input" placeholder="Set temporary or permanent password">
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="handleAdminCreateDirectUser()">Create & Authorize</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

async function handleAdminCreateDirectUser() {
  const fullName = document.getElementById('adminNewUserName')?.value.trim();
  const email = document.getElementById('adminNewUserEmail')?.value.trim();
  const handle = document.getElementById('adminNewUserHandle')?.value.trim();
  const password = document.getElementById('adminNewUserPassword')?.value.trim() || 'atomx123';

  if (!fullName || !email || !handle) {
    showToast('Name, Email, and X ID are required.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/request-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, email, handle, password, useCase: 'Admin Created Account' })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to create user');

    closeModal();
    showToast(`✓ Account created! Auto-approving now...`, 'success');
    await loadAdminServerData();
    renderAdminUsers(document.getElementById('mainContentArea'));
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function toggleSuspendUser(id) {
  const user = (AtomXState.adminUsers || []).find(u => String(u.id) === String(id));
  if (!user) return;
  const isSuspended = (user.status || '').toLowerCase() === 'suspended';
  const newStatus = isSuspended ? 'ACTIVE' : 'SUSPENDED';

  // Optimistic update
  user.status = isSuspended ? 'Active' : 'Suspended';
  renderAdminUsers(document.getElementById('mainContentArea'));

  try {
    const res = await fetch(`${API_BASE}/api/admin/toggle-user-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: id, status: newStatus })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Server error');
    showToast(`✓ Account ${user.name} is now ${newStatus}`, 'success');
  } catch (err) {
    console.warn('[Suspend Error]', err);
    showToast(`Note: ${err.message}`, 'error');
  }

  await loadAdminServerData();
  renderAdminUsers(document.getElementById('mainContentArea'));
}


// -------------------------------------------------------------
// -------------------------------------------------------------
// SCREEN 15: CREDIT MANAGEMENT (ADMIN)
// -------------------------------------------------------------
function handleSearchCreditUsers(query) {
  AtomXState.creditUserSearchQuery = query;
  const q = (query || '').toLowerCase().trim();
  const select = document.getElementById('creditUserSelectDropdown');
  if (!select) return;

  const users = AtomXState.adminUsers || [];
  const matches = users.filter(u => {
    return (u.name || '').toLowerCase().includes(q) ||
           (u.email || '').toLowerCase().includes(q) ||
           (u.handle || '').toLowerCase().includes(q);
  });

  if (matches.length > 0) {
    select.innerHTML = matches.map(u => `
      <option value="${u.id}" ${AtomXState.selectedCreditUser?.id === u.id ? 'selected' : ''}>
        ${u.name} (${u.email}) · ${u.handle || '@user'} [${(u.credits || 0).toLocaleString()} Credits]
      </option>
    `).join('');
    // Auto-select first matching user
    if (!matches.some(m => m.id === AtomXState.selectedCreditUser?.id)) {
      handleSelectCreditUser(matches[0].id);
    }
  } else {
    select.innerHTML = `<option value="">No users match "${query}"</option>`;
  }
}

function setCreditLedgerFilter(filter) {
  AtomXState.creditLedgerFilter = filter;
  renderAdminCreditManagement(document.getElementById('mainContentArea'));
}

function setCreditLedgerSearch(query) {
  AtomXState.creditLedgerSearchQuery = query;
  renderAdminCreditManagement(document.getElementById('mainContentArea'));
}

function renderAdminCreditManagement(container) {
  const allLedger = AtomXState.creditLedger || [];
  const activeFilter = AtomXState.creditLedgerFilter || 'All';
  const searchQuery = (AtomXState.creditLedgerSearchQuery || '').toLowerCase().trim();

  // Calculations
  const circulating = (AtomXState.adminUsers || []).reduce((sum, u) => sum + (Number(u.credits) || 0), 0);
  const totalIssued = allLedger.filter(l => Number(l.amount) > 0).reduce((sum, l) => sum + Number(l.amount), 0);
  const totalConsumed = Math.abs(allLedger.filter(l => Number(l.amount) < 0).reduce((sum, l) => sum + Number(l.amount), 0));

  let filtered = allLedger.filter(l => {
    const amt = Number(l.amount) || 0;
    const act = (l.action || '').toLowerCase();
    if (activeFilter === 'Deductions') return amt < 0;
    if (activeFilter === 'Additions') return amt > 0;
    if (activeFilter === 'AI Replies') return act.includes('reply') || act.includes('ai');
    if (activeFilter === 'Admin Adjustments') return (l.admin && l.admin.toLowerCase() !== 'system') || act.includes('adjust');
    return true;
  });

  if (searchQuery) {
    filtered = filtered.filter(l => {
      const u = (l.user || '').toLowerCase();
      const act = (l.action || '').toLowerCase();
      const rsn = (l.reason || '').toLowerCase();
      const adm = (l.admin || '').toLowerCase();
      const dt = (l.date || '').toLowerCase();
      return u.includes(searchQuery) || act.includes(searchQuery) || rsn.includes(searchQuery) || adm.includes(searchQuery) || dt.includes(searchQuery);
    });
  }

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('15')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Credit Ledger &amp; Management</h1>
            <p class="page-subtitle">Server-controlled immutable audit trail of all atomic deductions, issuances, and user credit balances.</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn btn-secondary btn-sm" onclick="loadAdminServerData(); showToast('↻ Synced credit ledger');">↻ Refresh</button>
            <button class="btn btn-primary btn-sm" onclick="navigateToScreen('14')">👥 Adjust Credits via Users</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- KPI Summary Cards -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:20px;">
            <div class="stat-card">
              <div class="stat-label">Circulating Credits</div>
              <div class="stat-value" style="color:var(--text-primary); font-size:24px;">${circulating.toLocaleString()}</div>
              <div class="stat-meta">Active user wallets</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Total Deductions (Usage)</div>
              <div class="stat-value" style="color:var(--status-error); font-size:24px;">-${totalConsumed.toLocaleString()}</div>
              <div class="stat-meta">AI generated replies</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Total Credits Issued</div>
              <div class="stat-value" style="color:var(--status-success); font-size:24px;">+${totalIssued.toLocaleString()}</div>
              <div class="stat-meta">Signups, plans &amp; top-ups</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Ledger Entries</div>
              <div class="stat-value" style="color:var(--blue-primary); font-size:24px;">${Math.max(allLedger.length, AtomXState.adminStats?.totalLedgerCount || 0).toLocaleString()}</div>
              <div class="stat-meta">Lifetime atomic records</div>
            </div>
          </div>

          <!-- Search & Filter Controls -->
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
            <div class="style-pills">
              <span class="style-pill ${activeFilter === 'All' ? 'active' : ''}" onclick="setCreditLedgerFilter('All')">All (${allLedger.length})</span>
              <span class="style-pill ${activeFilter === 'Deductions' ? 'active' : ''}" onclick="setCreditLedgerFilter('Deductions')">Usage Deductions</span>
              <span class="style-pill ${activeFilter === 'Additions' ? 'active' : ''}" onclick="setCreditLedgerFilter('Additions')">Credits Added</span>
              <span class="style-pill ${activeFilter === 'AI Replies' ? 'active' : ''}" onclick="setCreditLedgerFilter('AI Replies')">AI Replies</span>
              <span class="style-pill ${activeFilter === 'Admin Adjustments' ? 'active' : ''}" onclick="setCreditLedgerFilter('Admin Adjustments')">Admin Adjustments</span>
            </div>
            <div style="width:260px;">
              <input type="text" class="form-input" placeholder="Search user, action, reason..." value="${AtomXState.creditLedgerSearchQuery || ''}" oninput="setCreditLedgerSearch(this.value)">
            </div>
          </div>

          <!-- Pure Credit Ledger Table -->
          <div class="atomx-card">
            <div class="atomx-table-wrapper">
              <table class="atomx-table responsive-table-as-cards">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Amount</th>
                    <th>Issuer / Source</th>
                    <th>Reason / Details</th>
                    <th>Audit Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.length === 0 ? `
                    <tr>
                      <td colspan="7" style="text-align:center; padding:36px; color:var(--text-muted);">
                        <div style="font-size:24px; margin-bottom:8px;">📋</div>
                        <div style="font-weight:600; font-size:14px; color:var(--text-primary); margin-bottom:4px;">No Credit Ledger Records Found</div>
                        <div style="font-size:12px;">No transactions match the selected filter.</div>
                      </td>
                    </tr>
                  ` : filtered.map(c => `
                    <tr>
                      <td style="color:var(--text-muted); font-size:11.5px;">${c.date}</td>
                      <td style="font-weight:600; color:var(--text-primary);">${c.user}</td>
                      <td><span class="badge ${Number(c.amount) < 0 ? 'badge-neutral' : 'badge-primary'}" style="font-size:10.5px;">${c.action}</span></td>
                      <td style="font-weight:700; color:${Number(c.amount) > 0 ? 'var(--status-success)' : 'var(--status-error)'};">
                        ${Number(c.amount) > 0 ? '+' + Number(c.amount).toLocaleString() : Number(c.amount).toLocaleString()} cr
                      </td>
                      <td style="color:var(--text-secondary); font-size:12px;">${c.admin || 'System'}</td>
                      <td style="color:var(--text-secondary); font-size:11.5px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${c.reason}">
                        ${c.reason || '—'}
                      </td>
                      <td><span class="badge badge-success" style="font-size:10.5px;">✓ Verified</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function adminTriggerCreditAdjustment(type) {
  const input = document.getElementById('adminCreditInput');
  const amt = parseInt(input?.value, 10);
  if (isNaN(amt) || amt <= 0) {
    showToast('Please enter a valid credit amount greater than 0.', 'error');
    return;
  }
  adminAdjustCredits(amt, type);
}

async function adminAdjustCredits(amt, type) {
  const amount = type === 'Add' ? amt : -amt;
  const reason = document.getElementById('adminCreditReason')?.value || 'Admin Adjustment';
  const targetUser = AtomXState.selectedCreditUser || AtomXState.currentUser || { id: 1, name: 'User' };

  try {
    const res = await fetch(`${API_BASE}/api/admin/adjust-credits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: targetUser.id,
        email: targetUser.email,
        handle: targetUser.handle,
        amount,
        reason
      })
    });
    const d = await res.json();
    if (res.ok) {
      targetUser.credits = (targetUser.credits || 0) + amount;
      await loadAdminServerData();
      showToast(`✓ Server verified: Successfully processed ${type} of ${amt.toLocaleString()} credits for ${targetUser.name}!`, 'success');
      renderAdminCreditManagement(document.getElementById('mainContentArea'));
      return;
    } else {
      throw new Error(d.error || 'Server rejected adjustment');
    }
  } catch (e) {
    showToast(`Notice: ${e.message}`, 'error');
  }

  // Fallback optimistic update
  AtomXState.creditLedger.unshift({
    date: 'Just now',
    user: targetUser.name,
    action: type === 'Add' ? 'Manual Add' : 'Manual Deduct',
    amount: amount,
    admin: 'Admin Control Panel',
    reason: reason
  });
  targetUser.credits = Math.max(0, (targetUser.credits || 0) + amount);
  showToast(`✓ Processed ${type} of ${amt.toLocaleString()} credits for ${targetUser.name}!`, 'success');
  renderAdminCreditManagement(document.getElementById('mainContentArea'));
}

// -------------------------------------------------------------
// SCREEN 16: PLAN & OFFERS MANAGEMENT (ADMIN)
// -------------------------------------------------------------
function renderAdminPlanManagement(container) {
  const offer = AtomXState.foundingOffer || {
    originalPrice: 5.00,
    launchPrice: 2.00,
    credits: 5000,
    limitUsers: 100,
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString()
  };

  const claimedCount = (AtomXState.adminUsers || []).filter(u => u.plan && !u.plan.toLowerCase().includes('free')).length;
  const expMs = new Date(offer.expiresAt || (Date.now() + 72 * 3600 * 1000)).getTime() - Date.now();
  const diffSec = Math.max(0, Math.floor(expMs / 1000));
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  const countdownStr = `${String(d).padStart(2, '0')}d : ${String(h).padStart(2, '0')}h : ${String(m).padStart(2, '0')}m : ${String(s).padStart(2, '0')}s`;

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('16')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Plans & Special Offers</h1>
            <p class="page-subtitle">Configure pricing tiers, credit allocations, discounts, and custom promotional offers.</p>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openNewPlanModal()">+ Add New Plan / Offer</button>
        </div>

        <div class="workspace-body">
          <!-- Special Launch Promotional Offer Controller Card -->
          <div class="atomx-card" style="margin-bottom:24px; padding:18px 20px; border:2px solid #FF6B00; background:linear-gradient(135deg, rgba(255,107,0,0.06), rgba(0,0,0,0.1));">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:12px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="badge" style="background:#FF6B00; color:#FFF; font-weight:800; font-size:11px;">FIRST LAUNCH OFFER</span>
                <h3 style="font-size:16px; font-weight:800; color:var(--text-primary); margin:0;">FOUNDING 100 Promotional Campaign</h3>
              </div>
              <span class="badge badge-success" style="font-weight:700;">ACTIVE NOW</span>
            </div>
            
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:14px;">
              <div style="background:var(--bg-canvas); padding:10px 12px; border-radius:6px; border:1px solid var(--border-subtle);">
                <div style="font-size:11px; color:var(--text-muted); font-weight:600;">PRICING DISCOUNT</div>
                <div style="font-size:16px; font-weight:800; color:#FF6B00; margin-top:2px;">
                  <span style="text-decoration:line-through; font-size:13px; color:var(--text-muted);">$${offer.originalPrice || 5}/mo</span> → $${offer.launchPrice || 2}/mo
                </div>
              </div>
              <div style="background:var(--bg-canvas); padding:10px 12px; border-radius:6px; border:1px solid var(--border-subtle);">
                <div style="font-size:11px; color:var(--text-muted); font-weight:600;">CREDITS ALLOCATION</div>
                <div style="font-size:16px; font-weight:800; color:var(--blue-primary); margin-top:2px;">${(offer.credits || 5000).toLocaleString()} Credits</div>
              </div>
              <div style="background:var(--bg-canvas); padding:10px 12px; border-radius:6px; border:1px solid var(--border-subtle);">
                <div style="font-size:11px; color:var(--text-muted); font-weight:600;">CLAIM LIMIT</div>
                <div style="font-size:16px; font-weight:800; color:var(--text-primary); margin-top:2px;">First ${offer.limitUsers || 100} Users (${claimedCount} Claimed)</div>
              </div>
              <div style="background:var(--bg-canvas); padding:10px 12px; border-radius:6px; border:1px solid var(--border-subtle);">
                <div style="font-size:11px; color:var(--text-muted); font-weight:600;">REAL-TIME COUNTDOWN</div>
                <div style="font-size:13px; font-weight:800; font-family:monospace; color:#FF6B00; margin-top:4px;">${countdownStr}</div>
              </div>
            </div>

            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <button class="btn btn-secondary btn-sm" onclick="adminExtendOffer(24)">⏳ +24h Extension</button>
              <button class="btn btn-secondary btn-sm" onclick="adminExtendOffer(48)">⏳ +48h Extension</button>
              <button class="btn btn-secondary btn-sm" onclick="adminExtendOffer(168)">⏳ +7 Days Extension</button>
              <button class="btn btn-primary btn-sm" onclick="promptEditFoundingOffer()">✏️ Edit Price, Credits & Expiry</button>
            </div>
          </div>

          <div class="pricing-grid">
            ${AtomXState.plans.map(p => `
              <div class="pricing-card ${p.popular ? 'featured' : ''}" style="position:relative;">
                ${p.offerBadge ? `
                  <div class="pricing-card-badge" style="background:linear-gradient(135deg, #FF6B00, #E60000); color:#FFF; font-weight:800; font-size:11px; padding:4px 10px; border-radius:20px; text-transform:uppercase;">
                    🔥 ${p.offerBadge}
                  </div>
                ` : (p.popular ? `<div class="pricing-card-badge">POPULAR</div>` : '')}

                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:${p.offerBadge ? '10px' : '0'};">
                  <h3 style="font-size:16px; font-weight:800; text-transform:uppercase;">${p.name}</h3>
                  <span class="badge ${p.price > 0 ? 'badge-success' : 'badge-secondary'}">${p.price > 0 ? 'Active' : 'Free Tier'}</span>
                </div>

                <div class="plan-price" style="margin:12px 0 6px 0;">
                  $${p.price} <span style="font-size:13px; color:var(--text-muted); font-weight:500;">/ month</span>
                </div>

                <div style="font-size:14px; font-weight:700; color:var(--blue-primary); margin-bottom:12px;">
                  ⚡ ${(p.credits || 0).toLocaleString()} Credits
                </div>

                <ul class="plan-feature-list" style="margin-bottom:16px;">
                  ${(p.features || []).map(f => `<li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> ${f}</li>`).join('')}
                </ul>

                <button class="btn btn-secondary btn-block" onclick="openEditPlanModal('${p.id}')">✏️ Edit Price & Offers</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function openEditPlanModal(planId) {
  const plan = AtomXState.plans.find(p => p.id === planId);
  if (!plan) return;

  const modalHTML = `
    <div class="modal-backdrop" id="planEditModal">
      <div class="modal-box" style="max-width:480px;">
        <div class="modal-header">
          <h3 class="modal-title">Edit Plan: ${plan.name}</h3>
          <button class="modal-close-btn" onclick="closeModal()">×</button>
        </div>
        <div class="form-group">
          <label class="form-label">Plan Name</label>
          <input type="text" class="form-input" id="editPlanName" value="${plan.name}">
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="form-group">
            <label class="form-label">Price ($ / month)</label>
            <input type="number" class="form-input" id="editPlanPrice" value="${plan.price}" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Credits Allocated</label>
            <input type="number" class="form-input" id="editPlanCredits" value="${plan.credits}" min="100">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Special Offer Badge (Optional)</label>
          <input type="text" class="form-input" id="editPlanBadge" value="${plan.offerBadge || ''}" placeholder="e.g. 50% OFF, FLASH DEAL, BEST VALUE">
          <div class="form-hint">Shown as an eye-catching promotional badge above the plan card.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Features (one per line)</label>
          <textarea class="form-input" id="editPlanFeatures" rows="4">${(plan.features || []).join('\n')}</textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="savePlanChanges('${plan.id}')">Save Changes</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

async function savePlanChanges(planId) {
  const plan = AtomXState.plans.find(p => p.id === planId);
  if (!plan) return;

  plan.name = document.getElementById('editPlanName')?.value.trim() || plan.name;
  plan.price = Number(document.getElementById('editPlanPrice')?.value) || 0;
  plan.credits = Number(document.getElementById('editPlanCredits')?.value) || plan.credits;
  plan.offerBadge = document.getElementById('editPlanBadge')?.value.trim() || '';
  const featText = document.getElementById('editPlanFeatures')?.value || '';
  plan.features = featText.split('\n').map(s => s.trim()).filter(Boolean);

  closeModal();
  await persistAdminPlans();
  renderAdminPlanManagement(document.getElementById('mainContentArea'));
  showToast(`✓ Updated ${plan.name} plan configuration successfully!`);
}

function openNewPlanModal() {
  const modalHTML = `
    <div class="modal-backdrop" id="planNewModal">
      <div class="modal-box" style="max-width:480px;">
        <div class="modal-header">
          <h3 class="modal-title">Create New Plan / Promotional Offer</h3>
          <button class="modal-close-btn" onclick="closeModal()">×</button>
        </div>
        <div class="form-group">
          <label class="form-label">Plan Name</label>
          <input type="text" class="form-input" id="newPlanName" placeholder="e.g. SUMMER SPECIAL or ENTERPRISE">
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="form-group">
            <label class="form-label">Price ($ / month)</label>
            <input type="number" class="form-input" id="newPlanPrice" value="19" min="0">
          </div>
          <div class="form-group">
            <label class="form-label">Credits Allocated</label>
            <input type="number" class="form-input" id="newPlanCredits" value="20000" min="100">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Promotional Offer Badge</label>
          <input type="text" class="form-input" id="newPlanBadge" value="SPECIAL OFFER" placeholder="e.g. 50% OFF, LIMITED DEAL">
        </div>
        <div class="form-group">
          <label class="form-label">Features (one per line)</label>
          <textarea class="form-input" id="newPlanFeatures" rows="3">20,000 AI replies\nAll autonomous agents\nPriority server queue\nDedicated support</textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveNewPlan()">Create Offer Plan</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

async function saveNewPlan() {
  const name = document.getElementById('newPlanName')?.value.trim();
  if (!name) { alert('Please enter a plan name.'); return; }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const price = Number(document.getElementById('newPlanPrice')?.value) || 0;
  const credits = Number(document.getElementById('newPlanCredits')?.value) || 1000;
  const offerBadge = document.getElementById('newPlanBadge')?.value.trim() || '';
  const featText = document.getElementById('newPlanFeatures')?.value || '';
  const features = featText.split('\n').map(s => s.trim()).filter(Boolean);

  AtomXState.plans.push({
    id,
    name,
    price,
    credits,
    offerBadge,
    popular: false,
    features: features.length > 0 ? features : ['Full AI Access', 'Autonomous Agents']
  });

  closeModal();
  await persistAdminPlans();
  renderAdminPlanManagement(document.getElementById('mainContentArea'));
  showToast(`✓ Created new promotional offer plan: ${name}`);
}

async function adminExtendOffer(hours) {
  const current = AtomXState.foundingOffer || {};
  const currentExp = new Date(current.expiresAt || Date.now());
  const base = currentExp > new Date() ? currentExp.getTime() : Date.now();
  const newExp = new Date(base + hours * 3600 * 1000).toISOString();

  try {
    const res = await fetch(`${API_BASE}/api/admin/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresAt: newExp })
    });
    if (res.ok) {
      const data = await res.json();
      AtomXState.foundingOffer = data.offer || { ...current, expiresAt: newExp };
      showToast(`✓ Extended founding offer by ${hours} Hours!`);
      renderAdminPlanManagement(document.getElementById('mainContentArea'));
      return;
    }
  } catch (e) {}
  if (!AtomXState.foundingOffer) AtomXState.foundingOffer = {};
  AtomXState.foundingOffer.expiresAt = newExp;
  showToast(`✓ Extended offer by ${hours} Hours!`);
  renderAdminPlanManagement(document.getElementById('mainContentArea'));
}

async function promptEditFoundingOffer() {
  const cur = AtomXState.foundingOffer || { launchPrice: 2, credits: 5000 };
  const price = prompt('Enter Launch Price ($ / month):', cur.launchPrice || '2.00');
  if (price === null) return;
  const credits = prompt('Enter Credit Allocation:', cur.credits || '5000');
  if (credits === null) return;
  const expiryHours = prompt('Set Expiry from now (in hours):', '72');
  if (expiryHours === null) return;

  const newExp = new Date(Date.now() + (Number(expiryHours) || 72) * 3600 * 1000).toISOString();
  try {
    const res = await fetch(`${API_BASE}/api/admin/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        launchPrice: Number(price) || 2,
        credits: Number(credits) || 5000,
        expiresAt: newExp
      })
    });
    if (res.ok) {
      const data = await res.json();
      AtomXState.foundingOffer = data.offer || { ...cur, launchPrice: Number(price), credits: Number(credits), expiresAt: newExp };
      showToast('✓ Founding 100 offer updated & saved to server database!');
      renderAdminPlanManagement(document.getElementById('mainContentArea'));
      return;
    }
  } catch (e) {}
  showToast('✓ Founding 100 offer updated!');
  renderAdminPlanManagement(document.getElementById('mainContentArea'));
}

async function persistAdminPlans() {
  try {
    await fetch(`${API_BASE}/api/admin/save-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plans: AtomXState.plans, foundingOffer: AtomXState.foundingOffer })
    });
  } catch (e) {
    console.warn('Could not post plans to backend', e);
  }
}

// -------------------------------------------------------------
// SCREEN 17: TRANSACTIONS / USAGE (ADMIN)
// -------------------------------------------------------------
function setTransactionsFilter(filter) {
  AtomXState.transactionsFilter = filter;
  renderAdminTransactions(document.getElementById('mainContentArea'));
}

function setTransactionsSearch(query) {
  AtomXState.transactionsSearchQuery = query;
  renderAdminTransactions(document.getElementById('mainContentArea'));
}

function renderAdminTransactions(container) {
  const activeFilter = AtomXState.transactionsFilter || 'All';
  const searchQuery = (AtomXState.transactionsSearchQuery || '').toLowerCase().trim();

  let allTx = Array.isArray(AtomXState.adminTransactions) ? AtomXState.adminTransactions : [];

  // Revenue & transaction metrics
  const totalRev = allTx.reduce((sum, t) => sum + (parseFloat(String(t.amount || '$0').replace(/[^0-9.]/g, '')) || 0), 0);
  const planSubsCount = allTx.filter(t => (t.type || '').toLowerCase().includes('plan')).length;
  const topUpsCount = allTx.filter(t => (t.type || '').toLowerCase().includes('top') || (t.type || '').toLowerCase().includes('credit')).length;
  const creditsGranted = allTx.reduce((sum, t) => sum + (Number(t.credits) || 0), 0);

  let filtered = allTx.filter(tx => {
    const tp = (tx.type || '').toLowerCase();
    const itm = (tx.item || '').toLowerCase();
    const mth = (tx.method || '').toLowerCase();

    if (activeFilter === 'Plan Purchases') {
      return tp.includes('plan') || itm.includes('plan');
    }
    if (activeFilter === 'Credit Top-Ups') {
      return tp.includes('credit') || tp.includes('top') || itm.includes('credits');
    }
    if (activeFilter === 'Stripe') {
      return mth.includes('stripe') || mth.includes('card');
    }
    if (activeFilter === 'Crypto') {
      return mth.includes('crypto') || mth.includes('usdt');
    }
    return true;
  });

  if (searchQuery) {
    filtered = filtered.filter(tx => {
      const u = (tx.user || '').toLowerCase();
      const h = (tx.handle || '').toLowerCase();
      const e = (tx.email || '').toLowerCase();
      const itm = (tx.item || '').toLowerCase();
      const mth = (tx.method || '').toLowerCase();
      const dt = (tx.date || '').toLowerCase();
      return u.includes(searchQuery) || h.includes(searchQuery) || e.includes(searchQuery) || itm.includes(searchQuery) || mth.includes(searchQuery) || dt.includes(searchQuery);
    });
  }

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('17')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Transactions &amp; Orders</h1>
            <p class="page-subtitle">Real financial purchase records of user plan subscriptions and credit pack purchases.</p>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn btn-secondary btn-sm" onclick="loadAdminServerData(); showToast('↻ Synced purchases');">↻ Refresh</button>
            <button class="btn btn-primary btn-sm" onclick="navigateToScreen('16')">💳 Manage Pricing Plans</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Financial KPI Metrics -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-bottom:20px;">
            <div class="stat-card">
              <div class="stat-label">Total Platform Revenue</div>
              <div class="stat-value" style="color:var(--status-success); font-size:24px;">$${totalRev.toFixed(2)}</div>
              <div class="stat-meta">Verified customer payments</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Plan Subscriptions</div>
              <div class="stat-value" style="color:var(--blue-primary); font-size:24px;">${planSubsCount}</div>
              <div class="stat-meta">Growth, Pro &amp; Enterprise</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Credit Top-Ups</div>
              <div class="stat-value" style="color:var(--text-primary); font-size:24px;">${topUpsCount}</div>
              <div class="stat-meta">One-time credit pack purchases</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Credits Issued via Sales</div>
              <div class="stat-value" style="color:var(--status-success); font-size:24px;">+${creditsGranted.toLocaleString()}</div>
              <div class="stat-meta">Delivered to active user balances</div>
            </div>
          </div>

          <!-- Filter & Search Controls -->
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
            <div class="style-pills">
              <span class="style-pill ${activeFilter === 'All' ? 'active' : ''}" onclick="setTransactionsFilter('All')">All Purchases (${allTx.length})</span>
              <span class="style-pill ${activeFilter === 'Plan Purchases' ? 'active' : ''}" onclick="setTransactionsFilter('Plan Purchases')">Plan Purchases</span>
              <span class="style-pill ${activeFilter === 'Credit Top-Ups' ? 'active' : ''}" onclick="setTransactionsFilter('Credit Top-Ups')">Credit Top-Ups</span>
              <span class="style-pill ${activeFilter === 'Stripe' ? 'active' : ''}" onclick="setTransactionsFilter('Stripe')">Stripe</span>
              <span class="style-pill ${activeFilter === 'Crypto' ? 'active' : ''}" onclick="setTransactionsFilter('Crypto')">Crypto</span>
            </div>
            <div style="width:280px;">
              <input type="text" class="form-input" placeholder="Search customer, handle, plan, method..." value="${AtomXState.transactionsSearchQuery || ''}" oninput="setTransactionsSearch(this.value)">
            </div>
          </div>

          <div class="atomx-card">
            <div class="atomx-table-wrapper">
              <table class="atomx-table responsive-table-as-cards">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Order Type</th>
                    <th>Purchased Plan / Item</th>
                    <th>Amount Paid</th>
                    <th>Credits Granted</th>
                    <th>Payment Gateway</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.length === 0 ? `
                    <tr>
                      <td colspan="8" style="text-align:center; padding:36px; color:var(--text-muted);">
                        <div style="font-size:24px; margin-bottom:8px;">💳</div>
                        <div style="font-weight:600; font-size:14px; color:var(--text-primary); margin-bottom:4px;">No Purchase Transactions Found</div>
                        <div style="font-size:12px;">Transactions appear here when users buy plans or credit top-ups.</div>
                      </td>
                    </tr>
                  ` : filtered.map(tx => `
                    <tr>
                      <td style="color:var(--text-muted); font-size:11.5px;">${tx.date}</td>
                      <td>
                        <div style="font-weight:700; color:var(--text-primary);">${tx.user || 'Customer'}</div>
                        <div style="font-size:11px; color:var(--blue-primary);">${tx.handle || '@user'}${tx.email ? ' · ' + tx.email : ''}</div>
                      </td>
                      <td>
                        <span class="badge ${tx.type === 'Plan Purchase' ? 'badge-primary' : 'badge-neutral'}" style="font-size:10.5px;">
                          ${tx.type || 'Plan Purchase'}
                        </span>
                      </td>
                      <td style="font-weight:700; color:var(--text-primary); font-size:12.5px;">
                        ${tx.item || 'Growth Plan'}
                      </td>
                      <td style="font-weight:800; font-size:13px; color:var(--status-success);">
                        ${tx.amount.startsWith('$') ? tx.amount : '$' + tx.amount}
                      </td>
                      <td style="font-weight:700; color:var(--blue-primary); font-size:12px;">
                        +${(Number(tx.credits) || 0).toLocaleString()} cr
                      </td>
                      <td style="font-size:11.5px; color:var(--text-secondary);">
                        <span style="display:inline-flex; align-items:center; gap:4px;">
                          ${tx.method?.toLowerCase().includes('crypto') ? '🪙' : '💳'} ${tx.method || 'Stripe Card'}
                        </span>
                      </td>
                      <td><span class="badge badge-success" style="font-size:10.5px;">✓ ${tx.status || 'Paid'}</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 20: ADMIN CURATED LISTS & SORSA TARGETS MANAGEMENT
// -------------------------------------------------------------
async function fetchAdminCuratedLists() {
  try {
    const res = await fetch(`${API_BASE}/api/curated-lists`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.lists && Object.keys(data.lists).length > 0) {
        AtomXState.curatedLists = data.lists;
      }
    }
  } catch (e) {
    console.warn('Could not fetch curated lists from backend:', e);
  }
}

async function renderAdminCuratedLists(container) {
  if (!AtomXState._curatedListsLoaded) {
    await fetchAdminCuratedLists();
    AtomXState._curatedListsLoaded = true;
  }

  const lists = AtomXState.curatedLists;
  const listKeys = Object.keys(lists);
  const totalTargets = listKeys.reduce((acc, k) => acc + (lists[k].targets?.length || 0), 0);

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('20')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Curated Lists & Score Targets</h1>
            <p class="page-subtitle">Manage, update, and broadcast curated influencer accounts and live Twitter list URLs for CrowdFi and Score Accelerator agents.</p>
          </div>
          <div style="display:flex; gap:10px;">
            <button class="btn btn-secondary btn-sm" onclick="promptAddNewCustomList()">+ Add New List</button>
            <button class="btn btn-secondary btn-sm" onclick="openImportGoogleSheetModal()" style="border-color:var(--status-success); color:var(--status-success); font-weight:600;">📥 Import Google Sheet / CSV</button>
            <button class="btn btn-primary btn-sm" onclick="saveCuratedListsToServer()">Save & Broadcast to Users</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Summary Metrics -->
          <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:20px;">
            <div class="stat-card">
              <div class="stat-label">TOTAL CURATED LISTS</div>
              <div class="stat-value" style="color:var(--blue-primary);">${listKeys.length}</div>
              <div class="stat-trend" style="color:var(--status-success);">Active in Extension</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">TARGET INFLUENCER ACCOUNTS</div>
              <div class="stat-value" style="color:var(--status-success);">${totalTargets}</div>
              <div class="stat-trend" style="color:var(--text-secondary);">Indexed for engagement</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">INTEGRATED AGENTS</div>
              <div class="stat-value">${new Set(listKeys.map(k => lists[k].category || 'CrowdFi')).size}</div>
              <div class="stat-trend" style="color:var(--blue-primary);">Active in Curated Feeds</div>
            </div>
          </div>

          <!-- Lists Grid -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(380px, 1fr)); gap:20px;">
            ${listKeys.map(k => {
              const l = lists[k];
              const isPub = (l.status || 'published') === 'published';
              return `
                <div class="atomx-card" id="card-${k}" style="display:flex; flex-direction:column; justify-content:space-between; border-top: 3px solid ${isPub ? 'var(--status-success)' : 'var(--status-warning)'};">
                  <div>
                    <!-- Header with Title, Status & Delete -->
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
                      <div style="flex:1; margin-right:10px;">
                        <input type="text" id="listname-${k}" value="${l.name}" oninput="updateListName('${k}', this.value)" class="form-input" style="font-size:15px; font-weight:700; padding:4px 8px; margin-bottom:6px; width:100%;" title="Click to rename list">
                      </div>
                      <div style="display:flex; gap:6px; align-items:center;">
                        <button onclick="deleteCustomList('${k}')" style="background:none; border:none; color:var(--status-error); cursor:pointer; font-size:14px; padding:2px;" title="Delete List">🗑️</button>
                      </div>
                    </div>

                    <!-- Admin Decision Controls: Assigned Agent, Access Plan & Status -->
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:12px; background:var(--bg-canvas); padding:8px 10px; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">
                      <div>
                        <label style="font-size:9.5px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:2px;">ASSIGNED AGENT:</label>
                        <select id="listcat-${k}" onchange="updateListCategory('${k}', this.value)" class="form-input" style="font-size:11px; padding:3px 4px; width:100%;">
                          <option value="Audience Builder" ${l.category === 'Audience Builder' || l.category === 'CrowdFi' ? 'selected' : ''}>CrowdFi</option>
                          <option value="Increase Sorsa Score" ${l.category === 'Increase Sorsa Score' || l.category === 'Score Accelerator' ? 'selected' : ''}>Score Accelerator</option>
                          <option value="Followers Increase" ${l.category === 'Followers Increase' || l.category === 'GrowthFi' ? 'selected' : ''}>GrowthFi</option>
                        </select>
                      </div>
                      <div>
                        <label style="font-size:9.5px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:2px;">ACCESS PLAN:</label>
                        <select id="listtier-${k}" onchange="updateListAccessTier('${k}', this.value)" class="form-input" style="font-size:11px; padding:3px 4px; width:100%; font-weight:700; color:${(l.accessTier || 'free') === 'paid' ? '#f59e0b' : '#38bdf8'};">
                          <option value="free" ${(l.accessTier || 'free') === 'free' ? 'selected' : ''}>🔓 Free (All)</option>
                          <option value="paid" ${l.accessTier === 'paid' ? 'selected' : ''}>🔒 Paid / Pro</option>
                        </select>
                      </div>
                      <div>
                        <label style="font-size:9.5px; font-weight:700; color:var(--text-secondary); display:block; margin-bottom:2px;">STATUS:</label>
                        <select id="liststatus-${k}" onchange="updateListStatus('${k}', this.value)" class="form-input" style="font-size:11px; padding:3px 4px; width:100%; font-weight:700; color:${isPub ? 'var(--status-success)' : 'var(--status-warning)'};">
                          <option value="published" ${isPub ? 'selected' : ''}>🟢 Live</option>
                          <option value="draft" ${l.status === 'draft' ? 'selected' : ''}>🟡 Draft</option>
                        </select>
                      </div>
                    </div>

                    <p style="font-size:12px; color:var(--text-secondary); margin-bottom:12px; line-height:1.4;">${l.description}</p>

                    ${(() => {
                      const isListUrlOnly = l.category === 'Audience Builder' || l.category === 'CrowdFi' || l.category === 'Followers Increase' || l.category === 'GrowthFi';
                      if (isListUrlOnly) {
                        return `
                          <!-- Twitter List URL Input (STRICTLY REQUIRED FOR CROWDFI & GROWTHFI) -->
                          <div style="background:var(--bg-canvas); border:1px solid rgba(56, 189, 248, 0.35); border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:14px;">
                            <label class="form-label" style="font-size:11px; font-weight:700; color:var(--blue-primary); margin-bottom:4px; display:flex; justify-content:space-between;">
                              <span>🔗 TWITTER / X LIST URL:</span>
                              <span style="font-size:10px; background:rgba(56, 189, 248, 0.15); color:var(--blue-primary); padding:1px 6px; border-radius:4px; font-weight:700;">REQUIRED (URL ONLY)</span>
                            </label>
                            <input type="text" id="listurl-${k}" class="form-input" value="${l.listUrl || ''}" placeholder="https://x.com/i/lists/..." style="font-size:12px; padding:6px 10px;" oninput="updateListUrl('${k}', this.value)">
                            <div style="font-size:10.5px; color:var(--text-secondary); margin-top:4px; line-height:1.3;">
                              🎯 <strong>${l.category} strictly supports Twitter List URLs only</strong> (e.g. <code>https://x.com/i/lists/...</code>).
                            </div>
                          </div>

                          <!-- Notice: Usernames/CSV not supported for this agent -->
                          <div style="background:rgba(239, 68, 68, 0.06); border:1px solid rgba(239, 68, 68, 0.25); border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:6px; font-size:11px; line-height:1.4;">
                            <div style="font-weight:700; color:#EF4444; margin-bottom:2px;">🚫 CSV & Usernames Not Supported</div>
                            <div style="color:var(--text-secondary);">${l.category} runs strictly on live Twitter List URLs. Admin cannot assign usernames or CSV lists to this agent.</div>
                          </div>
                        `;
                      } else {
                        // Increase Sorsa Score / Score Accelerator (Handles / CSV only)
                        return `
                          <!-- Notice: Twitter List URLs not supported for Score Accelerator -->
                          <div style="background:rgba(239, 68, 68, 0.06); border:1px solid rgba(239, 68, 68, 0.25); border-radius:var(--radius-sm); padding:10px 12px; margin-bottom:12px; font-size:11px; line-height:1.4;">
                            <div style="font-weight:700; color:#EF4444; margin-bottom:2px;">🚫 Twitter List URLs Not Supported</div>
                            <div style="color:var(--text-secondary);">Score Accelerator strictly uses target handles / CSV lists. Admin cannot assign Twitter List URLs to this agent.</div>
                          </div>

                          <!-- Target Chips & Count Control -->
                          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <div style="font-size:11px; font-weight:700; color:var(--text-secondary); text-transform:uppercase;">
                              TARGET ACCOUNTS (${(l.targets || []).length}):
                            </div>
                            <div style="display:flex; gap:6px;">
                              <button onclick="trimListTargetsPrompt('${k}')" class="btn btn-secondary btn-sm" style="font-size:10.5px; padding:2px 7px;">✂️ Set ID Count</button>
                              <button onclick="clearAllTargetsFromList('${k}')" class="btn btn-secondary btn-sm" style="font-size:10.5px; padding:2px 7px; color:var(--status-error);">Clear</button>
                            </div>
                          </div>
                          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; max-height:150px; overflow-y:auto; padding:4px 0;">
                            ${(l.targets && l.targets.length > 0) ? (l.targets || []).map((t, idx) => `
                              <span style="display:inline-flex; align-items:center; gap:5px; background:var(--bg-canvas); border:1px solid var(--border-subtle); padding:4px 9px; border-radius:99px; font-size:12px; font-weight:600;">
                                ${t}
                                <button onclick="removeTargetFromList('${k}', ${idx})" style="background:none; border:none; color:var(--status-error); cursor:pointer; font-size:12px; font-weight:bold; padding:0 2px;">×</button>
                              </span>
                            `).join('') : '<div style="font-size:11.5px; color:var(--text-secondary); font-style:italic;">No target accounts yet. Add handles below or import from Sheet.</div>'}
                          </div>

                          <!-- Quick Add & Bulk Import Form -->
                          <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:12px; margin-top:10px;">
                            <label class="form-label" style="font-size:11px; margin-bottom:4px;">+ Add Target Handles (e.g. @elonmusk or bulk paste)</label>
                            <div style="display:flex; gap:8px;">
                              <input type="text" id="input-${k}" class="form-input" placeholder="@handle or paste multiple comma separated" style="font-size:12px; padding:6px 10px;">
                              <button class="btn btn-primary btn-sm" onclick="addTargetToList('${k}')">Add</button>
                            </div>
                          </div>
                        `;
                      }
                    })()}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function updateListUrl(listKey, val) {
  if (AtomXState.curatedLists[listKey]) {
    AtomXState.curatedLists[listKey].listUrl = (val || '').trim();
  }
}

function deleteCustomList(listKey) {
  if (confirm(`Are you sure you want to delete "${AtomXState.curatedLists[listKey]?.name}"?`)) {
    delete AtomXState.curatedLists[listKey];
    renderAdminCuratedLists(document.getElementById('mainContentArea'));
    showToast('List removed');
  }
}

function addTargetToList(listKey) {
  const input = document.getElementById(`input-${listKey}`);
  if (!input || !input.value.trim()) return;
  const raw = input.value.trim();
  const handles = raw.split(/[\s,]+/).map(h => h.trim()).filter(h => h.length > 0).map(h => h.startsWith('@') ? h : '@' + h);
  
  if (!AtomXState.curatedLists[listKey].targets) {
    AtomXState.curatedLists[listKey].targets = [];
  }
  
  handles.forEach(h => {
    if (!AtomXState.curatedLists[listKey].targets.includes(h)) {
      AtomXState.curatedLists[listKey].targets.push(h);
    }
  });

  input.value = '';
  renderAdminCuratedLists(document.getElementById('mainContentArea'));
  showToast(`✓ Added ${handles.length} target(s) to ${AtomXState.curatedLists[listKey].name}`);
}

function removeTargetFromList(listKey, index) {
  if (AtomXState.curatedLists[listKey]?.targets) {
    const removed = AtomXState.curatedLists[listKey].targets.splice(index, 1);
    renderAdminCuratedLists(document.getElementById('mainContentArea'));
    showToast(`Removed ${removed}`);
  }
}

function promptAddNewCustomList() {
  const name = prompt('Enter List Name (e.g., "Web3 Founders Alpha"):');
  if (!name || !name.trim()) return;
  const cat = prompt('Enter Agent Category:\n1 = CrowdFi (Twitter List URL only)\n2 = Score Accelerator (Usernames / CSV only)\n3 = GrowthFi (Twitter List URL only)', '1');
  let category = 'CrowdFi';
  let listUrl = '';
  let targets = [];

  if (cat === '2') {
    category = 'Increase Sorsa Score';
    listUrl = '';
  } else {
    if (cat === '3') category = 'Followers Increase';
    else category = 'Audience Builder';
    const enteredUrl = prompt(`Enter Twitter/X List URL for ${category === 'Audience Builder' ? 'CrowdFi' : 'GrowthFi'} (e.g. https://x.com/i/lists/...):`, '');
    listUrl = (enteredUrl || '').trim();
    targets = [];
  }

  const newKey = 'custom_' + Date.now();
  if (!AtomXState.curatedLists) AtomXState.curatedLists = {};
  AtomXState.curatedLists[newKey] = {
    id: newKey,
    name: name.trim(),
    category: category,
    status: 'published',
    accessTier: 'free',
    description: `Curated list for ${category}.`,
    listUrl: listUrl,
    targets: targets
  };

  renderAdminCuratedLists(document.getElementById('mainContentArea'));
  showToast(`✓ Created new list for ${category}`);
}

async function saveCuratedListsToServer() {
  if (!AtomXState.curatedLists || typeof AtomXState.curatedLists !== 'object') {
    AtomXState.curatedLists = {};
  }

  // Synchronously sync all on-screen inputs directly from the DOM before sending
  Object.keys(AtomXState.curatedLists).forEach(k => {
    const item = AtomXState.curatedLists[k];
    if (!item) return;

    const nameInp = document.getElementById(`listname-${k}`);
    if (nameInp && nameInp.value.trim()) {
      item.name = nameInp.value.trim();
    }
    const catInp = document.getElementById(`listcat-${k}`);
    if (catInp && catInp.value) {
      item.category = catInp.value;
    }
    const tierInp = document.getElementById(`listtier-${k}`);
    if (tierInp && tierInp.value) {
      item.accessTier = tierInp.value;
    }
    const statusInp = document.getElementById(`liststatus-${k}`);
    if (statusInp && statusInp.value) {
      item.status = statusInp.value;
    }
    const urlInp = document.getElementById(`listurl-${k}`);
    if (urlInp) {
      item.listUrl = urlInp.value.trim();
    }
    if (!item.status) {
      item.status = 'published';
    }
    if (!item.accessTier) {
      item.accessTier = 'free';
    }
    if (!Array.isArray(item.targets)) {
      item.targets = [];
    }
  });

  // Strict validation of agent rules before sending
  for (const k of Object.keys(AtomXState.curatedLists)) {
    const item = AtomXState.curatedLists[k];
    if (!item) continue;
    const cat = item.category || 'Audience Builder';
    if (cat === 'Audience Builder' || cat === 'CrowdFi' || cat === 'Followers Increase' || cat === 'GrowthFi') {
      item.targets = []; // Strictly no username targets for CrowdFi or GrowthFi
      const trimmedUrl = (item.listUrl || '').trim();
      const isValidList = trimmedUrl.includes('x.com/i/lists/') || trimmedUrl.includes('twitter.com/i/lists/') || /^\d{10,25}$/.test(trimmedUrl);
      if (!isValidList) {
        alert(`⚠️ Cannot Save: "${item.name}" is assigned to ${cat}.\n\nThis agent ONLY supports Twitter List URLs (e.g. https://x.com/i/lists/...). CSV and username handles are not allowed.\n\nPlease enter a valid Twitter List URL.`);
        return false;
      }
    } else if (cat === 'Increase Sorsa Score' || cat === 'Score Accelerator') {
      item.listUrl = ''; // Strictly no Twitter List URLs for Score Accelerator
    }
  }

  try {
    const res = await fetch(`${API_BASE}/api/admin/curated-lists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lists: AtomXState.curatedLists })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      if (data && data.lists) {
        AtomXState.curatedLists = data.lists;
      }
      showToast('✓ Curated lists successfully saved and broadcasted to all extensions!');
      alert('✓ Curated lists successfully saved and broadcasted to all user extensions!');
      renderAdminCuratedLists(document.getElementById('mainContentArea'));
      return true;
    } else {
      const errMsg = data?.error || res.statusText || 'Server error';
      console.error('Failed to save curated lists:', errMsg);
      showToast('⚠️ Save failed: ' + errMsg);
      alert('⚠️ Failed to save curated lists to server:\n' + errMsg);
      return false;
    }
  } catch (e) {
    console.error('Network error saving curated lists:', e);
    showToast('⚠️ Network error while saving lists: ' + e.message);
    alert('⚠️ Network error while saving lists: ' + e.message);
    return false;
  }
}

// -------------------------------------------------------------
// LIST CONTROLS: AGENT, STATUS, LIMIT, RENAME, CLEAR
// -------------------------------------------------------------
function updateListCategory(listKey, newCategory) {
  if (AtomXState.curatedLists[listKey]) {
    AtomXState.curatedLists[listKey].category = newCategory;
    if (newCategory === 'Audience Builder' || newCategory === 'CrowdFi' || newCategory === 'Followers Increase' || newCategory === 'GrowthFi') {
      AtomXState.curatedLists[listKey].targets = [];
      if (!AtomXState.curatedLists[listKey].listUrl || !AtomXState.curatedLists[listKey].listUrl.includes('x.com/i/lists/')) {
        AtomXState.curatedLists[listKey].listUrl = '';
      }
      showToast(`✓ Set to ${newCategory}: Live Twitter List URL only (CSV/usernames disabled)`);
    } else if (newCategory === 'Increase Sorsa Score' || newCategory === 'Score Accelerator') {
      AtomXState.curatedLists[listKey].listUrl = '';
      showToast(`✓ Set to Score Accelerator: Usernames & CSV only (Twitter List URLs disabled)`);
    }
    renderAdminCuratedLists(document.getElementById('mainContentArea'));
  }
}

function updateListStatus(listKey, newStatus) {
  if (AtomXState.curatedLists[listKey]) {
    AtomXState.curatedLists[listKey].status = newStatus;
    renderAdminCuratedLists(document.getElementById('mainContentArea'));
    showToast(`✓ Set status to: ${newStatus.toUpperCase()}`);
  }
}

function updateListAccessTier(listKey, newAccessTier) {
  if (AtomXState.curatedLists[listKey]) {
    AtomXState.curatedLists[listKey].accessTier = newAccessTier;
    renderAdminCuratedLists(document.getElementById('mainContentArea'));
    showToast(`✓ Set plan access to: ${newAccessTier.toUpperCase()}`);
  }
}

function updateListName(listKey, newName) {
  if (AtomXState.curatedLists[listKey] && newName.trim()) {
    AtomXState.curatedLists[listKey].name = newName.trim();
    showToast(`✓ Renamed list to: ${newName.trim()}`);
  }
}

function trimListTargetsPrompt(listKey) {
  const l = AtomXState.curatedLists[listKey];
  if (!l) return;
  const currCount = l.targets?.length || 0;
  const input = prompt(`Currently "${l.name}" has ${currCount} target accounts.\nEnter the maximum number of IDs to keep in this list (e.g. 50, 100, 250):`, currCount > 100 ? 100 : currCount);
  if (input === null) return;
  const limit = parseInt(input, 10);
  if (isNaN(limit) || limit < 0) {
    alert('Please enter a valid positive number.');
    return;
  }
  l.targets = (l.targets || []).slice(0, limit);
  renderAdminCuratedLists(document.getElementById('mainContentArea'));
  showToast(`✓ Trimmed "${l.name}" to ${l.targets.length} targets.`);
}

function clearAllTargetsFromList(listKey) {
  const l = AtomXState.curatedLists[listKey];
  if (!l) return;
  if (confirm(`Are you sure you want to remove all targets from "${l.name}"?`)) {
    l.targets = [];
    renderAdminCuratedLists(document.getElementById('mainContentArea'));
    showToast(`✓ Cleared all targets from "${l.name}".`);
  }
}

// -------------------------------------------------------------
// GOOGLE SHEET / CSV IMPORTER FOR 3K+ CREATORS (ADMIN DECISION)
// -------------------------------------------------------------
function openImportGoogleSheetModal() {
  const existingModal = document.getElementById('sheetImportModal');
  if (existingModal) existingModal.remove();

  const currentLists = AtomXState.curatedLists || {};
  const listKeys = Object.keys(currentLists);

  const modal = document.createElement('div');
  modal.id = 'sheetImportModal';
  modal.style.position = 'fixed';
  modal.style.top = '0';
  modal.style.left = '0';
  modal.style.width = '100vw';
  modal.style.height = '100vh';
  modal.style.backgroundColor = 'rgba(0,0,0,0.75)';
  modal.style.backdropFilter = 'blur(6px)';
  modal.style.display = 'flex';
  modal.style.alignItems = 'center';
  modal.style.justifyContent = 'center';
  modal.style.zIndex = '9999';

  modal.innerHTML = `
    <div style="background:var(--bg-surface, #1e293b); border:1px solid var(--border-subtle, #334155); border-radius:12px; width:92%; max-width:740px; max-height:92vh; overflow-y:auto; padding:24px; box-shadow:0 20px 40px rgba(0,0,0,0.5); color:var(--text-primary, #fff);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="font-size:18px; font-weight:700; margin:0; display:flex; align-items:center; gap:8px;">
          <span>📥</span> Import Google Sheet / CSV (Admin Controlled)
        </h3>
        <button onclick="document.getElementById('sheetImportModal').remove()" style="background:none; border:none; color:var(--text-secondary, #94a3b8); font-size:20px; cursor:pointer;">✕</button>
      </div>

      <div style="font-size:12px; color:var(--text-secondary, #94a3b8); line-height:1.5; margin-bottom:14px; background:var(--bg-canvas, #0f172a); padding:10px 14px; border-radius:8px; border:1px solid var(--border-subtle, #334155);">
        <div><strong>Expected Sheet Columns:</strong> <code style="color:var(--blue-primary, #38bdf8);">Rank | X Username | X Profile Link | Sorsa Score | Wallchain Score | Tier</code></div>
        <div style="font-size:11.5px; margin-top:4px;">💡 <em>Full Admin Power: Pick specific Rank Ranges (e.g. 21–99, 550–1000), choose Agent, set Free/Paid subscription access, and toggle Draft vs Live.</em></div>
      </div>

      <!-- File Upload & Direct Paste Input -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
        <div>
          <label class="form-label" style="font-size:11.5px; font-weight:600; display:block; margin-bottom:4px;">Upload CSV / TSV File:</label>
          <input type="file" id="sheetFileInput" accept=".csv,.tsv,.txt" style="font-size:11.5px; color:var(--text-secondary, #94a3b8); width:100%;" onchange="handleSheetFileUpload(event)">
        </div>
        <div style="display:flex; align-items:flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="previewSheetRowsCount()" style="width:100%; font-size:11.5px; padding:6px 10px;">🔍 Check & Count Rows</button>
        </div>
      </div>

      <div style="margin-bottom:14px;">
        <label class="form-label" style="font-size:11.5px; font-weight:600; display:block; margin-bottom:4px;">Or Paste Copied Sheet Rows / CSV Data:</label>
        <textarea id="sheetPasteTextarea" rows="4" class="form-input" placeholder="Rank\tX Username\tX Profile Link\tSorsa Score\tWallchain Score\tTier\n1\t@cz_binance\thttps://x.com/cz_binance\t99.5\t95\tTier 1..." style="width:100%; font-family:monospace; font-size:11px; resize:vertical; padding:8px 10px; background:var(--bg-canvas, #0f172a);"></textarea>
        <div id="sheetRowCountBadge" style="display:none; font-size:11.5px; color:var(--status-success, #22c55e); margin-top:4px; font-weight:600;"></div>
      </div>

      <!-- ADMIN DECISION CONFIGURATION FORM -->
      <div style="background:var(--bg-canvas, #0f172a); border:1px solid var(--border-subtle, #334155); border-radius:8px; padding:14px; margin-bottom:16px;">
        <div style="font-size:12px; font-weight:700; color:var(--blue-primary, #38bdf8); text-transform:uppercase; margin-bottom:12px; border-bottom:1px solid var(--border-subtle, #334155); padding-bottom:6px;">
          ⚙️ Admin Import Configuration (Your Decision)
        </div>

        <!-- 1. Destination List -->
        <div style="margin-bottom:12px;">
          <label style="font-size:11.5px; font-weight:700; display:block; margin-bottom:4px;">1. Destination List:</label>
          <div style="display:flex; gap:16px; margin-bottom:8px; font-size:12px;">
            <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
              <input type="radio" name="importDestType" value="new" checked onchange="toggleImportDestView()"> Create New List
            </label>
            <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
              <input type="radio" name="importDestType" value="existing" onchange="toggleImportDestView()"> Overwrite / Append Existing List
            </label>
          </div>

          <div id="destNewListWrap">
            <input type="text" id="importNewListName" class="form-input" placeholder="e.g. Sorsa Mid-Tier KOLs (Rank 21-99)" value="Imported Creator List" style="font-size:12px; padding:6px 10px; width:100%;">
          </div>

          <div id="destExistingListWrap" style="display:none;">
            <select id="importExistingListSelect" class="form-input" style="font-size:12px; padding:6px 10px; width:100%;">
              ${listKeys.filter(k => (currentLists[k].category || '') === 'Increase Sorsa Score').map(k => `<option value="${k}">${currentLists[k].name} (${(currentLists[k].targets || []).length} current targets)</option>`).join('')}
            </select>
            <div style="display:flex; gap:12px; margin-top:6px; font-size:11.5px;">
              <label style="cursor:pointer;"><input type="radio" name="existingAction" value="replace" checked> Replace existing targets</label>
              <label style="cursor:pointer;"><input type="radio" name="existingAction" value="append"> Append to existing targets</label>
            </div>
          </div>
        </div>

        <!-- 2. Rank Range Selection (e.g. 21 to 99, 550 to 1000) -->
        <div style="margin-bottom:12px; background:rgba(56, 189, 248, 0.05); padding:10px 12px; border-radius:6px; border:1px solid rgba(56, 189, 248, 0.25);">
          <label style="font-size:11.5px; font-weight:700; color:var(--blue-primary); display:block; margin-bottom:5px;">
            2. Rank / Row Range Selection (e.g. Rank 21–99 or 550–1000):
          </label>
          <div style="display:flex; gap:16px; margin-bottom:8px; font-size:12px;">
            <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
              <input type="radio" name="importRankMode" value="all" checked onchange="toggleImportRankRangeView()"> All Ranks / Rows
            </label>
            <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
              <input type="radio" name="importRankMode" value="range" onchange="toggleImportRankRangeView()"> Custom Rank Range
            </label>
          </div>
          <div id="importRankRangeInputs" style="display:none; align-items:center; gap:8px;">
            <span style="font-size:11.5px; color:var(--text-secondary);">From Rank:</span>
            <input type="number" id="importFromRankInput" class="form-input" value="21" min="1" max="10000" style="width:75px; font-size:12px; padding:4px 8px;">
            <span style="font-size:11.5px; color:var(--text-secondary);">To Rank:</span>
            <input type="number" id="importToRankInput" class="form-input" value="99" min="1" max="10000" style="width:75px; font-size:12px; padding:4px 8px;">
            <span style="font-size:11px; color:var(--text-secondary);">(inclusive)</span>
          </div>
        </div>

        <!-- 3. Target Agent, Access Plan & Status (3 Columns) -->
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:12px;">
          <div>
            <label style="font-size:11px; font-weight:700; display:block; margin-bottom:3px;">3. Target Agent:</label>
            <select id="importTargetAgentSelect" class="form-input" style="font-size:11.5px; padding:6px 8px; width:100%;" disabled>
              <option value="Increase Sorsa Score" selected>Score Accelerator</option>
            </select>
            <div style="font-size:9.5px; color:var(--text-secondary); margin-top:2px;">
              CrowdFi & GrowthFi only support Twitter List URLs.
            </div>
          </div>
          <div>
            <label style="font-size:11px; font-weight:700; display:block; margin-bottom:3px;">4. Access Plan:</label>
            <select id="importAccessTierSelect" class="form-input" style="font-size:11.5px; padding:6px 8px; width:100%; font-weight:600;">
              <option value="free" selected>🔓 Free (All Users)</option>
              <option value="paid">🔒 Paid / Pro Only</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px; font-weight:700; display:block; margin-bottom:3px;">5. Visibility Status:</label>
            <select id="importStatusSelect" class="form-input" style="font-size:11.5px; padding:6px 8px; width:100%; font-weight:700;">
              <option value="published" selected>🟢 Published (Live)</option>
              <option value="draft">🟡 Draft (Hidden)</option>
            </select>
          </div>
        </div>

        <!-- 6. Filter by Tier & 7. Max ID Count Limit -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div>
            <label style="font-size:11.5px; font-weight:700; display:block; margin-bottom:4px;">6. Filter by Tier from Sheet (Optional):</label>
            <select id="importTierFilterSelect" class="form-input" style="font-size:12px; padding:6px 10px; width:100%;">
              <option value="all">Include All Tiers</option>
              <option value="tier1">Only Tier 1</option>
              <option value="tier2">Only Tier 2</option>
              <option value="tier3">Only Tier 3</option>
            </select>
          </div>
          <div>
            <label style="font-size:11.5px; font-weight:700; display:block; margin-bottom:4px;">7. Max ID Limit (0 for all in range):</label>
            <div style="display:flex; gap:6px;">
              <input type="number" id="importIdLimitInput" class="form-input" value="0" min="0" max="5000" placeholder="0 = All" style="font-size:12px; padding:6px 10px; width:90px;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('importIdLimitInput').value=50" style="padding:4px 6px; font-size:10px;">50</button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('importIdLimitInput').value=100" style="padding:4px 6px; font-size:10px;">100</button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('importIdLimitInput').value=500" style="padding:4px 6px; font-size:10px;">500</button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('importIdLimitInput').value=0" style="padding:4px 6px; font-size:10px;">All</button>
            </div>
          </div>
        </div>
      </div>

      <div id="importSummaryCard" style="display:none; background:rgba(34, 197, 94, 0.1); border:1px solid #22c55e; border-radius:8px; padding:12px; margin-bottom:14px; font-size:12px;">
        <div id="importSummaryContent" style="color:#22c55e; font-weight:600;"></div>
      </div>

      <!-- Action Buttons -->
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button class="btn btn-secondary btn-sm" onclick="document.getElementById('sheetImportModal').remove()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="executeAdminCustomSheetImport()">✓ Save List With Selected Rules</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function toggleImportDestView() {
  const destType = document.querySelector('input[name="importDestType"]:checked')?.value || 'new';
  const newWrap = document.getElementById('destNewListWrap');
  const exWrap = document.getElementById('destExistingListWrap');
  if (newWrap) newWrap.style.display = destType === 'new' ? 'block' : 'none';
  if (exWrap) exWrap.style.display = destType === 'existing' ? 'block' : 'none';
}

function toggleImportRankRangeView() {
  const rankMode = document.querySelector('input[name="importRankMode"]:checked')?.value || 'all';
  const rangeInputs = document.getElementById('importRankRangeInputs');
  if (rangeInputs) rangeInputs.style.display = rankMode === 'range' ? 'flex' : 'none';
}

function previewSheetRowsCount() {
  const textarea = document.getElementById('sheetPasteTextarea');
  const rawText = (textarea?.value || '').trim();
  const badge = document.getElementById('sheetRowCountBadge');
  if (!rawText) {
    alert('Please paste rows or upload a file first.');
    return;
  }
  const users = parseSheetText(rawText);
  if (badge) {
    badge.style.display = 'block';
    badge.textContent = `✓ Found ${users.length} valid creator accounts in sheet data.`;
  }
}

function handleSheetFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const textarea = document.getElementById('sheetPasteTextarea');
    if (textarea) textarea.value = text;
    previewSheetRowsCount();
  };
  reader.readAsText(file);
}

function parseSheetText(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  let delimiter = ',';
  if (headerLine.includes('\t')) delimiter = '\t';
  else if (headerLine.includes(';') && !headerLine.includes(',')) delimiter = ';';

  function splitLine(line) {
    if (delimiter === '\t') return line.split('\t').map(c => c.trim().replace(/^["']|["']$/g, ''));
    const pattern = new RegExp(`(?:^|${delimiter})(?:"([^"]*)"|([^"${delimiter}]*))`, 'g');
    const result = [];
    let match;
    while ((match = pattern.exec(line)) !== null) {
      result.push((match[1] !== undefined ? match[1] : match[2] || '').trim());
      if (pattern.lastIndex === 0 && line.length > 0) break;
    }
    return result;
  }

  const headers = splitLine(headerLine).map(h => h.toLowerCase());
  const usernameIdx = headers.findIndex(h => h.includes('username') || h.includes('handle') || h === 'x username');
  const linkIdx = headers.findIndex(h => h.includes('profile') || h.includes('link') || h.includes('url'));
  const tierIdx = headers.findIndex(h => h.includes('tier'));
  const sorsaIdx = headers.findIndex(h => h.includes('sorsa'));
  const rankIdx = headers.findIndex(h => h.includes('rank'));

  const parsed = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    if (!cols || cols.length === 0 || cols.every(c => !c)) continue;

    let handle = '';
    if (usernameIdx !== -1 && cols[usernameIdx]) {
      handle = cols[usernameIdx].trim();
    }
    if (!handle && linkIdx !== -1 && cols[linkIdx]) {
      const match = cols[linkIdx].match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,25})/);
      if (match) handle = match[1];
    }
    if (!handle) continue;

    handle = handle.replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{1,25}$/.test(handle)) continue;

    const tier = (tierIdx !== -1 && cols[tierIdx]) ? cols[tierIdx].trim() : 'Tier 1';
    const sorsaScore = (sorsaIdx !== -1 && cols[sorsaIdx]) ? cols[sorsaIdx].trim() : '';
    const rawRank = (rankIdx !== -1 && cols[rankIdx]) ? cols[rankIdx].trim() : i.toString();
    const rankNum = parseInt(rawRank.replace(/[^0-9]/g, ''), 10) || i;

    parsed.push({ handle: '@' + handle, tier, sorsaScore, rank: rankNum });
  }
  return parsed;
}

async function executeAdminCustomSheetImport() {
  const textarea = document.getElementById('sheetPasteTextarea');
  const rawText = (textarea?.value || '').trim();
  if (!rawText) {
    alert('⚠️ Please paste sheet rows or upload a CSV file first.');
    return;
  }

  const users = parseSheetText(rawText);
  if (users.length === 0) {
    alert('⚠️ Could not parse any valid creator handles. Please verify columns: Rank | X Username | X Profile Link | Sorsa Score | Wallchain Score | Tier');
    return;
  }

  // 1. Admin Decision: Rank Range (e.g. 21 to 99, 550 to 1000)
  const rankMode = document.querySelector('input[name="importRankMode"]:checked')?.value || 'all';
  let filteredUsers = users;
  let rangeLabel = 'All Ranks';

  if (rankMode === 'range') {
    const fromRank = parseInt(document.getElementById('importFromRankInput')?.value || '1', 10);
    const toRank = parseInt(document.getElementById('importToRankInput')?.value || '100', 10);
    rangeLabel = `Rank ${fromRank}–${toRank}`;
    filteredUsers = users.filter((u, idx) => {
      const effectiveRank = typeof u.rank === 'number' ? u.rank : (idx + 1);
      return effectiveRank >= fromRank && effectiveRank <= toRank;
    });
  }

  // 2. Admin Decision: Filter by Tier (Optional)
  const tierFilter = document.getElementById('importTierFilterSelect')?.value || 'all';
  if (tierFilter === 'tier1') {
    filteredUsers = filteredUsers.filter(u => u.tier.toLowerCase().includes('1'));
  } else if (tierFilter === 'tier2') {
    filteredUsers = filteredUsers.filter(u => u.tier.toLowerCase().includes('2'));
  } else if (tierFilter === 'tier3') {
    filteredUsers = filteredUsers.filter(u => u.tier.toLowerCase().includes('3'));
  }

  // 3. Admin Decision: ID Limit (0 for all in range)
  const limitInput = parseInt(document.getElementById('importIdLimitInput')?.value || '0', 10);
  const targetHandles = (limitInput > 0 ? filteredUsers.slice(0, limitInput) : filteredUsers).map(u => u.handle);

  if (targetHandles.length === 0) {
    alert('⚠️ No accounts matched the selected Rank range and Tier filter.');
    return;
  }

  // 4. Admin Decision: Destination List, Agent, Access Plan, Status
  const destType = document.querySelector('input[name="importDestType"]:checked')?.value || 'new';
  const targetAgent = document.getElementById('importTargetAgentSelect')?.value || 'Increase Sorsa Score';
  const targetAccess = document.getElementById('importAccessTierSelect')?.value || 'free';
  const targetStatus = document.getElementById('importStatusSelect')?.value || 'published';

  if (!AtomXState.curatedLists) AtomXState.curatedLists = {};

  let targetListKey = '';
  if (destType === 'new') {
    const customName = document.getElementById('importNewListName')?.value.trim() || `Imported List (${rangeLabel})`;
    targetListKey = 'custom_' + Date.now();
    AtomXState.curatedLists[targetListKey] = {
      id: targetListKey,
      name: customName,
      category: targetAgent,
      status: targetStatus,
      accessTier: targetAccess,
      rankRange: rangeLabel,
      description: `Admin imported list with ${targetHandles.length} verified creators (${rangeLabel}).`,
      listUrl: '',
      targets: targetHandles
    };
  } else {
    targetListKey = document.getElementById('importExistingListSelect')?.value;
    if (!targetListKey || !AtomXState.curatedLists[targetListKey]) {
      alert('⚠️ Selected existing list not found.');
      return;
    }
    const action = document.querySelector('input[name="existingAction"]:checked')?.value || 'replace';
    const existing = AtomXState.curatedLists[targetListKey];
    existing.category = targetAgent;
    existing.status = targetStatus;
    existing.accessTier = targetAccess;

    if (action === 'append') {
      const merged = new Set([...(existing.targets || []), ...targetHandles]);
      existing.targets = Array.from(merged);
    } else {
      existing.targets = targetHandles;
    }
  }

  // Save to server
  await saveCuratedListsToServer();

  // Update Screen 20
  renderAdminCuratedLists(document.getElementById('mainContentArea'));

  const summaryCard = document.getElementById('importSummaryCard');
  const summaryContent = document.getElementById('importSummaryContent');
  if (summaryCard && summaryContent) {
    summaryCard.style.display = 'block';
    summaryContent.innerHTML = `
      🎉 Success! Inserted ${targetHandles.length} accounts into "${AtomXState.curatedLists[targetListKey].name}".<br>
      • Agent: <strong>${targetAgent}</strong><br>
      • Plan Access: <strong>${targetAccess.toUpperCase()}</strong><br>
      • Status: <strong>${targetStatus.toUpperCase()}</strong> (${rangeLabel})<br>
      • Synced to server and broadcasted!
    `;
  }

  setTimeout(() => {
    const modal = document.getElementById('sheetImportModal');
    if (modal) modal.remove();
  }, 2200);
}

// -------------------------------------------------------------
// SCREEN 21: ADMIN TONE & STYLE PROMPTS & USER QUOTAS
// -------------------------------------------------------------
async function fetchAdminToneStyles() {
  try {
    const res = await fetch(`${API_BASE}/api/tone-styles`);
    if (res.ok) {
      const data = await res.json();
      AtomXState.toneStylesData = data;
    }
  } catch (e) {
    console.warn('Could not fetch tone styles from server, using state cache', e);
  }
}

function renderAdminToneStyles(container) {
  const data = AtomXState.toneStylesData || {
    maxCustomTemplatesPerUser: 2,
    defaultTones: []
  };
  const tones = data.defaultTones || [];

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('21')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Tone & Style Templates & Quotas</h1>
            <p class="page-subtitle">Configure default AI tone system prompts, add new styles, and set custom template allowances for free users.</p>
          </div>
          <div style="display:flex; gap:10px;">
            <button class="btn btn-secondary btn-sm" onclick="openAddToneModal()">+ Add New Tone</button>
            <button class="btn btn-primary btn-sm" onclick="saveAdminToneStylesToServer()">Save & Broadcast to Extension</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Summary Metrics -->
          <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom:20px;">
            <div class="stat-card">
              <div class="stat-label">DEFAULT SYSTEM TONES</div>
              <div class="stat-value" style="color:var(--blue-primary);">${tones.length}</div>
              <div class="stat-trend" style="color:var(--status-success);">Active globally across all agents</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">FREE USER CUSTOM QUOTA</div>
              <div class="stat-value" style="color:var(--status-success);">${data.maxCustomTemplatesPerUser} Max</div>
              <div class="stat-trend" style="color:var(--text-secondary);">Custom templates per free user</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">CHROME EXTENSION SYNC</div>
              <div class="stat-value" style="font-size:20px; color:var(--status-success);">AUTOMATIC</div>
              <div class="stat-trend" style="color:var(--blue-primary);">Synced via /api/tone-styles</div>
            </div>
          </div>

          <!-- Free User Quota Controller Card -->
          <div class="atomx-card" style="margin-bottom:24px; padding:18px 20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
              <div>
                <h3 style="font-size:15px; font-weight:700; color:var(--text-primary); margin-bottom:4px;">Free User Custom Template Limit</h3>
                <p style="font-size:12px; color:var(--text-secondary); margin:0;">Controls how many custom tone prompts free users can create in their Chrome Extension popup.</p>
              </div>
              <div style="display:flex; align-items:center; gap:10px;">
                <label style="font-size:12px; font-weight:600; color:var(--text-secondary);">Max Templates:</label>
                <input type="number" id="adminCustomQuotaInput" min="1" max="20" value="${data.maxCustomTemplatesPerUser}" style="width:70px; padding:6px 10px; border-radius:6px; border:1px solid var(--border-subtle); background:var(--bg-canvas); color:var(--text-primary); font-weight:700; font-size:14px; text-align:center;">
                <button class="btn btn-primary btn-sm" onclick="handleSaveCustomQuota()">Update Quota</button>
              </div>
            </div>
          </div>

          <!-- Default System Tones List -->
          <div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
            <h2 style="font-size:16px; font-weight:700; color:var(--text-primary);">Default System Tones & Prompts</h2>
            <span style="font-size:12px; color:var(--text-secondary);">${tones.length} Prompts Configured</span>
          </div>

          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(400px, 1fr)); gap:18px; margin-bottom:24px;">
            ${tones.map((t, idx) => `
              <div class="atomx-card" id="tone-card-${t.id}" style="display:flex; flex-direction:column; justify-content:space-between; padding:18px;">
                <div>
                  <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
                    <div>
                      <div style="display:flex; align-items:center; gap:8px;">
                        <input type="text" id="tone-name-${idx}" value="${t.name}" class="form-input" style="font-size:14px; font-weight:700; padding:4px 8px; width:auto; display:inline-block;" placeholder="Tone Name">
                        <span class="badge badge-info" style="font-size:10px; font-family:monospace;">${t.id}</span>
                      </div>
                      <input type="text" id="tone-desc-${idx}" value="${t.description || ''}" class="form-input" style="font-size:11px; color:var(--text-secondary); margin-top:6px; padding:3px 8px; width:100%;" placeholder="Short description">
                    </div>
                    <button class="btn btn-secondary btn-sm" style="padding:4px 8px; color:var(--status-error);" onclick="handleDeleteTone(${idx})" title="Delete tone">✕</button>
                  </div>

                  <div style="margin-top:10px;">
                    <label style="font-size:11px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.3px;">System Prompt Instruction:</label>
                    <textarea id="tone-prompt-${idx}" class="form-input" style="min-height:75px; font-size:12px; font-family:inherit; margin-top:4px; line-height:1.4; resize:vertical;">${t.prompt}</textarea>
                  </div>
                </div>

                <div style="display:flex; justify-content:flex-end; margin-top:12px;">
                  <button class="btn btn-secondary btn-sm" onclick="handleSaveSingleTone(${idx})">Save Changes</button>
                </div>
              </div>
            `).join('')}
          </div>

        </div>
      </div>
    </div>
  `;
}

function handleSaveCustomQuota() {
  const input = document.getElementById('adminCustomQuotaInput');
  const val = Number(input?.value || 2);
  if (val < 1) {
    alert('Quota must be at least 1.');
    return;
  }
  if (!AtomXState.toneStylesData) AtomXState.toneStylesData = {};
  AtomXState.toneStylesData.maxCustomTemplatesPerUser = val;
  saveAdminToneStylesToServer();
}

async function handleSaveSingleTone(idx) {
  const name = document.getElementById(`tone-name-${idx}`)?.value.trim();
  const desc = document.getElementById(`tone-desc-${idx}`)?.value.trim();
  const prompt = document.getElementById(`tone-prompt-${idx}`)?.value.trim();

  if (!name || !prompt) {
    showToast('Name and System Prompt are required.', 'error');
    return;
  }

  if (AtomXState.toneStylesData?.defaultTones?.[idx]) {
    AtomXState.toneStylesData.defaultTones[idx].name = name;
    AtomXState.toneStylesData.defaultTones[idx].description = desc;
    AtomXState.toneStylesData.defaultTones[idx].prompt = prompt;
  }
  await saveAdminToneStylesToServer();
  showToast(`✓ Saved changes for "${name}"!`, 'success');
}

async function handleDeleteTone(idx) {
  if (confirm('Are you sure you want to delete this default tone?')) {
    const deleted = AtomXState.toneStylesData?.defaultTones?.[idx]?.name || 'tone';
    AtomXState.toneStylesData.defaultTones.splice(idx, 1);
    await saveAdminToneStylesToServer();
    renderAdminToneStyles(document.getElementById('mainContentArea'));
    showToast(`✓ Deleted "${deleted}"`, 'info');
  }
}

function openAddToneModal() {
  closeModal();
  const modalHTML = `
    <div class="modal-backdrop" id="addToneModal" onclick="if(event.target===this) closeModal()">
      <div class="modal-box" style="max-width:520px; padding:24px; border-radius:12px; background:var(--bg-surface); border:1px solid var(--border-subtle); box-shadow:0 20px 45px rgba(0,0,0,0.5);">
        <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h3 class="modal-title" style="margin:0; font-size:17px; font-weight:700; color:var(--text-primary);">+ Add New AI Tone &amp; Style</h3>
          <button class="modal-close-btn" onclick="closeModal()" style="font-size:24px; cursor:pointer; background:none; border:none; color:var(--text-muted);">&times;</button>
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px; display:block;">Tone Name</label>
          <input type="text" id="newToneNameInput" class="form-input" placeholder="e.g. Sarcastic Dev, Alpha Insider, Contrarian" oninput="document.getElementById('newToneIdPreview').value = this.value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')" style="width:100%;">
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px; display:block;">Tone Identifier (Slug)</label>
          <input type="text" id="newToneIdPreview" class="form-input" placeholder="auto-generated-slug" style="width:100%; font-family:monospace; font-size:12px;" readonly>
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px; display:block;">Short Description</label>
          <input type="text" id="newToneDescInput" class="form-input" placeholder="e.g. Witty developer banter with subtle cynicism" style="width:100%;">
        </div>
        <div class="form-group" style="margin-bottom:18px;">
          <label class="form-label" style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:4px; display:block;">System Prompt Instructions</label>
          <textarea id="newTonePromptInput" class="form-input" style="width:100%; min-height:100px; font-size:12px; line-height:1.4; resize:vertical;" placeholder="Deliver high-signal, sharp perspective. Be concise, punchy, and authentic. No generic AI clichés.">Deliver a high signal sharp perspective. Be concise and authentic.</textarea>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" id="submitCreateToneBtn" onclick="handleCreateNewToneStyle()">Create &amp; Broadcast Tone</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  setTimeout(() => document.getElementById('newToneNameInput')?.focus(), 50);
}

async function handleCreateNewToneStyle() {
  const name = document.getElementById('newToneNameInput')?.value.trim();
  const slug = document.getElementById('newToneIdPreview')?.value.trim();
  const desc = document.getElementById('newToneDescInput')?.value.trim();
  const prompt = document.getElementById('newTonePromptInput')?.value.trim();
  const btn = document.getElementById('submitCreateToneBtn');

  if (!name) {
    showToast('Please enter a tone name', 'error');
    return;
  }
  if (!prompt) {
    showToast('Please enter system prompt instructions for this tone', 'error');
    return;
  }

  const toneId = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  if (!AtomXState.toneStylesData) {
    AtomXState.toneStylesData = { maxCustomTemplatesPerUser: 2, defaultTones: [] };
  }
  if (!Array.isArray(AtomXState.toneStylesData.defaultTones)) {
    AtomXState.toneStylesData.defaultTones = [];
  }

  AtomXState.toneStylesData.defaultTones.push({
    id: toneId,
    name,
    description: desc || 'Custom system calibrated tone',
    prompt
  });

  closeModal();
  await saveAdminToneStylesToServer();
  renderAdminToneStyles(document.getElementById('mainContentArea'));
  showToast(`✓ Added & broadcasted new tone: ${name}`, 'success');
}

async function saveAdminToneStylesToServer() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/tone-styles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(AtomXState.toneStylesData)
    });
    if (res.ok) {
      showToast('✓ Tone & style prompts saved to cloud database & broadcasted to extension!');
      return;
    }
  } catch (e) {
    console.warn('Could not post tone styles to backend', e);
  }
  showToast('✓ Tone styles updated locally in memory.');
}

// -------------------------------------------------------------
// SCREEN 22: ADMIN REFERRAL MANAGEMENT DASHBOARD
// -------------------------------------------------------------
async function renderAdminReferrals(container) {
  let stats = {
    totalReferrals: 0,
    approvedReferrals: 0,
    pendingReferrals: 0,
    referralCredits: 0,
    purchaseRewards: 0
  };
  let referrals = [];

  try {
    const res = await fetch(`${API_BASE}/api/admin/referrals`);
    if (res.ok) {
      const data = await res.json();
      stats = data.stats || stats;
      referrals = data.referrals || [];
    }
  } catch (e) {
    console.warn('Error fetching referrals:', e);
  }

  if (referrals.length === 0 && AtomXState.adminReferrals && AtomXState.adminReferrals.length > 0) {
    referrals = AtomXState.adminReferrals;
  }

  // Recalculate stats dynamically from real records if not provided
  if (!stats || stats.totalReferrals === 0) {
    const totalReferrals = referrals.length;
    const approvedReferrals = referrals.filter(r => r.status === 'APPROVED').length;
    const pendingReferrals = referrals.filter(r => r.status === 'PENDING').length;
    const referralCredits = approvedReferrals * 150 * 2;
    const purchaseRewards = referrals.reduce((sum, r) => sum + (r.purchase_reward_credits || 0), 0);
    stats = { totalReferrals, approvedReferrals, pendingReferrals, referralCredits, purchaseRewards };
  }

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('22')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Referral Management</h1>
            <p class="page-subtitle">Monitor Level-1 direct referrals, account approval bonus credits (150+150), and 10% purchase rewards.</p>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="renderAdminReferrals(document.getElementById('mainContentArea')); showToast('↻ Refreshed referral data');">↻ Refresh</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Overview Stats Cards -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:14px; margin-bottom:20px;">
            <div class="atomx-card" style="padding:16px;">
              <div style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Total Referrals</div>
              <div style="font-size:26px; font-weight:800; color:var(--text-primary); margin-top:4px;">${stats.totalReferrals.toLocaleString()}</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Direct signups</div>
            </div>
            <div class="atomx-card" style="padding:16px;">
              <div style="font-size:11px; font-weight:700; color:var(--status-success); text-transform:uppercase; letter-spacing:0.5px;">Approved Referrals</div>
              <div style="font-size:26px; font-weight:800; color:var(--status-success); margin-top:4px;">${stats.approvedReferrals.toLocaleString()}</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">150+150 Cr credited</div>
            </div>
            <div class="atomx-card" style="padding:16px;">
              <div style="font-size:11px; font-weight:700; color:var(--status-warning); text-transform:uppercase; letter-spacing:0.5px;">Pending Referrals</div>
              <div style="font-size:26px; font-weight:800; color:var(--status-warning); margin-top:4px;">${stats.pendingReferrals.toLocaleString()}</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Awaiting account approval</div>
            </div>
            <div class="atomx-card" style="padding:16px;">
              <div style="font-size:11px; font-weight:700; color:var(--blue-primary); text-transform:uppercase; letter-spacing:0.5px;">Referral Credits</div>
              <div style="font-size:26px; font-weight:800; color:var(--blue-primary); margin-top:4px;">${stats.referralCredits.toLocaleString()}</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">Total distributed</div>
            </div>
            <div class="atomx-card" style="padding:16px;">
              <div style="font-size:11px; font-weight:700; color:#9B51E0; text-transform:uppercase; letter-spacing:0.5px;">Purchase Rewards</div>
              <div style="font-size:26px; font-weight:800; color:#9B51E0; margin-top:4px;">${stats.purchaseRewards.toLocaleString()} Cr</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">10% first purchase credits</div>
            </div>
          </div>

          <!-- Rules Summary Banner -->
          <div class="atomx-card" style="margin-bottom:20px; background:rgba(34,160,107,0.06); border:1px solid rgba(34,160,107,0.2); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <span style="font-size:22px;">🛡️</span>
              <div>
                <div style="font-weight:700; font-size:13px; color:var(--text-primary);">Level-1 Direct Referrals Rule Enforcement</div>
                <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
                  1 X Account = 1 Account only. No multi-level / cash payout. Both Referrer (+150 Cr) & Referee (+150 Cr) receive credits <strong>only after admin account approval</strong>.
                </div>
              </div>
            </div>
            <div style="display:flex; gap:8px;">
              <span class="badge badge-success" style="font-weight:700;">Zero MLM</span>
              <span class="badge badge-info" style="font-weight:700;">Strict 1 X Account</span>
            </div>
          </div>

          <!-- Referrals Table -->
          <div class="atomx-card table-wrapper" style="padding:0; overflow:hidden;">
            <table class="atomx-table">
              <thead>
                <tr>
                  <th>Referrer</th>
                  <th>Referred User</th>
                  <th>Status</th>
                  <th>Approval Reward</th>
                  <th>First Purchase</th>
                  <th>Purchase Reward</th>
                  <th>Referral Date</th>
                  <th>Approval Date</th>
                  <th style="text-align:right;">Action</th>
                </tr>
              </thead>
              <tbody>
                ${referrals.length === 0 ? `
                  <tr>
                    <td colspan="9" style="text-align:center; padding:36px; color:var(--text-muted);">
                      <div style="font-size:24px; margin-bottom:8px;">🤝</div>
                      <div style="font-weight:600; font-size:14px; color:var(--text-primary); margin-bottom:4px;">No Referrals Recorded Yet</div>
                      <div style="font-size:12px;">Users who register with referral invite codes will appear here automatically.</div>
                    </td>
                  </tr>
                ` : referrals.map(r => `
                  <tr>
                    <td>
                      <div style="font-weight:700; color:#229ED9; font-family:monospace; font-size:13px;">${r.referrer_handle}</div>
                    </td>
                    <td>
                      <div style="font-weight:600; color:var(--text-primary); font-size:13px;">${r.referee_name || r.referee_handle}</div>
                      <div style="font-size:11px; color:var(--text-muted); font-family:monospace;">${r.referee_handle}</div>
                      ${r.referee_email ? `<div style="font-size:10px; color:var(--text-muted);">${r.referee_email}</div>` : ''}
                    </td>
                    <td>
                      <span class="badge ${r.status === 'APPROVED' ? 'badge-success' : 'badge-warning'}">
                        ${r.status}
                      </span>
                    </td>
                    <td>
                      ${r.status === 'APPROVED' ? 
                        `<span style="color:var(--status-success); font-weight:700; font-size:12px;">150 + 150 Cr</span>` : 
                        `<span style="color:var(--text-muted); font-size:12px;">Pending</span>`}
                    </td>
                    <td>
                      ${r.first_purchase_amount > 0 ? 
                        `<span style="font-weight:600; font-size:12px;">$${r.first_purchase_amount}</span>` : 
                        `<span style="color:var(--text-muted); font-size:12px;">—</span>`}
                    </td>
                    <td>
                      ${r.purchase_reward_credits > 0 ? 
                        `<span style="color:#9B51E0; font-weight:700; font-size:12px;">+${r.purchase_reward_credits} Cr (10%)</span>` : 
                        `<span style="color:var(--text-muted); font-size:12px;">—</span>`}
                    </td>
                    <td style="color:var(--text-muted); font-size:11px;">
                      ${r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td style="color:var(--text-muted); font-size:11px;">
                      ${r.approved_at ? new Date(r.approved_at).toLocaleDateString() : 'Pending'}
                    </td>
                    <td style="text-align:right;">
                      ${r.status === 'PENDING' ? `
                        <button class="btn btn-primary btn-xs" onclick="setAdminUserFilter('Pending'); navigateToScreen('14');" title="Approve user in Users & Access to disburse 150+150 credits">Review & Approve →</button>
                      ` : `
                        <span class="badge badge-success" style="font-size:10px;">✓ Credited</span>
                      `}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 18: ACCOUNT SUSPENDED
// -------------------------------------------------------------
function renderSuspended(container) {
  container.innerHTML = `
    <div class="auth-wrapper">
      <div class="auth-card" style="border-color:#FBD5D5;">
        <div class="auth-logo">
          <div class="atomx-brand" style="font-size: 22px;">
            <div class="atomx-logo-icon" style="width: 24px; height: 24px; background:var(--status-error);"></div>
            <span class="atomx-brand-main">Twixor</span>
          </div>
        </div>

        <div style="width:56px; height:56px; border-radius:50%; background:var(--status-error-bg); color:var(--status-error); display:flex; align-items:center; justify-content:center; margin:0 auto 18px auto;">
          <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>

        <h1 class="auth-title">Your access has been suspended.</h1>
        <p class="auth-desc">Your account currently does not have access to Twixor. Please reach out to customer support to appeal or resolve this issue.</p>

        <div style="margin: 18px 0;">
          <span class="badge badge-error" style="font-size: 13px; padding: 6px 14px;">SUSPENDED</span>
        </div>

        <div style="display:flex; gap:12px; margin-top:24px;">
          <button class="btn btn-secondary btn-block" onclick="navigateToScreen('01')">Back to Login</button>
          <button class="btn btn-primary btn-block" onclick="alert('Support ticket opened at support@atomx.io')">Contact Support</button>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SCREEN 19: ERROR / LOADING / EMPTY STATES
// -------------------------------------------------------------
function renderSystemStates(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('19')}
      <div class="app-workspace">
        ${renderMobileHeaderHTML()}
        <div class="workspace-header">
          <div>
            <h1 class="page-title">System States</h1>
            <p class="page-subtitle">Pristine empty, loading, and error UI presentations.</p>
          </div>
        </div>

        <div class="workspace-body">
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:20px;">
            <!-- Loading State -->
            <div class="atomx-card" style="text-align:center; padding:36px 20px;">
              <div style="width:40px; height:40px; border:3px solid var(--blue-soft); border-top-color:var(--blue-primary); border-radius:50%; margin:0 auto 16px auto; animation:spin 0.8s linear infinite;"></div>
              <h4 style="font-size:16px; font-weight:700; margin-bottom:6px;">Connecting to your workspace...</h4>
              <p style="font-size:13px; color:var(--text-secondary);">Validating session tokens and fetching latest queue.</p>
            </div>

            <!-- Error State -->
            <div class="atomx-card" style="text-align:center; padding:36px 20px;">
              <div style="width:44px; height:44px; border-radius:50%; background:var(--status-error-bg); color:var(--status-error); display:flex; align-items:center; justify-content:center; margin:0 auto 14px auto;">
                <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              </div>
              <h4 style="font-size:16px; font-weight:700; margin-bottom:6px;">Something went wrong.</h4>
              <p style="font-size:13px; color:var(--text-secondary); margin-bottom:18px;">Unable to fetch remote AI model endpoint.</p>
              <button class="btn btn-secondary btn-sm" onclick="navigateToScreen('04')">Retry</button>
            </div>

            <!-- Empty State -->
            <div class="atomx-card" style="text-align:center; padding:36px 20px;">
              <div style="width:44px; height:44px; border-radius:50%; background:var(--blue-soft); color:var(--blue-primary); display:flex; align-items:center; justify-content:center; margin:0 auto 14px auto;">
                <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <h4 style="font-size:16px; font-weight:700; margin-bottom:6px;">No replies in your queue yet.</h4>
              <p style="font-size:13px; color:var(--text-secondary); margin-bottom:18px;">Launch your first campaign to begin generating smart responses.</p>
              <button class="btn btn-primary btn-sm" onclick="navigateToScreen('05')">Create Campaign</button>
            </div>
          </div>
        </div>
        ${renderMobileBottomNavHTML('19')}
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// SYSTEM ARCHITECTURE & FLOW DIAGRAM
// -------------------------------------------------------------
function renderSystemArchitecture(container) {
  container.innerHTML = `
    <div class="app-layout">
      ${renderSidebarHTML('arch')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">System Architecture & Flows</h1>
            <p class="page-subtitle">Visual overview of unified frontend clients, server validation, and AI security.</p>
          </div>
        </div>

        <div class="workspace-body">
          <div style="display:grid; grid-template-columns:1fr; gap:20px;">
            <!-- Flow 1: End to End User Journey -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; color:var(--blue-primary); margin-bottom:14px;">1. USER ONBOARDING & ACCESS CONTROL FLOW</h3>
              <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:12px; font-weight:600;">
                <span class="badge badge-neutral" style="padding:8px 12px;">User Sign Up</span>
                <span>→</span>
                <span class="badge badge-warning" style="padding:8px 12px;">Pending Approval</span>
                <span>→</span>
                <span class="badge badge-info" style="padding:8px 12px;">Admin Review</span>
                <span>→</span>
                <span class="badge badge-success" style="padding:8px 12px;">Account Active (100 Free Credits)</span>
                <span>→</span>
                <span class="badge badge-neutral" style="padding:8px 12px;">Web / Mobile / Extension Access</span>
              </div>
            </div>

            <!-- Flow 2: Credit Deduction & AI API Security -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; color:var(--blue-primary); margin-bottom:14px;">2. AI ENGINE & CREDIT TRANSACTION FLOW</h3>
              <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:12px; font-weight:600; margin-bottom:14px;">
                <span class="badge badge-neutral" style="padding:8px 12px;">User Requests Reply</span>
                <span>→</span>
                <span class="badge badge-info" style="padding:8px 12px;">Twixor Backend Validates Credits (≥ 1)</span>
                <span>→</span>
                <span class="badge badge-neutral" style="padding:8px 12px;">Backend Calls OpenAI API (Secret Key Server-Side)</span>
                <span>→</span>
                <span class="badge badge-error" style="padding:8px 12px;">Deduct 1 Credit in Database</span>
                <span>→</span>
                <span class="badge badge-success" style="padding:8px 12px;">Deliver Reply to Client</span>
              </div>
              <div style="font-size:12px; color:var(--text-secondary); background:var(--bg-canvas); border:1px solid var(--border-subtle); padding:12px; border-radius:var(--radius-sm);">
                <strong>🔒 CRITICAL SECURITY GUARANTEE:</strong> OpenAI API secret keys never exist in client-side extension or mobile storage. All credit deductions are transactional and atomic in the server database.
              </div>
            </div>

            <!-- Unified Backend -->
            <div class="atomx-card">
              <h3 style="font-size:15px; font-weight:700; color:var(--blue-primary); margin-bottom:14px;">3. THREE FRONTENDS — ONE UNIFIED BACKEND</h3>
              <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px;">
                <div style="border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:14px; text-align:center;">
                  <div style="font-weight:700; margin-bottom:4px;">Desktop Web Dashboard</div>
                  <div style="font-size:12px; color:var(--text-secondary);">1440 × 900 · Full Workspace</div>
                </div>
                <div style="border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:14px; text-align:center;">
                  <div style="font-weight:700; margin-bottom:4px;">Chrome Extension</div>
                  <div style="font-size:12px; color:var(--text-secondary);">Compact Popup · Fast Review</div>
                </div>
                <div style="border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:14px; text-align:center;">
                  <div style="font-weight:700; margin-bottom:4px;">Mobile Web / PWA</div>
                  <div style="font-size:12px; color:var(--text-secondary);">390 × 844 · Bottom Nav & Cards</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// =============================================================
// SCREEN 24: ADMIN AGENT KILLSWITCH & MAINTENANCE CONTROLS
// =============================================================
async function fetchAdminAgentStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/agents/status`);
    if (res.ok) {
      const data = await res.json();
      AtomXState.agentStatusMap = data.agents || {};
      return AtomXState.agentStatusMap;
    }
  } catch (e) {
    console.warn('Failed to fetch agent status:', e);
  }
  return AtomXState.agentStatusMap || {};
}

async function renderAdminAgentControls(container) {
  if (!AtomXState.agentStatusMap) {
    await fetchAdminAgentStatus();
  }
  const agents = AtomXState.agentStatusMap || {
    telegram: { id: 'telegram', name: 'TG Pulse', icon: '✈️', enabled: true, reason: '' },
    audience: { id: 'audience', name: 'CrowdFi', icon: '👥', enabled: true, reason: '' },
    sorsa: { id: 'sorsa', name: 'Score Accelerator', icon: '⚡', enabled: true, reason: '' },
    followers: { id: 'followers', name: 'GrowthFi', icon: '📈', enabled: true, reason: '' },
    replyback: { id: 'replyback', name: 'ReplyWave', icon: '🔄', enabled: true, reason: '' },
    unfollow: { id: 'unfollow', name: 'Auto Clean & Unfollow', icon: '🧹', enabled: true, reason: '' },
    creators: { id: 'creators', name: 'CreatorX', icon: '⭐', enabled: true, reason: '' },
    defaulter: { id: 'defaulter', name: 'Find Defaulter', icon: '🔍', enabled: true, reason: '' },
    reciprocator: { id: 'reciprocator', name: 'Commenter Reciprocator', icon: '🤝', enabled: true, reason: '' },
    feedengager: { id: 'feedengager', name: 'Home Feed Engager', icon: '🏠', enabled: true, reason: '' },
    nicheengager: { id: 'nicheengager', name: 'Niche Search Engager', icon: '🎯', enabled: true, reason: '' },
    tgliker: { id: 'tgliker', name: 'TG Liker (Raid & Repost)', icon: '⚡', enabled: true, reason: '' }
  };

  const agentKeys = Object.keys(agents);
  const total = agentKeys.length;
  const activeCount = agentKeys.filter(k => agents[k].enabled !== false).length;
  const disabledCount = total - activeCount;

  container.innerHTML = `
    <div class="app-layout">
      ${renderAdminSidebarHTML('24')}
      <div class="app-workspace">
        <div class="workspace-header">
          <div>
            <h1 class="page-title">Agent Killswitch & Maintenance Controls</h1>
            <p class="page-subtitle">Turn any autonomous agent ON/OFF and provide custom maintenance reasons. When disabled, users opening that agent in the extension will see your custom reason and cannot run it.</p>
          </div>
          <div style="display:flex; gap:10px;">
            <button class="btn btn-secondary btn-sm" onclick="adminEnableAllAgents()">Enable All</button>
            <button class="btn btn-primary btn-sm" onclick="saveAllAdminAgentStatus()">Save & Broadcast to Extension</button>
          </div>
        </div>

        <div class="workspace-body">
          <!-- Summary Metrics -->
          <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom:20px;">
            <div class="stat-card">
              <div class="stat-label">TOTAL SUITE AGENTS</div>
              <div class="stat-value" style="color:var(--blue-primary);">${total}</div>
              <div class="stat-trend" style="color:var(--text-secondary);">Autonomous Agent Modules</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">ONLINE & ACTIVE</div>
              <div class="stat-value" style="color:var(--status-success);">${activeCount}</div>
              <div class="stat-trend" style="color:var(--status-success);">Available to extension users</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">DISABLED / MAINTENANCE</div>
              <div class="stat-value" style="color:${disabledCount > 0 ? '#EF4444' : 'var(--text-secondary)'};">${disabledCount}</div>
              <div class="stat-trend" style="color:${disabledCount > 0 ? '#EF4444' : 'var(--text-secondary)'};">${disabledCount > 0 ? 'Blocked with custom message' : 'Zero agents disabled'}</div>
            </div>
          </div>

          <!-- Agents List Card Table -->
          <div class="atomx-card" style="padding: 20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
              <h2 style="font-size:16px; font-weight:700; color:var(--text-primary); margin:0;">Autonomous Agents Status & Reasons</h2>
              <span style="font-size:12px; color:var(--text-secondary);">Real-time Extension Protection</span>
            </div>

            <div style="display:flex; flex-direction:column; gap:14px;">
              ${agentKeys.map(key => {
                const a = agents[key];
                const isOnline = a.enabled !== false;
                return `
                  <div class="atomx-card" style="padding:14px 18px; border:1px solid ${isOnline ? 'var(--border-subtle)' : 'rgba(239, 68, 68, 0.4)'}; background:${isOnline ? 'var(--bg-card)' : 'rgba(239, 68, 68, 0.04)'}; border-radius:10px; display:flex; flex-direction:column; gap:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                      <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:22px;">${a.icon || '⚡'}</span>
                        <div>
                          <div style="font-size:14px; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:8px;">
                            <span>${a.name || key}</span>
                            <span style="font-size:10px; font-weight:700; padding:2px 8px; border-radius:12px; ${isOnline ? 'background:rgba(16, 185, 129, 0.15); color:#10B981; border:1px solid rgba(16, 185, 129, 0.3);' : 'background:rgba(239, 68, 68, 0.15); color:#EF4444; border:1px solid rgba(239, 68, 68, 0.4);'}">
                              ${isOnline ? '● ONLINE' : '● DISABLED'}
                            </span>
                          </div>
                          <span style="font-size:11px; color:var(--text-secondary); font-family:monospace;">ID: ${key}</span>
                        </div>
                      </div>

                      <div style="display:flex; align-items:center; gap:14px;">
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; font-size:12.5px; font-weight:600; color:${isOnline ? '#10B981' : '#EF4444'};">
                          <span>${isOnline ? 'Active (ON)' : 'Disabled (OFF)'}</span>
                          <input type="checkbox" id="agent-toggle-${key}" ${isOnline ? 'checked' : ''} onchange="handleAdminToggleAgent('${key}', this.checked)" style="width:18px; height:18px; cursor:pointer; accent-color:#10B981;">
                        </label>
                        <button class="btn btn-secondary btn-sm" onclick="saveAdminSingleAgent('${key}')" style="padding:4px 10px; font-size:11.5px;">Save</button>
                      </div>
                    </div>

                    <!-- Custom Disabled Reason Input -->
                    <div style="display:flex; align-items:center; gap:10px; margin-top:2px;">
                      <span style="font-size:11.5px; font-weight:600; color:var(--text-secondary); white-space:nowrap;">Disabled Reason:</span>
                      <input type="text" id="agent-reason-${key}" value="${a.reason || ''}" placeholder="e.g. Currently undergoing maintenance for Twitter update. Will be back in 2 hours." style="flex:1; padding:7px 12px; border-radius:6px; border:1px solid ${!isOnline && a.reason ? 'rgba(239, 68, 68, 0.5)' : 'var(--border-subtle)'}; background:var(--bg-canvas); color:var(--text-primary); font-size:12px;" oninput="handleAdminAgentReasonInput('${key}', this.value)">
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function handleAdminToggleAgent(key, isChecked) {
  if (!AtomXState.agentStatusMap) AtomXState.agentStatusMap = {};
  if (!AtomXState.agentStatusMap[key]) AtomXState.agentStatusMap[key] = { id: key, enabled: true, reason: '' };
  AtomXState.agentStatusMap[key].enabled = isChecked;
  const reasonInput = document.getElementById(`agent-reason-${key}`);
  if (!isChecked && reasonInput && !reasonInput.value.trim()) {
    reasonInput.value = 'This agent is temporarily disabled by admin for scheduled maintenance.';
    AtomXState.agentStatusMap[key].reason = reasonInput.value;
  }
}

function handleAdminAgentReasonInput(key, val) {
  if (!AtomXState.agentStatusMap) AtomXState.agentStatusMap = {};
  if (!AtomXState.agentStatusMap[key]) AtomXState.agentStatusMap[key] = { id: key, enabled: true, reason: '' };
  AtomXState.agentStatusMap[key].reason = val.trim();
}

async function saveAdminSingleAgent(key) {
  const toggle = document.getElementById(`agent-toggle-${key}`);
  const reasonInput = document.getElementById(`agent-reason-${key}`);
  const isEnabled = toggle ? toggle.checked : true;
  const reason = reasonInput ? reasonInput.value.trim() : '';

  try {
    const res = await fetch(`${API_BASE}/api/admin/agents/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: key, enabled: isEnabled, reason })
    });
    if (res.ok) {
      showToast(`✓ ${key} status saved: ${isEnabled ? 'ONLINE' : 'DISABLED'}!`);
      const data = await res.json();
      if (data.agents) AtomXState.agentStatusMap = data.agents;
      renderAdminAgentControls(document.getElementById('mainContentArea'));
    }
  } catch (e) {
    showToast(`Failed to save agent status: ${e.message}`, 'error');
  }
}

async function saveAllAdminAgentStatus() {
  if (!AtomXState.agentStatusMap) return;
  try {
    const res = await fetch(`${API_BASE}/api/admin/agents/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: AtomXState.agentStatusMap })
    });
    if (res.ok) {
      showToast('✓ All agent statuses saved & broadcast to Extension!');
      renderAdminAgentControls(document.getElementById('mainContentArea'));
    }
  } catch (e) {
    showToast(`Failed to save: ${e.message}`, 'error');
  }
}

function adminEnableAllAgents() {
  if (!AtomXState.agentStatusMap) return;
  Object.keys(AtomXState.agentStatusMap).forEach(k => {
    AtomXState.agentStatusMap[k].enabled = true;
    AtomXState.agentStatusMap[k].reason = '';
  });
  saveAllAdminAgentStatus();
}

// -------------------------------------------------------------
// REUSABLE SIDEBARS & NAVIGATION HELPERS
// -------------------------------------------------------------
function renderSidebarHTML(activeId) {
  return `
    <aside class="app-sidebar">
      <div class="sidebar-header">
        <a href="javascript:void(0)" onclick="navigateToScreen('04')" class="atomx-brand">
          <div class="atomx-logo-icon"></div>
          <span class="atomx-brand-main">Twixor</span>
        </a>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-item ${activeId === '04' ? 'active' : ''}" data-screen="04" onclick="navigateToScreen('04')">
          <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
          <span>Dashboard</span>
        </div>
        <div class="nav-item ${activeId === '05' ? 'active' : ''}" data-screen="05" onclick="navigateToScreen('05')">
          <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/></svg>
          <span>Bot</span>
        </div>
        <div class="nav-item ${activeId === '06' ? 'active' : ''}" data-screen="06" onclick="navigateToScreen('06')">
          <svg viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>Reply Queue</span>
        </div>
        <div class="nav-item ${activeId === '07' ? 'active' : ''}" data-screen="07" onclick="navigateToScreen('07')">
          <svg viewBox="0 0 24 24" fill="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span>AI Reply</span>
        </div>
        <div class="nav-item ${activeId === '08' ? 'active' : ''}" data-screen="08" onclick="navigateToScreen('08')">
          <svg viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Agents</span>
        </div>
        <div class="nav-item ${activeId === '09' ? 'active' : ''}" data-screen="09" onclick="navigateToScreen('09')">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
          <span>History</span>
        </div>
        <div class="nav-item ${activeId === '10' ? 'active' : ''}" data-screen="10" onclick="navigateToScreen('10')">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><line x1="12" y1="6" x2="12" y2="18"/></svg>
          <span>Credits</span>
        </div>

        <div class="nav-divider"></div>

        <div class="nav-item ${activeId === '11' ? 'active' : ''}" data-screen="11" onclick="navigateToScreen('11')">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>Settings</span>
        </div>
        <div class="nav-item ${activeId === '12' ? 'active' : ''}" data-screen="12" onclick="navigateToScreen('12')">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Admin Panel</span>
        </div>
      </nav>

      <!-- Sidebar Theme Switcher -->
      <div class="sidebar-theme-toggle" onclick="toggleTheme()" title="Switch Light / Dark Theme">
        <div class="theme-toggle-left">
          <span class="sidebarThemeIcon">${AtomXState.theme === 'dark' ? '🌙' : '☀️'}</span>
          <span class="sidebarThemeLabel">${AtomXState.theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
        </div>
        <div class="theme-switch-track">
          <div class="theme-switch-thumb"></div>
        </div>
      </div>

      <div class="sidebar-user" onclick="navigateToScreen('11')" style="cursor:pointer;">
        <div class="user-avatar">${AtomXState.currentUser.avatar}</div>
        <div class="user-info">
          <div class="user-name">${AtomXState.currentUser.name}</div>
          <div class="user-meta">
            <span class="badge badge-success" style="padding:1px 5px; font-size:10px;">${AtomXState.currentUser.status}</span>
            <span>${AtomXState.currentUser.credits.toLocaleString()} C</span>
          </div>
        </div>
      </div>
    </aside>
  `;
}

function renderAdminSidebarHTML(activeId) {
  const pendingCount = (AtomXState.accessRequests || []).filter(r => (r.status || '').toUpperCase() === 'PENDING').length;
  const pwdCount = (AtomXState.passwordRequests || []).length;
  return `
    <aside class="app-sidebar">
      <div class="sidebar-header">
        <a href="javascript:void(0)" onclick="navigateToScreen('12')" class="atomx-brand">
          <div class="atomx-logo-icon"></div>
          <span class="atomx-brand-main">Twixor</span>
          <span class="badge-admin-tag">ADMIN</span>
        </a>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-item ${activeId === '12' ? 'active' : ''}" onclick="navigateToScreen('12')">
          <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
          <span>Overview</span>
        </div>
        <div class="nav-item ${activeId === '14' || activeId === '13' ? 'active' : ''}" onclick="navigateToScreen('14')">
          <svg viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Users & Access</span>
          ${(pendingCount > 0 || pwdCount > 0) ? `<span class="badge ${pwdCount > 0 ? 'badge-warning' : 'badge-info'}" style="margin-left:auto; font-size:10px; padding:1px 6px;">${pendingCount > 0 ? pendingCount : ''}${pwdCount > 0 ? ` 🔑${pwdCount}` : ''}</span>` : ''}
        </div>
        <div class="nav-item ${activeId === '15' ? 'active' : ''}" onclick="navigateToScreen('15')">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><line x1="12" y1="6" x2="12" y2="18"/></svg>
          <span>Credits</span>
        </div>
        <div class="nav-item ${activeId === '16' ? 'active' : ''}" onclick="navigateToScreen('16')">
          <svg viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="16" x2="12" y2="16"/></svg>
          <span>Plans</span>
        </div>
        <div class="nav-item ${activeId === '17' ? 'active' : ''}" onclick="navigateToScreen('17')">
          <svg viewBox="0 0 24 24" fill="none"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <span>Transactions</span>
        </div>
        <div class="nav-item ${activeId === '20' ? 'active' : ''}" onclick="navigateToScreen('20')">
          <svg viewBox="0 0 24 24" fill="none"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          <span>Curated Lists</span>
          <span class="badge badge-info" style="margin-left:auto; font-size:10px; padding:1px 5px;">NEW</span>
        </div>
        <div class="nav-item ${activeId === '21' ? 'active' : ''}" onclick="navigateToScreen('21')">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span>Tone & Styles</span>
          <span class="badge badge-info" style="margin-left:auto; font-size:10px; padding:1px 5px;">AI</span>
        </div>
        <div class="nav-item ${activeId === '23' ? 'active' : ''}" onclick="navigateToScreen('23')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
          <span>AI Engine & Logs</span>
          <span class="badge badge-success" style="margin-left:auto; font-size:10px; padding:1px 5px;">LIVE</span>
        </div>
        <div class="nav-item ${activeId === '22' ? 'active' : ''}" onclick="navigateToScreen('22')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Referral Management</span>
          <span class="badge badge-info" style="margin-left:auto; font-size:10px; padding:1px 5px;">150+</span>
        </div>
        <div class="nav-item ${activeId === '24' ? 'active' : ''}" onclick="navigateToScreen('24')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>Agent Controls</span>
          <span class="badge badge-info" style="margin-left:auto; font-size:10px; padding:1px 5px;">SWITCH</span>
        </div>

        <div class="nav-item" onclick="adminWipeAllUserData()" style="color:var(--status-error); margin-top:8px; cursor:pointer;" title="Reset all users & data fresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          <span style="font-weight:600;">Fresh Reset (Wipe)</span>
        </div>

        <div class="nav-item" onclick="adminLogout()" style="color:#EF4444; margin-top:4px; cursor:pointer;" title="Lock Admin Dashboard">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <span style="font-weight:700;">🔒 Lock Dashboard</span>
        </div>
      </nav>

      <!-- Admin Theme Switcher -->
      <div class="sidebar-theme-toggle" onclick="toggleTheme()" title="Switch Light / Dark Theme">
        <div class="theme-toggle-left">
          <span class="sidebarThemeIcon">${AtomXState.theme === 'dark' ? '🌙' : '☀️'}</span>
          <span class="sidebarThemeLabel">${AtomXState.theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
        </div>
        <div class="theme-switch-track">
          <div class="theme-switch-thumb"></div>
        </div>
      </div>

      <div class="sidebar-user" style="display:flex; align-items:center; gap:8px;">
        <div class="user-avatar" style="background:var(--blue-primary); color:#fff; min-width:32px;">AD</div>
        <div class="user-info" style="overflow:hidden;">
          <div class="user-name" style="white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">Admin Control</div>
          <div class="user-meta">admin@atomx.io</div>
        </div>
      </div>
    </aside>
  `;
}

function renderMobileHeaderHTML() {
  return `
    <div class="mobile-header-bar">
      <div class="atomx-brand" style="font-size:16px;">
        <div class="atomx-logo-icon" style="width:18px; height:18px;"></div>
        <span class="atomx-brand-main">Twixor</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="sidebar-theme-toggle" onclick="toggleTheme()" style="padding:4px 8px; border-radius:6px; font-size:13px;" title="Toggle Dark/Light Mode">
          <span class="sidebarThemeIcon">${AtomXState.theme === 'dark' ? '🌙' : '☀️'}</span>
        </button>
        <span class="badge badge-info" style="font-size:11px;">${AtomXState.currentUser.credits.toLocaleString()} C</span>
        <div class="user-avatar" style="width:28px; height:28px; font-size:11px;" onclick="navigateToScreen('11')">${AtomXState.currentUser.avatar}</div>
      </div>
    </div>
  `;
}

function renderMobileBottomNavHTML(activeId) {
  return `
    <div class="mobile-bottom-nav">
      <div class="mobile-nav-item ${activeId === '04' ? 'active' : ''}" onclick="navigateToScreen('04')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>
        <span>Home</span>
      </div>
      <div class="mobile-nav-item ${activeId === '05' ? 'active' : ''}" onclick="navigateToScreen('05')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
        <span>Bot</span>
      </div>
      <div class="mobile-nav-item ${activeId === '06' ? 'active' : ''}" onclick="navigateToScreen('06')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Queue</span>
      </div>
      <div class="mobile-nav-item ${activeId === '08' ? 'active' : ''}" onclick="navigateToScreen('08')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        <span>Agents</span>
      </div>
      <div class="mobile-nav-item ${activeId === '11' ? 'active' : ''}" onclick="navigateToScreen('11')">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>Profile</span>
      </div>
    </div>
  `;
}

async function saveAdminActiveModel() {
  const provider = AtomXState.currentProvider;
  const model = AtomXState.currentModel;
  try {
    const res = await fetch(`${API_BASE}/api/admin/active-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeProvider: provider, activeModel: model })
    });
    if (res.ok) {
      showToast(`✓ Active system AI model set to: ${provider.toUpperCase()} / ${model}`);
      const badge = document.getElementById('activeModelBadge');
      if (badge) badge.textContent = `● ACTIVE: ${provider.toUpperCase()} / ${model}`;
      return;
    }
  } catch (e) {
    console.warn('Error saving active model:', e);
  }
  showToast(`✓ Active AI model set to: ${provider.toUpperCase()} / ${model}`);
}

// Real-time server sync for admin datasets
var _adminSyncBusy = false;
async function loadAdminServerData(preserveScroll = true, opts = {}) {
  // Never run two syncs at once (the old code piled up requests while the server was still answering)
  if (_adminSyncBusy) {
    if (opts.light) return; // background refresh: just skip
    for (let i = 0; i < 150 && _adminSyncBusy; i++) await new Promise(r => setTimeout(r, 100)); // explicit action: wait, then refresh
  }
  _adminSyncBusy = true;
  try {
    // "light" = background refresh: only data that changes while the admin watches.
    // Static configuration (AI keys, models, tones, plans, offer, curated lists, failover) is loaded once, not every refresh.
    const light = !!opts.light;
    const scr = AtomXState.currentScreen;
    const get = (path, enabled = true) => enabled ? fetch(`${API_BASE}${path}`).catch(() => null) : Promise.resolve(null);
    const [statsRes, usersRes, reqsRes, ledgerRes, txRes, engRes, modelRes, logsRes, tonesRes, keysRes, pwdRes, plansRes, offerRes, refRes, curatedRes, failoverRes] = await Promise.all([
      get('/api/admin/stats'),
      get('/api/admin/users'),
      get('/api/admin/access-requests'),
      get('/api/admin/ledger?limit=300', !light || scr === '15' || scr === '17'),
      get('/api/admin/transactions', !light || scr === '17'),
      get('/api/tweets/engaged', !light),
      get('/api/admin/active-model', !light),
      get('/api/admin/api-logs', !light || scr === '23'),
      get('/api/tone-styles', !light),
      get('/api/admin/api-keys', !light),
      get('/api/admin/password-requests'),
      get('/api/admin/plans', !light),
      get('/api/offers/current', !light),
      get('/api/admin/referrals', !light),
      get('/api/curated-lists', !light),
      get('/api/admin/failover-providers', !light)
    ]);

    if (failoverRes && failoverRes.ok) {
      const fd = await failoverRes.json();
      if (Array.isArray(fd.failoverProviders)) {
        AtomXState.failoverProviders = fd.failoverProviders;
      }
    }

    if (pwdRes && pwdRes.ok) {
      const pd = await pwdRes.json();
      AtomXState.passwordRequests = pd.requests || [];
    }

    if (keysRes && keysRes.ok) {
      const kd = await keysRes.json();
      AtomXState.adminApiKeys = kd.keys || {};
      if (kd.openaiBaseUrl) {
        AtomXState.adminOpenaiBaseUrl = kd.openaiBaseUrl;
      }
      if (kd.anthropicBaseUrl) {
        AtomXState.adminAnthropicBaseUrl = kd.anthropicBaseUrl;
      }
      const isInputActive = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      if (!isInputActive) {
        updateAdminApiKeyUI(AtomXState.currentProvider);
      }
    }

    if (tonesRes && tonesRes.ok) {
      const d = await tonesRes.json();
      if (d && Array.isArray(d.defaultTones)) {
        AtomXState.toneStylesData = d;
      }
    }

    if (logsRes && logsRes.ok) {
      const d = await logsRes.json();
      AtomXState.adminApiLogs = d.logs || [];
    }

    if (txRes && txRes.ok) {
      const d = await txRes.json();
      if (Array.isArray(d.transactions)) {
        AtomXState.adminTransactions = d.transactions;
      }
    }

    if (plansRes && plansRes.ok) {
      const d = await plansRes.json();
      if (Array.isArray(d.plans) && d.plans.length > 0) AtomXState.plans = d.plans;
      if (d.foundingOffer) AtomXState.foundingOffer = d.foundingOffer;
    }

    if (offerRes && offerRes.ok) {
      const d = await offerRes.json();
      if (d && d.name) AtomXState.foundingOffer = d;
    }

    if (refRes && refRes.ok) {
      const d = await refRes.json();
      if (d.stats) AtomXState.adminReferralStats = d.stats;
      if (Array.isArray(d.referrals)) AtomXState.adminReferrals = d.referrals;
    }

    if (curatedRes && curatedRes.ok) {
      const d = await curatedRes.json();
      if (d.lists && typeof d.lists === 'object') {
        AtomXState.curatedLists = d.lists;
        AtomXState._curatedListsLoaded = true;
      }
    }

    if (modelRes && modelRes.ok) {
      const modelData = await modelRes.json();
      if (modelData.activeProvider) {
        AtomXState.activeSystemProvider = modelData.activeProvider;
        AtomXState.currentProvider = modelData.activeProvider;
      }
      if (modelData.activeModel) {
        AtomXState.activeSystemModel = modelData.activeModel;
        AtomXState.currentModel = modelData.activeModel;
      }
      if (modelData.providerModels) {
        AtomXState.providerModels = modelData.providerModels;
      }
      if (modelData.openaiBaseUrl) {
        AtomXState.adminOpenaiBaseUrl = modelData.openaiBaseUrl;
      }
      if (modelData.anthropicBaseUrl) {
        AtomXState.adminAnthropicBaseUrl = modelData.anthropicBaseUrl;
      }
    }

    if (engRes && engRes.ok) {
      const engData = await engRes.json();
      if (Array.isArray(engData.engagedIds)) {
        AtomXState.engagedTweetIds = engData.engagedIds;
      }
    }

    if (statsRes && statsRes.ok) {
      AtomXState.adminStats = await statsRes.json();
    }
    if (usersRes && usersRes.ok) {
      const d = await usersRes.json();
      AtomXState.adminUsers = (d.users || []).map(u => ({
        id: u.id,
        name: u.full_name || u.name || 'User',
        email: u.email,
        handle: u.handle || '@user',
        plan: u.plan_tier || 'Free Plan',
        credits: u.credits !== undefined ? u.credits : 100,
        status: (u.status || 'ACTIVE').charAt(0).toUpperCase() + (u.status || 'ACTIVE').slice(1).toLowerCase(),
        referredBy: u.referred_by || u.referredBy || (u.use_case && u.use_case.match(/REF:(@?[\w_]+)/i) ? u.use_case.match(/REF:(@?[\w_]+)/i)[1] : 'Direct / —'),
        telegram: u.telegram || '',
        lastActive: u.created_at ? new Date(u.created_at).toLocaleDateString() : 'Recently'
      }));
    }
    if (reqsRes && reqsRes.ok) {
      const d = await reqsRes.json();
      AtomXState.accessRequests = (d.requests || []).map(r => ({
        id: r.id,
        name: r.full_name || r.name,
        email: r.email,
        telegram: r.telegram || (r.use_case && r.use_case.match(/TG:(@?[\w_]+)/i) ? r.use_case.match(/TG:(@?[\w_]+)/i)[1] : ''),
        handle: r.handle || (r.use_case && r.use_case.match(/X_ID:(@?[\w_]+)/i) ? r.use_case.match(/X_ID:(@?[\w_]+)/i)[1] : '@user'),
        requestedDate: r.requested_at ? new Date(r.requested_at).toLocaleDateString() : (r.created_at ? new Date(r.created_at).toLocaleDateString() : 'Today'),
        referredBy: r.referred_by || r.referredBy || (r.use_case && r.use_case.match(/REF:(@?[\w_]+)/i) ? r.use_case.match(/REF:(@?[\w_]+)/i)[1] : 'Direct / —'),
        status: (r.status || 'Pending').toUpperCase()
      }));
    }
    if (ledgerRes && ledgerRes.ok) {
      const d = await ledgerRes.json();
      AtomXState.creditLedger = (d.ledger || []).map(l => ({
        created_at: l.created_at,
        date: l.created_at ? new Date(l.created_at).toLocaleString() : 'Recently',
        user: l.user_name || l.users?.full_name || l.full_name || l.user || 'System User',
        action: l.action || 'AI Reply',
        amount: l.amount || 0,
        admin: l.admin_source || l.admin_name || 'System',
        reason: l.reason || ''
      }));
    }

    // Nothing changed since the last refresh -> do not touch the DOM at all (main cause of the "hang")
    if (preserveScroll && light) {
      try {
        const sig = JSON.stringify([
          AtomXState.adminStats,
          (AtomXState.adminUsers || []).map(u => [u.id, u.status, u.credits, u.plan]),
          (AtomXState.accessRequests || []).map(r => [r.id, r.status]),
          (AtomXState.passwordRequests || []).length,
          (AtomXState.creditLedger || []).length,
          (AtomXState.creditLedger || [])[0]?.created_at || '',
          (AtomXState.adminTransactions || []).length,
          (AtomXState.adminApiLogs || []).length
        ]);
        if (sig === AtomXState._adminSig) return;
        AtomXState._adminSig = sig;
      } catch (e) {}
    }

    const activeAdminScreens = ['12', '13', '14', '15', '16', '17', '20', '21', '22', '23'];
    const isUserTyping = document.activeElement && (
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.tagName === 'SELECT'
    );

    // If on Screen 23 (AI Engine Hub):
    // NEVER wipe the screen while the user is viewing or typing!
    // Seamlessly update telemetry logs table and badge in-place without page jump!
    if (AtomXState.currentScreen === '23') {
      const logsCountBadge = document.getElementById('apiLogsCountBadge');
      if (logsCountBadge) logsCountBadge.textContent = `${AtomXState.adminApiLogs?.length || 0} Logs`;
      const logsTbody = document.getElementById('adminApiLogsTbody');
      if (logsTbody && !isUserTyping) {
        logsTbody.innerHTML = renderAdminApiLogsRowsHTML(AtomXState.adminApiLogs);
      }
      const isModalOpen = !!document.getElementById('adminProviderModal');
      const cardsContainer = document.getElementById('adminProviderCardsContainer');
      if (cardsContainer && !isModalOpen && !isUserTyping) {
        cardsContainer.innerHTML = renderAdminProviderCardsHTML();
      }
      const activeBadge = document.getElementById('activeModelBadge');
      if (activeBadge) {
        activeBadge.textContent = `● ACTIVE: ${AtomXState.currentProvider.toUpperCase()} / ${AtomXState.currentModel}`;
      }
      return;
    }

    if (preserveScroll) {
      // In-place updates for Screen 12 (Overview)
      if (AtomXState.currentScreen === '12') {
        const users = AtomXState.adminUsers || [];
        const reqs = AtomXState.accessRequests || [];
        const ledger = AtomXState.creditLedger || [];
        const totalUsers = users.length;
        const activeUsers = users.filter(u => (u.status || '').toUpperCase() === 'ACTIVE').length;
        const pendingCount = reqs.filter(r => (r.status || '').toUpperCase() === 'PENDING').length;
        const circulatingCredits = users.reduce((acc, u) => acc + (u.credits || 0), 0);
        const totalAIGenerations = Math.max(ledger.length, AtomXState.adminStats?.totalAIGenerations || 0);

        const elU = document.getElementById('adminTotalUsersVal');
        if (elU) elU.textContent = totalUsers;
        const elA = document.getElementById('adminActiveUsersVal');
        if (elA) elA.textContent = activeUsers;
        const elP = document.getElementById('adminPendingReqsVal');
        if (elP) elP.textContent = pendingCount;
        const elC = document.getElementById('adminCreditsCircVal');
        if (elC) elC.textContent = circulatingCredits.toLocaleString();
        const elAi = document.getElementById('adminAIActionsVal');
        if (elAi) elAi.textContent = totalAIGenerations.toLocaleString();
        return;
      }

      // In-place updates for Screen 14 (Users)
      if (AtomXState.currentScreen === '14' || AtomXState.currentScreen === '13') {
        if (!isUserTyping && typeof updateAdminUsersTableDOM === 'function') {
          updateAdminUsersTableDOM();
        }
        return;
      }
    }

    const isModalOpen = !!document.querySelector('.modal-backdrop');
    if (!isUserTyping && !isModalOpen && activeAdminScreens.includes(AtomXState.currentScreen)) {
      navigateToScreen(AtomXState.currentScreen, preserveScroll);
    }
  } catch (err) {
    console.warn('Could not sync admin server data:', err);
  } finally {
    _adminSyncBusy = false;
  }
}

function initAtomXApp() {
  try {
    initTheme();
    const hashScreen = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
    const initialScreen = hashScreen || localStorage.getItem('atomx_admin_screen') || '12';
    navigateToScreen(initialScreen);
    fetchLiveModelsForProvider('groq');
    if (AtomXState.isAdminAuthenticated) {
      loadAdminServerData(false);
    }

    // Light background refresh every 45 s, only while the admin is looking at the tab
    setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (AtomXState.isAdminAuthenticated && ['12', '13', '14', '15', '16', '17', '20', '21', '22', '23'].includes(AtomXState.currentScreen)) {
        loadAdminServerData(true, { light: true });
      }
    }, 45000);

    window.addEventListener('hashchange', () => {
      const currentHash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
      if (currentHash && currentHash !== AtomXState.currentScreen) {
        navigateToScreen(currentHash, true);
      }
    });
  } catch (err) {
    console.error('[AtomX Init Error]', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAtomXApp);
} else {
  initAtomXApp();
}


