/**
 * ATOMX ENGAGE — ROBUST TWEET LINK EXTRACTOR & DEDUPLICATION SERVICE
 * Solves:
 *  1. Multiple link formats (x.com, twitter.com, fxtwitter, mobile.twitter, intent/like, intent/retweet)
 *  2. Messy Telegram/chat noise (timestamps [06/10/2026 9:48 pm], usernames, emojis, bot labels #859)
 *  3. Duplicate links within the batch
 *  4. Already engaged tweets from persistent history
 *  5. Tweets already present in the active queue
 */

function extractTweetLinks(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  // Matches standard status URLs (with queries, tracking tags, photo/video paths)
  const statusRegex = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|vxtwitter\.com|fixupx\.com|fxtwitter\.com)\/(?:#!\/)?([a-zA-Z0-9_]{1,30})\/status(?:es)?\/(\d{5,25})/gi;
  // Matches intent action URLs (intent/like, intent/retweet, intent/tweet with query params)
  const intentRegex = /(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\/intent\/(?:like|retweet|tweet)[^?\s]*\?(?:[^&\s]*&)*(?:tweet_id|in_reply_to)=(\d{5,25})/gi;

  const results = [];
  let match;

  while ((match = statusRegex.exec(rawText)) !== null) {
    const username = match[1];
    const tweetId = match[2];
    const isSpecial = ['i', 'intent'].includes(username.toLowerCase());
    results.push({
      tweetId,
      handle: isSpecial ? '@creator' : `@${username}`,
      author: isSpecial ? 'Creator' : username,
      canonicalUrl: `https://x.com/${isSpecial ? 'i' : username}/status/${tweetId}`,
      source: match[0]
    });
  }

  while ((match = intentRegex.exec(rawText)) !== null) {
    const tweetId = match[1];
    results.push({
      tweetId,
      handle: '@creator',
      author: 'Creator',
      canonicalUrl: `https://x.com/i/status/${tweetId}`,
      source: match[0]
    });
  }

  return results;
}

function filterTweetLinks(extractedLinks, options = {}) {
  const alreadyEngagedSet = new Set((options.alreadyEngagedIds || []).map(String));
  const currentQueueSet = new Set((options.currentQueueIds || []).map(String));

  const seenInBatch = new Set();
  let duplicateCount = 0;
  let alreadyEngagedCount = 0;
  let alreadyInQueueCount = 0;
  const freshTweets = [];

  for (const item of extractedLinks) {
    const tid = String(item.tweetId);
    if (seenInBatch.has(tid)) {
      duplicateCount++;
      continue;
    }
    seenInBatch.add(tid);

    if (alreadyEngagedSet.has(tid)) {
      alreadyEngagedCount++;
      continue;
    }

    if (currentQueueSet.has(tid)) {
      alreadyInQueueCount++;
      continue;
    }

    freshTweets.push({
      ...item,
      tweetId: tid
    });
  }

  return {
    totalFound: extractedLinks.length,
    uniqueInBatch: seenInBatch.size,
    duplicateCount,
    alreadyEngagedCount,
    alreadyInQueueCount,
    freshCount: freshTweets.length,
    freshTweets
  };
}

module.exports = {
  extractTweetLinks,
  filterTweetLinks
};
