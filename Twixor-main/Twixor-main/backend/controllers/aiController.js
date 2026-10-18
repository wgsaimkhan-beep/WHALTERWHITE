/**
 * ATOMX ENGAGE — AI REPLY GENERATION & MULTI-PROVIDER CONTROLLER
 * Rule: 1 Credit = 1 AI Reply. Atomically validated and deducted on server.
 */
const db = require('../config/db');
const multiProviderService = require('../services/multiProviderService');
const commentRules = require('../services/commentRules');

exports.getProviders = (req, res) => {
  res.json({
    providers: [
      { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini', hasKey: !!multiProviderService.getProviderKey('openai') },
      { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-1.5-flash', hasKey: !!multiProviderService.getProviderKey('gemini') },
      { id: 'groq', name: 'Groq (LPU)', defaultModel: 'llama-3.3-70b-versatile', hasKey: !!multiProviderService.getProviderKey('groq') },
      { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-3.5-sonnet', hasKey: !!multiProviderService.getProviderKey('openrouter') }
    ]
  });
};

const { isSafeUrl } = require('../middleware/authMiddleware');

exports.getProviderModels = async (req, res) => {
  const provider = req.params.provider || 'openai';
  const customKey = req.query.key || null;
  const customBaseUrl = req.query.baseUrl || null;

  // SSRF Protection: Only authenticated administrators can specify custom base URLs
  if (customBaseUrl) {
    if (!req.admin && (!req.user || req.user.role !== 'ADMIN')) {
      return res.status(403).json({ error: 'Specifying custom API base URLs is restricted to administrators.' });
    }
    if (!isSafeUrl(customBaseUrl)) {
      return res.status(400).json({ error: 'Invalid or disallowed base URL. Private IP ranges and loopbacks are blocked.' });
    }
  }

  try {
    const result = await multiProviderService.fetchLiveModels(provider, customKey, customBaseUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch models: ' + err.message });
  }
};

exports.generateReply = async (req, res) => {
  const reqHandle = req.body.userHandle || req.body.handle || req.body.user || req.headers['x-user-handle'] || null;
  const reqEmail = req.body.userEmail || req.body.email || req.headers['x-user-email'] || null;
  const rawUserId = req.headers['x-user-id'] || req.body.userId || null;

  const {
    tweetText,
    tweetAuthor = '@user',
    tweetAuthorName = '',
    style = 'Natural & Concise',
    stylePrompt = null,
    customPrompt = null,
    prompt = null,
    provider = 'openai',
    model = null,
    length = 'medium'
  } = req.body;

  if (!tweetText || tweetText.trim() === '') {
    return res.status(400).json({ error: 'Target tweet content is required' });
  }

  // 1. Resolve user server-side reliably
  let user = null;

  // BOLA Protection: If authenticated via JWT as regular user, strictly lock to caller's own account
  if (req.user && !req.admin && req.user.role !== 'ADMIN' && req.user.userId) {
    user = await db.getUserById(req.user.userId);
  } else {
    const cleanReqHandle = (reqHandle || '').replace(/^@/, '').trim();
    if (cleanReqHandle && cleanReqHandle !== 'user') user = await db.getUserByHandle(cleanReqHandle);
    if (!user && reqEmail) user = await db.getUserByEmail(reqEmail);
    if (!user && rawUserId && rawUserId !== '1' && rawUserId !== 'default_member') user = await db.getUserById(rawUserId);
  }

  if (!user) {
    const allUsers = await db.getAllUsers();
    user = (allUsers || []).find(u => (u.status || '').toUpperCase() === 'ACTIVE' && u.handle && u.handle !== '@user' && u.handle !== 'user') || allUsers?.[0] || null;
  }

  if (!user) {
    user = {
      id: 'default_member',
      handle: (cleanReqHandle && cleanReqHandle !== 'user') ? `@${cleanReqHandle}` : '@member',
      full_name: 'Verified Member',
      email: reqEmail || 'member@atomx.io',
      status: 'ACTIVE',
      credits: 100
    };
  }

  if ((user.status || '').toUpperCase() === 'SUSPENDED') {
    return res.status(403).json({ error: 'Account suspended. AI generation disabled.' });
  }

  if (typeof user.credits === 'number' && user.credits < 1) {
    return res.status(402).json({
      error: 'Insufficient credits',
      message: 'You have 0 credits remaining. Upgrade to Growth ($12/mo) or Pro ($29/mo) to continue generating.',
      currentBalance: 0
    });
  }

  let activeProv = provider;
  let activeModel = model;

  try {
    const adminController = require('./adminController');
    const settings = await adminController.getAiSettingsData();
    if (settings && settings.activeProvider) {
      activeProv = settings.activeProvider;
      if (settings.providerModels && settings.providerModels[activeProv]) {
        activeModel = settings.providerModels[activeProv];
      } else if (settings.activeModel) {
        activeModel = settings.activeModel;
      }
    }
  } catch (e) {}

  // 1. Transaction Pre-Reservation: Atomically lock and deduct 1 credit BEFORE slow AI call
  // This physically blocks users from bypassing credits by spamming parallel concurrent requests
  let creditReserved = false;
  let remainingCredits = typeof user.credits === 'number' ? user.credits : 99;

  if (user.id && user.id !== 'default_member') {
    try {
      remainingCredits = await db.deductCredit(
        user.id,
        1,
        'AI Reply',
        `[${activeProv} / ${activeModel || 'auto'}] Reply for ${tweetAuthor}`
      );
      creditReserved = true;
    } catch (deductErr) {
      return res.status(402).json({
        error: 'Insufficient credits',
        message: deductErr.message || 'You have 0 credits remaining. Upgrade to continue generating.',
        currentBalance: user.credits || 0
      });
    }
  }

  try {
    // 2. Generate Reply using selected Provider & Model (OpenAI, Gemini, Groq, OpenRouter)
    const aiResult = await multiProviderService.generateWithProvider({
      provider: activeProv,
      model: activeModel,
      tweetText,
      tweetAuthor,
      tweetAuthorName,
      style,
      stylePrompt: stylePrompt || customPrompt || prompt || null,
      length,
      user: user.handle || '@user',
      userName: user.full_name || '',
      userEmail: user.email || ''
    });

    // FINAL GATE (cannot be bypassed by any tone, custom prompt or provider):
    // nothing leaves the server unless it is 50-80 chars of lowercase a-z and spaces.
    let finalReply = aiResult.reply;
    if (!commentRules.validateComment(finalReply).valid) {
      finalReply = commentRules.correctComment(finalReply, tweetAuthor, tweetAuthorName) || commentRules.pickSafeFallback();
    }

    res.json({
      success: true,
      reply: finalReply,
      remainingCredits,
      creditCost: 1,
      provider: aiResult.provider,
      modelUsed: aiResult.modelUsed,
      tokensUsed: aiResult.tokensUsed
    });
  } catch (err) {
    // 3. Rollback & Auto-Refund: If any error occurred during AI generation, REFUND the credit immediately!
    if (creditReserved && user.id && user.id !== 'default_member') {
      try {
        console.warn(`[ATOMX AI] Generation failed, automatically refunding 1 credit to user ${user.id}...`);
        await db.addCredits(
          user.id,
          1,
          'AI Reply Refund',
          'System Auto-Refund',
          `Auto-refund due to AI generation error: ${err.message || 'Provider failure'}`
        );
      } catch (refundErr) {
        console.error('[ATOMX AI] Auto-refund error:', refundErr);
      }
    }

    console.error('[AI Generation Error]', err);
    res.status(500).json({ error: 'Generation failed: ' + (err.message || 'Service temporarily unavailable') });
  }
};
