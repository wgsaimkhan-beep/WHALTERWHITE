/**
 * ATOMX ENGAGE — CAMPAIGNS & REPLY QUEUE CONTROLLER (SUPABASE PERSISTENT)
 */
const db = require('../config/db');
const { extractTweetLinks, filterTweetLinks } = require('../services/tweetExtractorService');

exports.getCampaigns = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || 1;
    const campaigns = await db.getCampaigns(userId);
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getQueue = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || 1;
    const queue = await db.getQueue(userId);

    const stats = {
      total: queue.length,
      completed: queue.filter(q => q.status === 'COMPLETED').length,
      processing: queue.filter(q => q.status === 'PROCESSING').length,
      waiting: queue.filter(q => q.status === 'WAITING').length,
      failed: queue.filter(q => q.status === 'FAILED').length
    };

    res.json({ stats, queue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.addToQueue = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || 1;
    const { campaignId = null, author, handle, content } = req.body;

    if (!author || !content) {
      return res.status(400).json({ error: 'Author and tweet content are required' });
    }

    const result = await db.addToQueue(userId, campaignId, author, handle || '@user', content);
    res.status(201).json({
      message: 'Added to reply queue',
      queueId: result?.id || 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Batch parse & filter links from raw text (Telegram, etc.)
exports.parseAndFilterTweets = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || 1;
    const { rawText, currentQueueIds = [] } = req.body;

    if (!rawText || typeof rawText !== 'string') {
      return res.status(400).json({ error: 'rawText string is required' });
    }

    // 1. Extract all valid links
    const extracted = extractTweetLinks(rawText);

    // 2. Fetch already engaged tweet IDs from persistent database
    const dbEngagedIds = await db.getEngagedTweetIds(userId);

    // 3. Filter duplicates, already engaged, and already in queue
    const summary = filterTweetLinks(extracted, {
      alreadyEngagedIds: dbEngagedIds,
      currentQueueIds
    });

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get list of engaged tweet IDs for the user
exports.getEngagedTweets = async (req, res) => {
  try {
    let userId = req.headers['x-user-id'] || req.query.userId || 1;
    if (req.query.handle) {
      try {
        const u = await db.getUserByHandle(req.query.handle);
        if (u?.id) userId = u.id;
      } catch (e) {}
    }
    const engagedIds = await db.getEngagedTweetIds(userId);
    res.json({
      count: engagedIds.length,
      engagedIds
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Mark tweets as engaged
exports.markTweetsEngaged = async (req, res) => {
  try {
    let userId = req.headers['x-user-id'] || req.body?.userId || 1;
    const { tweets } = req.body;

    if (!tweets) {
      return res.status(400).json({ error: 'tweets array or object required' });
    }

    if (req.body?.handle) {
      try {
        const u = await db.getUserByHandle(req.body.handle);
        if (u?.id) userId = u.id;
      } catch (e) {}
    }

    await db.markTweetsEngaged(tweets, userId);
    res.json({
      message: 'Marked as engaged',
      count: Array.isArray(tweets) ? tweets.length : 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Clear engaged tweets cache
exports.clearEngagedTweets = async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || 1;
    await db.clearEngagedTweets(userId);
    res.json({ message: 'Engaged tweets cache cleared successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
