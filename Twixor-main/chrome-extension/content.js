/**
 * ATOMX ENGAGE — TWITTER / X CONTENT SCRIPT
 * Injects one-click AI reply buttons into Twitter/X interface and handles DOM extraction.
 */

console.log('ATOMX ENGAGE content script active on Twitter/X.');

// =========================================================================
// ATOMX TAB SHIELD: Neutralization of window.close is safely handled via
// prevent-tab-close.js (MAIN world content script) and background.js executeScript,
// Proactively inject prevent-tab-close.js into DOM to ensure MAIN world protection is active immediately
try {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL && !document.querySelector('script[data-atomx-shield]')) {
    const shieldScript = document.createElement('script');
    shieldScript.src = chrome.runtime.getURL('prevent-tab-close.js');
    shieldScript.setAttribute('data-atomx-shield', 'true');
    shieldScript.onload = () => shieldScript.remove();
    (document.head || document.documentElement).appendChild(shieldScript);
  }
} catch (e) {}

function isExtensionValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    return false;
  }
}

// Observe DOM changes to inject ATOMX buttons into tweet action toolbars
if (window.__atomx_observer) {
  try { window.__atomx_observer.disconnect(); } catch (e) {}
}

var atomxDomObserver = new MutationObserver(() => {
  if (!isExtensionValid()) {
    try { atomxDomObserver.disconnect(); } catch (e) {}
    return;
  }
  try { autoDismissConfirmationSheetIfPresent(); } catch (e) {}
  injectAtomXButtons();
});
window.__atomx_observer = atomxDomObserver;

if (isExtensionValid()) {
  atomxDomObserver.observe(document.body, { childList: true, subtree: true });
}

function injectAtomXButtons() {
  // Find tweet action bars (like, retweet, reply bars)
  const actionBars = document.querySelectorAll('div[role="group"]:not([data-atomx-injected="true"])');

  actionBars.forEach(bar => {
    bar.setAttribute('data-atomx-injected', 'true');

    // Create Twixor Quick Reply Button
    const btn = document.createElement('button');
    btn.className = 'atomx-inline-btn';
    btn.title = 'Generate Twixor AI Reply';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      <span>Twixor</span>
    `;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const tweetArticle = bar.closest('article[data-testid="tweet"]');
      if (!tweetArticle) return;

      const tweetData = extractTweetData(tweetArticle);
      btn.classList.add('loading');
      btn.querySelector('span').textContent = 'Thinking...';

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'GENERATE_INLINE_REPLY',
          tweet: tweetData
        });

        // Or direct fetch if background worker route
        const replyText = twxSafeComment(response?.reply);

        // Click tweet reply button to open input if not open
        const nativeReplyBtn = tweetArticle.querySelector('button[data-testid="reply"]');
        if (nativeReplyBtn) nativeReplyBtn.click();

        // Wait a tick for textarea to appear and insert text
        setTimeout(() => {
          insertIntoTwitterInput(replyText);
        }, 500);

      } catch (err) {
        console.error('Error generating Twixor inline reply:', err);
      } finally {
        btn.classList.remove('loading');
        btn.querySelector('span').textContent = 'Twixor';
      }
    });

    bar.appendChild(btn);
  });
}

function extractTweetData(article) {
  const textEl = article.querySelector('div[data-testid="tweetText"]');
  const userEl = article.querySelector('div[data-testid="User-Name"]');

  const text = textEl ? textEl.innerText.trim() : '';
  let authorName = '';
  let authorHandle = '';

  if (userEl) {
    const textLines = userEl.innerText.split('\n');
    authorName = textLines[0] || '';
    const handleMatch = userEl.innerText.match(/@[\w_]+/);
    authorHandle = handleMatch ? handleMatch[0] : '';
  }

  if (!authorHandle) {
    const userLink = article.querySelector('div[data-testid="User-Name"] a[role="link"], div[data-testid*="UserAvatar"] a[href^="/"], a[role="link"][href^="/"]');
    if (userLink) {
      const href = (userLink.getAttribute('href') || '').replace(/^\//, '').split('/')[0].split('?')[0];
      if (href && !['home', 'explore', 'notifications', 'messages', 'i', 'compose'].includes(href.toLowerCase())) {
        authorHandle = `@${href}`;
      }
    }
  }

  let tweetUrl = '';
  let tweetId = '';
  const statusLink = article.querySelector('a[href*="/status/"]');
  if (statusLink) {
    const href = statusLink.getAttribute('href');
    if (href) {
      const match = href.match(/\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
      if (match) {
        tweetId = match[2];
        tweetUrl = `https://x.com/${match[1]}/status/${match[2]}`;
      } else {
        tweetUrl = href.startsWith('http') ? href : `https://x.com${href}`;
      }
    }
  }

  return { text, authorName, authorHandle, tweetUrl, tweetId };
}

var isWorkflowAborted = false;
var isWorkflowItemSkipped = false;

// Human-like typing delay simulator with instant pause & abort support
async function sleep(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (isWorkflowAborted || isWorkflowItemSkipped) break;
    // If paused via HUD or extension, freeze here until resumed
    while (isHudWorkflowPaused && !isWorkflowAborted && !isWorkflowItemSkipped) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (isWorkflowAborted || isWorkflowItemSkipped) break;
    const remaining = Math.min(100, ms - (Date.now() - start));
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
  }
}

/**
 * Robust detection of the Main Focal Post on Twitter/X status pages.
 * Ensures actions (like, retweet) NEVER hit a random comment below.
 */
function getMainPostArticle() {
  const primary = document.querySelector('div[data-testid="primaryColumn"]') || document;
  const articles = Array.from(primary.querySelectorAll('article[data-testid="tweet"]'));
  if (articles.length === 0) return null;

  // If viewing a status URL /status/12345, find matching article
  const statusMatch = window.location.pathname.match(/\/status\/(\d+)/);
  if (statusMatch) {
    const targetId = statusMatch[1];
    const match = articles.find(a => {
      const links = Array.from(a.querySelectorAll('a[href*="/status/"]'));
      return links.some(l => l.getAttribute('href').includes(targetId));
    });
    if (match) return match;
  }

  // Fallback: The topmost tweet article is the focal post
  return articles[0];
}

/**
 * Detect the logged-in user's Twitter handle from navigation/profile links.
 * Supports both Desktop and Mobile browsers (Kiwi, Lemur, Mises, Yandex).
 */
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

function getLoggedInUserHandle() {
  const RESERVED_X_PATHS = [
    'home', 'explore', 'notifications', 'messages', 'i', 'compose',
    'settings', 'search', 'hashtag', 'lists', 'communities', 'verified-orgs-signup', 'login', 'signup',
    'unknown', 'undefined', 'null', 'user', 'none', 'jobs', 'premium'
  ];

  try {
    // 1. Desktop & Tablet Primary Navigation: a[data-testid="AppTabBar_Profile_Link"]
    const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (profileLink) {
      const href = profileLink.getAttribute('href') || '';
      const clean = href.replace(/^\//, '').split('/')[0].split('?')[0].replace('@', '').trim().toLowerCase();
      if (isValidTwitterHandle(clean)) {
        return clean;
      }
    }

    // 2. Desktop SideNav Account Switcher: button or div[data-testid="SideNav_AccountSwitcher_Button"]
    const switcher = document.querySelector('div[data-testid="SideNav_AccountSwitcher_Button"], button[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switcher) {
      const text = switcher.innerText || switcher.textContent || '';
      const match = text.match(/@([\w_]{1,30})/);
      if (match && isValidTwitterHandle(match[1])) return match[1].toLowerCase();
    }

    // 3. Mobile Navigation Drawer Profile Link: a[data-testid="SideNav_Profile_Link"]
    const sideNavProfile = document.querySelector('a[data-testid="SideNav_Profile_Link"]');
    if (sideNavProfile) {
      const href = sideNavProfile.getAttribute('href') || '';
      const clean = href.replace(/^\//, '').split('/')[0].split('?')[0].replace('@', '').trim().toLowerCase();
      if (isValidTwitterHandle(clean)) {
        return clean;
      }
    }

    // 4. Mobile Drawer Account Switcher (if mounted):
    const mobileDrawerSwitcher = document.querySelector('div[data-testid="AccountSwitcher_Account_Button"]');
    if (mobileDrawerSwitcher) {
      const text = mobileDrawerSwitcher.innerText || mobileDrawerSwitcher.textContent || '';
      const match = text.match(/@([\w_]{1,30})/);
      if (match && isValidTwitterHandle(match[1])) return match[1].toLowerCase();
    }

    // 5. Mobile Top Bar User Menu Avatar (button[data-testid="TopNavBar_UserMenu_Button"]):
    const topUserMenu = document.querySelector('div[data-testid="TopNavBar_UserMenu_Button"], button[data-testid="TopNavBar_UserMenu_Button"]');
    if (topUserMenu) {
      const aria = topUserMenu.getAttribute('aria-label') || '';
      const match = aria.match(/@([\w_]{1,30})/);
      if (match && isValidTwitterHandle(match[1])) return match[1].toLowerCase();
      const img = topUserMenu.querySelector('img');
      const alt = (img?.getAttribute('alt') || '').trim();
      const altMatch = alt.match(/@([\w_]{1,30})/);
      if (altMatch && isValidTwitterHandle(altMatch[1])) return altMatch[1].toLowerCase();
    }

    // 6. Tweet Status Page: User's own avatar in the inline reply box (universal on PC and Mobile)
    const inlineReplyUser = document.querySelector('div[data-testid="inline_reply"] a[role="link"][href^="/"]');
    if (inlineReplyUser) {
      const href = inlineReplyUser.getAttribute('href') || '';
      const clean = href.replace(/^\//, '').split('/')[0].split('?')[0].replace('@', '').trim().toLowerCase();
      if (isValidTwitterHandle(clean)) {
        return clean;
      }
    }

    // 7. Primary Navigation bar specifically (scoped to navigation container only, NEVER whole header):
    const navProfileLink = document.querySelector('nav[aria-label="Primary Navigation"] a[href^="/"][aria-label*="Profile" i], nav a[href^="/"][aria-label*="Profile" i]');
    if (navProfileLink) {
      const href = navProfileLink.getAttribute('href') || '';
      const clean = href.replace(/^\//, '').split('/')[0].split('?')[0].replace('@', '').trim().toLowerCase();
      if (isValidTwitterHandle(clean)) return clean;
    }

    // 8. Twitter React avatar container testid: data-testid="UserAvatar-Container-<handle>"
    const topAvatarContainer = document.querySelector(
      'button[data-testid="TopNavBar_UserMenu_Button"] [data-testid^="UserAvatar-Container-"], ' +
      'div[data-testid="TopNavBar_UserMenu_Button"] [data-testid^="UserAvatar-Container-"], ' +
      '[data-testid="TopNavBar"] [data-testid^="UserAvatar-Container-"], ' +
      'header [data-testid^="UserAvatar-Container-"], ' +
      'div[data-testid="inline_reply"] [data-testid^="UserAvatar-Container-"]'
    );
    if (topAvatarContainer) {
      const tid = topAvatarContainer.getAttribute('data-testid') || '';
      const match = tid.match(/UserAvatar-Container-([\w_]{1,30})/i);
      if (match && isValidTwitterHandle(match[1])) {
        return match[1].toLowerCase();
      }
    }
  } catch (e) {}
  return null;
}

function isDefinitelyLoggedOut() {
  try {
    return !!document.querySelector(
      'a[data-testid="loginButton"], a[href*="/login"], a[data-testid="signupButton"], div[data-testid="BottomBar"] a[href*="/login"], div[data-testid="LoggedOutBottomBar"]'
    );
  } catch (e) {
    return false;
  }
}

async function waitForLoggedInUserHandle(timeoutMs = 2500) {
  let h = getLoggedInUserHandle();
  if (h) return h;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(250);
    h = getLoggedInUserHandle();
    if (h) return h;
  }
  return null;
}

function showAccountMismatchModal(expectedHandle, actualHandle) {
  if (!isValidTwitterHandle(actualHandle) && actualHandle !== 'Not Logged In') return;
  const existing = document.getElementById('atomx-account-mismatch-banner');
  if (existing) existing.remove();

  // Route lock warning strictly inside the Extension (do not pollute Twitter DOM)
  chrome.storage.local.set({
    atomx_account_lock_warning: {
      expected: expectedHandle,
      current: actualHandle,
      timestamp: Date.now()
    }
  }).catch(() => null);

  chrome.runtime.sendMessage({
    type: 'ACCOUNT_LOCK_WARNING',
    expected: expectedHandle,
    current: actualHandle
  }).catch(() => null);
}

async function verifyAccountLockOrAbort(expectedHandle) {
  if (!expectedHandle) return { ok: true };
  const expected = expectedHandle.replace(/^@/, '').toLowerCase().trim();
  const rawCurrent = await waitForLoggedInUserHandle(2500);
  const current = (rawCurrent || '').toLowerCase().trim();

  // ONLY lock if current is a REAL, VALID Twitter handle that genuinely differs from expected!
  if (isValidTwitterHandle(current) && current !== expected) {
    showAccountMismatchModal(expected, current);
    return {
      ok: false,
      error: `Account Lock Mismatch: Active Twitter ID is @${current}, but extension is locked to @${expected}. Please log into @${expected}.`,
      unauthorizedAccount: true
    };
  }
  if (!isValidTwitterHandle(current) && isDefinitelyLoggedOut()) {
    showAccountMismatchModal(expected, 'Not Logged In');
    return {
      ok: false,
      error: `Please log into your verified Twitter account (@${expected}) on x.com.`,
      unauthorizedAccount: true
    };
  }
  // Clear any stale warning since session is valid
  chrome.storage?.local?.remove('atomx_account_lock_warning').catch(() => null);
  return { ok: true, current: expected };
}

/**
 * Check if the logged-in user has already replied/commented on this tweet
 */
function hasUserAlreadyCommented(myHandle) {
  if (!myHandle || typeof myHandle !== 'string') return false;
  const cleanHandle = myHandle.replace(/^@+/, '').trim().toLowerCase();
  // Never false-positive match reserved words, routes, or single-character strings
  if (cleanHandle.length < 3 || ['i', 'user', 'home', 'explore', 'notifications', 'messages', 'compose', 'settings', 'premium', 'jobs', 'lists', 'unknown'].includes(cleanHandle)) {
    return false;
  }

  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  if (articles.length <= 1) return false;

  // The main focal tweet is identified so we only inspect actual reply/comment articles
  const mainArticle = getMainPostArticle() || articles[0];
  const comments = articles.filter(a => a !== mainArticle);

  return comments.some(c => {
    const userEl = c.querySelector('div[data-testid="User-Name"]');
    if (!userEl) return false;

    // 1. Author handle directly in User-Name text (e.g. "@myHandle")
    const handleMatch = userEl.innerText.match(/@([\w_]+)/);
    if (handleMatch && handleMatch[1].toLowerCase() === cleanHandle) {
      return true;
    }

    // 2. Author profile link specifically in User-Name (e.g. href="/myHandle")
    const authorLink = userEl.querySelector('a[href^="/"]');
    if (authorLink) {
      const href = (authorLink.getAttribute('href') || '').toLowerCase().replace(/^\/+/, '').split('?')[0].split('/')[0];
      if (href === cleanHandle) return true;
    }

    return false;
  });
}

// QWERTY keyboard adjacent keys map for realistic typo simulation
var QWERTY_NEIGHBORS = {
  a: ['s', 'q', 'z'],
  b: ['v', 'g', 'h', 'n'],
  c: ['x', 'd', 'v'],
  d: ['s', 'e', 'r', 'f', 'c', 'x'],
  e: ['w', 'r', 'd', 's'],
  f: ['d', 'r', 't', 'g', 'v', 'c'],
  g: ['f', 't', 'y', 'h', 'b', 'v'],
  h: ['g', 'y', 'u', 'j', 'n', 'b'],
  i: ['u', 'o', 'k', 'j'],
  j: ['h', 'u', 'i', 'k', 'm', 'n'],
  k: ['j', 'i', 'o', 'l', 'm'],
  l: ['k', 'o', 'p'],
  m: ['n', 'j', 'k'],
  n: ['b', 'h', 'j', 'm'],
  o: ['i', 'p', 'k', 'l'],
  p: ['o', 'l'],
  q: ['w', 'a'],
  r: ['e', 't', 'f', 'd'],
  s: ['a', 'w', 'e', 'd', 'x', 'z'],
  t: ['r', 'y', 'g', 'f'],
  u: ['y', 'i', 'j', 'h'],
  v: ['c', 'f', 'g', 'b'],
  w: ['q', 'e', 's', 'a'],
  x: ['z', 's', 'd', 'c'],
  y: ['t', 'u', 'h', 'g'],
  z: ['a', 's', 'x']
};

/**
 * Natural Human Smooth Scrolling Engine:
 * Simulates genuine physical mousewheel / trackpad / touch strokes with:
 * - Variable stroke flick distances (140px - 220px per stroke)
 * - Cubic velocity deceleration curves (easing)
 * - 60fps micro-steps (15-25ms intervals)
 * - Organic human pauses between strokes (as a person scans reading material)
 * NEVER violently jumps, snaps, or jerks the viewport ("akbae tan diya chole ashe na").
 */
var isCommentActive = false;

async function humanSmoothScroll(distance, options = {}) {
  const isUp = distance < 0;
  const absDist = Math.abs(distance);
  if (absDist < 6) return;

  // Guard: Never scroll background timeline while a modal compose sheet or confirmation dialog is active
  // Per AGENTS_WORKFLOW_SPECIFICATION.md Section 3.1: Only freeze on actual modal dialogs, not regular in-page feeds
  const activeModalDialog = document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"], div[aria-modal="true"] div[data-testid="tweetTextarea_0"], div[data-testid="confirmationSheetDialog"]');
  if (!options.allowModalScroll && (isCommentActive && activeModalDialog)) {
    console.log('[ATOMX SCROLL] Modal compose dialog is currently active. Skipping background scroll.');
    return;
  }

  // Check user Cursor Movement Speed from safety settings:
  // If user selected 0 ms (Instant) or fast, make scroll instant and skip delay!
  const safetyRes = await chrome.storage?.local?.get(['atomx_safety_settings']).catch(() => ({}));
  const userCursorSpeed = safetyRes?.atomx_safety_settings?.cursorSpeed !== undefined ? Number(safetyRes.atomx_safety_settings.cursorSpeed) : 450;
  
  if (userCursorSpeed === 0) {
    window.scrollBy(0, isUp ? -absDist : absDist);
    return;
  }

  const flickBase = options.flickSize || (110 + Math.random() * 45);
  const numFlicks = Math.max(1, Math.round(absDist / flickBase));
  const flickDist = absDist / numFlicks;

  for (let f = 0; f < numFlicks; f++) {
    if (isWorkflowAborted || isWorkflowItemSkipped) break;

    const steps = 14 + Math.floor(Math.random() * 5); // 14-18 smooth micro-steps per stroke
    const thisFlickTarget = (f === numFlicks - 1) ? (absDist - f * flickDist) : flickDist;

    const speedFactor = Math.max(0.2, userCursorSpeed / 450);
    const stepSleep = Math.max(8, Math.round((22 + Math.floor(Math.random() * 14)) * speedFactor));
    const pauseBetweenFlicks = Math.max(30, Math.round((180 + Math.floor(Math.random() * 140)) * speedFactor));
    const settle = options.settlePause !== undefined ? Math.round(options.settlePause * speedFactor) : Math.round(250 * speedFactor);

    let traveled = 0;
    for (let s = 1; s <= steps; s++) {
      if (isWorkflowAborted || isWorkflowItemSkipped) break;
      const t = s / steps;
      // Smooth cubic ease-out curve
      const ease = 1 - Math.pow(1 - t, 3);
      const stepTarget = Math.round(thisFlickTarget * ease);
      const delta = stepTarget - traveled;
      traveled = stepTarget;

      if (delta !== 0) {
        window.scrollBy(0, isUp ? -delta : delta);
      }
      await sleep(stepSleep);
    }

    if (f < numFlicks - 1) {
      await sleep(pauseBetweenFlicks);
    }
  }

  await sleep(options.settlePause !== undefined ? Math.round(options.settlePause * Math.max(0.2, userCursorSpeed / 450)) : Math.round(250 * Math.max(0.2, userCursorSpeed / 450)));
}

/**
 * Human-like smooth alignment: scrolls the element into comfortable viewport position
 * using natural human strokes without any violent instant snapping.
 */
async function humanScrollElementIntoView(element, position = 'center', options = {}) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  // If element is inside a fixed/modal dialog, delegate to modal scroll helper without scrolling window
  if (element.closest('div[role="dialog"], div[aria-modal="true"]')) {
    return await ensureCommentBoxComfortablyVisible(element);
  }
  try {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let rect = element.getBoundingClientRect();

    // Sticky header clearance: Twitter/X top nav bar occupies ~53px - 110px
    const topSafeMargin = 115;
    const bottomSafeMargin = vh - 65;

    let targetY = 0;
    if (position === 'center') {
      targetY = rect.top - (vh / 2 - rect.height / 2);
    } else if (position === 'top') {
      targetY = rect.top - topSafeMargin;
    } else if (position === 'bottom') {
      targetY = rect.bottom - bottomSafeMargin;
    } else {
      if (rect.top >= topSafeMargin && rect.bottom <= bottomSafeMargin) return true; // Already comfortably in view
      targetY = rect.top < topSafeMargin ? (rect.top - (topSafeMargin + 10)) : (rect.bottom - bottomSafeMargin);
    }

    // Already in comfortable position — skip redundant scroll pass
    if (rect.top >= topSafeMargin && rect.bottom <= bottomSafeMargin && Math.abs(targetY) < 35) {
      return true;
    }

    // Prevent futile negative scroll when window is already at the very top
    if ((window.scrollY || 0) <= 2 && targetY < 0) {
      return true;
    }

    if (Math.abs(targetY) < 18) return true;

    await humanSmoothScroll(Math.round(targetY), { settlePause: 220, allowModalScroll: options.allowModalScroll || false });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Gentle scroll helper using human smooth scrolling (now fully async and awaited)
 */
async function gentleScrollIntoView(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  try {
    const rect = element.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top >= 115 && rect.bottom <= vh - 60) return true;
    return await humanScrollElementIntoView(element, 'center');
  } catch (e) {
    return false;
  }
}

/**
 * Global Rule: First smoothly scroll target post and its like/action button into viewport,
 * wait for scroll animation to settle so the button is visibly shown on screen, and THEN engage.
 */
async function scrollElementIntoViewAndEnsureVisible(element, blockPosition = 'center') {
  if (!element) return false;
  return await humanScrollElementIntoView(element, blockPosition);
}

/**
 * Natural human-like reading scroll for tweet status pages.
 * Smoothly scrolls down through the tweet text to bring the action toolbar
 * (like/repost) and reply/comment composer comfortably into the lower-middle viewport.
/**
 * Smart Viewport Alignment (Screenshot 2 Standard):
 * Positions the page so that:
 * 1. The tweet content/media is visible in the upper-to-middle screen.
 * 2. The action bar (Like, Retweet, Reply) is visible in the lower-middle screen.
 * 3. The inline comment box ("Post your reply") is comfortably visible right below the action bar.
 * Guarantees the like button and comment box are never pushed to the bottom edge or hidden (Screenshot 1).
 */
async function ensurePostAndActionsInView(mainArticle, targetButton = null) {
  if (!mainArticle || isWorkflowAborted || isWorkflowItemSkipped) return;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const isStatusPage = window.location.pathname.includes('/status/');

  try {
    const inlineReply = document.querySelector('div[data-testid="inline_reply"]') ||
                        document.querySelector('div[data-testid="tweetTextarea_0"]')?.closest('div[role="group"]') ||
                        document.querySelector('div[data-testid="tweetTextarea_0"]') ||
                        mainArticle.querySelector('div[role="group"]');

    const btn = targetButton ||
                mainArticle.querySelector('button[data-testid="like"], button[data-testid="unlike"]') ||
                mainArticle.querySelector('div[role="group"]');

    if (isStatusPage && inlineReply && btn) {
      const btnRect = btn.getBoundingClientRect();
      const replyRect = inlineReply.getBoundingClientRect();

      // Check if already in ideal layout (like Screenshot 2):
      // Like button is clearly visible in viewport, and reply container is visible above bottom edge
      const isAlreadyIdeal = (btnRect.top >= 70 && btnRect.bottom <= vh - 70) &&
                             (replyRect.top >= 100 && replyRect.bottom <= vh - 15);

      if (isAlreadyIdeal) {
        await sleep(250);
        return;
      }

      // Calculate target scroll position so the inline reply container sits comfortably at ~75% - 82% of viewport height.
      // This positions the Like button right above it at ~55% - 65% of viewport height (exact Screenshot 2 layout).
      const targetY = replyRect.top + window.scrollY - Math.round(vh * 0.78);
      const deltaY = targetY - window.scrollY;
      if (Math.abs(deltaY) > 25) {
        await humanSmoothScroll(Math.round(deltaY), { settlePause: 220 });
      }
      return;
    }

    // Fallback for feeds/timeline posts: only scroll if action button is outside safe viewport bounds
    if (btn) {
      const btnRect = btn.getBoundingClientRect();
      if (btnRect.top < 115 || btnRect.bottom > (vh - 60)) {
        await humanScrollElementIntoView(btn, 'center');
      }
    }
  } catch (err) {
    console.warn('[ATOMX] ensurePostAndActionsInView error:', err);
  }
}

/**
 * Natural human-like reading scroll for tweet status pages.
 * Smoothly scrolls down to ensure the action toolbar and comment box sit together (Screenshot 2).
 */
async function smoothScrollPostForReading(mainArticle) {
  if (!mainArticle) {
    await humanSmoothScroll(380, { settlePause: 300 });
    return;
  }
  await ensurePostAndActionsInView(mainArticle);
}

// ─────────────────────────────────────────────────────────────────────────────
// HYBRID HUMANIZED ACTION ENGINE (MODE A: VIRTUAL CURSOR | MODE B: CDP DEBUGGER)
// ─────────────────────────────────────────────────────────────────────────────

var virtualCursorEl = null;
var currentCursorPos = { x: -100, y: -100 };
var isCursorAnimating = false;
var lastScrollTime = 0;

function injectVirtualCursorStylesFallback() {
  if (document.getElementById('atomx-virtual-cursor-styles')) return;
  const style = document.createElement('style');
  style.id = 'atomx-virtual-cursor-styles';
  style.textContent = `
    .atomx-virtual-cursor {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      user-select: none !important;
      will-change: transform !important;

    }
    .atomx-cursor-icon-wrap {
      position: relative !important;
      display: inline-block !important;
      transform-origin: 4px 4px !important;
      transition: transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
    }
    .atomx-cursor-icon-wrap.atomx-cursor-pressed {
      transform: scale(0.82) !important;
    }
    .atomx-cursor-svg {
      filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45)) drop-shadow(0 0 8px rgba(56, 189, 248, 0.65)) !important;
      display: block !important;
    }
    .atomx-cursor-badge {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      font-size: 9.5px !important;
      font-weight: 700 !important;
      background: rgba(15, 23, 42, 0.9) !important;
      color: #38BDF8 !important;
      border: 1px solid rgba(56, 189, 248, 0.45) !important;
      border-radius: 9999px !important;
      padding: 1.5px 7px !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
      letter-spacing: 0.3px !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      animation: atomxPulseBadge 2.5s infinite ease-in-out !important;
    }
    @keyframes atomxPulseBadge {
      0%, 100% { border-color: rgba(56, 189, 248, 0.45); }
      50% { border-color: rgba(56, 189, 248, 0.85); box-shadow: 0 0 10px rgba(56, 189, 248, 0.3); }
    }
    .atomx-cursor-ripple {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 22px !important;
      height: 22px !important;
      border-radius: 50% !important;
      border: 2px solid #38BDF8 !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transform: translate(-30%, -30%) scale(0.2) !important;
    }
    .atomx-cursor-ripple.atomx-ripple-active {
      animation: atomxRippleAnim 0.45s ease-out forwards !important;
    }
    @keyframes atomxRippleAnim {
      0% {
        transform: translate(-30%, -30%) scale(0.2);
        opacity: 1;
        border-color: #38BDF8;
      }
      100% {
        transform: translate(-30%, -30%) scale(2.2);
        opacity: 0;
        border-color: #10B981;
      }
    }
  `;
  document.head?.appendChild(style);
}

function onPageScrollCursorDrift() {
  if (!virtualCursorEl || isCursorAnimating) return;
  const now = Date.now();
  if (now - lastScrollTime < 90) return;
  lastScrollTime = now;
  // Natural minor micro-drift (1-2px) to simulate human hand resting on mouse during scrolling
  const driftX = (Math.random() - 0.5) * 3;
  const driftY = (Math.random() - 0.5) * 3;
  currentCursorPos.x = Math.max(20, Math.min(window.innerWidth - 30, currentCursorPos.x + driftX));
  currentCursorPos.y = Math.max(20, Math.min(window.innerHeight - 30, currentCursorPos.y + driftY));
  virtualCursorEl.style.transform = `translate3d(${Math.round(currentCursorPos.x)}px, ${Math.round(currentCursorPos.y)}px, 0)`;
}

function ensureVirtualCursorActive() {
  injectVirtualCursorStylesFallback();
  const existing = document.getElementById('atomx-virtual-cursor');
  if (existing) {
    virtualCursorEl = existing;
    virtualCursorEl.style.display = 'flex';
    virtualCursorEl.style.opacity = '1';
    return virtualCursorEl;
  }

  const cursor = document.createElement('div');
  cursor.id = 'atomx-virtual-cursor';
  cursor.className = 'atomx-virtual-cursor';
  cursor.innerHTML = `
    <div class="atomx-cursor-icon-wrap" style="position:relative; display:inline-block;">
      <svg class="atomx-cursor-svg" width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.85 2.85a.5.5 0 0 0-.35.36z" fill="#0F172A" stroke="#38BDF8" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      <div class="atomx-cursor-ripple"></div>
    </div>
    <div class="atomx-cursor-badge">Twixor</div>
  `;

  const initialX = Math.round(window.innerWidth * 0.6);
  const initialY = Math.round(window.innerHeight * 0.4);
  currentCursorPos = { x: initialX, y: initialY };
  cursor.style.transform = `translate3d(${initialX}px, ${initialY}px, 0)`;

  document.body.appendChild(cursor);
  virtualCursorEl = cursor;

  window.removeEventListener('scroll', onPageScrollCursorDrift);
  window.addEventListener('scroll', onPageScrollCursorDrift, { passive: true });

  return cursor;
}

function removeVirtualCursor() {
  if (virtualCursorEl) {
    virtualCursorEl.style.transition = 'opacity 0.25s ease';
    virtualCursorEl.style.opacity = '0';
    setTimeout(() => {
      virtualCursorEl?.remove();
      virtualCursorEl = null;
    }, 260);
  }
  window.removeEventListener('scroll', onPageScrollCursorDrift);
}

async function animateVirtualCursorTo(targetX, targetY, durationMs = 220) {
  const cursor = ensureVirtualCursorActive();
  if (!cursor) return;

  const vw = window.innerWidth || 1000;
  const vh = window.innerHeight || 800;

  targetX = Math.max(15, Math.min(vw - 25, targetX));
  targetY = Math.max(15, Math.min(vh - 25, targetY));

  isCursorAnimating = true;
  const startX = Math.max(15, Math.min(vw - 25, currentCursorPos.x || Math.round(vw * 0.5)));
  const startY = Math.max(15, Math.min(vh - 25, currentCursorPos.y || Math.round(vh * 0.5)));

  const dx = targetX - startX;
  const dy = targetY - startY;
  const dist = Math.hypot(dx, dy);

  if (dist < 8) {
    currentCursorPos = { x: targetX, y: targetY };
    cursor.style.transform = `translate3d(${Math.round(targetX)}px, ${Math.round(targetY)}px, 0)`;
    isCursorAnimating = false;
    return;
  }

  const animTime = Math.min(520, Math.max(260, Math.round(durationMs * (dist / 300))));
  const steps = Math.min(26, Math.max(12, Math.round(animTime / 22)));
  const stepDelay = animTime / steps;

  // Organic curved Bezier control point with perpendicular offset
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const curveMagnitude = (Math.random() - 0.5) * Math.min(35, dist * 0.18);
  const ctrlX = Math.max(15, Math.min(vw - 25, startX + dx * 0.5 + perpX * curveMagnitude));
  const ctrlY = Math.max(15, Math.min(vh - 25, startY + dy * 0.5 + perpY * curveMagnitude));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const easeT = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    const u = 1 - easeT;
    const rawX = u * u * startX + 2 * u * easeT * ctrlX + easeT * easeT * targetX;
    const rawY = u * u * startY + 2 * u * easeT * ctrlY + easeT * easeT * targetY;
    const curX = Math.max(12, Math.min(vw - 20, rawX));
    const curY = Math.max(12, Math.min(vh - 20, rawY));

    cursor.style.transform = `translate3d(${Math.round(curX)}px, ${Math.round(curY)}px, 0)`;
    await sleep(stepDelay);
  }

  cursor.style.transform = `translate3d(${Math.round(targetX)}px, ${Math.round(targetY)}px, 0)`;
  currentCursorPos = { x: targetX, y: targetY };
  isCursorAnimating = false;

  await sleep(60 + Math.random() * 50);
}

function triggerVirtualCursorClickEffect() {
  if (!virtualCursorEl) return;
  const iconWrap = virtualCursorEl.querySelector('.atomx-cursor-icon-wrap');
  const ripple = virtualCursorEl.querySelector('.atomx-cursor-ripple');

  if (iconWrap) {
    iconWrap.classList.remove('atomx-cursor-pressed');
    void iconWrap.offsetWidth;
    iconWrap.classList.add('atomx-cursor-pressed');
  }

  if (ripple) {
    ripple.classList.remove('atomx-ripple-active');
    void ripple.offsetWidth;
    ripple.classList.add('atomx-ripple-active');
  }

  setTimeout(() => {
    iconWrap?.classList.remove('atomx-cursor-pressed');
    ripple?.classList.remove('atomx-ripple-active');
  }, 450);
}

function triggerElementClickPulse(element, color = '#38BDF8') {
  if (!element) return;
  const origTransition = element.style.transition;
  const origOutline = element.style.outline;
  const origBoxShadow = element.style.boxShadow;

  element.style.transition = 'outline 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease';
  element.style.outline = `2px solid ${color}`;
  element.style.boxShadow = `0 0 14px ${color}99`;

  setTimeout(() => {
    element.style.outline = origOutline || 'none';
    element.style.boxShadow = origBoxShadow || 'none';
    element.style.transition = origTransition || 'none';
  }, 350);
}

/**
 * Dispatches the complete human event sequence:
 * 'pointermove', 'mousemove', 'mouseover', 'pointerdown', 'mousedown', 'focus', 'click', 'pointerup', and 'mouseup'.
 */
function dispatchEnhancedHumanEvents(element, clientX, clientY) {
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const x = Math.round(clientX !== undefined ? clientX : rect.left + rect.width / 2);
  const y = Math.round(clientY !== undefined ? clientY : rect.top + rect.height / 2);

  const screenX = window.screenX + x;
  const screenY = window.screenY + y;

  const pointerProps = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX,
    screenY,
    pageX: window.pageXOffset + x,
    pageY: window.pageYOffset + y,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    pressure: 0.5,
    width: 1,
    height: 1
  };

  const mouseProps = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX,
    screenY,
    pageX: window.pageXOffset + x,
    pageY: window.pageYOffset + y,
    button: 0,
    buttons: 1
  };

  // 1. pointermove
  element.dispatchEvent(new PointerEvent('pointermove', { ...pointerProps, buttons: 0, pressure: 0 }));
  // 2. mousemove
  element.dispatchEvent(new MouseEvent('mousemove', { ...mouseProps, buttons: 0 }));
  // 3. mouseover
  element.dispatchEvent(new MouseEvent('mouseover', { ...mouseProps, buttons: 0 }));

  // 4. pointerdown
  element.dispatchEvent(new PointerEvent('pointerdown', pointerProps));
  // 5. mousedown
  element.dispatchEvent(new MouseEvent('mousedown', mouseProps));

  // 6. focus
  try {
    if (typeof element.focus === 'function') {
      element.focus({ preventScroll: true });
    }
  } catch (e) {}

  // 7. pointerup
  element.dispatchEvent(new PointerEvent('pointerup', { ...pointerProps, buttons: 0, pressure: 0 }));
  // 8. mouseup
  element.dispatchEvent(new MouseEvent('mouseup', { ...mouseProps, buttons: 0 }));

  // 9. Single authentic click with real client coordinates for React Native for Web
  const clickProps = { ...mouseProps, buttons: 0 };
  try {
    if (typeof element.click === 'function') {
      element.click();
    } else {
      element.dispatchEvent(new MouseEvent('click', clickProps));
    }
  } catch (e) {
    try { element.dispatchEvent(new MouseEvent('click', clickProps)); } catch (err) {}
  }
}

/**
 * Removes any lingering floating Twitter/X tooltip bubbles (e.g. "Reply", "Unlike", "Like") from the screen.
 */
function dismissLingeringTwitterTooltips() {
  try {
    const tooltips = document.querySelectorAll('div[role="tooltip"]');
    tooltips.forEach(t => {
      try { t.remove(); } catch (err) {}
    });
  } catch (e) {}
}

async function getActiveExecutionStrategy() {
  try {
    const res = await chrome.storage.local.get(['atomx_execution_strategy']);
    return res?.atomx_execution_strategy === 'debugger' ? 'debugger' : 'dom';
  } catch (e) {
    return 'dom';
  }
}

/**
 * Unified Humanized Action Engine (Hybrid Mode: Visual DOM Simulation vs CDP Debugger API)
 * Routes every click through:
 *  - Mode A: Enhanced Visual DOM Simulation (Virtual Cursor + Multi-Event Sequence)
 *  - Mode B: Chrome Debugger API (CDP Native Input.dispatchMouseEvent) with graceful DOM fallback
 */
async function performHumanClick(targetElement, options = {}) {
  if (!targetElement) return false;

  // Viewport scroll alignment: Always ensure target element is comfortably inside the viewport!
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  let rect = targetElement.getBoundingClientRect();
  const isInDialog = Boolean(targetElement.closest && targetElement.closest('div[role="dialog"], div[role="alertdialog"], div[aria-modal="true"], #atomx-floating-hud'));
  const isOffscreen = !isInDialog && (rect.top < 80 || rect.bottom > (vh - 60) || rect.left < 0 || rect.right > vw || rect.width === 0 || rect.height === 0);

  if (options.scroll !== false && (isOffscreen || options.scroll === true)) {
    console.log('[ATOMX ACTION] Target element is off-screen. Smooth scrolling into viewport center first...');
    await humanScrollElementIntoView(targetElement, 'center');
    await sleep(350);
    rect = targetElement.getBoundingClientRect();
  }

  if (rect.width === 0 || rect.height === 0) {
    targetElement.click();
    return true;
  }

  // Calculate coordinate inside element bounding box
  let targetX, targetY;
  if (options.exactCenter || isInDialog) {
    // For dialog buttons (e.g. Unfollow confirm), aim directly at the center of the button with tiny ±2px micro-jitter
    targetX = rect.left + rect.width / 2 + (Math.random() * 4 - 2);
    targetY = rect.top + rect.height / 2 + (Math.random() * 4 - 2);
  } else {
    const padX = Math.min(rect.width * 0.25, 10);
    const padY = Math.min(rect.height * 0.25, 10);
    targetX = rect.left + padX + Math.random() * Math.max(1, rect.width - padX * 2);
    targetY = rect.top + padY + Math.random() * Math.max(1, rect.height - padY * 2);
  }

  // Global Cursor Rules (Applied Identically to BOTH DOM Mode and Debugger Mode):
  // 1. Ensure Virtual Cursor is active and visible
  ensureVirtualCursorActive();

  // 2. Visibly animate cursor from current position to target element with organic Bezier transit
  // Read custom Cursor Speed from Global Safety Settings (0ms instant – 1500ms human)
  const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
  const userCursorSpeed = safetyRes?.atomx_safety_settings?.cursorSpeed !== undefined ? Number(safetyRes.atomx_safety_settings.cursorSpeed) : 450;
  const transitDuration = (userCursorSpeed === 0) ? 0 : (options.animDuration || Math.max(50, userCursorSpeed + Math.floor(Math.random() * 80 - 40)));

  if (transitDuration > 0) {
    await animateVirtualCursorTo(targetX, targetY, transitDuration);
  } else {
    const cursor = document.getElementById('atomx-virtual-cursor') || ensureVirtualCursorActive();
    if (cursor) {
      cursor.style.transform = `translate3d(${Math.round(targetX)}px, ${Math.round(targetY)}px, 0)`;
      cursor.style.display = 'flex';
      cursor.style.opacity = '1';
    }
    currentCursorPos = { x: targetX, y: targetY };
  }

  // 3. Human dwell pause: if 0ms speed selected, skip dwell pause for instant click!
  if (userCursorSpeed > 0) {
    const dwellFactor = Math.max(0.2, userCursorSpeed / 450);
    await sleep(options.hoverDwell !== undefined ? Math.round(options.hoverDwell * dwellFactor) : Math.round((480 + Math.random() * 200) * dwellFactor));
  }

  // 4. Trigger cursor press animation and click ripple effect
  triggerVirtualCursorClickEffect();

  // Press dwell: natural human finger hold duration before release
  if (userCursorSpeed > 0) {
    const pressFactor = Math.max(0.2, userCursorSpeed / 450);
    await sleep(Math.round((160 + Math.random() * 60) * pressFactor));
  }

  // 5. Visual element pulse (button glows with action color)
  triggerElementClickPulse(targetElement, options.pulseColor || '#38BDF8');

  // Re-calculate FRESH current coordinates right before clicking to ensure 100% target accuracy even if page shifted
  const freshRect = targetElement.getBoundingClientRect();
  const finalClickX = (freshRect.width > 0) ? (freshRect.left + freshRect.width / 2) : targetX;
  const finalClickY = (freshRect.height > 0) ? (freshRect.top + freshRect.height / 2) : targetY;

  // 6. Action Execution: Native CDP Debugger API (Hardware-level isTrusted: true) OR DOM Event Dispatch
  const strategy = await getActiveExecutionStrategy();
  let cdpSucceeded = false;

  if (strategy === 'debugger') {
    try {
      console.log(`[ATOMX ACTION] Dispatching CDP click via Debugger API at (${Math.round(finalClickX)}, ${Math.round(finalClickY)})`);
      const response = await chrome.runtime.sendMessage({
        type: 'CDP_DISPATCH_MOUSE_CLICK',
        x: finalClickX,
        y: finalClickY
      });

      if (response && response.ok) {
        cdpSucceeded = true;
      } else {
        console.warn('[ATOMX ACTION] CDP click response not ok, gracefully falling back to DOM events:', response?.error);
      }
    } catch (err) {
      console.warn('[ATOMX ACTION] CDP message failed, gracefully falling back to DOM events:', err);
    }
  }

  // If in DOM mode OR if Debugger API failed/unavailable (e.g. on mobile/Kiwi):
  if (!cdpSucceeded) {
    dispatchEnhancedHumanEvents(targetElement, finalClickX, finalClickY);
  }

  // 7. Post-click pause: if 0ms speed selected, skip pause for instant execution!
  if (userCursorSpeed > 0) {
    const pauseFactor = Math.max(0.2, userCursorSpeed / 450);
    await sleep(options.postPause !== undefined ? Math.round(options.postPause * pauseFactor) : Math.round((450 + Math.random() * 200) * pauseFactor));
  }
  dismissLingeringTwitterTooltips();
  return true;
}

/**
 * Visually highlights the Follow button with an emerald glow and dispatches human pointer events.
 * Guarantees the user and screen recording visibly witness the follow action.
 */
async function simulateHumanFollowClick(followBtn) {
  if (!followBtn) return false;
  try {
    await gentleScrollIntoView(followBtn);
    await sleep(150);

    // Perform human click: Virtual cursor moves to followBtn FIRST, hovers, pulses green, then clicks!
    await performHumanClick(followBtn, { pulseColor: '#10B981', scroll: false, postPause: 300 });
    return true;
  } catch (e) {
    followBtn.click();
    return true;
  }
}

/**
 * Safely dismisses blocking Twitter popups like "Who can reply?", "Got It" alerts, HoverCards, etc.
 */
function dismissAnyTwitterModal() {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]'));
  for (const d of dialogs) {
    const text = (d.innerText || '').toLowerCase();
    if (text.includes('who can reply') || text.includes('only some accounts can reply') || text.includes('got it')) {
      console.log('[ATOMX] Dismissing "Who can reply?" modal...');
      const gotItBtn = Array.from(d.querySelectorAll('button, div[role="button"]')).find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t === 'got it' || t === 'close' || b.getAttribute('aria-label') === 'Close';
      });
      if (gotItBtn) {
        try { gotItBtn.click(); } catch (e) {}
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      if (d.isConnected) {
        try { d.remove(); } catch (e) {}
      }
    }
  }
  const mask = document.querySelector('div[data-testid="mask"]');
  if (mask && !document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"]')) {
    try { mask.remove(); } catch (e) {}
  }

  // Also remove any lingering floating user HoverCard
  const hoverCard = document.querySelector('div[data-testid="HoverCard"]');
  if (hoverCard && hoverCard.isConnected) {
    try { hoverCard.remove(); } catch (e) {}
  }
}

/**
 * Follows the author of a tweet on the timeline.
 * Handles timeline tweets where no direct follow button exists by:
 * 1. Direct follow button on art (if present, e.g. promoted tweets)
 * 2. Opening the Tweet Caret (...) menu and clicking "Follow @handle" (or detecting if already following)
 * 3. Falling back to hovering avatar/user-name to open Twitter HoverCard and clicking "Follow"
 */
async function performFollowOnTweetAuthor(art, authorHandle) {
  if (!art || isWorkflowAborted) return false;

  // Dismiss any lingering Twitter modal (like "Who can reply?") before interacting with the tweet
  dismissAnyTwitterModal();

  const cleanHandle = (authorHandle || '').replace(/^@/, '').toLowerCase().trim();

  // Ensure tweet is smoothly in view so header & caret are visible and clickable
  try {
    await gentleScrollIntoView(art);
    await sleep(250);
  } catch (e) {}

  // 1. Direct follow button inside the article (e.g. sponsored / promoted tweets)
  let directBtn = art.querySelector('button[data-testid$="-follow"]:not([data-testid*="unfollow"]), div[data-testid$="-follow"]:not([data-testid*="unfollow"])');
  if (!directBtn) {
    directBtn = Array.from(art.querySelectorAll('button, div[role="button"]')).find(b => {
      const t = (b.innerText || '').trim();
      const tid = (b.getAttribute('data-testid') || '').toLowerCase();
      return (t === 'Follow' || tid.endsWith('-follow')) && !t.includes('Following') && !tid.includes('unfollow');
    });
  }
  if (directBtn) {
    console.log(`[ATOMX FOLLOW] Found direct follow button on tweet for @${cleanHandle}`);
    await simulateHumanFollowClick(directBtn);
    await sleep(400);
    return true;
  }

  // 2. Tweet Caret (...) menu strategy
  // In Twitter/X, clicking the caret button on another user's tweet opens a menu containing:
  // "Follow @handle" (if not followed) OR "Unfollow @handle" (if already followed).
  const caretBtn = art.querySelector('button[data-testid="caret"], div[data-testid="caret"], [data-testid="caret"], button[aria-label="More"], [aria-label="More"]');
  if (caretBtn && !isWorkflowAborted) {
    try {
      caretBtn.click();
      await sleep(350);

      const menu = document.querySelector('div[role="menu"], div[data-testid="Dropdown"]');
      if (menu) {
        const menuItems = Array.from(menu.querySelectorAll('div[role="menuitem"], [role="menuitem"]'));

        // Check if already following
        const isUnfollowItem = menuItems.find(it => {
          const txt = (it.innerText || '').trim().toLowerCase();
          return txt.startsWith('unfollow') || txt.includes('unfollow @');
        });

        if (isUnfollowItem) {
          console.log(`[ATOMX FOLLOW] Already following @${cleanHandle} (detected via Caret menu).`);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          await sleep(200);
          return true;
        }

        // Look for Follow item
        const followItem = menuItems.find(it => {
          const txt = (it.innerText || '').trim().toLowerCase();
          return txt.startsWith('follow @') || txt === 'follow' || (cleanHandle && txt.includes(`follow @${cleanHandle}`));
        });

        if (followItem) {
          console.log(`[ATOMX FOLLOW] Clicking "Follow @${cleanHandle}" in Caret menu...`);
          await performHumanClick(followItem, { pulseColor: '#10B981', scroll: false, postPause: 300 });
          await sleep(450);
          if (document.querySelector('div[role="menu"], div[data-testid="Dropdown"]')) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
          }
          return true;
        }

        // Close menu if neither found
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        await sleep(200);
      }
    } catch (err) {
      console.warn('[ATOMX FOLLOW] Caret menu follow error:', err);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
  }

  if (isWorkflowAborted) return false;

  // 3. HoverCard strategy fallback (hovering user avatar or username)
  try {
    const authorTarget = art.querySelector('div[data-testid="User-Name"] a, div[data-testid="Tweet-User-Avatar"] a, div[data-testid="Tweet-User-Avatar"]');
    if (authorTarget) {
      authorTarget.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      authorTarget.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      authorTarget.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await sleep(650);

      const hoverCard = document.querySelector('div[data-testid="HoverCard"]');
      let followedViaCard = false;
      if (hoverCard) {
        const hoverFollowBtn = Array.from(hoverCard.querySelectorAll('button, div[role="button"]')).find(b => {
          const txt = (b.innerText || '').trim();
          const tid = (b.getAttribute('data-testid') || '').toLowerCase();
          return (txt === 'Follow' || tid.endsWith('-follow')) && !txt.includes('Following') && !tid.includes('unfollow');
        });

        if (hoverFollowBtn) {
          console.log(`[ATOMX FOLLOW] Clicking Follow button in HoverCard for @${cleanHandle}...`);
          await simulateHumanFollowClick(hoverFollowBtn);
          await sleep(400);
          followedViaCard = true;
        } else {
          const isAlreadyFollowing = Array.from(hoverCard.querySelectorAll('button, div[role="button"]')).some(b => {
            const txt = (b.innerText || '').trim();
            return txt.includes('Following');
          });
          if (isAlreadyFollowing) {
            followedViaCard = true;
          }
        }
      }

      // Cleanly dismiss the HoverCard so it never lingers on screen
      authorTarget.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      authorTarget.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      authorTarget.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
      authorTarget.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      
      const lingeringCard = document.querySelector('div[data-testid="HoverCard"]');
      if (lingeringCard && lingeringCard.isConnected) {
        try { lingeringCard.remove(); } catch (e) {}
      }
      dismissLingeringTwitterTooltips();
      return followedViaCard;
    }
  } catch (e) {
    console.warn('[ATOMX FOLLOW] HoverCard follow fallback error:', e);
  }

  return false;
}

/**
 * Detects whether a tweet/article has already been liked by the logged-in user.
 * Checks for data-testid="unlike" or aria-labels indicating existing like status.
 */
function isPostAlreadyLiked(targetArticle) {
  if (!targetArticle) return false;
  if (targetArticle.querySelector('button[data-testid="unlike"], div[data-testid="unlike"], [data-testid="unlike"]')) {
    return true;
  }
  const likeBtn = targetArticle.querySelector('button[data-testid="like"], div[data-testid="like"]');
  if (likeBtn) {
    const aria = (likeBtn.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('unlike') || aria.endsWith('liked') || aria === 'liked') return true;
    return false; // Confirmed unliked
  }
  return false;
}

/**
 * 100% reliable Like Click with zero random skips and no duplicate clicks.
 * Global Rule: First scrolls post and like button onto screen, waits until visible, then moves cursor and clicks.
 */
async function simulateHumanLikeClick(targetArticle) {
  if (!targetArticle) return false;

  // Check if already liked
  if (isPostAlreadyLiked(targetArticle)) {
    return true; // Already liked
  }

  // 1. Find like button with all possible Twitter/X selectors
  let likeBtn = targetArticle.querySelector('button[data-testid="like"], div[data-testid="like"], [data-testid="like"]') ||
                Array.from(targetArticle.querySelectorAll('button, div[role="button"]')).find(b => {
                  const label = (b.getAttribute('aria-label') || '').toLowerCase();
                  return label.includes('like') && !label.includes('unlike');
                });

  if (!likeBtn) {
    await sleep(350);
    likeBtn = targetArticle.querySelector('button[data-testid="like"], div[data-testid="like"], [data-testid="like"]');
  }

  if (!likeBtn) return false;

  // 2. Smart Viewport Alignment (Screenshot 2 standard):
  await ensurePostAndActionsInView(targetArticle, likeBtn);
  if (isWorkflowAborted || isWorkflowItemSkipped) return false;

  const safetyResLike = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
  const uSpeedLike = safetyResLike?.atomx_safety_settings?.cursorSpeed !== undefined ? Number(safetyResLike.atomx_safety_settings.cursorSpeed) : 450;
  const isInstantLike = (uSpeedLike === 0);

  // Natural human pause so the like button and post are visibly clear on screen before clicking
  if (!isInstantLike) {
    await sleep(Math.round(300 * Math.max(0.2, uSpeedLike / 450)));
  }
  if (isWorkflowAborted || isWorkflowItemSkipped) return false;

  try {
    // Ensure likeBtn target is the actual button element (not an inner svg or div)
    const buttonTarget = likeBtn.closest('button, [role="button"]') || likeBtn;
    
    // Perform human click: Virtual cursor moves to likeBtn FIRST, hovers, pulses rose, then dispatches pointer & click events!
    await performHumanClick(buttonTarget, { pulseColor: '#F43F5E', scroll: false, postPause: isInstantLike ? 0 : 250 });

    // Verify if like registered on Twitter DOM without triggering accidental un-likes
    let isLikedConfirmed = isPostAlreadyLiked(targetArticle);
    if (!isLikedConfirmed && !isInstantLike) {
      for (let w = 0; w < 6; w++) {
        await sleep(100);
        if (isPostAlreadyLiked(targetArticle)) {
          isLikedConfirmed = true;
          break;
        }
      }
    }
    // Only if confirmed unliked after polling, apply a single fallback click
    if (!isLikedConfirmed) {
      console.log('[ATOMX LIKE] Like not reflected yet after wait. Applying single fallback click...');
      try { buttonTarget.click(); } catch (err) {}
    }
    return true;
  } catch (e) {
    const buttonTarget = likeBtn.closest('button, [role="button"]') || likeBtn;
    buttonTarget.click();
    return true;
  }
}

/**
 * 100% reliable Reply Click with visual highlighting & full pointer events.
 * Opens the Twitter / X reply modal dialog or focuses the composer.
 */
async function simulateHumanReplyClick(replyBtn) {
  if (!replyBtn) return false;
  try {
    const target = replyBtn.closest('button, [role="button"]') || replyBtn;
    await gentleScrollIntoView(target);
    await sleep(200);

    // Perform human click: Virtual cursor moves to replyBtn FIRST, hovers, pulses emerald, then clicks!
    await performHumanClick(target, { pulseColor: '#10B981', scroll: false, postPause: 250 });
    return true;
  } catch (e) {
    try {
      const target = replyBtn.closest('button, [role="button"]') || replyBtn;
      target.click();
    } catch (err) {
      replyBtn.click();
    }
    return true;
  }
}

/**
 * 100% reliable single-click Submit with visual blue pulse & pointer events.
 * Submits the reply/comment without triggering duplicate submission warnings.
 */
var lastSubmitClickTimestamp = 0;
async function simulateHumanSubmitClick(btn) {
  if (!btn) return false;
  // Guard against submitting an already-submitted button
  if (btn.getAttribute('data-atomx-submitted') === 'true') {
    console.warn('[ATOMX SUBMIT] Submit button already clicked for this comment. Preventing duplicate submit.');
    return true;
  }
  // Debounce guard: Prevent duplicate click within 4 seconds
  const now = Date.now();
  if (now - lastSubmitClickTimestamp < 4000) {
    console.warn('[ATOMX SUBMIT] Duplicate submit prevented by debounce guard.');
    return true;
  }
  lastSubmitClickTimestamp = now;
  btn.setAttribute('data-atomx-submitted', 'true');

  try {
    const isInDialog = !!btn.closest('div[role="dialog"], div[aria-modal="true"]');
    const rect = btn.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!isInDialog && (rect.top < 60 || rect.bottom > vh - 40)) {
      await humanScrollElementIntoView(btn, 'nearest');
      await sleep(200);
    }

    // Global rule: Cursor moves to Reply button, waits/hovers (420ms), and clicks
    console.log('[ATOMX SUBMIT] Moving virtual cursor to Reply button, hovering, and submitting...');
    await performHumanClick(btn, {
      pulseColor: '#3B82F6',
      scroll: false,
      hoverDwell: 420,
      postPause: 380
    });
    // Immediately disable pointer events to prevent any duplicate physical/synthetic click
    try {
      btn.style.pointerEvents = 'none';
      btn.disabled = true;
    } catch (err) {}
    return true;
  } catch (e) {
    try { btn.click(); } catch (err) {}
    return true;
  }
}

/**
 * 100% reliable Repost Click with green glow & modal confirmation.
 */
async function simulateHumanRepostClick(targetArticle) {
  if (!targetArticle) return false;
  if (targetArticle.querySelector('button[data-testid="unretweet"], div[data-testid="unretweet"]')) {
    return true; // Already reposted
  }

  // Only scroll article if outside safe viewport bounds
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const artRect = targetArticle.getBoundingClientRect();
  if (artRect.top < 115 || artRect.bottom > vh - 60) {
    await scrollElementIntoViewAndEnsureVisible(targetArticle, 'center');
    if (isWorkflowAborted || isWorkflowItemSkipped) return false;
  }

  const rtBtn = targetArticle.querySelector('button[data-testid="retweet"], div[data-testid="retweet"]') ||
                Array.from(targetArticle.querySelectorAll('button, div[role="button"]')).find(b => {
                  const label = (b.getAttribute('aria-label') || '').toLowerCase();
                  return label.includes('repost') || label.includes('retweet');
                });
  if (!rtBtn) return false;

  try {
    const rtRect = rtBtn.getBoundingClientRect();
    if (rtRect.top < 115 || rtRect.bottom > vh - 60) {
      await scrollElementIntoViewAndEnsureVisible(rtBtn, 'nearest');
      await sleep(250);
    }
    if (isWorkflowAborted || isWorkflowItemSkipped) return false;

    rtBtn.style.transition = 'transform 0.2s ease, filter 0.2s ease';
    rtBtn.style.transform = 'scale(1.2)';
    rtBtn.style.filter = 'drop-shadow(0 0 10px rgba(16, 185, 129, 0.85))';

    await performHumanClick(rtBtn, { pulseColor: '#10B981', scroll: false, postPause: 300 });

    await sleep(250);
    rtBtn.style.transform = 'scale(1)';
    rtBtn.style.filter = 'none';

    const confirmBtn = await waitForElement('div[data-testid="retweetConfirm"], button[data-testid="retweetConfirm"], [data-testid="retweetConfirm"]', 2500) ||
                       Array.from(document.querySelectorAll('div[role="menuitem"], button[role="menuitem"], div[data-testid="Dropdown"] span')).find(el => {
                         const txt = (el.innerText || '').trim();
                         return txt === 'Repost' || txt === 'Retweet';
                       });

    if (confirmBtn) {
      await performHumanClick(confirmBtn, { pulseColor: '#10B981', scroll: false, postPause: 350 });
      await sleep(350);
      return true;
    }
    return false;
  } catch (e) {
    rtBtn.click();
    return true;
  }
}

/**
 * Natural human-like smooth scrolling with micro-steps allowing Twitter React virtual DOM to hydrate.
 */
async function smoothScrollAndHydrate(totalDelta = 650, pauseAfter = 900) {
  const activeModalDialog = document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"], div[aria-modal="true"] div[data-testid="tweetTextarea_0"], div[data-testid="confirmationSheetDialog"]');
  if (isCommentActive && activeModalDialog) {
    console.log('[ATOMX SCROLL] Modal compose dialog is currently active. Skipping smoothScrollAndHydrate.');
    return;
  }
  await humanSmoothScroll(totalDelta, { settlePause: pauseAfter });
}

/**
 * Ensures the comment box (editor / textarea) is comfortably visible in the viewport or modal
 * BEFORE typing begins.
 * Specifically detects long posts (with lots of text or quote tweets) where the comment box
 * is pushed down near or below the bottom edge, and performs a gentle smooth scroll
 * so the user can clearly see what comment is being typed.
 */
async function ensureCommentBoxComfortablyVisible(editor) {
  if (!editor || !editor.isConnected) return false;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const rect = editor.getBoundingClientRect();

  // 1. Check if inside a Twitter Modal Dialog
  const modalDialog = editor.closest('div[role="dialog"], div[aria-modal="true"]');

  if (modalDialog) {
    // In a modal dialog, find the scrollable container holding the tweet and composer
    let scrollContainer = null;
    let curr = editor.parentElement;
    while (curr && curr !== modalDialog.parentElement) {
      const style = window.getComputedStyle(curr);
      const ov = style.overflowY;
      if ((ov === 'auto' || ov === 'scroll') && curr.scrollHeight > curr.clientHeight) {
        scrollContainer = curr;
        break;
      }
      if (curr === modalDialog) break;
      curr = curr.parentElement;
    }

    const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : modalDialog.getBoundingClientRect();
    const isPushedDownInContainer = scrollContainer
      ? (rect.bottom > containerRect.bottom - 70 || rect.top > containerRect.bottom - 130)
      : false;
    const isPushedDownInViewport = (rect.bottom > vh - 170 || rect.top > vh - 130);

    // ONLY when such a long post pushes the comment box down near the bottom:
    if (isPushedDownInContainer || isPushedDownInViewport || rect.top < 80) {
      console.log('[ATOMX] Long post in modal detected! Comment box is pushed down. Performing gentle scroll to bring into clear view...');
      const initialWinY = window.scrollY;

      if (scrollContainer) {
        const targetScrollDelta = rect.top - (containerRect.top + Math.round(containerRect.height * 0.38));
        if (Math.abs(targetScrollDelta) > 15) {
          scrollContainer.scrollBy({ top: Math.round(targetScrollDelta), behavior: 'smooth' });
          await sleep(380);
        }
      } else {
        editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(380);
      }

      // Safeguard: Ensure modal scroll never shifts the background window
      if (window.scrollY !== initialWinY) {
        window.scrollTo(0, initialWinY);
      }
      return true;
    }
    return false;
  }

  // 2. Non-modal: Status page or Timeline inline composer
  if (rect.bottom > vh - 170 || rect.top < 90) {
    console.log('[ATOMX] Comment box not comfortably visible in viewport. Gently scrolling into view...');
    const targetScroll = Math.round(rect.top - (vh * 0.42));
    if (Math.abs(targetScroll) > 25) {
      await humanSmoothScroll(targetScroll, { settlePause: 250, allowModalScroll: true });
    } else {
      editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(350);
    }
    return true;
  }

  return false;
}

/**
 * Human-like letter-by-letter typing with intentional typos & backspace corrections.
 * Fully compatible with modern X (Twitter) DraftJS & Lexical rich-text editors.
 */
async function typeTextHumanLike(editor, text) {
  if (!editor || !text) return false;

  // 1. Ensure comment box is comfortably visible on screen (especially for long posts / quote tweets in modal)
  await ensureCommentBoxComfortablyVisible(editor);

  // Visibly move virtual cursor to the comment box and click
  console.log('[ATOMX] Moving virtual cursor to comment box and clicking...');
  await performHumanClick(editor, {
    pulseColor: '#38BDF8',
    scroll: false,
    hoverDwell: 380,
    postPause: 450
  });

  editor.focus({ preventScroll: true });
  await sleep(150);

  // 2. Clear editor first using Selection range and delete
  try {
    if (editor && editor.isConnected) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false, null);
    }
  } catch (e) {}
  await sleep(180);

  let typedOk = false;

  // Mode B: If Debugger Mode is active, dispatch native hardware text insertion via CDP (Input.insertText)
  const strategy = await getActiveExecutionStrategy();
  if (strategy === 'debugger') {
    try {
      console.log('[ATOMX CDP] Inserting text via Chrome Debugger API (Input.insertText)...');
      editor.focus({ preventScroll: true });
      const cdpRes = await chrome.runtime.sendMessage({
        type: 'CDP_INSERT_TEXT',
        text: text
      });
      if (cdpRes && cdpRes.ok) {
        await sleep(250);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        if ((editor.innerText || editor.textContent || '').trim().length > 0) {
          typedOk = true;
          console.log('[ATOMX CDP] Native text insertion succeeded via Debugger API!');
        }
      }
    } catch (cdpErr) {
      console.warn('[ATOMX CDP] CDP insertText warning, falling back to human typing:', cdpErr);
    }
  }

  // 3. Type character-by-character using realistic human cadence (slow & natural)
  // execCommand natively maintains DraftJS's internal ContentState, block offset keys, and backspace handling.
  if (!typedOk) {
    try {
      const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
      const userTypingDelay = safetyRes?.atomx_safety_settings?.typingDelay !== undefined ? Number(safetyRes.atomx_safety_settings.typingDelay) : 110;

      for (let i = 0; i < text.length; i++) {
        if (isWorkflowAborted || isWorkflowItemSkipped) {
          console.log('[ATOMX] Typing aborted or skipped by user.');
          return false;
        }

        // Respect user pause while typing
        while (isHudWorkflowPaused && !isWorkflowAborted && !isWorkflowItemSkipped) {
          await sleep(400);
        }

        const char = text[i];
        try {
          editor.focus?.({ preventScroll: true });
          editor.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: char,
            bubbles: true,
            cancelable: true,
            composed: true
          }));
        } catch (e) {}
        const ok = document.execCommand('insertText', false, char);
        if (!ok) {
          throw new Error('execCommand insertText failed');
        }

        // Natural human typing cadence scaled by user's Comment Typing Delay setting
        let delay = 0;
        if (userTypingDelay > 0) {
          delay = Math.floor(userTypingDelay * (0.85 + Math.random() * 0.3));
          if (char === '.' || char === '!' || char === '?') {
            delay += Math.floor(userTypingDelay * 2.2); // punctuation pause
          } else if (char === ',' || char === ';') {
            delay += Math.floor(userTypingDelay * 1.4); // comma pause
          } else if (char === ' ') {
            delay += Math.floor(userTypingDelay * 0.9); // word space pause
          } else if (i > 0 && i % 14 === 0) {
            delay += Math.floor(userTypingDelay * 1.5); // thinking pause
          }
        }
        if (delay > 0) await sleep(delay);
      }

    if ((editor.innerText || editor.textContent || '').trim().length > 0) {
      typedOk = true;
    }
  } catch (err) {
    console.log('[ATOMX] Letter typing notice, switching to ClipboardEvent paste fallback:', err?.message || err);
  }
  }

  // 4. Robust Fallback via ClipboardEvent (Paste) if editor is still empty
  // Twitter's DraftJS / Lexical handles native paste events cleanly without corrupting the backspace tree
  if (!typedOk || !(editor.innerText || editor.textContent || '').trim()) {
    console.log('[ATOMX] Fallback to ClipboardEvent paste for DraftJS editor...');
    try {
      editor.focus({ preventScroll: true });
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      try {
        editor.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertFromPaste',
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          composed: true
        }));
      } catch (e) {}
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt
      });
      editor.dispatchEvent(pasteEvt);
      editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await sleep(250);
      if ((editor.innerText || editor.textContent || '').trim().length > 0) {
        typedOk = true;
      }
    } catch (pe) {
      console.log('[ATOMX] Paste fallback notice:', pe?.message || pe);
    }
  }

  await sleep(250);
  return true;
}

/**
 * Universal detector: Checks if target profile is protected/locked or comment section is turned off/restricted.
 */
function isTargetRestrictedOrCommentsLocked(targetArticle = null) {
  try {
    const pageText = (document.body ? document.body.innerText : '') || '';

    // 1. Check if profile account is locked/protected (strictly scoped to user profile header/name)
    const isProtected = pageText.includes('These posts are protected') ||
                        pageText.includes('Only confirmed followers have access') ||
                        !!document.querySelector('div[data-testid="UserName"] svg[data-testid="icon-lock"], div[data-testid="UserProfileHeader_Items"] svg[data-testid="icon-lock"], div[data-testid="UserProfileHeader_Items"] [aria-label*="Protected" i]');
    if (isProtected) {
      return { restricted: true, reason: 'Profile account is locked/protected' };
    }

    // 2. Check inline composer restriction box (only on tweet status pages)
    if (window.location.pathname.includes('/status/')) {
      const inlineBox = document.querySelector('div[data-testid="inline_reply"]');
      const inlineText = (inlineBox?.innerText || '').toLowerCase();
      if (
        inlineText.includes('who can reply') ||
        inlineText.includes('replies to this post are disabled') ||
        inlineText.includes('replies are restricted') ||
        inlineText.includes('accounts the author mentioned') ||
        inlineText.includes('people the author follows')
      ) {
        return { restricted: true, reason: 'Comments/replies are restricted on this post' };
      }
    }

    // 3. Check reply button on target article (only flag if explicitly disabled in DOM)
    if (targetArticle && targetArticle !== document) {
      const replyBtn = targetArticle.querySelector('button[data-testid="reply"], div[data-testid="reply"], [data-testid="reply"]') ||
                       Array.from(targetArticle.querySelectorAll('button, div[role="button"]')).find(b => {
                         const label = (b.getAttribute('aria-label') || '').toLowerCase();
                         return label.includes('reply') && !label.includes('post your reply');
                       });
      if (replyBtn) {
        const isBtnDisabled = replyBtn.getAttribute('aria-disabled') === 'true' || replyBtn.disabled || replyBtn.getAttribute('disabled') !== null;
        const btnLabel = (replyBtn.getAttribute('aria-label') || '').toLowerCase();
        if (isBtnDisabled || btnLabel.includes('disabled') || btnLabel.includes('restricted')) {
          return { restricted: true, reason: 'Reply button is disabled/restricted' };
        }
      }
    }

    // 4. Check global page notice
    if (
      pageText.includes('Replies to this post are disabled') ||
      pageText.includes('Who can reply? People @') ||
      pageText.includes('Who can reply? Accounts @')
    ) {
      return { restricted: true, reason: 'Replies disabled by author' };
    }
  } catch (e) {}

  return { restricted: false };
}

/**
 * Universal, rock-solid Twitter / X Comment & Reply Engine
 * Reliably opens modal dialogs for comments and timeline posts,
 * scopes typing & submit strictly to the dialog, and prevents self-commenting bugs.
 */
async function postCommentOnTargetArticle(targetArticle, commentText) {
  if (!commentText || isWorkflowAborted || isWorkflowItemSkipped) {
    if (isWorkflowItemSkipped) closeAnyOpenTwitterDialog();
    return { success: false, error: 'Empty text, skipped or aborted' };
  }

  // FINAL GATE: whatever the caller passed, only a valid 50-80 char lowercase a-z comment is ever typed
  commentText = twxSafeComment(commentText);

  // Instant check: If comments are locked/restricted, skip immediately without waiting
  const restriction = isTargetRestrictedOrCommentsLocked(targetArticle);
  if (restriction.restricted) {
    console.warn(`[ATOMX COMMENT ENGINE] Comments locked/restricted: ${restriction.reason}. Skipping.`);
    closeAnyOpenTwitterDialog();
    return { success: false, skipped: true, commentsRestricted: true, error: restriction.reason };
  }

  console.log('[ATOMX COMMENT ENGINE] Posting comment:', commentText);
  isCommentActive = true;

  try {
    let textarea = null;
    let dialog = null;
    let isDialog = false;

  const isStatusPage = window.location.pathname.includes('/status/');
  const mainArt = getMainPostArticle();
  const isMainTarget = !targetArticle || targetArticle === mainArt;

  // 1. On tweet status pages, check if inline reply box is already sitting under the tweet
  if (isStatusPage && isMainTarget) {
    let inlineBox = document.querySelector('div[data-testid="inline_reply"] div[data-testid="tweetTextarea_0"], div[data-testid="tweetTextarea_0"][contenteditable="true"]');

    // If placeholder "Post your reply" is present but tweetTextarea_0 isn't yet focused/mounted
    if (!inlineBox) {
      const placeholder = document.querySelector('div[data-testid="inline_reply"], div[data-testid="tweetTextarea_0_placeholder"]') ||
        Array.from(document.querySelectorAll('div[role="button"], div[contenteditable="true"], span, div')).find(el => {
          const t = (el.innerText || el.textContent || '').trim();
          return t === 'Post your reply' || t.startsWith('Post your reply');
        });
      if (placeholder) {
        await humanScrollElementIntoView(placeholder, 'center');
        await sleep(300);
        await performHumanClick(placeholder, {
          pulseColor: '#38BDF8',
          scroll: false,
          hoverDwell: 300,
          postPause: 300
        });
        await sleep(400);
        inlineBox = document.querySelector('div[data-testid="inline_reply"] div[data-testid="tweetTextarea_0"], div[data-testid="tweetTextarea_0"][contenteditable="true"]');
      }
    }

    if (inlineBox) {
      console.log('[ATOMX COMMENT ENGINE] Direct inline reply box detected, activating via virtual cursor...');
      await humanScrollElementIntoView(inlineBox, 'center');
      await sleep(250);
      await performHumanClick(inlineBox, {
        pulseColor: '#38BDF8',
        scroll: false,
        hoverDwell: 300,
        postPause: 300
      });
      textarea = inlineBox;
      isDialog = false;
      await sleep(200);
    }
  }

  // 2. If no textarea mounted yet, locate and click Reply button on targetArticle
  if (!textarea) {
    let replyBtn = targetArticle?.querySelector('button[data-testid="reply"], div[data-testid="reply"]');
    if (!replyBtn && !window.location.pathname.includes('/compose/post')) {
      replyBtn = document.querySelector('button[data-testid="reply"]');
    }

    if (!replyBtn) {
      console.log('[ATOMX COMMENT ENGINE] Reply button not found on target article (might be ad, video, or restricted). Skipping.');
      return { success: false, skipped: true, commentsRestricted: true, error: 'Reply button not found on post' };
    }

    console.log('[ATOMX COMMENT ENGINE] Clicking Reply button on target tweet/comment...');
    await simulateHumanReplyClick(replyBtn);
    await sleep(400);

    // Wait up to 3.5s for EITHER dialog OR inline box to appear
    const startWait = Date.now();
    while (Date.now() - startWait < 3500) {
      dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
      if (dialog) break;
      const inlineNow = document.querySelector('div[data-testid="inline_reply"] div[data-testid="tweetTextarea_0"], div[data-testid="tweetTextarea_0"][contenteditable="true"]');
      if (inlineNow) {
        textarea = inlineNow;
        isDialog = false;
        break;
      }
      await sleep(150);
    }

    if (dialog) {
      isDialog = true;

      // Check immediately if this is a "Who can reply?" restriction dialog
      const dialogText = (dialog.innerText || '').toLowerCase();
      if (dialogText.includes('who can reply') || dialogText.includes('only some accounts can reply') || dialogText.includes('accounts mentioned')) {
        console.log('[ATOMX COMMENT ENGINE] "Who can reply?" restriction detected. Dismissing modal...');
        const gotItBtn = Array.from(dialog.querySelectorAll('button, div[role="button"]')).find(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return t === 'got it' || t === 'close' || b.getAttribute('aria-label') === 'Close';
        });
        if (gotItBtn) {
          try { gotItBtn.click(); } catch (e) {}
        } else {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        }
        await sleep(300);
        if (dialog.isConnected) {
          try { dialog.remove(); } catch (e) {}
        }
        const mask = document.querySelector('div[data-testid="mask"]');
        if (mask && !document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"]')) {
          try { mask.remove(); } catch (e) {}
        }
        return { success: false, skipped: true, commentsRestricted: true, error: 'Who can reply restriction' };
      }

      for (let w = 0; w < 10; w++) {
        textarea = dialog.querySelector('div[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]');
        if (textarea) break;
        await sleep(150);
      }
    } else if (!textarea) {
      // Check if clicking reply focused an inline reply composer
      const inline = document.querySelector('div[data-testid="inline_reply"] div[data-testid="tweetTextarea_0"], div[data-testid="tweetTextarea_0"][contenteditable="true"], div[data-testid="tweetTextarea_0"]');
      if (inline) {
        console.log('[ATOMX COMMENT ENGINE] Inline reply textarea detected after click!');
        textarea = inline;
        isDialog = false;
      } else {
        console.log('[ATOMX COMMENT ENGINE] Reply modal or inline composer did not appear for this tweet (may be restricted or disabled). Skipping.');
        return { success: false, skipped: true, commentsRestricted: true, error: 'Reply box not available (comments restricted or disabled by author)' };
      }
    }
  }

  if (!textarea || isWorkflowAborted || isWorkflowItemSkipped) {
    if (dialog && dialog.isConnected) {
      // Safely close and dismiss any open dialog that failed to mount a composer
      const closeBtn = dialog.querySelector('button[aria-label="Close"], div[aria-label="Close"], button[data-testid="app-bar-close"]');
      if (closeBtn) {
        try { closeBtn.click(); } catch (e) {}
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      await sleep(250);
      if (dialog.isConnected) {
        try { dialog.remove(); } catch (e) {}
      }
      const mask = document.querySelector('div[data-testid="mask"]');
      if (mask && !document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"]')) {
        try { mask.remove(); } catch (e) {}
      }
    } else {
      await closeAnyOpenTwitterDialog();
    }
    if (isWorkflowAborted || isWorkflowItemSkipped) {
      console.log('[ATOMX COMMENT ENGINE] Reply cancelled: workflow was aborted or skipped by user.');
      return { success: false, aborted: isWorkflowAborted, skipped: isWorkflowItemSkipped, error: 'Workflow was aborted or skipped by user' };
    }
    console.log('[ATOMX COMMENT ENGINE] Reply textarea not found inside dialog. Dismissed modal and skipping comment.');
    return { success: false, commentsRestricted: true, error: 'Textarea not found inside dialog' };
  }

  // Pre-typing verification: check if daily post limit or rate limit is already active
  const preCheckLimit = checkTwitterRateLimit();
  if (preCheckLimit) {
    triggerRateLimitAbort(preCheckLimit.text, preCheckLimit.isDailyLimit);
    await closeAnyOpenTwitterDialog();
    return { success: false, aborted: true, rateLimited: true, isDailyLimit: preCheckLimit.isDailyLimit, error: preCheckLimit.text };
  }

  // Pre-typing verification: ONLY on single-tweet status pages (never on Home/Search timelines)
  const curHandle = getLoggedInUserHandle() || '';
  if (isStatusPage && curHandle && hasUserAlreadyCommented(curHandle)) {
    console.log(`[ATOMX COMMENT ENGINE] User @${curHandle} already has a comment on this post. Aborting and clearing dialog.`);
    clearAnyDraftComment();
    return { success: true, ignored: true, commentSkipped: true, reason: 'Already commented on this post previously.' };
  }

  // 3. Type into editor (letter by letter or instant paste depending on user typing delay)
  await typeTextHumanLike(textarea, commentText);

  if (isWorkflowAborted || isWorkflowItemSkipped) {
    await clearAnyDraftComment();
    return { success: false, aborted: isWorkflowAborted, skipped: isWorkflowItemSkipped, error: 'Workflow was aborted or skipped by user' };
  }

  // Brief pause for DraftJS to sync React state
  const speedChk = await chrome.storage?.local?.get(['atomx_safety_settings']).catch(() => ({}));
  const uSpeed = speedChk?.atomx_safety_settings?.cursorSpeed !== undefined ? Number(speedChk.atomx_safety_settings.cursorSpeed) : 450;
  if (uSpeed > 0) {
    await sleep(Math.round(600 * Math.max(0.2, uSpeed / 450)));
  } else {
    await sleep(100);
  }

  // 5. Find Submit Reply Button scoped to dialog if open
  const scope = (isDialog && dialog) ? dialog : document;
  const getSubmitBtn = () => {
    let btn = scope.querySelector('button[data-testid="tweetButton"]') ||
              scope.querySelector('button[data-testid="tweetButtonInline"]') ||
              document.querySelector('div[role="dialog"] button[data-testid="tweetButton"]') ||
              document.querySelector('button[data-testid="tweetButtonInline"]') ||
              document.querySelector('button[data-testid="tweetButton"]');

    if (!btn) {
      const allBtns = Array.from(scope.querySelectorAll('button, div[role="button"]'));
      btn = allBtns.find(b => {
        const txt = (b.innerText || '').trim().toLowerCase();
        return (txt === 'reply' || txt === 'post') && !txt.includes('post your reply');
      });
    }
    return btn;
  };

  let submitBtn = getSubmitBtn();

  // If button is still disabled or missing, wake up Twitter React state via W3C beforeinput & clipboard paste
  if (!submitBtn || submitBtn.getAttribute('aria-disabled') === 'true' || submitBtn.disabled) {
    try {
      textarea.focus({ preventScroll: true });
      const dt = new DataTransfer();
      dt.setData('text/plain', commentText);
      try {
        textarea.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertFromPaste',
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          composed: true
        }));
      } catch (ie) {}
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt
      });
      textarea.dispatchEvent(pasteEvt);
      await sleep(250);
      textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      await sleep(250);
    } catch (e) {
      console.log('[ATOMX COMMENT ENGINE] Editor paste activation notice:', e?.message || e);
    }
    submitBtn = getSubmitBtn();
  }

  if (!submitBtn) {
    console.log('[ATOMX COMMENT ENGINE] Submit reply button not found.');
    await clearAnyDraftComment();
    await closeAnyOpenTwitterDialog();
    return { success: false, error: 'Submit button not found' };
  }

  // Pre-submit verification: If comment section hydrated during typing, abort submission
  if (curHandle && hasUserAlreadyCommented(curHandle)) {
    console.log(`[ATOMX COMMENT ENGINE] User @${curHandle} comment appeared before submit. Aborting submission.`);
    await clearAnyDraftComment();
    await closeAnyOpenTwitterDialog();
    return { success: true, ignored: true, commentSkipped: true, reason: 'Already commented on this post previously.' };
  }

  // Wait briefly for React internal editorState to sync and enable the submit button
  let waitCount = 0;
  while ((submitBtn.getAttribute('aria-disabled') === 'true' || submitBtn.disabled) && waitCount < 15) {
    await sleep(150);
    submitBtn = getSubmitBtn() || submitBtn;
    waitCount++;
  }

  // Pre-submit check: Ensure textarea actually contains content before attempting submit
  const currentEditorContent = (textarea.innerText || textarea.textContent || '').trim();
  if (!currentEditorContent) {
    console.log('[ATOMX COMMENT ENGINE] Textarea empty before submit. Re-attempting text entry...');
    await typeTextHumanLike(textarea, commentText);
    await sleep(350);
    submitBtn = getSubmitBtn() || submitBtn;
  }

  // If submit button is still strictly disabled in React state, DO NOT force-click (prevents "content of your post is invalid" rejection)
  const isStillDisabled = submitBtn.getAttribute('aria-disabled') === 'true' || submitBtn.disabled;
  if (isStillDisabled) {
    console.log('[ATOMX COMMENT ENGINE] Submit button remained disabled by Twitter React state. Discarding cleanly to avoid invalid post content error.');
    await clearAnyDraftComment();
    await closeAnyOpenTwitterDialog();
    return { success: false, skipped: true, error: 'Twitter submit button remained disabled in React state' };
  }

  // 6. Click Submit with human pointer events (single click guarantee)
  await simulateHumanSubmitClick(submitBtn);
  console.log('[ATOMX COMMENT ENGINE] Clicked Submit button, awaiting Twitter confirmation...');

  // Immediately lock submitBtn to ensure zero secondary clicks occur
  try {
    submitBtn.style.pointerEvents = 'none';
    submitBtn.disabled = true;
  } catch (e) {}

  // Wait for Twitter to process the comment and confirm
  let isConfirmedSent = false;
  const submitWaitStart = Date.now();
  const maxSubmitWaitMs = 8000;

  while (Date.now() - submitWaitStart < maxSubmitWaitMs) {
    if (isWorkflowAborted || isWorkflowItemSkipped) break;

    // A. Check for Twitter's native "Your post was sent" toast (100% authoritative confirmation)
    const toastElements = Array.from(document.querySelectorAll('div[data-testid="toast"], [data-testid="toast"] span, [role="status"]'));
    for (const tEl of toastElements) {
      const tTxt = (tEl.innerText || tEl.textContent || '').toLowerCase();
      if (tTxt.includes('your post was sent') || tTxt.includes('post was sent') || (tTxt.includes('sent') && tTxt.includes('view'))) {
        isConfirmedSent = true;
        console.log('[ATOMX COMMENT ENGINE] Twitter "Your post was sent" toast confirmed! Comment verified.');
        break;
      }
    }
    if (isConfirmedSent) break;

    // B. Check if Twitter gave "Whoops! You already said that."
    // Note: On Twitter this notice ONLY appears when the identical tweet has already been published.
    // Hence, this is proof that the comment was already successfully posted!
    const duplicateAlert = Array.from(document.querySelectorAll('div[role="alert"], [data-testid="toast"], div[role="alertdialog"]')).find(el => {
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return txt.includes('whoops! you already said that') || txt.includes('you already sent that');
    });
    if (duplicateAlert) {
      isConfirmedSent = true;
      console.log('[ATOMX COMMENT ENGINE] "Whoops! You already said that" alert detected — comment already published on Twitter! Verified.');
      break;
    }

    // C. Check immediately if Twitter responded with a REAL content rejection error banner or toast
    const postErr = checkTwitterPostError();
    if (postErr) {
      console.warn('[ATOMX COMMENT ENGINE] Twitter rejected post content:', postErr);
      await clearAnyDraftComment();
      await closeAnyOpenTwitterDialog();
      return { success: false, skipped: true, postInvalid: true, error: `Twitter post rejected: ${postErr}` };
    }

    // D. Check immediately if Twitter responded with a rate limit or daily limit error banner/toast
    const activeLimit = checkTwitterRateLimit();
    if (activeLimit) {
      triggerRateLimitAbort(activeLimit.text, activeLimit.isDailyLimit);
      await clearAnyDraftComment();
      await closeAnyOpenTwitterDialog();
      return { success: false, aborted: true, rateLimited: true, isDailyLimit: activeLimit.isDailyLimit, error: activeLimit.text };
    }

    // E. Check if dialog / inline box has closed / cleared naturally
    if (isDialog) {
      const activeDialog = document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"], div[aria-modal="true"] div[data-testid="tweetTextarea_0"]');
      if (!activeDialog) {
        isConfirmedSent = true;
        console.log('[ATOMX COMMENT ENGINE] Reply dialog successfully closed by Twitter! Comment verified.');
        break;
      }
    } else {
      const inlineTa = document.querySelector('div[data-testid="inline_reply"] div[data-testid="tweetTextarea_0"]');
      if (!inlineTa || !(inlineTa.innerText || inlineTa.textContent || '').trim()) {
        isConfirmedSent = true;
        console.log('[ATOMX COMMENT ENGINE] Inline reply textarea cleared by Twitter! Comment verified.');
        break;
      }
    }

    // F. Check if user\'s comment now appears in the thread below
    if (curHandle && isStatusPage) {
      const myComment = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).find(art => {
        const text = (art.innerText || art.textContent || '');
        return text.includes(`@${curHandle}`) && text.includes(commentText.slice(0, 20));
      });
      if (myComment) {
        isConfirmedSent = true;
        console.log('[ATOMX COMMENT ENGINE] Published comment found in thread under tweet! Comment verified.');
        break;
      }
    }

    // NO secondary fallback button.click()! The initial click is authentic and final.
    await sleep(250);
  }

  // If dialog is still lingering after max wait, check if submit is still enabled (failed)
  if (!isConfirmedSent) {
    const lingeringDialog = document.querySelector('div[role="dialog"] div[data-testid="tweetTextarea_0"], div[aria-modal="true"] div[data-testid="tweetTextarea_0"]');
    if (lingeringDialog) {
      const lingeringBtn = getSubmitBtn();
      const stillActive = lingeringBtn && !lingeringBtn.disabled && lingeringBtn.getAttribute('aria-disabled') !== 'true';
      if (stillActive) {
        console.warn('[ATOMX COMMENT ENGINE] Comment was not sent by Twitter (button still active after 8s). Discarding.');
        await clearAnyDraftComment();
        await closeAnyOpenTwitterDialog();
        return { success: false, error: 'Comment submission was not processed by Twitter' };
      }
    }
  }

  const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
  const s = safetyRes?.atomx_safety_settings || {};
  const isInstant = (s.cursorSpeed !== undefined && Number(s.cursorSpeed) === 0);
  if (!isInstant) {
    await sleep(Math.round(600 * Math.max(0.2, (Number(s.cursorSpeed) || 450) / 450)));
  }

  // Reply Delay (After Comment): Centralized Anti-Ban Safety pause before next action
  try {
    let rMin = s.replyDelayMin !== undefined ? Number(s.replyDelayMin) : (s.replyDelay !== undefined ? Math.max(0, Number(s.replyDelay) - 3) : 3);
    let rMax = s.replyDelayMax !== undefined ? Number(s.replyDelayMax) : (s.replyDelay !== undefined ? Number(s.replyDelay) : 6);
    if (isNaN(rMin)) rMin = 3;
    if (isNaN(rMax)) rMax = 6;
    if (rMin > rMax) [rMin, rMax] = [rMax, rMin];

    if (isInstant || (rMin === 0 && rMax === 0)) {
      // Strictly 0s delay when user configured 0 or instant mode!
    } else {
      const waitSec = Math.floor(rMin + Math.random() * (rMax - rMin + 1));
      if (waitSec > 0) {
        console.log(`[ATOMX COMMENT ENGINE] Reply Delay (After Comment): dynamically randomized ${waitSec}s from configured range [${rMin}s - ${rMax}s]...`);
        for (let rSec = waitSec; rSec > 0 && !isWorkflowAborted; rSec--) {
          const rTimeStr = `0:${String(rSec).padStart(2, '0')}`;
          updateFloatingHud({
            stateBadge: 'PACING',
            statusText: `⏳ Reply Delay (After Comment): ${rSec}s remaining...`,
            countdownText: `Reply Delay: ${rTimeStr}`,
            nextAction: `Reply Delay: ${rTimeStr}`,
            timerBadge: `⏱️ ${rTimeStr}`
          });
          try {
            const curStored = await chrome.storage.local.get(['atomx_tg_raid', 'atomx_active_hud']).catch(() => ({}));
            if (curStored?.atomx_tg_raid?.active) {
              chrome.storage.local.set({
                atomx_tg_raid: {
                  ...curStored.atomx_tg_raid,
                  stateBadge: 'PACING',
                  statusText: `⏳ Reply Delay (After Comment): ${rSec}s remaining...`,
                  countdownText: `Reply Delay: ${rTimeStr}`,
                  timerBadge: `⏱️ ${rTimeStr}`
                }
              }).catch(() => null);
            }
          } catch (e) {}
          await sleep(1000);
        }
      }
    }
  } catch (e) {}

  return { success: true };
} finally {
  isCommentActive = false;
}
}

// Helper: Detects Twitter post validation errors (The content of your post is invalid, duplicates, etc.)
function checkTwitterPostError() {
  const elements = Array.from(document.querySelectorAll(
    'div[data-testid="toast"], div[role="alert"], div[role="alertdialog"], div[data-testid="error-detail"], [data-testid="toast"] span, [role="alert"] span, [aria-live="assertive"], [aria-live="polite"]'
  ));
  for (const el of elements) {
    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
    if (
      txt.includes('content of your post is invalid') ||
      txt.includes('post is invalid') ||
      txt.includes('something went wrong') ||
      txt.includes('cannot send') ||
      txt.includes('tweet is unavailable') ||
      txt.includes('post was deleted')
    ) {
      return txt;
    }
  }
  return null;
}

// =========================================================================
// TWITTER / X RATE LIMIT & DAILY POST LIMIT AUTO-ABORT MONITOR
// =========================================================================
function checkTwitterRateLimit() {
  const elements = Array.from(document.querySelectorAll(
    'div[data-testid="toast"], div[role="alert"], div[role="alertdialog"], div[data-testid="error-detail"], [data-testid="toast"] span, [role="alert"] span, div[data-testid="empty_state"], div[role="dialog"], div[aria-modal="true"]'
  ));

  const checkText = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    const txt = raw.toLowerCase();

    // 1. Daily Post Limit / Tweet Limit (Twitter hard cap message)
    if (
      txt.includes('daily post limit') ||
      txt.includes('hit the daily post limit') ||
      txt.includes('daily tweet limit') ||
      txt.includes('daily limit') ||
      txt.includes('subscribe to premium for higher limits') ||
      txt.includes('upgrade to unlock') ||
      txt.includes('over the daily limit') ||
      txt.includes('reached your limit') ||
      txt.includes('you are over the daily limit') ||
      txt.includes('whoops! you\'ve hit your daily post limit')
    ) {
      return {
        isDailyLimit: true,
        text: "You've hit the daily post limit. Subscribe to Premium for higher limits."
      };
    }

    // 2. Standard Rate Limit / Over Capacity
    if (
      txt.includes('rate limit') ||
      txt.includes('rate-limit') ||
      txt.includes('rate limited') ||
      txt.includes('rate-limited') ||
      txt.includes('sorry, you are rate limited') ||
      txt.includes('sorry you are rate limit') ||
      txt.includes('you are rate limited') ||
      txt.includes('cannot retrieve tweets at this time') ||
      txt.includes('cannot retrieve posts at this time') ||
      txt.includes('over capacity')
    ) {
      return {
        isDailyLimit: false,
        text: "Twitter Rate Limit: Sorry, you are rate limited."
      };
    }

    return null;
  };

  for (const el of elements) {
    const res = checkText(el.innerText || el.textContent || '');
    if (res) return res;
  }

  // Also check top-level alerts / error toasts anywhere on document body
  const toasts = document.querySelectorAll('div[data-testid="toast"], div[role="alert"]');
  for (const t of toasts) {
    const res = checkText(t.textContent || '');
    if (res) return res;
  }

  // Also check open modal dialog text if present
  const openModal = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
  if (openModal) {
    const res = checkText(openModal.innerText || openModal.textContent || '');
    if (res) return res;
  }

  return null;
}

function showLimitWarningOnPage(reason, isDailyLimit = false) {
  const existing = document.getElementById('atomx-limit-warning-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'atomx-limit-warning-modal';
  modal.style.cssText = `
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: 90%;
    max-width: 520px;
    background: linear-gradient(135deg, rgba(30, 20, 25, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%);
    border: 2px solid #EF4444;
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.8), 0 0 24px rgba(239, 68, 68, 0.35);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #FFFFFF;
    z-index: 2147483647;
    padding: 16px 20px;
    box-sizing: border-box;
    user-select: none;
  `;

  const titleText = isDailyLimit ? "🛑 Twitter Daily Post Limit Reached!" : "🚨 Twitter Rate Limit Detected!";
  const descText = isDailyLimit
    ? "Twitter has restricted your account from posting further tweets/replies today (<strong>\"You've hit the daily post limit\"</strong>).<br><br>All active AtomX automation tasks have been <strong>automatically stopped immediately</strong> to protect your account."
    : "Twitter returned a rate limit response (<strong>\"Sorry, you are rate limited\"</strong>).<br><br>All active AtomX automation tasks have been <strong>automatically stopped immediately</strong> to protect your account.";

  modal.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:20px;">🛑</span>
        <strong style="font-size:15px; color:#F87171; font-weight:800;">${titleText}</strong>
      </div>
      <button id="atomx-close-limit-modal-btn" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.15); color:#FCA5A5; font-size:14px; font-weight:800; border-radius:6px; width:26px; height:26px; cursor:pointer; display:flex; align-items:center; justify-content:center; line-height:1;" title="Close Alert">✕</button>
    </div>
    <div style="font-size:12.5px; color:#E2E8F0; line-height:1.5; margin-bottom:14px;">
      ${descText}
    </div>
    <div style="display:flex; justify-content:flex-end; gap:8px;">
      <button id="atomx-ack-limit-modal-btn" style="background:#EF4444; color:#FFFFFF; border:none; padding:8px 16px; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; box-shadow:0 2px 8px rgba(239,68,68,0.4);">
        Acknowledge & Stop Tasks
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  const cleanup = () => {
    if (modal && modal.isConnected) modal.remove();
  };

  modal.querySelector('#atomx-close-limit-modal-btn')?.addEventListener('click', cleanup);
  modal.querySelector('#atomx-ack-limit-modal-btn')?.addEventListener('click', cleanup);
}

function triggerRateLimitAbort(reason = 'Sorry, you are rate limited.', isDailyLimit = false) {
  console.warn(`[ATOMX ALERT] Twitter Limit Detected (${isDailyLimit ? 'DAILY POST LIMIT' : 'RATE LIMIT'}): ${reason}. Stopping all automation immediately.`);
  isWorkflowAborted = true;

  // Clean up any open reply modal or draft
  closeAnyOpenTwitterDialog();
  clearAnyDraftComment();

  const badgeText = isDailyLimit ? 'DAILY_LIMIT' : 'RATE_LIMITED';
  const statusText = isDailyLimit
    ? '🛑 Daily Post Limit Hit! All automation stopped immediately to protect account.'
    : '🚨 Rate limit detected! All automation stopped immediately to protect account.';

  updateFloatingHud({
    stateBadge: badgeText,
    statusText: statusText,
    timerBadge: '🛑 Stopped',
    nextAction: isDailyLimit ? 'Stopped: Daily Limit Hit' : 'Stopped: Rate Limit Hit',
    isStopped: true,
    active: false
  });

  // Display prominent on-page notification toast
  showLimitWarningOnPage(reason, isDailyLimit);

  // Send message to background service worker to kill all workflows and alarms
  chrome.runtime.sendMessage({
    type: 'RATE_LIMIT_DETECTED',
    isDailyLimit,
    error: reason
  }).catch(() => null);

  chrome.runtime.sendMessage({ type: 'ABORT_WORKFLOW' }).catch(() => null);
  chrome.runtime.sendMessage({ type: 'BG_ABORT_AGENT_WORKFLOW' }).catch(() => null);
}

// =========================================================================
// ATOMX FLOATING MINI HUD (ON-PAGE OVERLAY WIDGET)
// =========================================================================
var floatingHudEl = null;
var isHudDismissedLocally = false;
var isPopupOpenLocally = false;
var isHudWorkflowPaused = false;

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(['atomx_popup_open', 'atomx_hud_dismissed', 'atomx_workflow_paused']).then(res => {
    isPopupOpenLocally = Boolean(res?.atomx_popup_open);
    isHudDismissedLocally = Boolean(res?.atomx_hud_dismissed);
    isHudWorkflowPaused = Boolean(res?.atomx_workflow_paused);
    if (isPopupOpenLocally || isHudDismissedLocally) {
      if (floatingHudEl) floatingHudEl.style.display = 'none';
    }
  }).catch(() => null);
}

function ensureFloatingHud() {
  if (floatingHudEl && document.body.contains(floatingHudEl)) return floatingHudEl;

  const existing = document.getElementById('atomx-floating-hud');
  if (existing) {
    floatingHudEl = existing;
    return floatingHudEl;
  }

  const hud = document.createElement('div');
  const isMobileScreen = window.innerWidth <= 480;
  hud.style.cssText = `
    position: fixed;
    bottom: ${isMobileScreen ? '10px' : '24px'};
    right: ${isMobileScreen ? '8px' : '24px'};
    width: ${isMobileScreen ? 'calc(100vw - 16px)' : '330px'};
    max-width: 360px;
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(59, 130, 246, 0.35);
    border-radius: 14px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65), 0 0 1px rgba(255, 255, 255, 0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #F8FAFC;
    z-index: 2147483647;
    padding: 13px;
    box-sizing: border-box;
    transition: transform 0.2s ease, opacity 0.2s ease;
    user-select: none;
  `;

  hud.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px;">
      <div style="display: flex; align-items: center; gap: 7px;">
        <span id="hud-badge" style="background: rgba(16, 185, 129, 0.15); color: #10B981; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px;">RUNNING</span>
        <strong id="hud-title" style="font-size: 13px; font-weight: 700; color: #FFFFFF;">Twixor Agent</strong>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span id="hud-indicator" style="font-size: 11px; font-weight: 700; color: #60A5FA;">Active</span>
        <button id="hud-minimize-btn" title="Minimize / Expand" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12); color: #CBD5E1; font-size: 14px; font-weight: 700; border-radius: 6px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; line-height: 1;">−</button>
        <button id="hud-close-btn" title="Close & Hide HUD (✕)" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #FCA5A5; font-size: 13px; font-weight: 800; border-radius: 6px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; line-height: 1;">✕</button>
      </div>
    </div>

    <!-- 3 Metric Cards Grid -->
    <div id="hud-body" style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
        <div style="background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 6px 4px; text-align: center;">
          <div style="font-size: 9px; color: #94A3B8; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">DONE</div>
          <div id="hud-done-count" style="font-size: 17px; font-weight: 800; color: #10B981; margin-top: 1px;">0</div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 6px 4px; text-align: center;">
          <div style="font-size: 9px; color: #94A3B8; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">COLLECTED</div>
          <div id="hud-col-count" style="font-size: 17px; font-weight: 800; color: #60A5FA; margin-top: 1px;">0</div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 6px 4px; text-align: center;">
          <div style="font-size: 9px; color: #94A3B8; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">SKIPPED</div>
          <div id="hud-skip-count" style="font-size: 17px; font-weight: 800; color: #F59E0B; margin-top: 1px;">0</div>
        </div>
      </div>

      <!-- Progress Track -->
      <div style="width: 100%; height: 5px; background: rgba(255, 255, 255, 0.08); border-radius: 99px; overflow: hidden;">
        <div id="hud-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #3B82F6, #10B981); transition: width 0.3s ease;"></div>
      </div>

      <!-- Live Status Text -->
      <div id="hud-status-text" style="font-size: 11px; color: #CBD5E1; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
        Initializing agent automation...
      </div>

      <!-- Next Action & Real-Time Countdown Row -->
      <div id="hud-next-action-row" style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.65); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 7px; padding: 5px 8px; font-size: 11px;">
        <div style="display: flex; align-items: center; gap: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
          <span style="color: #94A3B8; font-size: 9.5px; font-weight: 700; text-transform: uppercase;">NEXT:</span>
          <span id="hud-next-action-text" style="color: #60A5FA; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Preparing next target...</span>
        </div>
        <div id="hud-timer-badge" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #10B981; font-weight: 800; font-family: monospace; font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; margin-left: 6px;">
          ⚡ Active
        </div>
      </div>

      <!-- Action Controls: Pause/Resume, Skip, Stop -->
      <div style="display: flex; gap: 7px; margin-top: 6px;">
        <button id="hud-pause-btn" style="flex: 1; padding: 7.5px 0; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(251, 191, 36, 0.55); border-radius: 8px; color: #FFFFFF; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; box-shadow: 0 0 10px rgba(245, 158, 11, 0.2); transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);" title="Pause or Resume current workflow">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#FBBF24"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg>
          <span id="hud-pause-text">Pause</span>
        </button>
        <button id="hud-skip-action-btn" style="flex: 1; padding: 7.5px 0; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(96, 165, 250, 0.55); border-radius: 8px; color: #FFFFFF; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; box-shadow: 0 0 10px rgba(59, 130, 246, 0.22); transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);" title="Skip current tweet/profile link immediately">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#60A5FA"><path d="M5 19L14 12L5 5v14z"/><rect x="16" y="5" width="3" height="14" rx="1.5"/></svg>
          <span>Skip</span>
        </button>
        <button id="hud-stop-btn" style="flex: 1; padding: 7.5px 0; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(248, 113, 113, 0.6); border-radius: 8px; color: #FFFFFF; font-size: 11px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; box-shadow: 0 0 10px rgba(239, 68, 68, 0.25); transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);" title="Completely abort and stop workflow">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#F87171"><rect x="5.5" y="5.5" width="13" height="13" rx="3.5"/></svg>
          <span>STOP</span>
        </button>
        <button id="hud-dismiss-btn" style="flex: 1; padding: 7.5px 0; background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 8px; color: #FFFFFF; font-size: 11px; font-weight: 700; cursor: pointer; display: none; align-items: center; justify-content: center; gap: 4px;" title="Dismiss HUD">
          Dismiss
        </button>
      </div>
    </div>
  `;

  // Pause / Resume listener — Instant response
  hud.querySelector('#hud-pause-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    isHudWorkflowPaused = !isHudWorkflowPaused;
    const pauseBtn = hud.querySelector('#hud-pause-btn');
    if (pauseBtn) {
      pauseBtn.innerHTML = isHudWorkflowPaused
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="#34D399"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg><span id="hud-pause-text">Resume</span>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="#FBBF24"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg><span id="hud-pause-text">Pause</span>`;
      pauseBtn.style.color = '#FFFFFF';
      pauseBtn.style.background = 'rgba(30, 41, 59, 0.75)';
      pauseBtn.style.borderColor = isHudWorkflowPaused ? 'rgba(52, 211, 153, 0.6)' : 'rgba(251, 191, 36, 0.55)';
      pauseBtn.style.boxShadow = isHudWorkflowPaused ? '0 0 10px rgba(16, 185, 129, 0.2)' : '0 0 10px rgba(245, 158, 11, 0.2)';
    }
    const badge = hud.querySelector('#hud-badge');
    if (badge) {
      badge.textContent = isHudWorkflowPaused ? 'PAUSED' : 'RUNNING';
      badge.style.color = isHudWorkflowPaused ? '#FBBF24' : '#10B981';
      badge.style.background = isHudWorkflowPaused ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.15)';
      badge.style.borderColor = isHudWorkflowPaused ? 'rgba(245, 158, 11, 0.5)' : 'rgba(16, 185, 129, 0.4)';
    }
    const timerBadge = hud.querySelector('#hud-timer-badge');
    if (timerBadge) {
      timerBadge.textContent = isHudWorkflowPaused ? '⏸️ Paused' : '⚡ Active';
    }
    if (typeof TgLikerNativeEngine !== 'undefined') {
      try {
        TgLikerNativeEngine.setCtrl({
          state: isHudWorkflowPaused ? 'paused' : 'running',
          runId: Date.now()
        });
      } catch (err) {}
    }
    chrome.storage.local.set({
      atomx_workflow_paused: isHudWorkflowPaused,
      tgl_ctrl: { state: isHudWorkflowPaused ? 'paused' : 'running' }
    }).catch(() => null);
    chrome.runtime.sendMessage({ type: 'TOGGLE_WORKFLOW_PAUSE', isPaused: isHudWorkflowPaused }).catch(() => null);
  });

  // Skip current item listener — Instant response & real-time tracker update
  let isHudSkipBtnLocked = false;
  hud.querySelector('#hud-skip-action-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isHudSkipBtnLocked) return;
    isHudSkipBtnLocked = true;
    setTimeout(() => { isHudSkipBtnLocked = false; }, 500);
    isWorkflowItemSkipped = true;
    isHudWorkflowPaused = false;

    // Reset pause button UI if it was paused
    const pauseBtn = hud.querySelector('#hud-pause-btn');
    if (pauseBtn) {
      pauseBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
        Pause
      `;
      pauseBtn.style.color = '#FBBF24';
      pauseBtn.style.background = 'rgba(245, 158, 11, 0.12)';
      pauseBtn.style.borderColor = 'rgba(245, 158, 11, 0.55)';
    }
    const badge = hud.querySelector('#hud-badge');
    if (badge) {
      badge.textContent = 'RUNNING';
      badge.style.color = '#10B981';
      badge.style.background = 'rgba(16, 185, 129, 0.15)';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    }

    isWorkflowItemSkipped = true;
    clearAnyDraftComment();
    chrome.storage.local.set({ atomx_skip_current: true, atomx_workflow_paused: false }).catch(() => null);
    chrome.runtime.sendMessage({ type: 'TOGGLE_WORKFLOW_PAUSE', isPaused: false }).catch(() => null);
    chrome.runtime.sendMessage({ type: 'SKIP_WORKFLOW_ITEM' }).catch(() => null);

    // Instant local HUD visual feedback
    const statusEl = hud.querySelector('#hud-status-text');
    if (statusEl) statusEl.textContent = '⏭️ Skipping current item...';
    const timerBadge = hud.querySelector('#hud-timer-badge');
    if (timerBadge) timerBadge.textContent = '⏭️ Skip';
  });

  // Stop workflow listener — Instant response & full engine unification
  hud.querySelector('#hud-stop-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    isWorkflowAborted = true;
    closeAnyOpenTwitterDialog();

    // 1. Immediately kill TgLikerNativeEngine if running
    if (typeof TgLikerNativeEngine !== 'undefined') {
      try {
        TgLikerNativeEngine.stop();
        TgLikerNativeEngine.removeCursor();
      } catch (err) {}
    }
    const tglCursor = document.getElementById('tgl-cursor');
    if (tglCursor) tglCursor.remove();
    removeVirtualCursor();

    const stored = await chrome.storage.local.get(['atomx_agent_workflow', 'atomx_active_hud', 'tgl_state', 'tgl_cfg']).catch(() => ({}));
    const prevWf = stored?.atomx_agent_workflow || {};
    const prevHud = stored?.atomx_active_hud || {};
    const prevTglState = stored?.tgl_state || {};
    const agentId = prevWf.agentId || 'tgliker';
    const title = prevWf.title || prevHud.title || 'TG Liker (Raid & Repost)';
    const total = prevWf.total || prevHud.collected || stored?.tgl_cfg?.maxPosts || 0;
    const done = prevWf.successCount ?? prevHud.done ?? prevTglState.total ?? 0;
    const skipped = prevWf.ignoredCount ?? prevHud.skipped ?? prevTglState.stats?.skipped ?? 0;
    const liked = prevWf.liked ?? prevTglState.stats?.liked ?? 0;
    const reposted = prevWf.reposted ?? prevTglState.stats?.reposted ?? 0;
    const bookmarked = prevWf.bookmarked ?? prevTglState.stats?.bookmarked ?? 0;

    const stoppedHud = {
      ...prevHud,
      title,
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      timerBadge: '🛑 Stopped',
      countdownText: '',
      nextAction: 'Stopped',
      isStopped: true,
      active: false,
      done,
      collected: total,
      skipped,
      indicator: `Post ${done}/${total > 0 ? total : '∞'}`
    };

    const stoppedWf = {
      ...prevWf,
      agentId,
      title,
      active: false,
      isStopped: true,
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      countdownText: '',
      timerBadge: '🛑 Stopped',
      total,
      successCount: done,
      ignoredCount: skipped,
      liked,
      reposted,
      bookmarked
    };

    updateFloatingHud(stoppedHud);

    if (isExtensionValid()) {
      await chrome.storage.local.set({
        atomx_active_hud: stoppedHud,
        atomx_agent_workflow: stoppedWf,
        atomx_workflow_paused: false,
        atomx_tg_raid: { active: false, stateBadge: 'STOPPED', isStopped: true },
        tgl_ctrl: { state: 'stopped', runId: 0 },
        tgl_state: {
          ...prevTglState,
          phase: 'stopped',
          status: '⏹ Stopped by user'
        },
        atomx_tgliker_last_stats: {
          handled: done,
          liked,
          reposted,
          bookmarked,
          skipped
        }
      }).catch(() => null);

      chrome.runtime.sendMessage({ type: 'ABORT_WORKFLOW' }).catch(() => null);
      chrome.runtime.sendMessage({ type: 'BG_ABORT_AGENT_WORKFLOW' }).catch(() => null);
    }
  });

  // Minimize / Expand toggle
  let isMinimized = false;
  hud.querySelector('#hud-minimize-btn')?.addEventListener('click', () => {
    isMinimized = !isMinimized;
    const body = hud.querySelector('#hud-body');
    const minBtn = hud.querySelector('#hud-minimize-btn');
    if (body) body.style.display = isMinimized ? 'none' : 'flex';
    if (minBtn) minBtn.textContent = isMinimized ? '+' : '−';
  });

  // Dismiss / Close HUD handler - Stays dismissed until a new workflow starts!
  const handleDismissHud = () => {
    isHudDismissedLocally = true;
    hud.style.display = 'none';
    if (isExtensionValid()) {
      chrome.storage.local.set({ atomx_hud_dismissed: true }).catch(() => null);
    }
  };

  hud.querySelector('#hud-close-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDismissHud();
  });

  hud.querySelector('#hud-dismiss-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDismissHud();
  });

  // Make draggable
  let isDragging = false;
  let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
  hud.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = hud.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    hud.style.bottom = 'auto';
    hud.style.right = 'auto';
    hud.style.left = `${initialLeft}px`;
    hud.style.top = `${initialTop}px`;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    hud.style.left = `${Math.max(10, Math.min(window.innerWidth - 330, initialLeft + dx))}px`;
    hud.style.top = `${Math.max(10, Math.min(window.innerHeight - 150, initialTop + dy))}px`;
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  document.body.appendChild(hud);
  floatingHudEl = hud;
  return floatingHudEl;
}

let currentHudState = {
  active: false,
  isStopped: false,
  stateBadge: 'READY',
  title: 'Twixor Agent',
  indicator: '',
  done: 0,
  collected: 0,
  skipped: 0,
  statusText: '',
  nextAction: '',
  timerBadge: '',
  countdownText: ''
};

function updateFloatingHud(data = {}) {
  // Merge incoming partial data into persistent HUD state
  currentHudState = Object.assign({}, currentHudState, data);
  const hudData = currentHudState;

  if (hudData.isStopped || hudData.stateBadge === 'STOPPED') {
    isWorkflowAborted = true;
    removeVirtualCursor();
  } else if (hudData.active || data.isNewWorkflow) {
    isWorkflowAborted = false;
    ensureVirtualCursorActive();
  }

  // If explicitly requested a new workflow, clear dismiss flag
  if (data.isNewWorkflow) {
    isHudDismissedLocally = false;
    currentHudState.isStopped = false;
    currentHudState.active = true;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.remove('atomx_hud_dismissed').catch(() => null);
    }
  }

  // The HUD should ONLY be visible when the extension popup is closed!
  if (isPopupOpenLocally && !data.forceShow) {
    if (floatingHudEl) floatingHudEl.style.display = 'none';
    return;
  }

  // If user dismissed HUD on this page instance and it's not a brand new workflow, keep it hidden
  if (isHudDismissedLocally && !data.isNewWorkflow && !data.forceShow) {
    if (floatingHudEl) floatingHudEl.style.display = 'none';
    return;
  }

  const hud = ensureFloatingHud();
  if (!hud) return;

  hud.style.display = 'block';

  if (hudData.title) {
    const el = hud.querySelector('#hud-title');
    if (el) el.textContent = hudData.title;
  }
  if (hudData.indicator) {
    const el = hud.querySelector('#hud-indicator');
    if (el) el.textContent = hudData.indicator;
  }
  if (hudData.stateBadge) {
    const el = hud.querySelector('#hud-badge');
    if (el) {
      el.textContent = hudData.stateBadge;
      if (hudData.stateBadge === 'DONE') {
        el.style.background = 'rgba(16, 185, 129, 0.25)';
        el.style.color = '#34D399';
        el.style.border = '1px solid rgba(16, 185, 129, 0.6)';
      } else if (hudData.stateBadge === 'RATE_LIMITED' || hudData.stateBadge === 'DAILY_LIMIT' || hudData.stateBadge === 'LIMIT_REACHED') {
        el.style.background = 'rgba(239, 68, 68, 0.25)';
        el.style.color = '#EF4444';
        el.style.border = '1px solid rgba(239, 68, 68, 0.6)';
      } else if (hudData.stateBadge === 'STOPPED') {
        el.style.background = 'rgba(100, 116, 139, 0.2)';
        el.style.color = '#94A3B8';
        el.style.border = '1px solid rgba(100, 116, 139, 0.4)';
      } else if (hudData.stateBadge === 'PAUSED') {
        el.style.background = 'rgba(245, 158, 11, 0.2)';
        el.style.color = '#FBBF24';
        el.style.border = '1px solid rgba(245, 158, 11, 0.5)';
      } else {
        el.style.background = 'rgba(16, 185, 129, 0.15)';
        el.style.color = '#10B981';
        el.style.border = '1px solid rgba(16, 185, 129, 0.4)';
      }
    }
  }
  if (hudData.done !== undefined) {
    const el = hud.querySelector('#hud-done-count');
    if (el) el.textContent = hudData.done;
  }
  if (hudData.collected !== undefined) {
    const el = hud.querySelector('#hud-col-count');
    if (el) el.textContent = hudData.collected;
  }
  if (hudData.skipped !== undefined) {
    const el = hud.querySelector('#hud-skip-count');
    if (el) el.textContent = hudData.skipped;
  }
  if (hudData.progressPercent !== undefined) {
    const el = hud.querySelector('#hud-progress-bar');
    if (el) el.style.width = `${Math.min(100, Math.max(0, hudData.progressPercent))}%`;
  }
  if (hudData.statusText) {
    const el = hud.querySelector('#hud-status-text');
    if (el) {
      el.textContent = hudData.statusText;
      el.title = hudData.statusText;
    }
  }

  // Next action display
  const nextActionEl = hud.querySelector('#hud-next-action-text');
  if (nextActionEl) {
    if (hudData.stateBadge === 'DONE') {
      nextActionEl.textContent = 'Workflow Completed';
    } else if (hudData.isStopped || hudData.stateBadge === 'STOPPED') {
      nextActionEl.textContent = 'Stopped by user';
    } else if (hudData.stateBadge === 'PAUSED' || isHudWorkflowPaused) {
      nextActionEl.textContent = 'Workflow Paused';
    } else if (hudData.stateBadge === 'PACING' || hudData.stateBadge === 'BATCH_BREAK') {
      nextActionEl.textContent = hudData.countdownText || hudData.nextAction || 'Pacing Delay...';
    } else if (hudData.countdownText && (hudData.countdownText.includes('Next') || hudData.countdownText.includes('Delay') || hudData.countdownText.includes('Wait') || hudData.countdownText.includes('Break') || hudData.countdownText.includes('Pacing'))) {
      nextActionEl.textContent = hudData.countdownText;
    } else if (hudData.nextAction && hudData.nextAction !== 'Completed') {
      nextActionEl.textContent = hudData.nextAction;
    } else if (hudData.indicator) {
      nextActionEl.textContent = `Target ${hudData.indicator}`;
    }
  }

  // Timer badge display (Real-time delay and countdown display)
  const timerBadgeEl = hud.querySelector('#hud-timer-badge');
  if (timerBadgeEl) {
    if (hudData.stateBadge === 'DONE') {
      timerBadgeEl.textContent = '✓ Done';
      timerBadgeEl.style.color = '#34D399';
    } else if (hudData.stateBadge === 'PAUSED' || isHudWorkflowPaused) {
      timerBadgeEl.textContent = '⏸️ Paused';
      timerBadgeEl.style.color = '#FBBF24';
    } else if (hudData.isStopped || hudData.stateBadge === 'STOPPED') {
      timerBadgeEl.textContent = '⏹️ Stopped';
      timerBadgeEl.style.color = '#94A3B8';
    } else if (hudData.timerBadge && hudData.timerBadge.includes('⏱️')) {
      timerBadgeEl.textContent = hudData.timerBadge;
      timerBadgeEl.style.color = '#38BDF8';
    } else if (hudData.countdownText) {
      const match = hudData.countdownText.match(/(\d+:\d+|\d+\s*s|\d+)/i);
      if (match) {
        const val = match[0].trim();
        timerBadgeEl.textContent = val.includes(':') || val.endsWith('s') ? `⏱️ ${val}` : `⏱️ ${val}s`;
        timerBadgeEl.style.color = '#38BDF8';
      } else {
        timerBadgeEl.textContent = '⏱️ Delay';
        timerBadgeEl.style.color = '#38BDF8';
      }
    } else if (hudData.stateBadge === 'PACING' || (hudData.statusText && hudData.statusText.includes('Delay'))) {
      const match = (hudData.statusText || '').match(/(\d+)\s*s/);
      timerBadgeEl.textContent = match ? `⏱️ ${match[1]}s` : '⏱️ Delay';
      timerBadgeEl.style.color = '#38BDF8';
    } else {
      timerBadgeEl.textContent = '⚡ Active';
      timerBadgeEl.style.color = '#10B981';
    }
  }

  // Sync Pause, Skip, Stop, Dismiss appearance
  const pauseBtn = hud.querySelector('#hud-pause-btn');
  const skipBtn = hud.querySelector('#hud-skip-action-btn');
  const stopBtn = hud.querySelector('#hud-stop-btn');
  const dismissBtn = hud.querySelector('#hud-dismiss-btn');

  // A workflow is ONLY finished if explicitly stopped or done with non-zero done or reached collected target
  const isLimitHit = hudData.stateBadge === 'RATE_LIMITED' || hudData.stateBadge === 'DAILY_LIMIT' || hudData.stateBadge === 'LIMIT_REACHED';
  const isFinished = Boolean(hudData.isStopped) || hudData.stateBadge === 'DONE' || hudData.stateBadge === 'STOPPED' || isLimitHit || (hudData.done !== undefined && hudData.collected !== undefined && hudData.collected > 0 && hudData.done >= hudData.collected);
  const isRunning = !isFinished && (hudData.active !== false) && hudData.stateBadge !== 'DONE' && hudData.stateBadge !== 'STOPPED' && !isLimitHit;

  if (isFinished && hudData.stateBadge !== 'STOPPED' && !isLimitHit) {
    const bEl = hud.querySelector('#hud-badge');
    if (bEl) {
      bEl.textContent = 'DONE';
      bEl.style.background = 'rgba(16, 185, 129, 0.25)';
      bEl.style.color = '#34D399';
      bEl.style.border = '1px solid rgba(16, 185, 129, 0.6)';
    }
    if (nextActionEl) nextActionEl.textContent = 'Workflow Completed';
    if (timerBadgeEl) timerBadgeEl.textContent = '✓ Done';
  } else if (isLimitHit) {
    const bEl = hud.querySelector('#hud-badge');
    if (bEl) {
      bEl.textContent = hudData.stateBadge === 'DAILY_LIMIT' ? 'DAILY LIMIT' : 'RATE LIMITED';
      bEl.style.background = 'rgba(239, 68, 68, 0.25)';
      bEl.style.color = '#EF4444';
      bEl.style.border = '1px solid rgba(239, 68, 68, 0.6)';
    }
    if (nextActionEl) nextActionEl.textContent = hudData.stateBadge === 'DAILY_LIMIT' ? '🛑 Stopped: Daily Limit Hit' : '🛑 Stopped: Rate Limited';
    if (timerBadgeEl) timerBadgeEl.textContent = '🛑 Stopped';
  }

  if (isRunning) {
    if (stopBtn) stopBtn.style.display = 'flex';
    if (pauseBtn) {
      pauseBtn.style.display = 'flex';
      const isPaused = hudData.stateBadge === 'PAUSED' || isHudWorkflowPaused;
      pauseBtn.innerHTML = isPaused
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="#34D399"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg><span id="hud-pause-text">Resume</span>`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="#FBBF24"><rect x="6" y="5" width="4" height="14" rx="2"/><rect x="14" y="5" width="4" height="14" rx="2"/></svg><span id="hud-pause-text">Pause</span>`;
      pauseBtn.style.color = '#FFFFFF';
      pauseBtn.style.background = 'rgba(30, 41, 59, 0.75)';
      pauseBtn.style.borderColor = isPaused ? 'rgba(52, 211, 153, 0.6)' : 'rgba(251, 191, 36, 0.55)';
      pauseBtn.style.boxShadow = isPaused ? '0 0 10px rgba(16, 185, 129, 0.2)' : '0 0 10px rgba(245, 158, 11, 0.2)';
    }
    if (skipBtn) skipBtn.style.display = (hudData.hideSkip || hudData.canSkip === false) ? 'none' : 'flex';
    if (dismissBtn) dismissBtn.style.display = 'none';
  } else {
    if (stopBtn) stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (skipBtn) skipBtn.style.display = 'none';
    if (dismissBtn) dismissBtn.style.display = 'flex';
  }

  // Real-time synchronization to storage so popup progress tracker stays 1:1 in sync
  if (isFinished || data.stateBadge === 'DONE' || data.stateBadge === 'STOPPED') {
    if (window._atomxHudSyncTimer) {
      clearTimeout(window._atomxHudSyncTimer);
      window._atomxHudSyncTimer = null;
    }
  } else if (!window._atomxHudSyncTimer && typeof chrome !== 'undefined' && chrome.storage?.local) {
    window._atomxHudSyncTimer = setTimeout(() => {
      window._atomxHudSyncTimer = null;
      chrome.storage.local.get(['atomx_active_hud', 'atomx_agent_workflow'], (res) => {
        if (res?.atomx_active_hud?.stateBadge === 'DONE' || res?.atomx_active_hud?.isStopped || res?.atomx_agent_workflow?.stateBadge === 'DONE' || res?.atomx_agent_workflow?.active === false) {
          return;
        }
        const activeHud = { ...(res?.atomx_active_hud || {}), ...data };
        const updates = { atomx_active_hud: activeHud };
        if (res?.atomx_agent_workflow && res.atomx_agent_workflow.active) {
          updates.atomx_agent_workflow = {
            ...res.atomx_agent_workflow,
            statusText: data.statusText || res.atomx_agent_workflow.statusText,
            stateBadge: data.stateBadge || res.atomx_agent_workflow.stateBadge,
            ignoredCount: data.skipped !== undefined ? data.skipped : res.atomx_agent_workflow.ignoredCount,
            successCount: data.done !== undefined ? data.done : res.atomx_agent_workflow.successCount,
            countdownText: data.countdownText !== undefined ? data.countdownText : res.atomx_agent_workflow.countdownText
          };
        }
        chrome.storage.local.set(updates).catch(() => null);
      });
    }, 150);
  }
}

function hideFloatingHud() {
  if (floatingHudEl) {
    floatingHudEl.style.display = 'none';
  }
}

// Automatically sync & hydrate on-page floating HUD from chrome.storage.local
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(['atomx_active_hud', 'atomx_hud_dismissed', 'atomx_popup_open'], (res) => {
    isPopupOpenLocally = Boolean(res?.atomx_popup_open);
    isHudDismissedLocally = Boolean(res?.atomx_hud_dismissed);
    const activeHud = res?.atomx_active_hud;

    if (isPopupOpenLocally || isHudDismissedLocally) {
      hideFloatingHud();
      return;
    }

    if (activeHud && activeHud.active) {
      updateFloatingHud(activeHud);
    } else if (activeHud && (activeHud.isStopped || activeHud.stateBadge === 'DONE')) {
      updateFloatingHud(activeHud);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!isExtensionValid() || area !== 'local') return;

    if (changes.atomx_popup_open !== undefined) {
      isPopupOpenLocally = Boolean(changes.atomx_popup_open.newValue);
      if (isPopupOpenLocally) {
        hideFloatingHud();
      } else {
        // Popup closed: show HUD if active and not dismissed
        chrome.storage.local.get(['atomx_active_hud', 'atomx_hud_dismissed']).then(s => {
          if (s?.atomx_active_hud?.active && !s?.atomx_hud_dismissed) {
            updateFloatingHud(s.atomx_active_hud);
          }
        }).catch(() => null);
      }
    }

    if (changes.atomx_hud_dismissed !== undefined) {
      isHudDismissedLocally = Boolean(changes.atomx_hud_dismissed.newValue);
      if (isHudDismissedLocally) {
        hideFloatingHud();
      }
    }

    if (changes.atomx_skip_current !== undefined) {
      isWorkflowItemSkipped = Boolean(changes.atomx_skip_current.newValue);
      if (isWorkflowItemSkipped) {
        clearAnyDraftComment();
      }
    }

    if (changes.atomx_workflow_paused !== undefined) {
      isHudWorkflowPaused = Boolean(changes.atomx_workflow_paused.newValue);
      const pauseBtn = floatingHudEl?.querySelector('#hud-pause-btn');
      if (pauseBtn) {
        pauseBtn.textContent = isHudWorkflowPaused ? '▶️ Resume' : '⏸️ Pause';
        pauseBtn.style.color = isHudWorkflowPaused ? '#34D399' : '#FBBF24';
        pauseBtn.style.background = isHudWorkflowPaused ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)';
      }
      const badge = floatingHudEl?.querySelector('#hud-badge');
      if (badge && !isWorkflowAborted) {
        badge.textContent = isHudWorkflowPaused ? 'PAUSED' : 'RUNNING';
        badge.style.color = isHudWorkflowPaused ? '#FBBF24' : '#10B981';
      }
    }

    if (changes.atomx_agent_workflow) {
      const wf = changes.atomx_agent_workflow.newValue;
      if (wf && (wf.active === false || wf.isStopped || wf.stateBadge === 'STOPPED')) {
        isWorkflowAborted = true;
      }
    }

    if (changes.atomx_active_hud) {
      const val = changes.atomx_active_hud.newValue;

      if (val && val.isNewWorkflow) {
        isHudDismissedLocally = false;
      }

      if (val && (val.isStopped || val.stateBadge === 'STOPPED')) {
        isWorkflowAborted = true;
      }

      if (isPopupOpenLocally || isHudDismissedLocally) {
        hideFloatingHud();
        return;
      }

      if (val && val.active) {
        updateFloatingHud(val);
      } else if (val && (val.isStopped || val.stateBadge === 'DONE')) {
        updateFloatingHud(val);
      } else {
        hideFloatingHud();
      }
    }
  });
}


async function insertIntoTwitterInput(text) {
  text = twxSafeComment(text); // final gate before anything is typed into X
  const editor = document.querySelector('div[data-testid="tweetTextarea_0"]') ||
                 document.querySelector('div[role="textbox"][contenteditable="true"]');
  if (editor) {
    await typeTextHumanLike(editor, text);
  }
}

// Listen to commands from Extension Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ ok: true, active: true });
    return true;
  }

  if (message.type === 'CHECK_CURRENT_LOGGED_IN_X_HANDLE' || message.type === 'GET_CURRENT_X_ACCOUNT') {
    (async () => {
      let handle = await waitForLoggedInUserHandle(1500);
      if (!isValidTwitterHandle(handle)) handle = null;
      const isLoggedOut = !handle && isDefinitelyLoggedOut();
      sendResponse({
        success: true,
        handle: handle ? `@${handle}` : null,
        rawHandle: handle || null,
        isLoggedIn: Boolean(handle) || !isLoggedOut,
        isDefinitelyLoggedOut: isLoggedOut
      });
    })();
    return true;
  }

  if (message.type === 'SHOW_ACCOUNT_MISMATCH_MODAL') {
    showAccountMismatchModal(message.expected, message.current);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'INIT_VIRTUAL_CURSOR' || message.type === 'START_VIRTUAL_CURSOR') {
    ensureVirtualCursorActive();
    sendResponse({ ok: true, active: true });
    return true;
  }

  if (message.type === 'REMOVE_VIRTUAL_CURSOR') {
    removeVirtualCursor();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'ABORT_WORKFLOW') {
    isWorkflowAborted = true;
    removeVirtualCursor();
    console.log('[ATOMX] Abort signal received. Stopping all automation.');
    updateFloatingHud({
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      countdownText: '',
      isStopped: true,
      active: false
    });
    sendResponse({ success: true, aborted: true });
    return true;
  }

  if (message.type === 'TOGGLE_WORKFLOW_PAUSE') {
    isHudWorkflowPaused = Boolean(message.isPaused);
    const pauseBtn = floatingHudEl?.querySelector('#hud-pause-btn');
    if (pauseBtn) {
      pauseBtn.textContent = isHudWorkflowPaused ? '▶️ Resume' : '⏸️ Pause';
      pauseBtn.style.color = isHudWorkflowPaused ? '#34D399' : '#FBBF24';
      pauseBtn.style.background = isHudWorkflowPaused ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)';
      pauseBtn.style.borderColor = isHudWorkflowPaused ? 'rgba(16, 185, 129, 0.5)' : 'rgba(245, 158, 11, 0.5)';
    }
    const badge = floatingHudEl?.querySelector('#hud-badge');
    if (badge && !isWorkflowAborted) {
      badge.textContent = isHudWorkflowPaused ? 'PAUSED' : 'RUNNING';
      badge.style.color = isHudWorkflowPaused ? '#FBBF24' : '#10B981';
    }
    const timerBadge = floatingHudEl?.querySelector('#hud-timer-badge');
    if (timerBadge) {
      timerBadge.textContent = isHudWorkflowPaused ? '⏸️ Paused' : '⚡ Active';
    }
    sendResponse({ success: true, isPaused: isHudWorkflowPaused });
    return true;
  }

  if (message.type === 'SKIP_WORKFLOW_ITEM') {
    isWorkflowItemSkipped = true;
    clearAnyDraftComment();
    const statusEl = floatingHudEl?.querySelector('#hud-status-text');
    if (statusEl) statusEl.textContent = '⏭️ Skipping current item...';
    const timerBadge = floatingHudEl?.querySelector('#hud-timer-badge');
    if (timerBadge) timerBadge.textContent = '⏭️ Skip';
    sendResponse({ success: true, skipped: true });
    return true;
  }

  if (message.type === 'UPDATE_FLOATING_HUD') {
    const payload = message.data || message.hud || message.payload || message;
    updateFloatingHud(payload);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'ABORT_WORKFLOW' || message.type === 'BG_ABORT_AGENT_WORKFLOW' || message.type === 'STOP_WORKFLOW') {
    isWorkflowAborted = true;
    if (typeof TgLikerNativeEngine !== 'undefined') {
      try {
        TgLikerNativeEngine.stop();
        TgLikerNativeEngine.removeCursor();
      } catch (err) {}
    }
    const tglCursor = document.getElementById('tgl-cursor');
    if (tglCursor) tglCursor.remove();
    removeVirtualCursor();
    closeAnyOpenTwitterDialog();
    updateFloatingHud({
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      timerBadge: '🛑 Stopped',
      countdownText: '',
      nextAction: 'Stopped by user',
      isStopped: true,
      active: false
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'HIDE_FLOATING_HUD') {
    isHudDismissedLocally = true;
    hideFloatingHud();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'POPUP_OPENED') {
    isPopupOpenLocally = true;
    hideFloatingHud();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'POPUP_CLOSED') {
    isPopupOpenLocally = false;
    chrome.storage.local.get(['atomx_active_hud', 'atomx_hud_dismissed', 'atomx_tg_raid', 'atomx_agent_workflow']).then(s => {
      const activeHud = s?.atomx_active_hud;
      const isRunning = Boolean(s?.atomx_tg_raid?.active || s?.atomx_agent_workflow?.active || activeHud?.active);
      if (isRunning && !s?.atomx_hud_dismissed && activeHud) {
        updateFloatingHud(activeHud);
      }
    }).catch(() => null);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'CLEANUP_DRAFTS_BEFORE_NAV') {
    clearAnyDraftComment();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'EXTRACT_FOCUSED_TWEET') {
    const firstTweet = getMainPostArticle();
    if (firstTweet) {
      const data = extractTweetData(firstTweet);
      sendResponse({
        success: true,
        tweetText: data.text,
        authorName: data.authorName,
        authorHandle: data.authorHandle
      });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  if (message.type === 'INSERT_REPLY_TEXT') {
    insertIntoTwitterInput(message.text);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SYNC_WORKFLOW_OPTIONS') {
    if (message.options) {
      console.log('[ATOMX CONTENT] Synced live workflow options from popup:', message.options);
    }
    sendResponse({ success: true });
    return true;
  }

  // Master Autonomous Automation Handler: Performs selected actions on current tweet
  if (message.type === 'EXECUTE_AUTONOMOUS_ENGAGEMENT') {
    executeAutonomousTweetWorkflow(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  // Agent 1: Audience Builder — Scan active profiles on Twitter list
  if (message.type === 'SCAN_ACTIVE_PROFILES_FROM_LIST' || message.type === 'AUDIENCE_BUILDER_HUNT_USERS') {
    huntAudienceUsers(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 1: Audience Builder — Scrape commenters from most engaged recent tweets in Twitter List
  if (message.type === 'COLLECT_AUDIENCE_FROM_LIST') {
    collectAudienceFromListTimeline(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, profiles: [] }));
    return true;
  }

  // Agent 1: Audience Builder — Collect repliers from tweet discussion thread
  if (message.type === 'COLLECT_REPLIERS_FROM_TWEET_THREAD') {
    collectRepliersFromTweetThread(message.targetCount || 10)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, profiles: [] }));
    return true;
  }

  // Agent 1: Audience Builder — Click and open top post with virtual cursor
  if (message.type === 'CLICK_AND_OPEN_TARGET_POST') {
    clickAndOpenTargetPost(message.postUrl, message.author)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 1: Audience Builder — Find, mark/like, and extract next unvisited comment in thread
  if (message.type === 'FIND_AND_LIKE_NEXT_UNPROCESSED_COMMENT') {
    findAndLikeNextUnprocessedComment(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ found: false, error: err.message }));
    return true;
  }

  // Agent 1: Audience Builder — Follow & engage user on page
  if (message.type === 'FOLLOW_USER_ON_PAGE' || message.type === 'AUDIENCE_ENGAGE_AND_FOLLOW') {
    engageAndFollowProfile(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 2: Reply Back Loop — Scan and reply to comments
  if (message.type === 'EXECUTE_REPLY_BACK_CYCLE') {
    executeReplyBackCycle(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 11: Find Defaulter — Scan post comments and return all author handles
  if (message.type === 'AUDIT_POST_DEFAULTERS') {
    auditPostCommenters(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, commenters: [] }));
    return true;
  }

  // Agent 12: Telegram Live Liker & Proof Recorder — Visual live actions with glow ring
  if (message.type === 'EXECUTE_LIVE_RAID_ENGAGEMENT') {
    executeLiveRaidEngagement(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 7: Auto Unfollow — Scan following page and unfollow matching accounts
  if (message.type === 'EXECUTE_AUTO_UNFOLLOW_STEP') {
    executeAutoUnfollowStep(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 13: Commenter Reciprocator — Scan post comments, like unliked comments & collect profiles
  if (message.type === 'COLLECT_RECIPROCATOR_COMMENTERS') {
    collectReciprocatorCommenters(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, commenters: [] }));
    return true;
  }

  // Agent 14: Home Feed Engager — Scan home timeline, auto-skip Ads, and execute actions
  if (message.type === 'EXECUTE_HOME_FEED_ENGAGEMENT_STEP') {
    executeHomeFeedEngagementStep(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SCROLL_FEED_DOWN') {
    humanSmoothScroll(700, { settlePause: 300 }).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Agent 13: Commenter Reciprocator — Engage on commenter profile
  if (message.type === 'RECIPROCAL_PROFILE_ENGAGEMENT') {
    engageAndFollowProfile(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Agent 4: Followers Increase — Scrape top engaging accounts from live niche/list feed
  if (message.type === 'COLLECT_ENGAGING_NICHE_PROFILES') {
    collectEngagingNicheProfiles(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, profiles: [] }));
    return true;
  }

  // Agent 4: Followers Increase — Autonomous direct timeline engagement on List's recent posts
  if (message.type === 'EXECUTE_FOLLOWERS_LIST_CYCLE') {
    executeFollowersListCycle(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, engagedCount: 0 }));
    return true;
  }

  // Agent 1: Audience Builder — Discover most engaged recent tweets from list query
  if (message.type === 'DISCOVER_TOP_ENGAGED_LIST_TWEETS') {
    discoverTopEngagedListTweets(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, topTweets: [] }));
    return true;
  }

  // Agent 4: Followers Increase — Discover top active/recent posts from List timeline
  if (message.type === 'DISCOVER_TOP_ACTIVE_LIST_TWEETS') {
    discoverTopActiveListTweets(message)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message, topTweets: [] }));
    return true;
  }

  // Agent 16: TG Liker — Mass raid & repost engager
  if (message.type === 'START_TG_LIKER_ENGINE') {
    TgLikerNativeEngine.init(message.cfg)
      .then(res => sendResponse({ success: true, res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // TG Liker: Scroll Recorder & Stop Picker messages
  if (message.type === 'recscroll') {
    if (recRunning) { sendResponse({ ok: false, error: 'already scrolling' }); return true; }
    recRunning = true; recAbort = false;
    (async () => {
      try {
        if (typeof TgLikerNativeEngine !== 'undefined') TgLikerNativeEngine.removeCursor();
        const tglCursor = document.getElementById('tgl-cursor');
        if (tglCursor) tglCursor.remove();
        await new Promise(r => setTimeout(r, 900));
        const reached = await recScrollToTopSmooth(message.pace);
        if (reached && !recAbort) await new Promise(r => setTimeout(r, 1800));
        sendResponse({ ok: true, reachedTop: reached });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      } finally {
        recRunning = false;
      }
    })();
    return true;
  }

  if (message.type === 'pickstop') {
    startTweetStopPick();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'recping') {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'recabort') {
    recAbort = true;
    sendResponse({ ok: true });
    return true;
  }
});

// Neutralize Twitter / X "Leave site? Changes you made may not be saved" prompt
function suppressBeforeUnloadPrompt() {
  try {
    window.addEventListener('beforeunload', (e) => {
      try { e.stopImmediatePropagation(); } catch (err) {}
    }, true);
  } catch (e) {}
}
suppressBeforeUnloadPrompt();

// Helper: Finds Twitter's "Save post? -> Discard" button with 100% precision (NEVER matches Save)
function findTwitterDiscardButton() {
  // 1. Direct Twitter testid for the Discard action in confirmation sheets
  const confirmSheetBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
  if (confirmSheetBtn) {
    const text = (confirmSheetBtn.innerText || confirmSheetBtn.textContent || '').trim().toLowerCase();
    if (text.includes('discard') || text.includes('descartar') || text.includes('abandonner') || !text.includes('save')) {
      return confirmSheetBtn.closest('button, [role="button"]') || confirmSheetBtn;
    }
  }

  // 2. Scan all buttons inside confirmationSheetDialog
  const sheetBtns = Array.from(document.querySelectorAll(
    'div[data-testid="confirmationSheetDialog"] button, div[data-testid="confirmationSheetDialog"] [role="button"], div[data-testid="sheetDialog"] button'
  ));
  for (const el of sheetBtns) {
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    if (text.includes('discard') || text.includes('descartar') || text.includes('abandonner')) {
      return el.closest('button, [role="button"]') || el;
    }
  }

  // 3. Scan all buttons and role="button" elements across the page
  const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
  for (const el of allBtns) {
    const text = (el.innerText || el.textContent || '').trim().toLowerCase();
    if ((text.includes('discard') || text.includes('descartar') || text.includes('abandonner')) && !text.includes('save') && !text.includes('guardar')) {
      return el.closest('button, [role="button"]') || el;
    }
  }

  // 4. Scan all span / div elements with exact text "Discard"
  const allSpans = Array.from(document.querySelectorAll('div[data-testid="confirmationSheetDialog"] span, div[role="dialog"] span, span'));
  for (const span of allSpans) {
    const text = (span.innerText || span.textContent || '').trim().toLowerCase();
    if (text === 'discard' || text === 'descartar') {
      return span.closest('button, [role="button"]') || span;
    }
  }

  return null;
}

// Helper: Dispatches authentic human pointer and mouse clicks on Discard button
async function executeHumanDiscardClick(btn) {
  if (!btn) return false;
  try {
    const target = btn.closest('button, [role="button"]') || btn;
    console.log('[ATOMX] Clicking Discard button:', target);
    target.focus?.({ preventScroll: true });
    dispatchEnhancedHumanEvents(target);
    try { target.click(); } catch (e) {}
    return true;
  } catch (e) {
    console.warn('[ATOMX] Error clicking discard button:', e);
    try { btn.click(); } catch (err) {}
    return true;
  }
}

// Helper: Dispatches native Escape keyboard events to dismiss any open modals safely without triggering window.close
function dismissOpenModalViaEscape() {
  const targets = [
    document.activeElement,
    document.querySelector('div[role="dialog"]'),
    document.querySelector('div[aria-modal="true"]'),
    document.body,
    document
  ];
  for (const t of targets) {
    if (!t) continue;
    try {
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      t.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    } catch (e) {}
  }
}

// Cleanly handles comment skipping as instructed:
// 1. If "Save post? -> Discard" dialog is open, click Discard immediately.
// 2. Clear text in composer so Twitter does not prompt to save draft.
// 3. Click Close (X) button once, wait for Discard dialog if triggered, and click Discard cleanly.
// 4. Never closes the tab or breaks Twitter router.
let isSkipHandlingInProgress = false;
async function handleTwitterCommentSkip() {
  if (isSkipHandlingInProgress) {
    while (isSkipHandlingInProgress) {
      await sleep(100);
    }
    return true;
  }
  isSkipHandlingInProgress = true;

  try {
    console.log('[ATOMX SKIP] Initiating clean comment clearance & dialog dismissal flow...');

    // PRIORITY 1: Check if "Save post? -> Discard" confirmation dialog is ALREADY open
    const immediateDiscard = findTwitterDiscardButton();
    if (immediateDiscard) {
      console.log('[ATOMX SKIP] "Save post?" dialog detected immediately, clicking Discard...');
      await executeHumanDiscardClick(immediateDiscard);
      await sleep(350);
    }

    // STEP 1: Clear text inside any open tweet textarea so Twitter doesn't prompt to save draft
    const activeTextareas = Array.from(document.querySelectorAll(
      'div[role="dialog"] div[data-testid="tweetTextarea_0"], div[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]'
    ));
    for (const ta of activeTextareas) {
      if (ta && ta.isConnected) {
        try {
          ta.focus?.({ preventScroll: true });
          document.execCommand('selectAll', false, null);
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true }));
          document.execCommand('delete', false, null);
          ta.innerText = '';
          ta.textContent = '';
          ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
          ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true }));
          ta.blur?.();
        } catch (err) {}
      }
    }
    await sleep(100);

    // PRIORITY 2: Check again if clearing text triggered "Save post? -> Discard"
    const discardAfterClear = findTwitterDiscardButton();
    if (discardAfterClear) {
      console.log('[ATOMX SKIP] Discard dialog appeared after text clear, clicking Discard...');
      await executeHumanDiscardClick(discardAfterClear);
      await sleep(350);
    }

    // STEP 2: Only target actual Twitter compose dialogs or confirmation sheets
    const composeDialog = document.querySelector(
      'div[role="dialog"] div[data-testid="tweetTextarea_0"], div[aria-modal="true"] div[data-testid="tweetTextarea_0"], div[data-testid="confirmationSheetDialog"]'
    )?.closest('div[role="dialog"], div[aria-modal="true"], div[data-testid="confirmationSheetDialog"]');

    if (composeDialog) {
      console.log('[ATOMX SKIP] Compose modal detected, dismissing cleanly via mask/discard...');
      // Method A: Click the backdrop mask (safely unmounts modal without router back or window.close)
      const backdropMask = document.querySelector('div[data-testid="mask"]');
      if (backdropMask) {
        try { backdropMask.click(); } catch (e) {}
        await sleep(150);
      }

      // Method B: Check if clicking backdrop prompted "Save post? -> Discard"
      const postMaskDiscard = findTwitterDiscardButton();
      if (postMaskDiscard) {
        console.log('[ATOMX SKIP] Discard dialog appeared, clicking Discard...');
        await executeHumanDiscardClick(postMaskDiscard);
        await sleep(200);
      }

      // Method C: If still attached to DOM, remove it directly to guarantee zero tab closing
      if (composeDialog.isConnected) {
        try { composeDialog.remove(); } catch (e) {}
      }
    }

    // Dismiss any "Who can reply?" or informational modals
    dismissAnyTwitterModal();

    // Final check for any lingering Discard button
    const finalDiscard = findTwitterDiscardButton();
    if (finalDiscard) {
      console.log('[ATOMX SKIP] Final Discard cleanup click...');
      await executeHumanDiscardClick(finalDiscard);
      await sleep(200);
    }

    // STEP 3: Clear inline reply box if lingering
    const inlineBox = document.querySelector('div[data-testid="inline_reply"] div[data-testid="tweetTextarea_0"]');
    if (inlineBox) {
      try {
        inlineBox.innerText = '';
        inlineBox.textContent = '';
      } catch (err) {}
    }

    // STEP 4: If Twitter router pushed /compose/post into URL, restore URL cleanly
    if (window.location.pathname.includes('/compose/post')) {
      try {
        window.history.replaceState({}, '', '/home');
      } catch (e) {}
    }

    // STEP 5: Failsafe mask cleanup — ensure backdrop mask never freezes the page for the user
    const leftoverMasks = document.querySelectorAll('div[data-testid="mask"]');
    leftoverMasks.forEach(m => {
      try { m.remove(); } catch (e) {}
    });

    // STEP 6: Reset Virtual Cursor position to natural viewport center
    if (virtualCursorEl) {
      const resetX = Math.round(window.innerWidth * 0.5);
      const resetY = Math.round(window.innerHeight * 0.4);
      currentCursorPos = { x: resetX, y: resetY };
      virtualCursorEl.style.transform = `translate3d(${resetX}px, ${resetY}px, 0)`;
      virtualCursorEl.style.opacity = '1';
    }

    dismissLingeringTwitterTooltips();
    console.log('[ATOMX SKIP] Comment clearance & modal dismissal completed successfully.');
    return true;
  } catch (err) {
    console.warn('[ATOMX SKIP] Error during comment skip handling:', err);
    return false;
  } finally {
    isCommentActive = false;
    isSkipHandlingInProgress = false;
  }
}


// Forward legacy calls to handleTwitterCommentSkip
async function clearAnyDraftComment() {
  return await handleTwitterCommentSkip();
}

async function closeAnyOpenTwitterDialog() {
  return await handleTwitterCommentSkip();
}

// Wait for element helper with timeout and abort support
function waitForElement(selector, timeout = 7000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const startTime = Date.now();
    const interval = setInterval(() => {
      if (isWorkflowAborted) {
        clearInterval(interval);
        return resolve(null);
      }
      const found = document.querySelector(selector);
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// TWIXOR COMMENT RULES (client-side final gate, mirrors backend/services/commentRules.js)
// Every comment must be 50 to 80 characters, lowercase a to z and single spaces only.
// twxSafeComment() ALWAYS returns a compliant comment, so nothing invalid can be shown or typed.
// ─────────────────────────────────────────────────────────────────────────────
var TWX_MIN_CHARS = 50;
var TWX_MAX_CHARS = 80;
var TWX_ALLOWED_RE = /^[a-z]+(?: [a-z]+)*$/;
var TWX_DANGLING = new Set(['a','an','the','and','or','but','of','to','in','on','at','for','with','by','from','as','is','are','was','be','that','this','its','it','your','their','our','my']);
var TWX_SAFE_FALLBACKS = [
  'solid progress and the direction here makes a lot of sense to me',
  'this kind of steady building is what keeps a community moving forward',
  'clear thinking behind this and i like where the project is heading',
  'really like how focused the execution looks on this latest update',
  'strong signal here and the long term vision feels well thought out',
  'good to see real progress shipped instead of just big promises'
];

function twxNormalizeComment(raw) {
  let t = String(raw == null ? '' : raw);
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<\/?think>/gi, ' ');
  t = t.replace(/^\s*(?:final\s+)?(?:reply|comment|tweet|response|ai reply|output|answer)\s*:\s*/i, '');
  t = t.replace(/https?:\/\/\S+/gi, ' ').replace(/(^|\s)[@#][\w]+/g, ' ');
  t = t.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  return t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function twxIsValidComment(text) {
  return typeof text === 'string' &&
    text.length >= TWX_MIN_CHARS &&
    text.length <= TWX_MAX_CHARS &&
    TWX_ALLOWED_RE.test(text);
}

function twxCorrectComment(raw) {
  let t = twxNormalizeComment(raw);
  if (!t) return '';
  if (t.length > TWX_MAX_CHARS) {
    const words = t.split(' ');
    while (words.length > 1 && words.join(' ').length > TWX_MAX_CHARS) words.pop();
    while (words.length > 1 && TWX_DANGLING.has(words[words.length - 1])) words.pop();
    t = words.join(' ');
  }
  return twxIsValidComment(t) ? t : '';
}

function twxPickFallbackComment() {
  return TWX_SAFE_FALLBACKS[Math.floor(Math.random() * TWX_SAFE_FALLBACKS.length)];
}

/** Always returns a valid comment: the cleaned/trimmed text, or a compliant fallback. */
function twxSafeComment(raw) {
  return twxCorrectComment(raw) || twxPickFallbackComment();
}

// Legacy helper kept so existing call sites keep working: word limits are no longer used,
// the strict 50 to 80 character rule below applies to every tone.
function extractMaxWordsFromPrompt() {
  return null;
}

/**
 * Client-side final gate (cannot be bypassed by any tone or custom prompt).
 * Returns a comment of 50 to 80 characters using only lowercase a to z and spaces.
 * The second argument is ignored and only kept for backward compatibility.
 */
function sanitizeClientComment(text) {
  return twxSafeComment(text);
}

async function executeAutonomousTweetWorkflow(params) {
  isWorkflowAborted = false;
  isWorkflowItemSkipped = false;
  await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);

  // 1-to-1 Verified Account Enforcement
  if (params.verifiedXHandle) {
    const lockCheck = await verifyAccountLockOrAbort(params.verifiedXHandle);
    if (!lockCheck.ok) {
      return { success: false, error: lockCheck.error, unauthorizedAccount: true };
    }
  }

  const actions = params.actions || { like: true, comment: true, repost: false, follow: false, scroll: true };
  const replyText = params.replyText || '';
  const performed = [];

  console.log('[ATOMX AUTONOMOUS WORKFLOW] Starting execution with actions:', actions);

  // 1. Verify that the current page matches the requested tweet URL (prevent race conditions on reused tabs)
  let expectedTweetId = '';
  if (params.tweetUrl) {
    const targetMatch = params.tweetUrl.match(/\/status\/(\d+)/);
    expectedTweetId = targetMatch ? targetMatch[1] : '';
  }
  if (!expectedTweetId) {
    const urlMatch = window.location.href.match(/\/status\/(\d+)/);
    if (urlMatch) expectedTweetId = urlMatch[1];
  }

  if (expectedTweetId && !window.location.href.includes(expectedTweetId)) {
    console.log(`[ATOMX] Tab URL does not yet match requested tweet ID ${expectedTweetId}. Waiting for tab navigation...`);
    for (let w = 0; w < 15; w++) {
      await sleep(300);
      if (window.location.href.includes(expectedTweetId)) break;
    }
    if (!window.location.href.includes(expectedTweetId)) {
      console.warn(`[ATOMX] Tab did not navigate to expected tweet ${expectedTweetId}. Aborting action on stale page.`);
      return {
        success: false,
        skipped: true,
        ignored: true,
        reason: 'Page failed to navigate to target tweet (stale page prevented)',
        performed
      };
    }
  }

  // Helper to persist engaged tweet ID to local storage immediately
  const markTweetEngagedLocally = async (tid) => {
    const idToSave = String(tid || expectedTweetId || '');
    if (!idToSave) return;
    try {
      const cur = await chrome.storage.local.get(['engagedTweetIds']);
      const updated = Array.from(new Set([...(cur?.engagedTweetIds || []), idToSave]));
      await chrome.storage.local.set({ engagedTweetIds: updated });
    } catch (e) {}
  };

  // Identify MAIN POST article (wait for tweet DOM hydration up to 6s)
  let mainArticle = null;
  for (let r = 0; r < 12; r++) {
    const candidate = getMainPostArticle();
    if (candidate) {
      if (expectedTweetId) {
        // Verify this candidate article is actually the target tweet, NOT a stale tweet left in DOM
        const links = Array.from(candidate.querySelectorAll('a[href*="/status/"]'));
        const matchesTarget = links.some(l => (l.getAttribute('href') || '').includes(expectedTweetId));
        if (matchesTarget) {
          mainArticle = candidate;
          break;
        }
      } else {
        mainArticle = candidate;
        break;
      }
    }
    await sleep(500);
  }

  if (!mainArticle) {
    console.warn('[ATOMX] Could not locate focal tweet article on page.');
    return {
      success: false,
      skipped: true,
      ignored: true,
      reason: 'Post unavailable or could not be loaded',
      performed
    };
  }

  // On status pages: Allow Twitter 1.5 - 2s to stream/hydrate comments under the post!
  if (window.location.pathname.includes('/status/')) {
    for (let cWait = 0; cWait < 5; cWait++) {
      const allArts = document.querySelectorAll('article[data-testid="tweet"]');
      if (allArts.length > 1) break;
      await sleep(400);
    }
  }

  // 2. Detect already liked & already commented status
  const isAlreadyLiked = isPostAlreadyLiked(mainArticle);
  let loggedInHandle = getLoggedInUserHandle() || (params.verifiedXHandle || '').replace(/^@+/, '');
  if (!loggedInHandle) {
    try {
      const stored = await chrome.storage.local.get(['verifiedXHandle']);
      loggedInHandle = (stored?.verifiedXHandle || '').replace(/^@+/, '');
    } catch (e) {}
  }
  const isAlreadyCommented = hasUserAlreadyCommented(loggedInHandle);

  console.log(`[ATOMX STATUS CHECK] isAlreadyLiked: ${isAlreadyLiked}, isAlreadyCommented: ${isAlreadyCommented} (user: @${loggedInHandle || 'unknown'})`);

  // USER RULE 1: If both like and comment are already done -> IGNORE AUTOMATICALLY!
  if (isAlreadyLiked && isAlreadyCommented) {
    console.log('[ATOMX] Both like and comment already completed on this post. Auto-ignoring.');
    await markTweetEngagedLocally();
    return {
      success: true,
      ignored: true,
      commentSkipped: true,
      likeSkipped: true,
      isAlreadyLiked: true,
      isAlreadyCommented: true,
      reason: 'Both like and comment already completed on this post.',
      performed: ['Auto-Ignored (Already Liked & Commented)']
    };
  }

  // USER RULE 2: If user already commented on this post, AUTO-IGNORE!
  if (actions.comment && isAlreadyCommented) {
    console.log('[ATOMX] User already commented on this post previously. Auto-ignoring.');
    await markTweetEngagedLocally();
    if (actions.like && !isAlreadyLiked) {
      try {
        const likeBtn = mainArticle.querySelector('button[data-testid="like"]');
        if (likeBtn) {
          likeBtn.click();
          performed.push('Liked Main Post ❤️ (Free courtesy)');
        }
      } catch (e) {
        console.log('[ATOMX] Courtesy like notice:', e);
      }
    }
    return {
      success: true,
      ignored: true,
      commentSkipped: true,
      isAlreadyLiked: !!isAlreadyLiked,
      isAlreadyCommented: true,
      reason: 'Already commented on this post previously.',
      performed: ['Auto-Ignored (Already Commented)']
    };
  }

  // USER RULE: If like only done -> do comment only. If neither -> do both.
  const shouldLike = actions.like && !isAlreadyLiked;
  const shouldComment = actions.comment && !isAlreadyCommented;

  if (shouldComment) {
    const restriction = isTargetRestrictedOrCommentsLocked(mainArticle);
    if (restriction.restricted) {
      console.log(`[ATOMX] Tweet comments restricted: ${restriction.reason}. Auto-skipping.`);
      return {
        success: true,
        skipped: true,
        ignored: true,
        reason: restriction.reason,
        performed: [`Auto-Skipped (${restriction.reason})`]
      };
    }
  }

  if (isAlreadyLiked && actions.like) {
    performed.push('Already Liked (Skipped like)');
  }
  if (isAlreadyCommented && actions.comment) {
    performed.push('Already Commented (Skipped comment)');
  }

  // If no remaining requested actions needed:
  if (!shouldLike && !shouldComment && !actions.repost && !actions.follow) {
    await markTweetEngagedLocally();
    return {
      success: true,
      ignored: true,
      commentSkipped: isAlreadyCommented,
      likeSkipped: isAlreadyLiked,
      isAlreadyLiked: !!isAlreadyLiked,
      isAlreadyCommented: !!isAlreadyCommented,
      reason: 'Requested actions were already satisfied on this post.',
      performed
    };
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) {
    return { success: true, skipped: true, ignored: true, reason: 'Skipped by user', performed };
  }

  // 3. Auto-Follow Creator FIRST (Naturally executed at top of post while avatar & header are in full view)
  if (actions.follow && !isWorkflowAborted && !isWorkflowItemSkipped) {
    try {
      // 1. Look inside mainArticle author header
      let followBtn = Array.from(mainArticle.querySelectorAll('button, div[role="button"]')).find(b => {
        const txt = (b.innerText || '').trim();
        const testId = b.getAttribute('data-testid') || '';
        return (txt === 'Follow' || testId.endsWith('-follow')) && !txt.includes('Following') && !testId.includes('unfollow');
      });

      // 2. Look across whole page if not directly inside mainArticle header
      if (!followBtn) {
        followBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
          const txt = (b.innerText || '').trim();
          const testId = b.getAttribute('data-testid') || '';
          return (txt === 'Follow' || testId.endsWith('-follow')) && !txt.includes('Following') && !testId.includes('unfollow');
        });
      }

      // 3. Hover over author avatar/name to trigger Twitter HoverCard if not visible directly
      if (!followBtn) {
        const authorLink = mainArticle.querySelector('div[data-testid="User-Name"] a, a[role="link"][href*="/"]');
        if (authorLink) {
          authorLink.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          await sleep(650);
          const hoverCard = document.querySelector('div[data-testid="HoverCard"], div[role="dialog"]');
          if (hoverCard) {
            followBtn = Array.from(hoverCard.querySelectorAll('button')).find(b => {
              const txt = (b.innerText || '').trim();
              return txt === 'Follow' && !txt.includes('Following');
            });
          }
        }
      }

      if (followBtn && !isWorkflowItemSkipped && !isWorkflowAborted) {
        await simulateHumanFollowClick(followBtn);
        performed.push('Followed Creator ➕');
        await sleep(400);
      } else {
        const isFollowing = Array.from(document.querySelectorAll('button')).some(b => (b.innerText || '').trim() === 'Following');
        if (isFollowing) {
          performed.push('Already Following');
        }
      }
    } catch (e) {
      console.warn('Follow action error:', e);
    }
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) return { success: true, skipped: true, ignored: true, reason: 'Skipped by user', performed };

  // 4. Natural Reading Scroll: Smoothly scroll down through post to bring action bar & comment box into view together
  if (actions.scroll !== false && !isWorkflowAborted && !isWorkflowItemSkipped) {
    await smoothScrollPostForReading(mainArticle);
    performed.push('Scrolled & hydrated');
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) return { success: true, skipped: true, ignored: true, reason: 'Skipped by user', performed };

  // 5. Auto-Like Action (MAIN POST ONLY) — 100% reliable execution with visual pulse
  if (shouldLike && !isWorkflowAborted && !isWorkflowItemSkipped) {
    try {
      const likedOk = await simulateHumanLikeClick(mainArticle);
      if (likedOk) {
        performed.push('Liked Main Post ❤️');
        await markTweetEngagedLocally();
        await sleep(500);
      }
    } catch (e) {
      console.warn('Like action error:', e);
    }
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) return { success: true, skipped: true, ignored: true, reason: 'Skipped by user', performed };

  // 6. Auto-Repost Action (MAIN POST ONLY)
  if (actions.repost && !isWorkflowAborted && !isWorkflowItemSkipped) {
    try {
      const isAlreadyReposted = !!mainArticle.querySelector('button[data-testid="unretweet"], div[data-testid="unretweet"]');
      if (isAlreadyReposted) {
        performed.push('Already Reposted');
      } else {
        const rtBtn = mainArticle.querySelector('button[data-testid="retweet"], div[data-testid="retweet"], button[aria-label*="Repost" i], button[aria-label*="Retweet" i]');
        if (rtBtn) {
          rtBtn.click();
          await sleep(500);
          // Twitter confirms with either data-testid="retweetConfirm" or menuitem containing text Repost
          let confirmBtn = document.querySelector('div[data-testid="retweetConfirm"], button[data-testid="retweetConfirm"]');
          if (!confirmBtn) {
            const menuItems = Array.from(document.querySelectorAll('div[role="menuitem"], span, div'));
            confirmBtn = menuItems.find(el => {
              const txt = (el.innerText || '').trim();
              return txt === 'Repost' || txt === 'Retweet';
            });
          }
          if (confirmBtn && !isWorkflowItemSkipped && !isWorkflowAborted) {
            confirmBtn.click();
            performed.push('Reposted 🔁');
            await sleep(500);
          }
        }
      }
    } catch (e) {
      console.warn('Repost action error:', e);
    }
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) return { success: true, skipped: true, ignored: true, reason: 'Skipped by user', performed };

  // 7. Auto-Comment Action with Live Contextual AI Generation & Human-Like Typing
  if (shouldComment && !isWorkflowAborted && !isWorkflowItemSkipped) {
    try {
      // Step A: Extract the REAL TWEET TEXT directly from Twitter DOM
      const tweetData = extractTweetData(mainArticle);
      const liveTweetText = (tweetData.text || '').trim();
      const liveAuthor = tweetData.authorHandle || tweetData.authorName || params.tweetAuthor || '@user';

      let commentToPost = params.replyText;

      // Generate reply using the REAL tweet content from the page DOM via background service worker
      if (!commentToPost || params.generateContextual !== false) {
        try {
          console.log('[ATOMX] Asking background worker for live contextual AI reply for post:', liveTweetText.slice(0, 100));
          const aiResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
              type: 'GENERATE_AI_REPLY',
              tweetText: liveTweetText || params.tweetUrl || '',
              tweetAuthor: liveAuthor,
              tweetAuthorName: tweetData.authorName || '',
              style: params.style || 'Bullish (5-10 words)',
              stylePrompt: params.stylePrompt || null
            }, resolve);
          });

          if (aiResp && aiResp.success && aiResp.reply) {
            commentToPost = aiResp.reply;
            console.log('[ATOMX] Live AI reply received via background service worker:', commentToPost);
          } else {
            console.warn('[ATOMX] Background worker reply generation failed:', aiResp?.error);
          }
        } catch (genErr) {
          console.warn('[ATOMX] Error communicating with background worker:', genErr);
        }
      }

      if (isWorkflowItemSkipped || isWorkflowAborted) return { success: true, skipped: true, ignored: true, reason: 'Skipped by user', performed };

      if (!commentToPost) {
        commentToPost = twxPickFallbackComment();
      }

      // Enforce client-side anti-bot sanitization (dynamic word limit if specified in prompt)
      commentToPost = sanitizeClientComment(commentToPost, extractMaxWordsFromPrompt(params.stylePrompt || params.style));

      let lastCommentError = null;
      // Step B: Post comment via universal comment engine
      const commentRes = await postCommentOnTargetArticle(mainArticle, commentToPost);
      if (commentRes && commentRes.success) {
        performed.push(`Human Typed & Commented: "${commentToPost}" 💬`);
        await markTweetEngagedLocally();
      } else if (commentRes?.commentsRestricted) {
        const restrictReason = commentRes.error || 'Comments restricted by author';
        console.log(`[ATOMX] Comment restricted: ${restrictReason}`);
        return {
          success: true,
          skipped: true,
          ignored: true,
          reason: restrictReason,
          commentSkipReason: restrictReason,
          performed,
          isAlreadyLiked,
          isAlreadyCommented,
          commentSkipped: true,
          commentPosted: false
        };
      } else if (commentRes?.skipped || commentRes?.aborted || isWorkflowItemSkipped || isWorkflowAborted) {
        console.log('[ATOMX] Comment skipped or aborted by user.');
        return {
          success: true,
          skipped: true,
          ignored: true,
          aborted: Boolean(commentRes?.aborted || isWorkflowAborted),
          reason: isWorkflowAborted ? 'Workflow aborted by user' : (isWorkflowItemSkipped ? 'Skipped by user' : (commentRes?.error || 'Workflow item skipped')),
          commentSkipReason: commentRes?.error || 'Skipped by user',
          performed,
          isAlreadyLiked,
          isAlreadyCommented,
          commentSkipped: true,
          commentPosted: false
        };
      } else {
        lastCommentError = commentRes?.error || 'Comment restricted or unavailable';
        console.warn('[ATOMX] Comment posting error:', lastCommentError);
        performed.push(`Comment Skipped (${lastCommentError})`);
      }
    } catch (e) {
      if (isWorkflowItemSkipped || isWorkflowAborted) {
        return {
          success: true,
          skipped: true,
          ignored: true,
          reason: 'Workflow was aborted or skipped by user',
          performed
        };
      }
      console.warn('Comment action error:', e);
    }
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) {
    return {
      success: true,
      skipped: true,
      ignored: true,
      reason: 'Workflow was aborted or skipped by user',
      performed,
      isAlreadyLiked,
      isAlreadyCommented,
      commentSkipped: true,
      commentPosted: false
    };
  }

  // Check if requested actions were actually fulfilled
  const requestedActions = [];
  if (actions.like && !isAlreadyLiked) requestedActions.push('like');
  if (actions.comment && !isAlreadyCommented) requestedActions.push('comment');
  if (actions.repost) requestedActions.push('repost');
  if (actions.follow) requestedActions.push('follow');

  const isCommentPosted = performed.some(p => p.includes('Commented:'));
  const isCommentSkipped = actions.comment ? !isCommentPosted : false;
  const anyDone = performed.some(p => p.includes('Liked') || p.includes('Commented') || p.includes('Reposted') || p.includes('Followed'));

  // If actions were requested, but none could be completed (e.g. elements not found)
  if (requestedActions.length > 0 && !anyDone) {
    console.warn('[ATOMX AUTONOMOUS WORKFLOW] Requested actions could not be fulfilled on this tweet.');
    return {
      success: false,
      skipped: true,
      ignored: true,
      reason: 'Could not complete requested actions on this post',
      performed,
      isAlreadyLiked,
      isAlreadyCommented,
      commentSkipped: isCommentSkipped,
      commentPosted: false
    };
  }

  console.log('[ATOMX AUTONOMOUS WORKFLOW] Finished. Actions completed:', performed);
  return {
    success: true,
    performed,
    isAlreadyLiked,
    isAlreadyCommented,
    commentSkipped: isCommentSkipped,
    commentPosted: isCommentPosted,
    commentSkipReason: isCommentSkipped ? (isAlreadyCommented ? 'Already commented previously' : (performed.find(p => p.includes('Comment Skipped')) || 'Comments restricted by author')) : null
  };
}

/**
 * Robust numerical metric parser for Twitter (handles "1.2K", "500", "2M", aria-labels)
 */
function extractTwitterMetric(element) {
  if (!element) return 0;
  const rawText = (element.innerText || element.getAttribute('aria-label') || '').trim();
  if (!rawText) return 0;
  const match = rawText.match(/([\d,.]+)\s*([kKmMbB])?/);
  if (!match) return 0;
  let val = parseFloat(match[1].replace(/,/g, ''));
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k') val *= 1000;
  else if (unit === 'm') val *= 1000000;
  else if (unit === 'b') val *= 1000000000;
  return Math.round(val) || 0;
}

/**
 * Agent 1: Audience Builder Profile Scanner & Tweet Hunter (Phase B & C)
 * Performs DEEP SCAN across the target timeline dynamically,
 * indexes tweets with full engagement metrics (replies, retweets, likes),
 * filters by date range, ranks them to find genuine busy tweets, and extracts candidate profiles.
 * Dynamically scales scanning cycles to reliably collect 10, 25, 50, or 100 profiles.
 */
async function huntAudienceUsers(options = {}) {
  isWorkflowAborted = false;

  // 1-to-1 Verified Account Enforcement
  if (options.verifiedXHandle) {
    const lockCheck = await verifyAccountLockOrAbort(options.verifiedXHandle);
    if (!lockCheck.ok) {
      return {
        success: false,
        error: lockCheck.error,
        unauthorizedAccount: true,
        profiles: [],
        busyTweets: []
      };
    }
  }

  const targetCount = Number(options.targetCount) || 10;
  const dateRange = options.dateRange || '24h';
  const sortBy = options.sortBy || 'replies';

  const tweetMap = new Map();
  const directProfiles = [];
  const seenHandles = new Set();
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase();

  let maxAgeMs = Infinity;
  if (dateRange === '1h') maxAgeMs = 1 * 3600 * 1000;
  else if (dateRange === '2h') maxAgeMs = 2 * 3600 * 1000;
  else if (dateRange === '4h') maxAgeMs = 4 * 3600 * 1000;
  else if (dateRange === '12h') maxAgeMs = 12 * 3600 * 1000;
  else if (dateRange === '24h') maxAgeMs = 24 * 3600 * 1000;
  else if (dateRange === '3d') maxAgeMs = 3 * 24 * 3600 * 1000;
  else if (dateRange === '7d') maxAgeMs = 7 * 24 * 3600 * 1000;

  console.log(`[ATOMX AUDIENCE] Starting deep timeline scan (Target: ${targetCount}, Date: ${dateRange}, Sort: ${sortBy})...`);

  // DYNAMIC SCROLL ENGINE: Keep scrolling until targetCount profiles are collected
  let consecutiveStalls = 0;
  let prevDiscoveredCount = 0;
  const maxScanCycles = Math.max(120, targetCount * 5); // Large ceiling so it never cuts off prematurely

  for (let cycle = 0; cycle < maxScanCycles; cycle++) {
    if (isWorkflowAborted) break;

    // Check Twitter Rate Limit during timeline scanning
    if (checkTwitterRateLimit()) {
      triggerRateLimitAbort('Rate limited during timeline scanning');
      break;
    }

    const visibleArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

    if (visibleArticles.length === 0) {
      consecutiveStalls++;
      if (consecutiveStalls >= 5) {
        console.log(`[ATOMX AUDIENCE DEEP SCAN] Feed empty (0 tweets visible). Stopping scan.`);
        break;
      }
    }

    for (const article of visibleArticles) {
      // STRICT FILTER: Post-Authors Only (Zero Replies, Zero Reposts)
      const socialCtx = (article.querySelector('div[data-testid="socialContext"]')?.innerText || '').toLowerCase();
      if (socialCtx.includes('reposted') || socialCtx.includes('retweeted')) continue;

      const artText = article.innerText || '';
      if (artText.includes('Replying to @') || artText.includes('Replying to')) continue;
      const isReplyElement = Array.from(article.querySelectorAll('div, span, a')).some(el => {
        const t = (el.innerText || '').trim();
        return t.startsWith('Replying to @') || t.startsWith('Replying to');
      });
      if (isReplyElement) continue;

      const data = extractTweetData(article);
      const cleanHandle = (data.authorHandle || '').replace('@', '').toLowerCase();
      if (!cleanHandle || cleanHandle === loggedInHandle) continue;

      const tweetKey = data.tweetId || `${cleanHandle}_${(data.text || '').slice(0, 30)}`;
      if (tweetMap.has(tweetKey)) continue;

      // Parse timestamp from <time>
      const timeEl = article.querySelector('time');
      const timeStr = timeEl ? timeEl.getAttribute('datetime') : null;
      const timestamp = timeStr ? new Date(timeStr).getTime() : Date.now();
      const ageMs = Date.now() - timestamp;

      // Date range filter with graceful fallback so targetCount is never starved
      if (maxAgeMs !== Infinity && ageMs > maxAgeMs) {
        if (ageMs > 72 * 3600 * 1000) {
          continue;
        }
      }

      // Parse full engagement metrics
      const replyBtn = article.querySelector('button[data-testid="reply"]');
      const likeBtn = article.querySelector('button[data-testid="like"], button[data-testid="unlike"]');
      const rtBtn = article.querySelector('button[data-testid="retweet"], button[data-testid="unretweet"]');

      const repliesCount = extractTwitterMetric(replyBtn);
      const likesCount = extractTwitterMetric(likeBtn);
      const retweetsCount = extractTwitterMetric(rtBtn);
      const engagementScore = (repliesCount * 5) + (retweetsCount * 3) + likesCount;

      const tweetObj = {
        tweetId: data.tweetId,
        tweetUrl: data.tweetUrl,
        authorHandle: data.authorHandle || `@${cleanHandle}`,
        cleanHandle,
        authorName: data.authorName || cleanHandle,
        text: data.text,
        timestamp,
        repliesCount,
        likesCount,
        retweetsCount,
        engagementScore
      };

      tweetMap.set(tweetKey, tweetObj);

      // Index creator handle
      if (!seenHandles.has(cleanHandle)) {
        seenHandles.add(cleanHandle);
        directProfiles.push({
          handle: data.authorHandle || `@${cleanHandle}`,
          cleanHandle,
          name: data.authorName || cleanHandle,
          tweetSnippet: (data.text || '').slice(0, 90),
          repliesCount,
          likesCount,
          timestamp
        });
      }
    }

    // Check if feed is stuck or needs retry button clicked
    if (directProfiles.length === prevDiscoveredCount) {
      consecutiveStalls++;
      // Auto-click any "Retry" or "Show" buttons if Twitter stopped loading
      const loadMoreBtns = Array.from(document.querySelectorAll('button[role="button"], div[role="button"]')).filter(b => {
        const t = (b.innerText || '').toLowerCase();
        return t.includes('retry') || t.includes('show') || t.includes('load more');
      });
      if (loadMoreBtns.length > 0) {
        loadMoreBtns[0].click();
        await sleep(1000);
      }

      // Allow up to 8 consecutive attempts before giving up on truly exhausted feeds
      if (consecutiveStalls >= 8) {
        console.log(`[ATOMX AUDIENCE DEEP SCAN] Timeline exhausted at ${directProfiles.length} profiles.`);
        break;
      }
    } else {
      consecutiveStalls = 0;
      prevDiscoveredCount = directProfiles.length;
    }

    // Smooth scroll down to load next batch of timeline posts
    await humanSmoothScroll(900, { settlePause: 400 });

    // TARGET SATISFACTION: Require at least 4 visible scroll cycles so user visibly sees feed exploration
    const minScrollCycles = 4;
    if (cycle >= minScrollCycles && directProfiles.length >= targetCount) {
      console.log(`[ATOMX AUDIENCE DEEP SCAN] Target reached: collected ${directProfiles.length}/${targetCount} profiles across ${cycle + 1} scroll cycles!`);
      break;
    }
  }

  const allDiscovered = Array.from(tweetMap.values());
  console.log(`[ATOMX AUDIENCE DEEP SCAN] Completed scan: indexed ${allDiscovered.length} tweets, ${directProfiles.length} unique creators.`);

  // Sort tweets and post-authors based on user setting
  if (sortBy === 'replies') {
    allDiscovered.sort((a, b) => (b.repliesCount - a.repliesCount) || (b.engagementScore - a.engagementScore));
    directProfiles.sort((a, b) => (b.repliesCount - a.repliesCount) || (b.likesCount - a.likesCount));
  } else {
    allDiscovered.sort((a, b) => b.timestamp - a.timestamp);
    directProfiles.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  // Provide candidate busy tweets (with replies)
  let topTweets = allDiscovered.filter(t => t.repliesCount > 0 && t.tweetUrl);
  if (topTweets.length === 0 && allDiscovered.length > 0) {
    topTweets = allDiscovered.filter(t => t.tweetUrl).slice(0, 20);
  } else {
    topTweets = topTweets.slice(0, Math.min(30, Math.max(12, targetCount)));
  }

  if (topTweets.length > 0) {
    console.log(`[ATOMX TOP BUSY TWEETS] Found ${topTweets.length} active candidate threads for reply extraction.`);
  }

  return {
    success: true,
    targetCount,
    topTweets,
    profiles: directProfiles,
    directProfiles: directProfiles,
    totalScanned: allDiscovered.length,
    aborted: isWorkflowAborted
  };
}

// Backward compatibility alias
var scanActiveProfilesFromList = (count) => huntAudienceUsers({ targetCount: count });

/**
 * Agent 1 & Agent 4: Collect active repliers/commenters from a busy tweet discussion thread
 * Extracts the real community members who participated and replied to the busy tweet.
 * Dynamically scrolls until targetCount is met or thread replies are exhausted.
 */
async function collectRepliersFromTweetThread(targetCount = 10) {
  isWorkflowAborted = false;
  const numTarget = Number(targetCount) || 10;
  const collected = [];
  const seenHandles = new Set();
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase();

  const storedAudience = await new Promise(r => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['atomx_audience_engaged_history'], r);
    } else r({});
  });
  const engagedHistory = (storedAudience?.atomx_audience_engaged_history && typeof storedAudience.atomx_audience_engaged_history === 'object')
    ? storedAudience.atomx_audience_engaged_history : {};

  // DYNAMIC SCROLL: Keep scrolling until targetCount repliers are met
  const maxThreadScrolls = Math.max(80, numTarget * 4);
  let consecutiveNoNew = 0;

  for (let s = 0; s < maxThreadScrolls; s++) {
    if (isWorkflowAborted || collected.length >= numTarget) break;

    const stopCheck = await chrome.storage?.local?.get(['atomx_agent_workflow', 'atomx_active_hud']).catch(() => ({}));
    if (stopCheck?.atomx_agent_workflow?.isStopped || stopCheck?.atomx_active_hud?.stateBadge === 'STOPPED' || stopCheck?.atomx_agent_workflow?.active === false) {
      isWorkflowAborted = true;
      break;
    }

    const allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    // Replies are articles after index 0 (index 0 is focal post)
    const replyArticles = allArticles.length > 1 ? allArticles.slice(1) : allArticles;

    let newInThisScroll = 0;
    for (const art of replyArticles) {
      if (collected.length >= numTarget || isWorkflowAborted) break;

      const data = extractTweetData(art);
      const cleanHandle = (data.authorHandle || '').replace('@', '').toLowerCase();
      const lastTime = engagedHistory[cleanHandle];
      // Only skip if cleanHandle is missing, own handle, duplicate, or engaged within last 24h
      if (!cleanHandle || cleanHandle === loggedInHandle || seenHandles.has(cleanHandle) || (lastTime && (Date.now() - lastTime < 24 * 3600 * 1000))) {
        continue;
      }

      seenHandles.add(cleanHandle);
      newInThisScroll++;
      console.log(`[ATOMX THREAD REPLIER] Collected engaged user (${collected.length + 1}/${numTarget}): @${cleanHandle}`);
      collected.push({
        handle: data.authorHandle || `@${cleanHandle}`,
        cleanHandle,
        name: data.authorName || cleanHandle,
        tweetSnippet: (data.text || '').slice(0, 90)
      });
    }

    if (collected.length >= numTarget || isWorkflowAborted) break;

    // Check for "Show replies" or "Show more replies" buttons and click them
    const showBtns = Array.from(document.querySelectorAll('button[role="button"], div[role="button"]')).filter(b => {
      const txt = (b.innerText || '').toLowerCase();
      return txt.includes('show replies') || txt.includes('show more replies') || txt.includes('show probability') || txt.includes('hidden replies');
    });
    if (showBtns.length > 0) {
      showBtns[0].click();
      await sleep(1000);
    }

    if (newInThisScroll === 0) {
      consecutiveNoNew++;
      if (consecutiveNoNew >= 8) {
        // Thread replies exhausted
        break;
      }
    } else {
      consecutiveNoNew = 0;
    }

    await humanSmoothScroll(900, { settlePause: 400 });
  }

  return {
    success: true,
    targetCount: numTarget,
    collectedCount: collected.length,
    profiles: collected,
    aborted: isWorkflowAborted
  };
}

function isCommentAlreadyLiked(art) {
  if (!art) return false;
  if (art.querySelector('button[data-testid="unlike"], div[data-testid="unlike"], [data-testid="unlike"]')) {
    return true;
  }
  const likeBtn = art.querySelector('button[data-testid="like"], div[data-testid="like"]');
  if (likeBtn) {
    const aria = (likeBtn.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('unlike') || aria.endsWith('liked') || aria === 'liked') return true;
    return false; // Confirmed unliked
  }
  return false;
}

/**
 * Agent 1: Audience Builder In-Thread Comment Scanner & Marker
 * Inspects comments on the current tweet status post directly.
 * Skips comments that are already liked (tracked from previous sessions).
 * For the next unliked comment:
 *  - Likes the comment on the post (serves as permanent visual & DOM tracking marker)
 *  - Returns the commenter's handle so the same tab visits their profile, engages, and goes back.
 */
async function findAndLikeNextUnprocessedComment(options = {}) {
  isWorkflowItemSkipped = false;
  const verifiedHandle = (options.verifiedXHandle || '').toLowerCase().replace(/^@/, '').trim();
  const mainAuthor = (options.mainAuthor || '').toLowerCase().replace(/^@/, '').trim();
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase();

  let persistedHistory = {};
  try {
    const stored = await new Promise(r => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['atomx_audience_engaged_history'], r);
      } else r({});
    });
    if (stored?.atomx_audience_engaged_history && typeof stored.atomx_audience_engaged_history === 'object') {
      persistedHistory = stored.atomx_audience_engaged_history;
    }
  } catch (e) {}

  const maxScrollAttempts = 20;
  const seenHandlesInThisScan = new Set();

  for (let s = 0; s < maxScrollAttempts; s++) {
    if (isWorkflowAborted || isWorkflowItemSkipped) {
      return { found: false, aborted: true };
    }

    const mainArticle = getMainPostArticle();
    const allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const commentArticles = allArticles.filter(a => a !== mainArticle);

    for (const art of commentArticles) {
      if (isWorkflowAborted || isWorkflowItemSkipped) {
        return { found: false, aborted: true };
      }

      const data = extractTweetData(art);
      const cleanHandle = (data.authorHandle || '').replace('@', '').toLowerCase().trim();
      if (!cleanHandle) continue;

      // Skip user's own handle or post creator's handle
      if (cleanHandle === loggedInHandle || cleanHandle === verifiedHandle || (mainAuthor && cleanHandle === mainAuthor)) {
        continue;
      }

      // Check if this article has a like/unlike button (confirming it is an actionable comment)
      const hasActionButtons = art.querySelector('button[data-testid="like"], button[data-testid="unlike"], div[data-testid="like"], div[data-testid="unlike"]');
      if (!hasActionButtons) continue;

      // CRITICAL: Check if this comment is ALREADY liked (already processed & tracked!)
      const isAlreadyLiked = isCommentAlreadyLiked(art);
      if (isAlreadyLiked) {
        // Already processed in this or previous session! Skip!
        continue;
      }

      // 24h deduplication check (only when not explicitly told to ignore history)
      if (!options.ignoreEngagedHistory) {
        const lastTime = persistedHistory[cleanHandle];
        if (lastTime && (Date.now() - lastTime < 24 * 3600 * 1000)) {
          continue;
        }
      }

      if (seenHandlesInThisScan.has(cleanHandle)) continue;
      seenHandlesInThisScan.add(cleanHandle);

      // Found a fresh, unliked comment!
      const safetyComm = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
      const uSpeedComm = safetyComm?.atomx_safety_settings?.cursorSpeed !== undefined ? Number(safetyComm.atomx_safety_settings.cursorSpeed) : 450;
      const isInstantComm = (uSpeedComm === 0);
      const dwellFactorComm = isInstantComm ? 0 : Math.max(0.2, uSpeedComm / 450);

      await humanScrollElementIntoView(art, 'center');
      if (!isInstantComm) await sleep(Math.round(300 * dwellFactorComm));

      // 1. LIKE the comment on the post with Virtual Cursor (cursor moves, hovers, clicks)
      const likeBtn = art.querySelector('button[data-testid="like"]');
      let commentLiked = false;
      if (likeBtn) {
        try {
          await performHumanClick(likeBtn, {
            pulseColor: '#F43F5E',
            scroll: false,
            hoverDwell: isInstantComm ? 0 : 300,
            postPause: isInstantComm ? 0 : 350
          });
          commentLiked = true;
          console.log(`[ATOMX AUDIENCE] Successfully liked comment by @${cleanHandle} with virtual cursor!`);
          if (!isInstantComm) await sleep(Math.round(350 * dwellFactorComm));
        } catch (likeErr) {
          console.warn('[ATOMX AUDIENCE] Like comment click notice:', likeErr);
        }
      }

      // 2. Visibly move Virtual Cursor to commenter's avatar/handle and click to open their profile!
      let profileClicked = false;
      const profileLink = art.querySelector('div[data-testid="User-Name"] a[role="link"]') ||
                          art.querySelector(`a[href="/${cleanHandle}" i], a[href="/${cleanHandle}/" i]`) ||
                          art.querySelector('div[data-testid*="UserAvatar"]')?.closest('a');
      if (profileLink) {
        try {
          console.log(`[ATOMX AUDIENCE] Moving virtual cursor to @${cleanHandle}'s profile link and clicking to visit...`);
          if (!isInstantComm) await sleep(Math.round(250 * dwellFactorComm));
          await performHumanClick(profileLink, {
            pulseColor: '#38BDF8',
            scroll: false,
            hoverDwell: isInstantComm ? 0 : 380,
            postPause: isInstantComm ? 100 : 600
          });
          profileClicked = true;
        } catch (pErr) {}
      }

      return {
        found: true,
        cleanHandle,
        handle: `@${cleanHandle}`,
        authorName: data.authorName || cleanHandle,
        commentText: (data.text || '').slice(0, 100),
        commentLiked,
        profileClicked
      };
    }

    // Check for "Show replies" buttons
    const showBtns = Array.from(document.querySelectorAll('button[role="button"], div[role="button"]')).filter(b => {
      const txt = (b.innerText || '').toLowerCase();
      return txt.includes('show replies') || txt.includes('show more replies') || txt.includes('show probability') || txt.includes('hidden replies');
    });
    if (showBtns.length > 0) {
      await performHumanClick(showBtns[0], { scroll: false, hoverDwell: 250 });
      await sleep(600);
    }

    // Scroll down human-like to reveal more comments
    await humanSmoothScroll(520 + Math.floor(Math.random() * 140), { settlePause: 400 });
  }

  return { found: false, exhausted: true };
}

/**
 * Find the Following button on a Twitter profile page.
 * Supports both standard Twitter profiles (button with "Following" text / data-testid)
 * and Creator profiles with Subscriptions enabled (where "Following" is represented
 * by the [👤✓] icon button situated immediately to the left of the purple "Subscribe" button).
 */
function findProfileFollowingButton() {
  const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));

  // 1. Standard Profile Check:
  const standardBtn = allButtons.find(b => {
    const txt = (b.innerText || '').trim();
    const testId = (b.getAttribute('data-testid') || '').toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    return (
      txt === 'Following' ||
      txt.includes('Following') ||
      testId.endsWith('-unfollow') ||
      testId.includes('unfollow') ||
      aria === 'following' ||
      aria.startsWith('following @') ||
      aria.includes('following')
    );
  });
  if (standardBtn) {
    return { button: standardBtn, isSubscribeLayout: false };
  }

  // 2. Creator Profile with "Subscribe" button:
  const subscribeBtn = allButtons.find(b => {
    const txt = (b.innerText || '').trim().toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    return txt.includes('subscribe');
  });

  if (subscribeBtn) {
    // Check siblings or preceding buttons within the same container
    const parent = subscribeBtn.closest('div[role="group"]') || subscribeBtn.parentElement;
    if (parent) {
      const containerBtns = Array.from(parent.querySelectorAll('button, div[role="button"]')).filter(b => b !== subscribeBtn);
      for (const candidate of containerBtns) {
        const testId = (candidate.getAttribute('data-testid') || '').toLowerCase();
        const aria = (candidate.getAttribute('aria-label') || '').toLowerCase();
        if (testId.includes('senddm') || testId.includes('notification') || testId.includes('useractions') || aria.includes('message') || aria.includes('notify') || aria.includes('more')) {
          continue;
        }
        return { button: candidate, isSubscribeLayout: true };
      }
    }

    // Fallback: search in allButtons preceding subscribeBtn
    const globalIdx = allButtons.indexOf(subscribeBtn);
    if (globalIdx > 0) {
      for (let i = globalIdx - 1; i >= Math.max(0, globalIdx - 4); i--) {
        const candidate = allButtons[i];
        const testId = (candidate.getAttribute('data-testid') || '').toLowerCase();
        const aria = (candidate.getAttribute('aria-label') || '').toLowerCase();
        if (testId.includes('senddm') || testId.includes('notification') || testId.includes('useractions') || aria.includes('message') || aria.includes('notify') || aria.includes('more')) {
          continue;
        }
        const rect = candidate.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top < 650) {
          return { button: candidate, isSubscribeLayout: true };
        }
      }
    }
  }

  return null;
}

/**
 * Find the Follow button on a Twitter profile page.
 * Supports standard profiles and Creator profiles with Subscriptions.
 */
function findProfileFollowButton() {
  const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));

  // 1. Standard Follow button:
  const standardFollowBtn = allButtons.find(b => {
    const txt = (b.innerText || '').trim();
    const testId = (b.getAttribute('data-testid') || '').toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    return (
      (txt === 'Follow' || testId.endsWith('-follow') || aria.startsWith('follow @') || aria === 'follow') &&
      !txt.includes('Following') &&
      !testId.includes('unfollow') &&
      !aria.includes('following')
    );
  });
  if (standardFollowBtn) return standardFollowBtn;

  // 2. Creator profile check:
  const subscribeBtn = allButtons.find(b => {
    const txt = (b.innerText || '').trim().toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    return txt.includes('subscribe');
  });

  if (subscribeBtn) {
    const parent = subscribeBtn.closest('div[role="group"]') || subscribeBtn.parentElement;
    if (parent) {
      const containerBtns = Array.from(parent.querySelectorAll('button, div[role="button"]')).filter(b => b !== subscribeBtn);
      for (const candidate of containerBtns) {
        const testId = (candidate.getAttribute('data-testid') || '').toLowerCase();
        const aria = (candidate.getAttribute('aria-label') || '').toLowerCase();
        const txt = (candidate.innerText || '').trim().toLowerCase();
        if (testId.includes('senddm') || testId.includes('notification') || testId.includes('useractions') || aria.includes('message') || aria.includes('notify') || aria.includes('more')) {
          continue;
        }
        if (txt === 'follow' || testId.includes('follow') || aria.includes('follow')) {
          return candidate;
        }
      }
    }
  }

  return null;
}

/**
 * Executes unfollow on a profile page.
 * Handles both standard confirmation dialogs and the Creator Subscribe layout
 * where clicking [👤✓] expands "Unfollow @username" button before confirmation.
 */
async function executeProfileUnfollowAction(followingInfo, targetHandle = '') {
  if (!followingInfo || !followingInfo.button) return false;
  const btn = followingInfo.button;

  console.log(`[ATOMX] Initiating unfollow on @${targetHandle} (Subscribe layout: ${followingInfo.isSubscribeLayout})...`);

  // 1. Ensure button is in viewport and click via Virtual Cursor
  await humanScrollElementIntoView(btn, 'center');
  await sleep(300);
  await performHumanClick(btn, {
    pulseColor: '#EF4444',
    scroll: false,
    hoverDwell: 450,
    postPause: 500
  });

  // 2. If it expanded/revealed an "Unfollow @username" option (as seen in Subscribe profiles):
  await sleep(400);
  const findRevealedOption = () => {
    const items = Array.from(document.querySelectorAll('button, div[role="button"], div[role="menuitem"], span[role="button"]'));
    const cleanHandle = (targetHandle || '').replace(/^@/, '').toLowerCase();
    return items.find(el => {
      const txt = (el.innerText || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const testId = (el.getAttribute('data-testid') || '').toLowerCase();

      // Don't mistake the confirmation dialog's final confirm button for the revealed menu
      if (testId.includes('confirmationsheetconfirm')) return false;

      const hasUnfollow = txt.startsWith('unfollow') || aria.startsWith('unfollow') || testId.includes('unfollow');
      const matchesHandle = cleanHandle ? (txt.includes(cleanHandle) || aria.includes(cleanHandle)) : true;
      return hasUnfollow && matchesHandle;
    });
  };

  const revealedBtn = findRevealedOption();
  if (revealedBtn && revealedBtn !== btn) {
    console.log(`[ATOMX] Found expanded unfollow button ("${revealedBtn.innerText.trim()}"). Clicking via virtual cursor...`);
    await humanScrollElementIntoView(revealedBtn, 'center');
    await sleep(250);
    await performHumanClick(revealedBtn, {
      pulseColor: '#EF4444',
      scroll: false,
      hoverDwell: 420,
      postPause: 500
    });
  }

  // 3. Confirm Unfollow via Twitter confirmation dialog / sheet if presented
  const confirmBtn = await waitForElement(
    'button[data-testid="confirmationSheetConfirm"], div[data-testid="confirmationSheetConfirm"]',
    2500
  ) || Array.from(document.querySelectorAll('div[role="dialog"] button, div[role="alertdialog"] button, button')).find(b => {
    const txt = (b.innerText || '').trim().toLowerCase();
    const testId = (b.getAttribute('data-testid') || '').toLowerCase();
    return testId.includes('confirmationsheetconfirm') || txt === 'unfollow';
  });

  if (confirmBtn) {
    console.log('[ATOMX] Confirming unfollow modal via virtual cursor...');
    await humanScrollElementIntoView(confirmBtn, 'center');
    await sleep(250);
    await performHumanClick(confirmBtn, {
      pulseColor: '#EF4444',
      scroll: false,
      hoverDwell: 450,
      postPause: 600
    });
    await sleep(800);
    return true;
  }

  await sleep(500);
  return true;
}

/**
 * Agent 1: Audience Builder Per-Profile Interaction (Phase D)
 * Smoothly deep-scrolls profile page past header/bio/tabs, skips pinned posts,
 * centers the creator's real recent post on screen, likes it, generates AI reply adhering
 * to "Tone & Style (Applied Globally)", and follows the user.
 */
async function engageAndFollowProfile(options = {}) {
  isWorkflowAborted = false;

  // Instant 1-click skip detection from storage or memory
  const initialSkip = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
  if (initialSkip?.atomx_skip_current || isWorkflowItemSkipped) {
    isWorkflowItemSkipped = false;
    await chrome.storage.local.set({ atomx_skip_current: false }).catch(() => null);
    console.log('[ATOMX] Target profile was skipped by user before execution.');
    return { success: true, skipped: true, ignored: true, reason: 'Skipped by user' };
  }
  isWorkflowItemSkipped = false;

  // 1-to-1 Verified Account Enforcement
  if (options.verifiedXHandle) {
    const lockCheck = await verifyAccountLockOrAbort(options.verifiedXHandle);
    if (!lockCheck.ok) {
      return { success: false, error: lockCheck.error, unauthorizedAccount: true };
    }
  }

  const targetHandle = typeof options === 'string' ? options : (options.handle || '');
  const likePosts = options.likePosts !== false;
  const replyPosts = !!options.replyPosts;
  const repostPosts = !!options.repostPosts;
  const followPosts = options.followPosts !== false;
  const autoUnfollow = !!options.autoUnfollow;
  const postsCountSetting = options.postsCount || options.postsPerProfile || 'random';
  const style = options.style || 'Bullish (5-10 words)';
  const stylePrompt = options.stylePrompt || null;
  const backendUrl = (options.backendUrl || 'https://twixor.onrender.com').replace(/\/+$/, '');

  let likesDone = 0;
  let replyDone = 0;
  let repostDone = 0;
  let followed = false;
  let unfollowedFirst = false;

  if (checkTwitterRateLimit()) {
    triggerRateLimitAbort();
    return { success: false, aborted: true, rateLimited: true, error: 'Twitter Rate Limit detected' };
  }

  if (isWorkflowItemSkipped || isWorkflowAborted) {
    return { success: true, skipped: true, ignored: true, reason: 'Skipped by user' };
  }

  // Auto-skip if profile is protected or locked
  const profileRestriction = isTargetRestrictedOrCommentsLocked();
  if (profileRestriction.restricted) {
    console.log(`[ATOMX] @${targetHandle} is protected/locked: ${profileRestriction.reason}. Auto-skipping.`);
    return { success: true, skipped: true, ignored: true, reason: profileRestriction.reason };
  }

  try {
    // Step 1: Follow & Smart Unfollow Status Check (supports both standard and Subscribe layouts)
    const followingInfo = findProfileFollowingButton();
    const pageText = (document.body ? document.body.innerText : '') || '';
    const hasFollowsYouBadge = pageText.includes('Follows you');

    // Smart Unfollow Strategy for Sorsa Booster:
    // If target does not follow back and we already follow them -> unfollow first, engage on posts, then re-follow!
    if (autoUnfollow && followingInfo && !hasFollowsYouBadge && !isWorkflowItemSkipped && !isWorkflowAborted) {
      console.log(`[ATOMX] @${targetHandle} does not follow back. Executing Unfollow First strategy (Subscribe layout: ${followingInfo.isSubscribeLayout})...`);
      const unfollowDone = await executeProfileUnfollowAction(followingInfo, targetHandle);
      if (unfollowDone) {
        unfollowedFirst = true;
        await sleep(900);
      }
    } else if (!followingInfo && followPosts && !isWorkflowItemSkipped && !isWorkflowAborted) {
      // Follow action if requested and not yet following
      const followBtn = findProfileFollowButton();
      if (followBtn && !isWorkflowItemSkipped && !isWorkflowAborted) {
        await simulateHumanFollowClick(followBtn);
        followed = true;
        await sleep(500);
      }
    }

    if (isWorkflowItemSkipped || isWorkflowAborted) {
      return { success: true, skipped: true, ignored: true, reason: 'Skipped by user' };
    }

    // Step 2: Smooth scroll down past profile header/bio with human hydration
    await smoothScrollAndHydrate(550, 900);

    if (isWorkflowItemSkipped || isWorkflowAborted) {
      return { success: true, skipped: true, ignored: true, reason: 'Skipped by user' };
    }

    // Step 3: Wait for timeline posts to hydrate with retry scrolling
    let allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (allArticles.length === 0) {
      for (let retries = 0; retries < 6 && allArticles.length === 0; retries++) {
        if (isWorkflowItemSkipped || isWorkflowAborted) break;
        await sleep(500);
        await humanSmoothScroll(350, { settlePause: 350 });
        allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      }
    }

    if (allArticles.length === 0) {
      console.log(`[ATOMX] No tweets found on profile timeline for @${targetHandle}.`);
      return { success: true, skipped: true, ignored: true, reason: 'No tweets found on profile' };
    }

    if (isWorkflowItemSkipped || isWorkflowAborted) {
      return { success: true, skipped: true, ignored: true, reason: 'Skipped by user' };
    }

    // Filter out pinned posts and any posts that are already liked
    const validRecentArticles = allArticles.filter(art => {
      const socialCtx = art.querySelector('div[data-testid="socialContext"]')?.innerText?.toLowerCase() || '';
      const isPinned = socialCtx.includes('pinned') || socialCtx.includes('pin');
      return !isPinned && !isPostAlreadyLiked(art);
    });

    let candidatePosts = validRecentArticles;
    if (candidatePosts.length === 0) {
      // If no unliked posts found:
      // If commenting or reposting is enabled, we can still comment/repost on recent non-pinned posts!
      if (replyPosts || repostPosts) {
        candidatePosts = allArticles.filter(art => {
          const socialCtx = art.querySelector('div[data-testid="socialContext"]')?.innerText?.toLowerCase() || '';
          return !socialCtx.includes('pinned') && !socialCtx.includes('pin');
        });
        if (candidatePosts.length === 0) candidatePosts = allArticles;
      } else {
        console.log(`[ATOMX] Recent posts for @${targetHandle} are already liked. Auto-skipping profile as per global rule.`);
        return { success: true, skipped: true, ignored: true, reason: 'Recent posts already liked' };
      }
    }

    // Determine how many posts to engage
    let numPostsToEngage = 1;
    if (postsCountSetting === 'random') {
      numPostsToEngage = Math.floor(Math.random() * 2) + 1; // 1 or 2 posts
    } else {
      numPostsToEngage = Math.max(1, Number(postsCountSetting) || 1);
    }
    const postsSlice = candidatePosts.slice(0, numPostsToEngage);

    // Step 4: Engage each post in postsSlice with all selected actions (Like, Repost, Comment)
    // Runs sequentially down the timeline without needing to scroll back up!
    for (let pIdx = 0; pIdx < postsSlice.length; pIdx++) {
      if (isWorkflowAborted || isWorkflowItemSkipped) break;
      const art = postsSlice[pIdx];

      // Read global safety speed for pacing
      const currentSafety = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
      const userSpeed = currentSafety?.atomx_safety_settings?.cursorSpeed !== undefined ? Number(currentSafety.atomx_safety_settings.cursorSpeed) : 450;
      const isInstant = (userSpeed === 0);
      const actionPacing = isInstant ? 0 : Math.round(450 * Math.max(0.2, userSpeed / 450));

      // Center this post comfortably on screen
      await humanScrollElementIntoView(art, 'center');
      if (!isInstant) await sleep(Math.round(400 * Math.max(0.2, userSpeed / 450)));

      // Concurrent AI Reply Pre-fetching:
      // Initiates the AI request IMMEDIATELY so the network call runs in parallel with Like & Repost!
      // This completely removes the 3-5 second waiting freeze between Like and Comment!
      let replyPromise = null;
      if (replyPosts && !isWorkflowItemSkipped && !isWorkflowAborted) {
        const postRestriction = isTargetRestrictedOrCommentsLocked(art);
        if (!postRestriction.restricted) {
          replyPromise = (async () => {
            try {
              const tweetData = extractTweetData(art);
              const tweetText = tweetData.text || '';
              const authorName = tweetData.authorName || targetHandle;
              const authorHandle = tweetData.authorHandle || `@${targetHandle}`;

              const stored = (typeof chrome !== 'undefined' && chrome.storage?.local)
                ? await chrome.storage.local.get(['currentUser', 'user', 'verifiedXHandle', 'selectedTone', 'selectedTonePrompt']).catch(() => ({}))
                : {};
              const effStyle = options.style || stored?.selectedTone || style || 'Bullish (5-10 words)';
              const effPrompt = options.stylePrompt || stored?.selectedTonePrompt || stylePrompt || null;

              let commentToPost = '';
              try {
                const aiRes = await chrome.runtime.sendMessage({
                  type: 'GENERATE_INLINE_REPLY',
                  tweetText,
                  tweetAuthor: authorHandle,
                  tweetAuthorName: authorName,
                  style: effStyle,
                  stylePrompt: effPrompt
                });
                if (aiRes?.reply) commentToPost = aiRes.reply.trim();
              } catch (mErr) {
                console.warn('[ATOMX] Background worker message error:', mErr);
              }

              // Direct fetch fallback if background worker failed
              if (!commentToPost) {
                try {
                  const uHandle = stored?.verifiedXHandle || stored?.currentUser?.handle || stored?.user?.handle || '@user';
                  const uEmail = stored?.currentUser?.email || stored?.user?.email || '';
                  const uId = stored?.currentUser?.id || stored?.user?.id || null;

                  const directRes = await fetch(`${backendUrl}/api/generate-reply`, {
                    method: 'POST',
                    headers: { 
                      'Content-Type': 'application/json',
                      'x-user-handle': uHandle,
                      'x-user-id': uId ? String(uId) : '1'
                    },
                    body: JSON.stringify({
                      tweetText,
                      tweetAuthor: authorHandle,
                      tweetAuthorName: authorName,
                      style: effStyle,
                      stylePrompt: effPrompt,
                      userHandle: uHandle,
                      userEmail: uEmail,
                      userId: uId
                    })
                  });
                  if (directRes.ok) {
                    const dJson = await directRes.json();
                    commentToPost = dJson?.reply?.trim();
                  }
                } catch (dErr) {}
              }

              if (!commentToPost) {
                commentToPost = twxPickFallbackComment();
              }

              return sanitizeClientComment(commentToPost, extractMaxWordsFromPrompt(effPrompt || effStyle));
            } catch (err) {
              return '';
            }
          })();
        }
      }

      // Action 1: Auto-Like
      if (likePosts && !isWorkflowItemSkipped && !isWorkflowAborted) {
        if (!isPostAlreadyLiked(art)) {
          const ok = await simulateHumanLikeClick(art);
          if (ok) {
            likesDone++;
            if (actionPacing > 0) await sleep(actionPacing);
          }
        } else {
          console.log('[ATOMX] Post already liked. Skipping like.');
        }
      }

      // Action 2: Auto-Repost
      if (repostPosts && !isWorkflowItemSkipped && !isWorkflowAborted) {
        const ok = await simulateHumanRepostClick(art);
        if (ok) {
          repostDone++;
          if (actionPacing > 0) await sleep(actionPacing);
        }
      }

      // Action 3: Auto-Comment
      if (replyPosts && !isWorkflowItemSkipped && !isWorkflowAborted) {
        const postRestriction = isTargetRestrictedOrCommentsLocked(art);
        if (postRestriction.restricted) {
          console.log(`[ATOMX] Comments restricted on post ${pIdx + 1}: ${postRestriction.reason}. Skipping comment.`);
        } else {
          try {
            const commentToPost = replyPromise ? await replyPromise : '';
            if (commentToPost) {
              const commentRes = await postCommentOnTargetArticle(art, commentToPost);
              if (commentRes && commentRes.success) {
                replyDone++;
                if (actionPacing > 0) await sleep(Math.round(800 * Math.max(0.2, userSpeed / 450)));
              }
            }
          } catch (rErr) {
            console.warn('[ATOMX] Could not post profile reply:', rErr);
          }
        }
      }

      // Smoothly scroll down to next post in postsSlice if multiple posts requested
      if (pIdx < postsSlice.length - 1 && !isWorkflowAborted && !isWorkflowItemSkipped) {
        await humanSmoothScroll(380 + Math.floor(Math.random() * 80), { settlePause: 350 });
      }
    }

    // Step 7: If unfollowed first, RE-FOLLOW now to maximize follow-back!
    if (unfollowedFirst && followPosts && !isWorkflowAborted) {
      console.log(`[ATOMX] Re-following @${targetHandle} after engagement...`);
      if (window.scrollY > 0) {
        await humanSmoothScroll(-window.scrollY, { settlePause: 400 });
      }
      const reFollowBtn = findProfileFollowButton();
      if (reFollowBtn) {
        await simulateHumanFollowClick(reFollowBtn);
        followed = true;
        await sleep(500);
      }
    }

    if (isWorkflowAborted) {
      return { success: false, aborted: true };
    }

    return {
      success: true,
      alreadyFollowing: !!followingInfo && !unfollowedFirst,
      followed,
      unfollowedFirst,
      handle: targetHandle,
      likesDone,
      replyDone,
      repostDone
    };
  } catch (err) {
    return { success: false, error: err.message, likesDone, replyDone, repostDone };
  }
}

// Backward compatibility alias
var followUserOnPage = (handle) => engageAndFollowProfile({ handle, likePosts: false, replyPosts: false });

/**
 * Agent 2: Reply Back Loop Execution on Current Post
 * Iterates through all comments on your tweet, auto-likes, and replies with AI + human typing.
 */
async function executeReplyBackCycle(params = {}) {
  isWorkflowAborted = false;

  // 1-to-1 Verified Account Enforcement
  if (params.verifiedXHandle) {
    const lockCheck = await verifyAccountLockOrAbort(params.verifiedXHandle);
    if (!lockCheck.ok) {
      return {
        success: false,
        error: lockCheck.error,
        unauthorizedAccount: true
      };
    }
  }

  const mainArticle = getMainPostArticle();
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();
  const style = params.style || 'Natural & Concise';
  const delaySec = Number(params.delaySec || 12);
  const maxComments = Number(params.maxComments || 999);
  const autoLike = params.autoLike !== false;
  const alreadyReplied = new Set(Array.isArray(params.alreadyRepliedIds) ? params.alreadyRepliedIds : []);

  // 1. Initial scrolling & handle "Load more replies" to hydrate existing comments
  for (let s = 0; s < 3; s++) {
    await humanSmoothScroll(600, { settlePause: 350 });
    // Click any "Show more replies" buttons if present
    const loadMoreButtons = Array.from(document.querySelectorAll('button[role="button"]')).filter(b => {
      const txt = (b.innerText || '').toLowerCase();
      return txt.includes('show replies') || txt.includes('show more replies') || txt.includes('show probability');
    });
    if (loadMoreButtons.length > 0) {
      loadMoreButtons[0].click();
      await sleep(1000);
    }
  }

  // Scroll back to top of comments
  if (mainArticle) {
    mainArticle.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await sleep(800);
  }

  // 2. Take a strict SNAPSHOT of comments at this moment (never re-queries mid-run)
  const allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const rawComments = allArticles.filter(a => a !== mainArticle);

  // Filter out self-comments and already replied comments
  const snapshotQueue = [];
  let skippedSelf = 0;

  for (const art of rawComments) {
    const data = extractTweetData(art);
    const authorHandle = (data.authorHandle || '').toLowerCase().replace(/^@/, '').trim();

    // Skip your own comments & nested self replies
    if (authorHandle && loggedInHandle && authorHandle === loggedInHandle) {
      skippedSelf++;
      continue;
    }

    // Skip if already replied in previous runs
    const commentKey = `${authorHandle}_${(data.text || '').slice(0, 30)}`;
    if (alreadyReplied.has(commentKey)) {
      skippedSelf++;
      continue;
    }

    snapshotQueue.push({ article: art, data, commentKey, authorHandle });
    if (snapshotQueue.length >= maxComments) break;
  }

  const results = [];
  let doneCount = 0;

  for (let i = 0; i < snapshotQueue.length; i++) {
    if (isWorkflowAborted) break;

    // Check Twitter Rate Limit before action
    if (checkTwitterRateLimit()) {
      triggerRateLimitAbort();
      break;
    }

    const item = snapshotQueue[i];
    const { article: commentArt, data: commentData, commentKey } = item;

    // Update Floating HUD
    updateFloatingHud({
      title: 'ReplyWave',
      stateBadge: 'REPLYING',
      indicator: `Comment ${i + 1}/${snapshotQueue.length}`,
      done: doneCount,
      collected: snapshotQueue.length,
      skipped: skippedSelf,
      progressPercent: Math.round(((i + 1) / snapshotQueue.length) * 100),
      statusText: `Replying to @${commentData.authorHandle}...`
    });

    // Scroll comment into view
    commentArt.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(600);

    // 1. Auto-Like the comment (❤️)
    if (autoLike) {
      await simulateHumanLikeClick(commentArt);
      await sleep(400);
    }

    // 2. Generate Contextual AI reply for this comment via background worker
    let replyText = '';
    try {
      const aiResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'GENERATE_AI_REPLY',
          tweetText: commentData.text || 'Great comment!',
          tweetAuthor: commentData.authorHandle || '@user',
          style
        }, resolve);
      });
      if (aiResp && aiResp.success && aiResp.reply) {
        replyText = aiResp.reply;
      }
    } catch (e) {}

    if (!replyText) {
      replyText = twxPickFallbackComment();
    }

    // Enforce anti-bot sanitization (dynamic word limit if specified in prompt)
    replyText = sanitizeClientComment(replyText, extractMaxWordsFromPrompt(params?.stylePrompt || params?.style || style));

    // 3. Post reply using universal robust posting engine
    const commentRes = await postCommentOnTargetArticle(commentArt, replyText);
    if (commentRes && commentRes.success) {
      doneCount++;
      results.push({ commenter: commentData.authorHandle, reply: replyText, commentKey });
      updateFloatingHud({
        done: doneCount,
        statusText: `✓ Replied to @${commentData.authorHandle}!`
      });
      await sleep(800);
    } else if (commentRes?.skipped || commentRes?.aborted || isWorkflowAborted || isWorkflowItemSkipped) {
      console.log('[ATOMX REPLY LOOP] Comment skipped or aborted by user.');
    } else {
      console.warn('[ATOMX REPLY LOOP] Could not post reply to comment:', commentRes?.error);
    }

    // Check Twitter Rate Limit after action
    if (checkTwitterRateLimit()) {
      triggerRateLimitAbort();
      break;
    }

    // 6. Safe delay before next comment
    if (i < snapshotQueue.length - 1 && !isWorkflowAborted) {
      for (let s = delaySec; s > 0; s--) {
        if (isWorkflowAborted) break;
        updateFloatingHud({
          statusText: `Next reply in ${s}s...`
        });
        await sleep(1000);
      }
    }
  }

  return {
    success: true,
    totalFound: rawComments.length,
    queuedCount: snapshotQueue.length,
    repliedCount: doneCount,
    skippedSelf,
    results,
    aborted: isWorkflowAborted
  };
}

// =========================================================================
// AGENT 5 / 7: AUTO UNFOLLOW STANDALONE ENGINE (Defaulter Audit & Clean-Up)
// =========================================================================
var autoUnfollowSessionProcessed = new Set();

function findFollowingUserCells() {
  // Strategy 1: Standard Twitter UserCell selector (tag-agnostic)
  let cells = Array.from(document.querySelectorAll('[data-testid="UserCell"]'));
  if (cells.length > 0) return cells;

  // Strategy 2: cellInnerDiv containing handle and a follow/unfollow button
  const innerDivs = Array.from(document.querySelectorAll('div[data-testid="cellInnerDiv"]'));
  cells = innerDivs.filter(div => {
    const hasHandle = div.querySelector('div[data-testid="User-Name"], a[href^="/"]') || /@([a-zA-Z0-9_]{1,25})/.test(div.innerText || '');
    const hasFollowBtn = Array.from(div.querySelectorAll('button, div[role="button"]')).some(b => {
      const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const tid = (b.getAttribute('data-testid') || '').toLowerCase();
      return (txt.includes('following') || aria.includes('following') || tid.includes('unfollow')) &&
             !tid.includes('more') && !tid.includes('caret') && !tid.includes('dm');
    });
    return hasHandle && hasFollowBtn;
  });
  if (cells.length > 0) return cells;

  // Strategy 3: Find all buttons representing "Following" status and traverse to row container
  const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
  const followingBtns = allBtns.filter(b => {
    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    const tid = (b.getAttribute('data-testid') || '').toLowerCase();
    if (txt === 'follow' || aria === 'follow' || (tid.endsWith('-follow') && !tid.includes('unfollow'))) return false;
    if (tid.includes('more') || tid.includes('dm') || tid.includes('caret') || tid.includes('useractions')) return false;
    return (
      tid.includes('unfollow') ||
      txt.includes('following') ||
      txt.includes('unfollow') ||
      aria.includes('following') ||
      aria.includes('unfollow')
    );
  });

  const rowSet = new Set();
  const rows = [];
  for (const b of followingBtns) {
    const row = b.closest('[data-testid="UserCell"]') ||
                b.closest('div[data-testid="cellInnerDiv"]') ||
                b.closest('div[role="row"]') ||
                b.parentElement?.parentElement?.parentElement ||
                b.parentElement?.parentElement;
    if (row && !rowSet.has(row)) {
      rowSet.add(row);
      row.__atomx_following_btn = b;
      rows.push(row);
    }
  }
  if (rows.length > 0) return rows;

  // Strategy 4: Containers with User-Name
  const userNames = Array.from(document.querySelectorAll('div[data-testid="User-Name"]'));
  for (const un of userNames) {
    const row = un.closest('div[data-testid="cellInnerDiv"]') || un.closest('div[role="row"]') || un.parentElement?.parentElement;
    if (row && !rowSet.has(row)) {
      rowSet.add(row);
      rows.push(row);
    }
  }

  return rows;
}

function extractHandleFromFollowingCell(cell) {
  if (!cell) return '';
  // 1. Check User-Name container link
  const userNameLink = cell.querySelector('div[data-testid="User-Name"] a[href^="/"]');
  if (userNameLink) {
    const h = (userNameLink.getAttribute('href') || '').replace(/^\//, '').split('/')[0].split('?')[0].toLowerCase().trim();
    if (h && !['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'settings', 'search', 'hashtag'].includes(h)) {
      return h;
    }
  }

  // 2. Extract handle via regex from cell text: @someHandle
  const text = cell.innerText || cell.textContent || '';
  const match = text.match(/@([a-zA-Z0-9_]{1,25})/);
  if (match && match[1]) {
    const h = match[1].toLowerCase().trim();
    if (!['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'settings', 'search', 'hashtag'].includes(h)) {
      return h;
    }
  }

  // 3. Fallback to any link starting with /
  const links = Array.from(cell.querySelectorAll('a[href^="/"]'));
  for (const l of links) {
    const h = (l.getAttribute('href') || '').replace(/^\//, '').split('/')[0].split('?')[0].toLowerCase().trim();
    if (h && !['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'settings', 'search', 'hashtag'].includes(h)) {
      return h;
    }
  }

  return '';
}

function findFollowingButtonInCell(cell) {
  if (!cell) return null;
  if (cell.__atomx_following_btn && document.body.contains(cell.__atomx_following_btn)) {
    return cell.__atomx_following_btn;
  }

  const allBtns = Array.from(cell.querySelectorAll('button, div[role="button"]'));
  return allBtns.find(b => {
    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    const testId = (b.getAttribute('data-testid') || '').toLowerCase();

    // Explicitly reject if it's already a "Follow" button (not following) or More/DM
    if (txt === 'follow' || aria === 'follow' || aria.startsWith('follow ') || (testId.endsWith('-follow') && !testId.includes('unfollow'))) {
      return false;
    }
    if (testId.includes('more') || testId.includes('dm') || testId.includes('caret') || testId.includes('useractions')) {
      return false;
    }

    return (
      testId.includes('unfollow') ||
      txt.includes('following') ||
      txt.includes('unfollow') ||
      aria.includes('following') ||
      aria.includes('unfollow')
    );
  }) || null;
}

function checkCellFollowsYou(cell) {
  if (!cell) return false;
  const followIndicator = cell.querySelector('[data-testid="userFollowIndicator"]');
  if (followIndicator) return true;
  const cellText = (cell.innerText || '').toLowerCase();
  return /follows you|te sigue|vous suit|folgt dir|ti segue|следит за вами/i.test(cellText);
}

function findUnfollowConfirmationButton() {
  // Strategy 1: Standard Twitter confirmationSheetConfirm testid
  const testIdBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
  if (testIdBtn) {
    const btn = testIdBtn.tagName === 'BUTTON' ? testIdBtn : (testIdBtn.querySelector('button') || testIdBtn);
    const rect = btn.getBoundingClientRect();
    if (rect.width >= 35 && rect.height >= 15) return btn;
  }

  // Strategy 2: Look inside active confirmation dialog specifically for the Unfollow button
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[role="alertdialog"], div[aria-modal="true"], div[data-testid="confirmationSheetDialog"]'));
  for (const dialog of dialogs) {
    const allBtns = Array.from(dialog.querySelectorAll('button, div[role="button"]'));
    const confirmBtn = allBtns.find(b => {
      const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
      const tid = (b.getAttribute('data-testid') || '').toLowerCase();
      if (txt === 'cancel' || tid.includes('cancel')) return false;

      const rect = b.getBoundingClientRect();
      const isButtonSize = rect.width >= 40 && rect.width <= 450 && rect.height >= 20 && rect.height <= 85;
      return isButtonSize && (tid.includes('confirm') || txt === 'unfollow');
    });
    if (confirmBtn) return confirmBtn;
  }

  // Strategy 3: Page button with exact text "Unfollow" (and genuine button dimensions)
  const allPageBtns = Array.from(document.querySelectorAll('button'));
  const candidate = allPageBtns.find(b => {
    const txt = (b.innerText || '').trim().toLowerCase();
    const rect = b.getBoundingClientRect();
    return txt === 'unfollow' && rect.width >= 40 && rect.width <= 450 && rect.height >= 20 && rect.height <= 85;
  });
  if (candidate) return candidate;

  return null;
}

async function executeAutoUnfollowStep(params = {}) {
  isWorkflowAborted = false;
  if (params.resetSession) {
    autoUnfollowSessionProcessed.clear();
  }

  const { criteria = { notFollowing: true, lowScore: false }, scoreThreshold = 30, whitelist = [] } = params;
  const cleanWhitelist = new Set((whitelist || []).map(w => (w || '').replace(/^@/, '').toLowerCase().trim()));
  const myHandle = (params.verifiedXHandle || '').toLowerCase().replace(/^@/, '').trim();

  // 1. Wait for Following page items to hydrate (resilient multi-strategy search)
  let userCells = findFollowingUserCells();
  if (userCells.length === 0) {
    const startWait = Date.now();
    while (Date.now() - startWait < 5000) {
      if (isWorkflowAborted) return { success: false, aborted: true };
      await sleep(300);
      userCells = findFollowingUserCells();
      if (userCells.length > 0) break;
    }
  }

  if (userCells.length === 0) {
    // Gentle scroll down to trigger Twitter's virtual scroll hydration
    await humanSmoothScroll(500, { settlePause: 600 });
    await sleep(700);
    userCells = findFollowingUserCells();
  }

  if (userCells.length === 0) {
    console.warn('[ATOMX UNFOLLOW] Zero user cells detected on Following page after scroll hydration.');
    return { success: true, exhausted: true, reason: 'No user cells found on following page' };
  }

  let skippedCountInBatch = 0;

  for (const cell of userCells) {
    if (isWorkflowAborted) return { success: false, aborted: true };

    const href = extractHandleFromFollowingCell(cell);
    if (!href) continue;
    if (myHandle && href === myHandle) continue;

    // 1. Whitelist Check (Never unfollow protected VIP accounts)
    if (cleanWhitelist.has(href)) {
      if (!autoUnfollowSessionProcessed.has(href)) {
        autoUnfollowSessionProcessed.add(href);
        skippedCountInBatch++;
        console.log(`[ATOMX UNFOLLOW] @${href} is whitelisted. Skipping.`);
      }
      continue;
    }

    // 2. Check if already evaluated in this active session
    if (autoUnfollowSessionProcessed.has(href)) {
      continue;
    }

    // 3. Inspect "Follows you" badge
    const followsYou = checkCellFollowsYou(cell);

    // Evaluate criteria
    let shouldUnfollow = false;
    if (criteria.notFollowing && !followsYou) {
      shouldUnfollow = true;
    }
    if (criteria.lowScore && !shouldUnfollow) {
      shouldUnfollow = true;
    }

    if (!shouldUnfollow) {
      // Account follows you back — retain follow and move forward
      autoUnfollowSessionProcessed.add(href);
      skippedCountInBatch++;
      console.log(`[ATOMX UNFOLLOW] @${href} follows you back. Retaining follow and moving to next...`);
      continue;
    }

    // 4. Locate Following button to click
    const followBtn = findFollowingButtonInCell(cell);
    if (!followBtn) {
      console.warn(`[ATOMX UNFOLLOW] Following button not found for @${href}. Skipping.`);
      autoUnfollowSessionProcessed.add(href);
      continue;
    }

    // 5. Scroll cell into center view
    console.log(`[ATOMX UNFOLLOW] Target non-reciprocal account: @${href}. Centering for authentic human unfollow...`);
    await scrollElementIntoViewAndEnsureVisible(cell, 'center');
    await sleep(350);

    // 6. Click Following button with authentic Virtual Cursor and red ripple (#EF4444)
    await performHumanClick(followBtn, {
      pulseColor: '#EF4444',
      scroll: false,
      hoverDwell: 350,
      postPause: 300
    });

    // Wait up to 3000ms for confirmation sheet to appear
    let confirmBtn = null;
    const startConfirmWait = Date.now();
    while (Date.now() - startConfirmWait < 3000) {
      if (isWorkflowAborted) return { success: false, aborted: true };
      confirmBtn = findUnfollowConfirmationButton();
      if (confirmBtn) break;
      await sleep(150);
    }

    // Direct click fallback on Following button if confirmation sheet didn't appear
    if (!confirmBtn) {
      console.log(`[ATOMX UNFOLLOW] Confirmation sheet not detected yet for @${href}. Applying direct click fallback on Following button...`);
      try {
        followBtn.focus();
        followBtn.click();
        followBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}

      const secondWait = Date.now();
      while (Date.now() - secondWait < 2500) {
        if (isWorkflowAborted) return { success: false, aborted: true };
        confirmBtn = findUnfollowConfirmationButton();
        if (confirmBtn) break;
        await sleep(150);
      }
    }

    if (confirmBtn) {
      // Allow modal slide-in transition to fully settle so coordinates are 100% frozen
      await sleep(250);
      confirmBtn = findUnfollowConfirmationButton() || confirmBtn;

      console.log(`[ATOMX UNFOLLOW] Confirming unfollow sheet dead-center for @${href}...`);
      await performHumanClick(confirmBtn, {
        pulseColor: '#EF4444',
        scroll: false,
        exactCenter: true,
        hoverDwell: 350,
        postPause: 350
      });

      // Direct synthetic & native click dispatch on the confirm button
      try {
        confirmBtn.focus();
        confirmBtn.click();
        confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}

      // Check if modal dialog still present after 350ms, dispatch secondary direct click
      await sleep(350);
      const lingeringConfirmBtn = findUnfollowConfirmationButton();
      if (lingeringConfirmBtn) {
        console.log(`[ATOMX UNFOLLOW] Sheet still present. Dispatching direct fallback click on confirm button...`);
        try {
          lingeringConfirmBtn.focus();
          lingeringConfirmBtn.click();
          lingeringConfirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (e) {}
      }

      await sleep(750);
      autoUnfollowSessionProcessed.add(href);
      return { success: true, unfollowed: true, handle: href };
    } else {
      // Check if button state already changed to "Follow" directly
      const updatedBtn = findFollowingButtonInCell(cell);
      const updatedTxt = (cell.innerText || '').toLowerCase();
      if (!updatedBtn || (updatedTxt.includes('follow') && !updatedTxt.includes('following'))) {
        console.log(`[ATOMX UNFOLLOW] @${href} unfollow verified without modal.`);
        autoUnfollowSessionProcessed.add(href);
        return { success: true, unfollowed: true, handle: href };
      }

      console.warn(`[ATOMX UNFOLLOW] Confirmation dialog not found for @${href}. Marking processed.`);
      autoUnfollowSessionProcessed.add(href);
      return { success: false, action: 'FAILED', handle: href, error: 'Confirmation button not found' };
    }
  }

  // All visible cells in this viewport were evaluated (either followed back or whitelisted)
  // Scroll down smoothly to hydrate the next batch of accounts using Global Human Scroll Architecture
  console.log(`[ATOMX UNFOLLOW] Evaluated visible batch (${skippedCountInBatch} followed back/whitelisted). Scrolling for more accounts via humanSmoothScroll...`);
  await humanSmoothScroll(750, { settlePause: 450 });
  await sleep(600);
  return {
    success: true,
    skipped: true,
    scrolledMore: true,
    skippedCount: Math.max(1, skippedCountInBatch),
    reason: 'Visible accounts follow you back. Scrolled down.'
  };
}

// =========================================================================
// AGENT 11: COMMENT POD AUDITOR — FIND DEFAULTERS
// =========================================================================
async function auditPostCommenters(params = {}) {
  isWorkflowAborted = false;
  const maxScrolls = Math.max(Number(params.maxScrolls) || 100, 80);
  const commenters = new Set();
  const mainArticle = getMainPostArticle();
  const mainHandle = mainArticle ? (extractTweetData(mainArticle).authorHandle || '').toLowerCase().replace(/^@/, '').trim() : '';

  let consecutiveNoNew = 0;
  let prevSize = 0;
  let clickedSpamOrHidden = false;

  console.log('[ATOMX DEFAULTERS] Starting deep comment audit on post. Will scroll till end and expand probable spam/hidden replies.');

  for (let i = 0; i < maxScrolls; i++) {
    if (isWorkflowAborted) break;

    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach(art => {
      if (mainArticle && art === mainArticle) return;

      const userEl = art.querySelector('div[data-testid="User-Name"]');
      if (userEl) {
        // 1. Direct handle match from User-Name text: @username
        const handleMatch = (userEl.innerText || userEl.textContent || '').match(/@([a-zA-Z0-9_]{1,25})/);
        if (handleMatch) {
          const clean = handleMatch[1].toLowerCase().trim();
          if (clean && clean !== mainHandle && !['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'hashtag', 'settings'].includes(clean)) {
            commenters.add(clean);
          }
        }

        // 2. Also check profile link
        const links = userEl.querySelectorAll('a[href^="/"]');
        for (const link of links) {
          const href = (link.getAttribute('href') || '').replace(/^\//, '').split('?')[0].split('/')[0].toLowerCase().trim();
          if (href && !['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'hashtag', 'settings'].includes(href)) {
            if (href !== mainHandle && /^[a-z0-9_]{1,25}$/.test(href)) {
              commenters.add(href);
            }
            break;
          }
        }
      }
    });

    // Detect and Auto-Click "Probable Spam" or hidden / additional replies
    const actionButtons = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
    let buttonClicked = false;
    for (const btn of actionButtons) {
      const txt = (btn.innerText || btn.textContent || '').toLowerCase().trim();
      if (
        txt.includes('probable spam') ||
        txt.includes('offensive content') ||
        txt.includes('show additional replies') ||
        txt.includes('show more replies') ||
        txt.includes('show replies') ||
        txt.includes('show probability')
      ) {
        try {
          await gentleScrollIntoView(btn);
          btn.click();
          buttonClicked = true;
          clickedSpamOrHidden = true;
          console.log(`[ATOMX DEFAULTERS] Clicked expand button: "${txt.slice(0, 40)}"`);
          await sleep(1400);
          break;
        } catch (e) {}
      }
    }

    if (commenters.size === prevSize && !buttonClicked) {
      consecutiveNoNew++;
      // Check if user has scrolled past bottom
      if (consecutiveNoNew >= 8) {
        console.log(`[ATOMX DEFAULTERS] No new comments for 8 consecutive cycles. Scan complete.`);
        break;
      }
    } else {
      consecutiveNoNew = 0;
      prevSize = commenters.size;
    }

    await smoothScrollAndHydrate(850, 800);
  }

  console.log(`[ATOMX DEFAULTERS] Finished audit. Total unique commenters found: ${commenters.size} (expanded spam: ${clickedSpamOrHidden})`);

  return {
    success: true,
    mainAuthor: mainHandle,
    commenters: Array.from(commenters)
  };
}

// =========================================================================
// AGENT 13: COMMENTER RECIPROCATOR — PRE-COLLECTION LIKING & SMART DEDUPLICATION
// =========================================================================
async function collectReciprocatorCommenters(params = {}) {
  isWorkflowAborted = false;
  const targetCount = Number(params.targetCount || params.maxCount || 10);
  const maxScrolls = Math.max(params.maxScrolls || 40, targetCount * 4);
  const likeDelayMs = Number(params.commentLikeDelayMs || params.likeDelay || 4000);
  const collectedProfiles = [];
  const collectedHandles = new Set();
  const mainArticle = getMainPostArticle();
  const mainHandle = mainArticle ? (extractTweetData(mainArticle).authorHandle || '').toLowerCase().replace(/^@/, '').trim() : '';
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();

  let likesGiven = 0;
  let skippedAlreadyLiked = 0;
  let consecutiveNoNew = 0;
  let prevSize = 0;

  console.log(`[ATOMX RECIPROCATOR] Scanning comments for post (target: ${targetCount}, special like delay: ${likeDelayMs}ms). Will auto-like unliked comments and skip already-liked comments.`);

  for (let i = 0; i < maxScrolls; i++) {
    if (isWorkflowAborted) break;

    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    for (const art of articles) {
      if (isWorkflowAborted) break;
      if (mainArticle && art === mainArticle) continue;

      // Extract author handle
      let commentAuthor = '';
      const userEl = art.querySelector('div[data-testid="User-Name"]');
      if (userEl) {
        const links = userEl.querySelectorAll('a[href^="/"]');
        for (const link of links) {
          const href = (link.getAttribute('href') || '').replace(/^\//, '').split('?')[0].split('/')[0].toLowerCase().trim();
          if (href && !['home', 'explore', 'notifications', 'messages', 'i', 'compose'].includes(href)) {
            commentAuthor = href;
            break;
          }
        }
      }

      if (!commentAuthor) {
        const d = extractTweetData(art);
        commentAuthor = (d.authorHandle || '').toLowerCase().replace(/^@/, '').trim();
      }

      // Skip self comments and main post author
      if (!commentAuthor || commentAuthor === mainHandle || (loggedInHandle && commentAuthor === loggedInHandle)) {
        continue;
      }

      // If author already collected in this run, skip
      if (collectedHandles.has(commentAuthor)) {
        continue;
      }

      // ── CRITICAL FEATURE ──
      // Check if this comment is ALREADY LIKED
      const isAlreadyLiked = !!art.querySelector('button[data-testid="unlike"], div[data-testid="unlike"], [data-testid="unlike"]') ||
                             Array.from(art.querySelectorAll('button, div[role="button"]')).some(b => {
                               const l = (b.getAttribute('aria-label') || '').toLowerCase();
                               return l.includes('unlike') || l.includes('liked');
                             });

      if (isAlreadyLiked) {
        // ALREADY LIKED: Skip collecting this profile (native deduplication)
        skippedAlreadyLiked++;
        continue;
      }

      // NOT YET LIKED: Like the comment on the spot before collecting profile!
      await gentleScrollIntoView(art);
      await sleep(200);
      const likedOk = await simulateHumanLikeClick(art);
      if (likedOk) {
        likesGiven++;
      }

      // Global Safety Governed Delay: Uses user's configured safety delay
      const safetyRes = await chrome.storage.local.get(['atomx_safety_settings']).catch(() => ({}));
      const s = safetyRes?.atomx_safety_settings || {};
      let waitMin = s.profileWaitMin !== undefined ? Number(s.profileWaitMin) : (s.profileWait !== undefined ? Math.max(1, Number(s.profileWait) - 1) : 2);
      let waitMax = s.profileWaitMax !== undefined ? Number(s.profileWaitMax) : (s.profileWait !== undefined ? Number(s.profileWait) : 4);
      if (waitMin > waitMax) [waitMin, waitMax] = [waitMax, waitMin];
      const safetyPacing = Math.floor(waitMin * 1000 + Math.random() * ((waitMax - waitMin) * 1000 + 1));
      console.log(`[ATOMX RECIPROCATOR] Comment liked. Global safety pacing: ${(safetyPacing / 1000).toFixed(1)}s`);
      await sleep(safetyPacing);

      // Collect this commenter's profile for reciprocal engagement
      collectedHandles.add(commentAuthor);
      collectedProfiles.push(commentAuthor);

      if (collectedProfiles.length >= targetCount) {
        break;
      }
    }

    if (collectedProfiles.length >= targetCount) {
      break;
    }

    // Auto-click "Show more replies" if visible
    const showBtns = Array.from(document.querySelectorAll('button[role="button"], div[role="button"]')).filter(b => {
      const txt = (b.innerText || '').toLowerCase();
      return txt.includes('show replies') || txt.includes('show more replies') || txt.includes('show probability');
    });
    if (showBtns.length > 0) {
      showBtns[0].click();
      await sleep(1000);
    }

    if (collectedProfiles.length === prevSize) {
      consecutiveNoNew++;
      if (consecutiveNoNew >= 8) break;
    } else {
      consecutiveNoNew = 0;
      prevSize = collectedProfiles.length;
    }

    await smoothScrollAndHydrate(650, 750);
  }

  console.log(`[ATOMX RECIPROCATOR] Scan finished. Collected ${collectedProfiles.length} profiles, liked ${likesGiven} comments, skipped ${skippedAlreadyLiked} already-liked.`);

  return {
    success: true,
    mainAuthor: mainHandle,
    commenters: collectedProfiles,
    likesGiven,
    skippedAlreadyLiked
  };
}

// =========================================================================
// AGENT 14: HOME FEED ENGAGER (x.com/home with Ad Skip & AI Voice)
// =========================================================================

/**
 * Detects whether a tweet article is a Promoted Post / Sponsored Ad on Twitter/X.
 * Checks placement tracking testids, icon-promoted SVGs, and text indicators.
 */
function isPromotedTweet(article) {
  if (!article) return false;

  // 1. Placement tracking / Promoted testids & SVGs
  if (article.querySelector('[data-testid="placementTracking"], [data-testid="promoted"], svg[data-testid="icon-promoted"]')) {
    return true;
  }

  // 2. Check metadata header / social context / badge elements ONLY (do NOT inspect tweet text!)
  const headerOrBadges = Array.from(article.querySelectorAll('[data-testid="User-Name"], [data-testid="socialContext"], [data-testid="tweet"] > div:first-child'));
  for (const container of headerOrBadges) {
    const textSpans = Array.from(container.querySelectorAll('span, div[dir="ltr"]'));
    for (const el of textSpans) {
      const txt = (el.innerText || '').trim();
      if (txt === 'Ad' || txt === 'Promoted' || txt === 'Sponsored' || txt === 'Promoted Tweet') {
        return true;
      }
    }
  }

  // 3. Twitter business / ads redirect link (only inside header or CTA buttons, not tweet links)
  const promoLink = article.querySelector('a[href*="ads.twitter.com"], a[href*="business.twitter.com"], a[href*="ads.x.com"]');
  if (promoLink) {
    return true;
  }

  return false;
}

/**
 * Detects whether an article is a Repost / Retweet.
 */
function isRetweetOrRepost(article) {
  if (!article) return false;
  const socialContext = article.querySelector('[data-testid="socialContext"]');
  if (socialContext) {
    const scText = (socialContext.innerText || '').toLowerCase();
    if (scText.includes('repost') || scText.includes('retweet')) return true;
  }
  const raw = (article.innerText || '').trim();
  if (raw.startsWith('Reposted') || raw.includes(' reposted\n') || raw.includes(' Retweeted\n')) {
    return true;
  }
  return false;
}

/**
 * Detects whether an article is a reply/comment to someone else rather than a root tweet.
 * Supports multi-language phrases (Spanish, English, French, etc.) and DOM structure.
 */
function isReplyOrCommentTweet(article) {
  if (!article) return false;
  const text = (article.innerText || '').toLowerCase();

  const replyPhrases = [
    'replying to',
    'en respuesta a',
    'respondiendo a',
    'en réponse à',
    'en reponse a',
    'antwort an',
    'em resposta a',
    'risposta a',
    'yanıt olarak',
    'в ответ',
    'ردًا على',
    'への返信'
  ];
  if (replyPhrases.some(phrase => text.includes(phrase))) {
    return true;
  }

  // Look for reply header blocks above the main tweet body
  const userHeader = article.querySelector('div[data-testid="User-Name"]');
  if (userHeader) {
    const parent = userHeader.parentElement;
    if (parent) {
      const parentText = (parent.innerText || '').toLowerCase();
      if (replyPhrases.some(p => parentText.includes(p))) return true;
    }
  }

  // Check for vertical thread connector line (replies in conversation streams)
  if (article.querySelector('div[style*="border-left"], div[style*="border-right"], [data-testid="Tweet-User-Avatar"] + div[style*="width: 2px"]')) {
    return true;
  }

  return false;
}

/**
 * Scans user's Home Timeline (x.com/home) or Search Stream (x.com/search) for fresh unengaged posts.
 * Skips Promoted Ads automatically.
 * Skips Reposts (Retweets) and Comments/Replies in Niche Search.
 * Skips user's own posts and already engaged tweets.
 * Executes requested actions (Like, Comment, Repost, Follow) with human pacing and AI voice.
 */
async function executeHomeFeedEngagementStep(params = {}) {
  isWorkflowItemSkipped = false;
  await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
  if (isWorkflowAborted) return { success: false, aborted: true };

  // Dismiss any lingering dialog before starting new post scan
  await closeAnyOpenTwitterDialog();

  const actions = params.actions || { like: true, comment: true, repost: false, follow: false };
  const verifiedHandle = (params.verifiedXHandle || '').toLowerCase().replace(/^@/, '').trim();
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase();
  const alreadyEngagedSet = new Set((params.alreadyEngagedIds || []).map(String));
  const filterRepAndCom = params.filterRepliesAndReposts || window.location.pathname.startsWith('/search');

  // Find timeline articles
  let articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  if (articles.length === 0) {
    for (let r = 0; r < 5 && articles.length === 0; r++) {
      if (isWorkflowAborted || isWorkflowItemSkipped) return { success: false, aborted: true };
      await humanSmoothScroll(400, { settlePause: 400 });
      articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    }
  }

  if (articles.length === 0) {
    return { success: false, reason: 'No timeline tweets found' };
  }

  for (const art of articles) {
    if (isWorkflowAborted) return { success: false, aborted: true };
    if (isWorkflowItemSkipped) {
      isWorkflowItemSkipped = false;
      await clearAnyDraftComment();
      return { success: false, skipped: true, ignored: true };
    }

    // 1. Promoted Ad Check — Auto-skip 100% of Ads and continue to next tweet
    if (isPromotedTweet(art)) {
      console.log('[ATOMX FEED/NICHE] Promoted Ad detected. Auto-skipping to next post...');
      continue;
    }

    // 2. Niche Search Filter: Strict auto-filter of Reposts and Comments/Replies
    if (filterRepAndCom) {
      if (isRetweetOrRepost(art)) {
        console.log('[ATOMX NICHE ENGAGER] Repost / Retweet detected. Auto-skipping to next post...');
        continue;
      }
      if (isReplyOrCommentTweet(art)) {
        console.log('[ATOMX NICHE ENGAGER] Reply / Comment detected. Auto-skipping to next post...');
        continue;
      }
    }

    const data = extractTweetData(art);
    const cleanHandle = (data.authorHandle || '').replace(/^@/, '').toLowerCase().trim();
    const tweetId = data.tweetId;

    // 3. Skip user's own posts
    if (cleanHandle && (cleanHandle === loggedInHandle || cleanHandle === verifiedHandle)) {
      continue;
    }

    // 4. Skip already engaged or skipped posts
    if (art.getAttribute('data-atomx-skipped') === 'true' || art.getAttribute('data-atomx-engaged') === 'true') {
      continue;
    }
    const isAlreadyLiked = isPostAlreadyLiked(art);
    if (tweetId && alreadyEngagedSet.has(String(tweetId))) {
      continue;
    }
    // If like is the only requested action and it's already liked, skip
    if (actions.like && !actions.comment && !actions.repost && !actions.follow && isAlreadyLiked) {
      continue;
    }

    // Check if article has action buttons
    const hasButtons = art.querySelector('button[data-testid="like"], button[data-testid="unlike"], button[data-testid="reply"]');
    if (!hasButtons) continue;

    // Found fresh unengaged post! Bring comfortably to screen center
    await humanScrollElementIntoView(art, 'center');
    await sleep(400);

    const performed = { like: false, comment: false, repost: false, follow: false };

    // Action 1: Like
    if (actions.like && !isAlreadyLiked && !isWorkflowAborted && !isWorkflowItemSkipped) {
      const ok = await simulateHumanLikeClick(art);
      if (ok) performed.like = true;
      await sleep(400);
    }

    // Action 2: Repost
    if (actions.repost && !isWorkflowAborted && !isWorkflowItemSkipped) {
      const ok = await simulateHumanRepostClick(art);
      if (ok) performed.repost = true;
      await sleep(400);
    }

    // Action 3: Comment (with AI Voice)
    if (actions.comment && !isWorkflowAborted && !isWorkflowItemSkipped) {
      const liveTweetText = (data.text || '').trim();
      const liveAuthor = data.authorHandle || '@user';

      let commentToPost = '';
      try {
        const aiResp = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'GENERATE_AI_REPLY',
            tweetText: liveTweetText,
            tweetAuthor: liveAuthor,
            tweetAuthorName: data.authorName || '',
            style: params.style || 'Bullish (5-10 words)',
            stylePrompt: params.stylePrompt || null
          }, resolve);
        });
        if (aiResp && aiResp.success && aiResp.reply) {
          commentToPost = aiResp.reply;
        }
      } catch (e) {}

      if (!commentToPost) {
        commentToPost = twxPickFallbackComment();
      }
      commentToPost = sanitizeClientComment(commentToPost, extractMaxWordsFromPrompt(params.stylePrompt || params.style));

      const comRes = await postCommentOnTargetArticle(art, commentToPost);
      if (comRes && comRes.success) {
        performed.comment = true;
      }
      if (comRes?.skipped || isWorkflowItemSkipped) {
        isWorkflowItemSkipped = false;
        await clearAnyDraftComment();
        art.setAttribute('data-atomx-skipped', 'true');
        art.setAttribute('data-atomx-engaged', 'true');
        if (tweetId) {
          alreadyEngagedSet.add(String(tweetId));
          try {
            const curEng = await chrome.storage.local.get(['engagedTweetIds']);
            const updated = Array.from(new Set([...(curEng?.engagedTweetIds || []), String(tweetId)]));
            await chrome.storage.local.set({ engagedTweetIds: updated });
          } catch (e) {}
        }
        await humanSmoothScroll(520, { settlePause: 400 });
        dismissLingeringTwitterTooltips();
        return { success: false, skipped: true, performed, authorHandle: data.authorHandle, tweetId };
      }
      await sleep(500);
    }

    // Action 4: Follow
    if (actions.follow && !isWorkflowAborted && !isWorkflowItemSkipped) {
      const targetHandle = data.authorHandle || '';
      console.log(`[ATOMX HOME FEED] Performing follow action on author @${targetHandle}`);
      const followed = await performFollowOnTweetAuthor(art, targetHandle);
      if (followed) {
        performed.follow = true;
      }
      await sleep(400);
    }

    // Check if user clicked skip during follow or after actions
    if (isWorkflowItemSkipped) {
      isWorkflowItemSkipped = false;
      await clearAnyDraftComment();
      art.setAttribute('data-atomx-skipped', 'true');
      art.setAttribute('data-atomx-engaged', 'true');
      if (tweetId) {
        alreadyEngagedSet.add(String(tweetId));
        try {
          const curEng = await chrome.storage.local.get(['engagedTweetIds']);
          const updated = Array.from(new Set([...(curEng?.engagedTweetIds || []), String(tweetId)]));
          await chrome.storage.local.set({ engagedTweetIds: updated });
        } catch (e) {}
      }
      await humanSmoothScroll(520, { settlePause: 400 });
      dismissLingeringTwitterTooltips();
      return { success: false, skipped: true, performed, authorHandle: data.authorHandle, tweetId };
    }

    // Ensure dialog is closed and any floating tooltips ("Reply", "Unlike") are dismissed
    await closeAnyOpenTwitterDialog();
    dismissLingeringTwitterTooltips();
    await sleep(300);

    // Scroll down past this engaged post so the next post is brought into viewport
    await humanSmoothScroll(500, { settlePause: 350 });
    dismissLingeringTwitterTooltips();

    return {
      success: true,
      engaged: true,
      tweetId: tweetId || null,
      authorHandle: cleanHandle || 'creator',
      performed,
      commented: performed.comment
    };
  }

  // If no fresh post in current viewport, smoothly scroll down
  await humanSmoothScroll(700, { settlePause: 400 });
  return { success: false, scrolledMore: true };
}

// =========================================================================
// TG LIKER: STOP AT POST & SCROLL RECORDER ENGINE
// =========================================================================
let tglStopCount = 0;
const tglNormTxt = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function getTweetArticleInfo(a) {
  let handle = '';
  const un = a.querySelector('[data-testid="User-Name"]');
  if (un) { const m = (un.textContent || '').match(/@([A-Za-z0-9_]{1,15})/); if (m) handle = m[1]; }
  const tt = a.querySelector('[data-testid="tweetText"]');
  const timeLink = a.querySelector('a[href*="/status/"] time');
  const link = (timeLink && timeLink.closest('a')) || a.querySelector('a[href*="/status/"]');
  const href = (link && link.getAttribute('href')) || '';
  const m = href.match(/\/status\/(\d+)/);
  const id = m ? m[1] : null;
  return { id, handle, text: tt ? (tt.textContent || '') : '' };
}

function matchesStopTarget(stop, a, id) {
  if (!stop || (!stop.id && !stop.handle && !stop.text)) return false;
  if (stop.id) return id === stop.id;
  const info = getTweetArticleInfo(a);
  if (stop.handle && info.handle.toLowerCase() !== String(stop.handle).toLowerCase()) return false;
  const want = tglNormTxt(stop.text);
  let hit;
  if (!want) hit = !!stop.handle;
  else { const have = tglNormTxt(info.text); hit = have.length >= 6 && (have.includes(want) || want.includes(have)); }
  if (!hit) return false;
  tglStopCount++;
  return tglStopCount >= (stop.nth || 1);
}

// Visual Tweet Picker for "Stop at post"
let pickOn = false;
function startTweetStopPick() {
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
    const info = getTweetArticleInfo(a);
    if (!info.id) { bar.textContent = '⚠ Ei post e id pawa jayni, onno post e click koro'; return; }
    try { chrome.storage.local.set({ tgl_stoppick: { id: info.id, handle: info.handle, text: tglNormTxt(info.text).slice(0, 140), at: Date.now() } }); } catch (x) {}
    finish();
  };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(); } };
  document.addEventListener('mouseover', over, true);
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((n) => document.addEventListener(n, swallow, true));
  document.addEventListener('keydown', key, true);
}

// ── Standalone Scroll Recorder Engine ────────────────────────────────
const REC_PACE = {
  slow:   { burst: 1.0, pause: [380, 760], dist: [0.45, 0.8] },   // ~0.55 screen/s
  normal: { burst: 1.6, pause: [160, 380], dist: [0.45, 0.8] },   // ~1 screen/s
  fast:   { burst: 2.4, pause: [90, 200],  dist: [0.45, 0.8] },   // ~1.6 screen/s
  faster: { burst: 4.5, pause: [40, 110],  dist: [0.8, 1.3] },    // ~3 screen/s
  turbo:  { burst: 8,   pause: [15, 60],   dist: [1.2, 1.8] },    // ~5 screen/s
  insane: { burst: 14,  pause: [0, 25],    dist: [1.8, 2.6] }     // ~9 screen/s
};
let recAbort = false;
let recRunning = false;

function findPageScroller() {
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
const isScrollerRoot = (el) => el === document.scrollingElement || el === document.documentElement || el === document.body;
const getScrollerTop = (el) => (isScrollerRoot(el) ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) : el.scrollTop);
function setScrollerTop(el, y) {
  y = Math.max(0, y);
  if (isScrollerRoot(el)) {
    window.scrollTo({ top: y, behavior: 'instant' });
    if (Math.abs(getScrollerTop(el) - y) > 2) { document.documentElement.scrollTop = y; document.body.scrollTop = y; }
  } else el.scrollTop = y;
}

function wheelViaCdpCall(dy) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage({ type: 'trusted', action: 'wheel', x: Math.round(window.innerWidth * 0.5), y: Math.round(window.innerHeight * 0.5), dy }, (r) => { void chrome.runtime.lastError; res(!!(r && r.ok)); });
    } catch (e) { res(false); }
  });
}

async function recGlideUp(el, dy, ms) {
  if (Math.abs(dy) < 4) return 0;
  const from = getScrollerTop(el);
  const t0 = performance.now();
  while (!recAbort) {
    const t = Math.min(1, (performance.now() - t0) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    setScrollerTop(el, from + dy * e);
    if (t >= 1) break;
    await new Promise(r => { requestAnimationFrame(r); setTimeout(r, 50); });
  }
  return from - getScrollerTop(el);
}

async function recScrollToTopSmooth(pace) {
  const P = REC_PACE[pace] || REC_PACE.normal;
  const t0 = Date.now();
  let stuck = 0, useWheel = false;
  let el = findPageScroller();
  const sleepFn = ms => new Promise(r => setTimeout(r, ms));
  const randNum = (a, b) => a + Math.random() * (b - a);
  const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));

  while (getScrollerTop(el) > 3 && !recAbort) {
    if (Date.now() - t0 > 20 * 60 * 1000) break; // safety: max 20 min
    const vh = window.innerHeight;
    const before = getScrollerTop(el);
    const d = Math.min(before, vh * randNum(P.dist[0], P.dist[1]));
    const ms = clampNum((d / vh) / P.burst * 1000 * randNum(0.9, 1.1), 40, 1400);
    if (!useWheel) await recGlideUp(el, -d, ms);
    else {
      const steps = Math.max(3, Math.round(ms / 40));
      for (let i = 0; i < steps && !recAbort; i++) { await wheelViaCdpCall(-d / steps); await sleepFn(ms / steps); }
    }
    await sleepFn(40);
    if (Math.abs(getScrollerTop(el) - before) < 2) {
      stuck++;
      if (stuck === 2) { el = findPageScroller(); }
      else if (stuck === 3 && !useWheel) { useWheel = true; }
      else if (stuck >= 6) { setScrollerTop(el, 0); break; }
    } else stuck = 0;
    await sleepFn(randNum(P.pause[0], P.pause[1]));
  }
  if (useWheel) { try { chrome.runtime.sendMessage({ type: 'trusted', action: 'detach' }, () => void chrome.runtime.lastError); } catch (e) {} }
  return getScrollerTop(el) <= 3;
}

// =========================================================================
// AGENT 16: TG LIKER — MASS RAID, REPOSTS & QUOTES ENGAGER
// 100% Exact Port of Native Continuous In-Page Raid & Glide Engine
// =========================================================================
const TgLikerNativeEngine = (() => {
  const K = { cfg: 'tgl_cfg', ctrl: 'tgl_ctrl', state: 'tgl_state', hour: 'tgl_hourlog', seen: 'tgl_seen' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  let ctrl = { state: 'stopped', runId: 0 };
  let S = {};            // content-written state
  let hourLog = [];      // last 1 hour action timestamps
  let myRun = null;
  let seenMap = {};      // { [targetUrl]: [post ids already handled] }
  let seenCtx = null;    // current page seen context
  let dead = false;
  let busy = false;
  let currentCfg = null;

  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[K.ctrl]) {
      ctrl = changes[K.ctrl].newValue || { state: 'stopped', runId: 0 };
      if (ctrl.state === 'stopped') {
        dead = true;
        removeCursor();
      }
    }
    if (changes.atomx_agent_workflow?.newValue?.isStopped || changes.atomx_active_hud?.newValue?.isStopped) {
      ctrl = { state: 'stopped', runId: 0 };
      dead = true;
      removeCursor();
    }
  });

  // ---------------------------------------------------------------- state / status
  let lastStatus = '';
  let lastStatusAt = 0;

  async function save(patch) {
    if (!extAlive()) { dead = true; return; }
    Object.assign(S, patch);
    try {
      await chrome.storage.local.set({ [K.state]: S });

      // Sync to AtomX Agent Workflow & Floating HUD in real time
      const total = (currentCfg && currentCfg.maxPosts) || S.total || 0;
      const done = S.total || 0;
      const liked = S.stats?.liked || 0;
      const reposted = S.stats?.reposted || 0;
      const bookmarked = S.stats?.bookmarked || 0;
      const skipped = S.stats?.skipped || 0;
      const isStopped = ctrl.state === 'stopped' || S.phase === 'stopped';
      const isDone = S.phase === 'done';
      const stateBadge = isDone ? 'DONE' : (isStopped ? 'STOPPED' : (ctrl.state === 'paused' ? 'PAUSED' : (S.onBreak ? 'BREAK' : 'RUNNING')));

      const hudPayload = {
        title: 'TG Liker (Raid & Repost)',
        stateBadge,
        indicator: `Post ${done}/${total > 0 ? total : '∞'}`,
        done,
        collected: total,
        skipped,
        progressPercent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 50,
        statusText: S.status || `[${done}/${total > 0 ? total : '∞'}] (❤️${liked} 🔁${reposted} 🔖${bookmarked})`,
        countdownText: S.wait ? `Break: ${Math.round(S.wait.left)}s left` : '',
        isStopped,
        active: !isStopped && !isDone
      };

      // Direct synchronous update to on-page Floating HUD
      if (typeof updateFloatingHud === 'function') {
        updateFloatingHud(hudPayload);
      }

      await chrome.storage.local.set({
        atomx_agent_workflow: {
          agentId: 'tgliker',
          title: 'TG Liker (Raid & Repost)',
          active: !isStopped && !isDone,
          isStopped,
          stateBadge,
          statusText: S.status || 'Running...',
          total,
          successCount: done,
          liked,
          reposted,
          bookmarked,
          ignoredCount: skipped,
          countdownText: S.wait ? `Break: ${Math.round(S.wait.left)}s left` : ''
        },
        atomx_active_hud: hudPayload,
        atomx_tgliker_last_stats: {
          handled: done,
          liked,
          reposted,
          bookmarked,
          skipped
        }
      }).catch(() => null);
    } catch (e) { dead = true; }
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

  // Pause / Stop gate: stays here when paused, returns false when stopped
  async function gate() {
    while (true) {
      if (dead || !extAlive()) return false;
      if (ctrl.runId !== myRun || ctrl.state === 'stopped') return false;
      if (ctrl.state === 'paused') {
        status('⏸ Paused');
        await sleep(250);
        continue;
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
  const isReposted = (a) => !!a.querySelector('[data-testid="unretweet"]');
  const isBookmarked = (a) => !!(
    a.querySelector('[data-testid="removeBookmark"]') ||
    a.querySelector('button[aria-label*="Remove from Bookmarks" i]') ||
    a.querySelector('button[aria-label*="Bookmarked" i]')
  );
  const findBookmarkBtn = (a) =>
    a.querySelector('[data-testid="bookmark"]') ||
    a.querySelector('button[aria-label*="Bookmark" i]') ||
    a.querySelector('div[role="button"][aria-label*="Bookmark" i]') ||
    a.querySelector('button[aria-label*="Save" i]') ||
    a.querySelector('[data-testid*="bookmark" i]');

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
    setTimeout(f, 50);   // Fallback for background tabs where rAF throttles
  });

  // ---------------------------------------------------------------- virtual mouse cursor
  let cursorEl = null;
  let cur = { x: 0, y: 0 };

  function placeCursor(x, y) {
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1200;
    x = clamp(x, 15, vw - 25);
    y = clamp(y, 15, vh - 25);
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

  // Curved path cursor glide (ease-in-out Bézier)
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
      if (dead || ctrl.state === 'stopped') return;
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

  // Cursor moves naturally over element, pauses briefly, then clicks with visual feedback
  async function humanClick(el, color, delay) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { el.click(); return; }
    const x = r.left + r.width * rand(0.3, 0.7);
    const y = r.top + r.height * rand(0.3, 0.7);
    const cursorMs = clamp(delay * 0.15, 220, 500);
    const dist = Math.hypot(x - cur.x, y - cur.y);
    await moveCursor(x, y, clamp(cursorMs + dist * 0.25, cursorMs, 650));
    await sleep(clamp(delay * 0.05, 70, 250));          // Hover pause
    clickEffect(x, y, color);
    await sleep(rand(60, 110));                         // Press dwell
    dispatchClick(el, x, y);
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

  // ---------------------------------------------------------------- break
  async function takeBreak(cfg, long) {
    const b = long ? cfg.longBreak : cfg.breaks;
    const total = long ? rand(b.minMin * 60, b.minMax * 60) : rand(b.secMin, b.secMax);
    const kind = long ? 'long' : 'break';
    let left = total;
    let lastSave = 0;
    await save({ onBreak: true, wait: { kind, left: total, total } });
    while (left > 0) {
      if (!(await gate())) { await save({ onBreak: false, wait: null }); return false; }
      const now = Date.now();
      if (now - lastSave >= 1000) {
        lastSave = now;
        lastStatus = '';
        save({ status: `${long ? '🛑 Long break' : '☕ Break'} — ${fmt(Math.max(0, left))} remaining`, wait: { kind, left: Math.max(0, left), total } });
      }
      await sleep(250);
      left -= 0.25;
    }
    const patch = {
      onBreak: false, wait: null,
      sinceBreak: 0, breakAt: randInt(cfg.breaks.everyMin, cfg.breaks.everyMax)
    };
    if (long) { patch.sinceLong = 0; patch.longAt = randInt(cfg.longBreak.everyMin, cfg.longBreak.everyMax); }
    await save(patch);
    return true;
  }

  // Hourly limit: max N posts per hour
  async function quotaGate(cfg) {
    if (!cfg.hourlyMax) return true;
    while (true) {
      const now = Date.now();
      hourLog = hourLog.filter((t) => now - t < 3600e3);
      if (hourLog.length < cfg.hourlyMax) { if (S.wait) await save({ wait: null }); return true; }
      const waitSec = Math.ceil((hourLog[0] + 3600e3 - now) / 1000);
      if (!(await gate())) { await save({ wait: null }); return false; }
      lastStatus = '';
      save({ status: `⏳ Hourly limit (${hourLog.length}/${cfg.hourlyMax}) — resumes in ${fmt(waitSec)}`,
             wait: { kind: 'hourly', left: waitSec, total: 3600 } });
      await sleep(1000);
    }
  }

  // ---------------------------------------------------------------- main raid (single page)
  async function raidPage(cfg, target) {
    try { return await raidPageInner(cfg, target); }
    finally { await flushSeen(); }
  }

  async function raidPageInner(cfg, target) {
    const delay = Number.isFinite(cfg.speedMs) ? cfg.speedMs : 3500;
    const instant = delay < 1000;       // Turbo: instant jump + direct click
    const human = !instant;             // Human mode: smooth scroll + curved mouse cursor
    const A = cfg.actions || { like: true };

    const SPEED = instant
      ? { settle: 30, likeMax: 900, menuMax: 2000, afterAction: 80, scrollWaitMax: 1200, pollStep: 40 }
      : { settle: 70, likeMax: 1500, menuMax: 2500, afterAction: 60, scrollWaitMax: 2000, pollStep: 60,
          scrollMsMin: 320, scrollMsMax: Math.min(800, Math.round(delay * 0.35)), likeAtViewportPct: 0.62 };

    const mainId = (location.pathname.match(/\/status\/(\d+)/) || [])[1] || null;
    const seenList = Array.isArray(seenMap[target.url]) ? seenMap[target.url].slice() : [];
    seenCtx = { url: target.url, list: seenList };
    const done = new Set(seenList);
    const preSeen = seenList.length;
    const viewed = new Set();
    const doneNoId = new WeakSet();
    let emptyScrolls = 0;
    let failStreak = 0;
    tglStopCount = 0;

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

    // Needs work check: avoids re-touching posts already matching selected actions
    const needsWork = (a) =>
      (A.like && !isLiked(a)) ||
      (A.repost && !isReposted(a)) ||
      (A.bookmark && !isBookmarked(a));

    const glideToPost = async (a) => {
      const anchor = a.querySelector('[data-testid="like"], [data-testid="unlike"]') || a;
      const vh = window.innerHeight || 800;
      const dy = anchor.getBoundingClientRect().top - vh * SPEED.likeAtViewportPct;
      const ms = clamp(260 + Math.abs(dy) * 0.45, SPEED.scrollMsMin, SPEED.scrollMsMax) * rand(0.92, 1.08);
      ensureCursor();
      // Mouse naturally wanders slightly with scroll as a real hand would
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
      return { error: 'No posts found on X page. Please check login or page load.' };
    }

    let handled = 0;

    while (true) {
      if (!(await gate())) return { stopped: true };

      const item = nextArticle();

      // No new post found -> scroll downward
      if (!item) {
        const idsNow = articlesNow().map(articleId).filter(Boolean);
        const newInDom = idsNow.some((x) => !viewed.has(x));
        idsNow.forEach((x) => viewed.add(x));
        if (newInDom) emptyScrolls = 0; else emptyScrolls++;
        if (emptyScrolls > (instant ? 7 : 6)) return { endReached: true };

        // Continue mode: rapidly fast-scroll past previously handled posts
        if (preSeen > 0 && handled === 0) {
          status(`⏩ Continuing downward... ${done.size} posts passed`);
          window.scrollBy({ top: Math.round(window.innerHeight * 1.6), behavior: 'instant' });
          await waitUntil(() => hasFresh() || articlesNow().some((x) => { const i = articleId(x); return i && !viewed.has(i); }), 1200, 60);
          continue;
        }

        status(`Scrolling... ${done.size} seen, ${handled} engaged`);
        if (emptyScrolls >= 2) await clickShowMore();
        if (human) await glideScroll(Math.round(window.innerHeight * 0.85), 650);
        else window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: 'instant' });
        await waitUntil(hasFresh, SPEED.scrollWaitMax, SPEED.pollStep);
        continue;
      }
      emptyScrolls = 0;

      const { a, id } = item;
      if (!id) { doneNoId.add(a); continue; }   // Skip ads / promoted
      done.add(id);
      const stopHit = matchesStopTarget(cfg.stop, a, id);

      // All selected actions already satisfied -> skip scroll/click
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
        if (S.stats.skipped % 10 === 0) await save({ stats: S.stats, total: S.total });
        status(`${instant ? '⚡ Turbo' : '🖱️ Running'} — ${S.total}${cfg.maxPosts ? '/' + cfg.maxPosts : ''} posts`);
        continue;
      }

      if (!(await quotaGate(cfg))) return { stopped: true };

      const postStart = Date.now();
      const ev = { liked: false, reposted: false, bookmarked: false };
      let attempted = false;
      let failed = false;

      // ---- 1) Smooth Scroll to Target Post ----
      if (human) await glideToPost(a);
      else a.scrollIntoView({ block: 'center', behavior: 'instant' });
      await sleep(SPEED.settle);
      if (!(await gate())) return { stopped: true };

      // ---- 2) LIKE Action ----
      if (A.like && !isLiked(a)) {
        attempted = true;
        const lb = a.querySelector('[data-testid="like"]');
        if (lb) {
          if (human) await humanClick(lb, '#F43F5E', delay); else lb.click();
        }
        let ok = await waitUntil(() => isLiked(a), SPEED.likeMax);
        if (!ok && lb && ctrl.state !== 'stopped') {
          try { lb.click(); } catch (e) {}
          ok = await waitUntil(() => isLiked(a), 700);
        }
        if (isLiked(a)) ev.liked = true; else failed = true;
      }

      // ---- 3) REPOST Action ----
      if (A.repost && (await gate())) {
        const alreadyReposted = !!a.querySelector('[data-testid="unretweet"]');
        if (!alreadyReposted) {
          const rt = a.querySelector('[data-testid="retweet"]');
          if (rt) {
            attempted = true;
            if (human) await humanClick(rt, '#10B981', delay); else rt.click();
            // Wait for Twitter's dropdown menu to render and settle on screen
            await waitUntil(() => {
              const el = document.querySelector('[data-testid="retweetConfirm"]');
              if (!el) return false;
              const r = el.getBoundingClientRect();
              return r.width > 10 && r.height > 10 && r.top > 0 && r.left > 0;
            }, SPEED.menuMax);
            await sleep(180); // Smooth dwell for dropdown animation

            const confirmItem = document.querySelector('[data-testid="retweetConfirm"]');
            if (confirmItem) {
              if (human) {
                await humanClick(confirmItem, '#10B981', delay);
                await sleep(100);
                if (document.querySelector('[data-testid="retweetConfirm"]')) {
                  try { confirmItem.click(); } catch (e) {}
                }
              } else {
                confirmItem.click();
              }
              const ok = await waitUntil(() => a.querySelector('[data-testid="unretweet"]'), SPEED.likeMax);
              if (ok) ev.reposted = true; else failed = true;
              await sleep(SPEED.afterAction);
            } else {
              failed = true;
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              await sleep(150);
            }
          }
        }
      }

      // ---- 4) BOOKMARK Action ----
      if (A.bookmark && !isBookmarked(a) && (await gate())) {
        let bm = findBookmarkBtn(a);
        if (!bm) {
          await waitUntil(() => findBookmarkBtn(a), 400, 50);
          bm = findBookmarkBtn(a);
        }
        if (bm) {
          attempted = true;
          if (human) await humanClick(bm, '#3B82F6', delay); else bm.click();
          let ok = await waitUntil(() => isBookmarked(a), SPEED.likeMax);
          if (!ok && ctrl.state !== 'stopped') {
            try { bm.click(); } catch (e) {}
            ok = await waitUntil(() => isBookmarked(a), 700);
          }
          if (ok || isBookmarked(a)) ev.bookmarked = true; else failed = true;
          await sleep(SPEED.afterAction);
        }
      }

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
      await save({ stats: S.stats, sinceBreak: S.sinceBreak, sinceLong: S.sinceLong, total: S.total });
      status(`${instant ? '⚡ Turbo' : '🖱️ Running'} — ${S.total}${cfg.maxPosts ? '/' + cfg.maxPosts : ''} posts`);

      // Stop point: user target post reached
      if (stopHit) return { stopReached: true };

      // Max posts limit check
      if (cfg.maxPosts && S.total >= cfg.maxPosts) return { limitReached: true };

      // 3 consecutive failures: abort to avoid rate limit bans
      if (failStreak >= 3) {
        return { error: '3 consecutive actions failed (possible X rate limit). Please try again shortly.' };
      }

      // Smart Break Engine evaluation
      if (acted) {
        const longDue = cfg.longBreak && cfg.longBreak.enabled && S.sinceLong >= S.longAt;
        const shortDue = cfg.breaks && cfg.breaks.enabled && S.sinceBreak >= S.breakAt;
        if (longDue) { if (!(await takeBreak(cfg, true))) return { stopped: true }; }
        else if (shortDue) { if (!(await takeBreak(cfg, false))) return { stopped: true }; }
      }

      // Natural Human Pacing Delay
      if (human && acted) {
        const remain = delay * rand(0.92, 1.08) - (Date.now() - postStart);
        if (remain > 0) await sleep(remain);
      }
    }
  }

  // ---------------------------------------------------------------- target navigation / loop
  const normPath = (p) => { try { return new URL(p, location.href).pathname.replace(/\/+$/, '').toLowerCase(); } catch (e) { return ''; } };

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
    currentCfg = cfg;
    const idx = S.targetIndex || 0;
    const target = cfg.targets && cfg.targets[idx];
    if (!target) return;

    myRun = ctrl.runId;
    const res = await raidPage(cfg, target);
    setTimeout(removeCursor, 1500);

    if (res.stopReached) {
      const s = S.stats || {};
      await save({
        phase: 'done',
        status: `📍 Stop point reached (${S.total} posts, ${s.liked || 0} liked). Job finished.`
      });
      return;
    }
    if (res.limitReached) {
      const s = S.stats || {};
      await save({
        phase: 'done',
        status: `✓ Target complete: ${S.total} posts (${s.liked || 0} like, ${s.reposted || 0} repost, ${s.bookmarked || 0} bookmark, ${s.skipped || 0} skip).`
      });
      return;
    }
    if (res.stopped) { await save({ phase: 'stopped', status: '⏹ Stopped by user' }, true); return; }
    if (res.error) { await save({ phase: 'error', status: '⚠ ' + res.error }); return; }

    // Page reached end -> proceed to next target if multi-target configured
    if (idx + 1 < (cfg.targets ? cfg.targets.length : 0)) {
      await save({ targetIndex: idx + 1, status: 'Navigating to next target...' });
      await sleep(500);
      location.href = cfg.targets[idx + 1].url;
      return;
    }

    // Continuous Feed Loop
    if (cfg.loop) {
      const wait = cfg.speedMs < 3000 ? 20 : 60;
      const ok = await waitActive(wait, '✓ Pass complete — refreshing feed for new posts');
      if (!ok) { await save({ phase: 'stopped', status: '⏹ Stopped by user' }); return; }
      await save({ targetIndex: 0, round: (S.round || 1) + 1, status: 'Refreshing feed...' });
      location.href = cfg.targets[0].url;
      return;
    }

    await save({ phase: 'done', status: '✓ Complete' });
  }

  // ---------------------------------------------------------------- init
  async function init(overrideCfg) {
    if (!extAlive() || busy) return;
    dead = false;
    busy = true;
    try {
      const data = await chrome.storage.local.get([K.cfg, K.ctrl, K.state, K.hour, K.seen]);
      const cfg = overrideCfg || data[K.cfg];
      ctrl = data[K.ctrl] || { state: 'stopped', runId: 0 };
      S = data[K.state] || {};
      hourLog = Array.isArray(data[K.hour]) ? data[K.hour] : [];
      seenMap = data[K.seen] && typeof data[K.seen] === 'object' ? data[K.seen] : {};

      if (!cfg || !(ctrl.state === 'running' || ctrl.state === 'paused') || S.phase !== 'running') return;

      const me = await chrome.runtime.sendMessage({ type: 'whoami' }).catch(() => null);
      if (cfg.tabId && me && me.tabId && me.tabId !== cfg.tabId) return;

      const target = cfg.targets && cfg.targets[S.targetIndex || 0];
      if (!target) return;

      const want = normPath(target.url);
      if (want && normPath(location.href) !== want) {
        await save({ status: '⚠ Tab not on target URL. Please restart.' });
        return;
      }

      currentCfg = cfg;
      S.stats = S.stats || { liked: 0, reposted: 0, bookmarked: 0, skipped: 0 };
      if (S.breakAt == null && cfg.breaks) S.breakAt = randInt(cfg.breaks.everyMin, cfg.breaks.everyMax);
      if (S.sinceBreak == null) S.sinceBreak = 0;
      if (S.longAt == null && cfg.longBreak) S.longAt = randInt(cfg.longBreak.everyMin, cfg.longBreak.everyMax);
      if (S.sinceLong == null) S.sinceLong = 0;

      await runJob(cfg);
    } catch (e) {
      console.warn('[ATOMX TG-LIKER] Engine init error:', e);
    } finally {
      busy = false;
    }
  }

  function stopEngine() {
    ctrl = { state: 'stopped', runId: 0 };
    if (S) S.phase = 'stopped';
    dead = true;
    removeCursor();
  }

  return {
    init,
    runJob,
    stop: stopEngine,
    removeCursor,
    setCtrl: (c) => {
      ctrl = c || { state: 'stopped', runId: 0 };
      if (ctrl.state === 'stopped') {
        dead = true;
        removeCursor();
      }
    }
  };
})();

// =========================================================================
// AGENT 12: TELEGRAM LIVE LIKER & PROOF RECORDER
// =========================================================================
async function executeLiveRaidEngagement(params = {}) {
  isWorkflowAborted = false;
  const { actions = { like: true, repost: true, bookmark: false, glow: true }, delay = 2500 } = params;

  let tweetArticle = getMainPostArticle();
  if (!tweetArticle) {
    tweetArticle = document.querySelector('article[data-testid="tweet"]');
  }
  if (!tweetArticle) {
    return { success: false, error: 'No tweet found on active tab' };
  }

  // Smooth scroll into view so screen recorder captures the target
  await gentleScrollIntoView(tweetArticle);
  await sleep(400);

  // Visual Recording Glow
  if (actions.glow) {
    tweetArticle.style.transition = 'box-shadow 0.4s ease, outline 0.4s ease';
    tweetArticle.style.outline = '3px solid #3B82F6';
    tweetArticle.style.boxShadow = '0 0 24px rgba(59, 130, 246, 0.45)';
  }

  let liked = false, reposted = false, bookmarked = false;

  // 1. Auto Like
  if (actions.like && !isWorkflowAborted) {
    const ok = await simulateHumanLikeClick(tweetArticle);
    if (ok) {
      liked = true;
      await sleep(600);
    }
  }

  // 2. Auto Repost
  if (actions.repost && !isWorkflowAborted) {
    const repostBtn = tweetArticle.querySelector('[data-testid="retweet"]');
    if (repostBtn) {
      repostBtn.click();
      await sleep(600);
      const confirmItem = await waitForElement('[data-testid="retweetConfirm"]', 2500);
      if (confirmItem) {
        confirmItem.click();
        reposted = true;
      }
      await sleep(800);
    }
  }

  // 3. Auto Bookmark
  if (actions.bookmark && !isWorkflowAborted) {
    const bmBtn = tweetArticle.querySelector('[data-testid="bookmark"]');
    if (bmBtn) {
      bmBtn.click();
      bookmarked = true;
      await sleep(600);
    }
  }

  // 4. Auto Comment & AI Reply
  let commented = false;
  let commentText = '';
  if (actions.comment && !isWorkflowAborted) {
    commentText = params.replyText || '';
    if (!commentText) {
      try {
        const tweetData = extractTweetData(tweetArticle);
        const liveTweetText = (tweetData.text || '').trim();
        const liveAuthor = tweetData.authorHandle || tweetData.authorName || '@user';

        const aiResp = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'GENERATE_AI_REPLY',
            tweetText: liveTweetText,
            tweetAuthor: liveAuthor,
            style: params.style || 'Bullish (5-10 words)',
            stylePrompt: params.stylePrompt || null
          }, resolve);
        });
        if (aiResp && aiResp.success && aiResp.reply) {
          commentText = aiResp.reply;
        }
      } catch (e) {}
    }

    if (!commentText) {
      commentText = twxPickFallbackComment();
    }

    commentText = sanitizeClientComment(commentText, extractMaxWordsFromPrompt(params.stylePrompt || params.style));
    const commentRes = await postCommentOnTargetArticle(tweetArticle, commentText);
    if (commentRes && commentRes.success) {
      commented = true;
    }
  }

  // Clean outline gently after actions
  setTimeout(() => {
    if (tweetArticle) {
      tweetArticle.style.outline = '';
      tweetArticle.style.boxShadow = '';
    }
  }, 2200);

  return {
    success: true,
    liked,
    reposted,
    bookmarked,
    commented,
    commentText
  };
}

// =========================================================================
// AGENT 1: AUDIENCE BUILDER — COLLECT ENGAGED COMMENTERS FROM LIST TIMELINE
// =========================================================================
async function collectAudienceFromListTimeline(params = {}) {
  isWorkflowAborted = false;
  const targetCount = Number(params.targetCount || 10);
  const freshness = params.freshness || '1h';
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();

  let freshnessMs = 60 * 60 * 1000;
  if (freshness === '15m') freshnessMs = 15 * 60 * 1000;
  else if (freshness === '30m') freshnessMs = 30 * 60 * 1000;
  else if (freshness === '1h') freshnessMs = 60 * 60 * 1000;
  else if (freshness === '2h') freshnessMs = 2 * 3600 * 1000;
  else if (freshness === '6h') freshnessMs = 6 * 3600 * 1000;
  else if (freshness === '12h') freshnessMs = 12 * 3600 * 1000;
  else if (freshness === '24h') freshnessMs = 24 * 3600 * 1000;
  else if (freshness === '3d') freshnessMs = 3 * 24 * 3600 * 1000;
  else if (freshness === '7d') freshnessMs = 7 * 24 * 3600 * 1000;

  const storedAudience = await new Promise(r => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['atomx_audience_engaged_history'], r);
    } else r({});
  });
  const engagedHistory = (storedAudience?.atomx_audience_engaged_history && typeof storedAudience.atomx_audience_engaged_history === 'object')
    ? storedAudience.atomx_audience_engaged_history : {};

  const collectedProfiles = new Map();
  const startTime = Date.now();
  let consecutiveEmptyScrolls = 0;
  const maxScanDurationMs = 120000; // 2 minutes warning threshold

  for (let s = 0; s < 25; s++) {
    if (isWorkflowAborted) break;
    if (Date.now() - startTime > maxScanDurationMs) {
      console.warn('[ATOMX AUDIENCE] Scraper reached 2-minute safety threshold.');
      break;
    }

    const initialCount = collectedProfiles.size;
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

    for (const art of articles) {
      if (collectedProfiles.size >= targetCount) break;

      const timeEl = art.querySelector('time');
      const timeStr = timeEl ? timeEl.getAttribute('datetime') : null;
      const tweetTime = timeStr ? new Date(timeStr).getTime() : Date.now();
      const ageMs = Date.now() - tweetTime;
      if (ageMs > freshnessMs) continue; // Skip tweets older than freshness window

      const replyBtn = art.querySelector('button[data-testid="reply"], div[data-testid="reply"]');
      const repliesCount = extractTwitterMetric(replyBtn);

      const tweetData = extractTweetData(art);
      const authorHandle = (tweetData.authorHandle || '').replace(/^@/, '').toLowerCase().trim();

      // Collect commenters / repliers in thread
      const userLinks = Array.from(art.querySelectorAll('a[role="link"][href^="/"], div[data-testid="User-Name"] a[href^="/"]'));
      for (const link of userLinks) {
        const href = (link.getAttribute('href') || '').replace(/^\//, '').split('?')[0].split('/')[0].toLowerCase().trim();
        if (!href || ['home', 'explore', 'notifications', 'messages', 'i', 'compose'].includes(href) || href === loggedInHandle) continue;

        if (engagedHistory[href]) continue; // Skip if already engaged

        if (!collectedProfiles.has(href)) {
          collectedProfiles.set(href, {
            cleanHandle: href,
            handle: `@${href}`,
            name: href,
            repliesCount: repliesCount || 1
          });
        }
      }

      if (authorHandle && authorHandle !== loggedInHandle && !engagedHistory[authorHandle] && !collectedProfiles.has(authorHandle)) {
        collectedProfiles.set(authorHandle, {
          cleanHandle: authorHandle,
          handle: `@${authorHandle}`,
          name: authorHandle,
          repliesCount: repliesCount || 1
        });
      }
    }

    if (collectedProfiles.size >= targetCount) break;

    if (collectedProfiles.size === initialCount) {
      consecutiveEmptyScrolls++;
    } else {
      consecutiveEmptyScrolls = 0;
    }

    // If 5-6 scrolls find no fresh tweets, scroll back up slightly to re-trigger feed hydration
    if (consecutiveEmptyScrolls >= 5) {
      console.log('[ATOMX AUDIENCE] 5 scrolls found no fresh tweets. Re-hydrating feed...');
      await humanSmoothScroll(-800, { settlePause: 600 });
      consecutiveEmptyScrolls = 0;
      continue;
    }

    await smoothScrollAndHydrate(650, 900);
  }

  const profilesArray = Array.from(collectedProfiles.values()).slice(0, targetCount);
  const warned = (Date.now() - startTime > maxScanDurationMs) && profilesArray.length < targetCount;

  return {
    success: true,
    profiles: profilesArray,
    totalFound: profilesArray.length,
    warned: warned ? 'Warning: List had few fresh tweets in chosen timeframe after 2 minutes of scanning.' : null
  };
}

// =========================================================================
// AGENT 4: COLLECT ENGAGING NICHE PROFILES (FOLLOWERS INCREASE DISCOVERY)
// =========================================================================
async function collectEngagingNicheProfiles(params = {}) {
  isWorkflowAborted = false;
  const targetCount = Number(params.targetCount || 8);
  const maxScrolls = Number(params.maxScrolls || 16);
  const freshness = params.freshness || '1h';
  const sortBy = params.sortBy || 'active'; // 'active' (highest replies) vs 'recent'
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();

  let freshnessMs = 60 * 60 * 1000;
  if (freshness === '15m') freshnessMs = 15 * 60 * 1000;
  else if (freshness === '30m') freshnessMs = 30 * 60 * 1000;
  else if (freshness === '1h') freshnessMs = 60 * 60 * 1000;
  else if (freshness === '2h') freshnessMs = 2 * 3600 * 1000;
  else if (freshness === '6h') freshnessMs = 6 * 3600 * 1000;
  else if (freshness === '12h') freshnessMs = 12 * 3600 * 1000;
  else if (freshness === '24h') freshnessMs = 24 * 3600 * 1000;
  else if (freshness === '3d') freshnessMs = 3 * 24 * 3600 * 1000;
  else if (freshness === '7d') freshnessMs = 7 * 24 * 3600 * 1000;

  const foundMap = new Map();
  let consecutiveEmptyScrolls = 0;

  for (let s = 0; s < maxScrolls; s++) {
    if (isWorkflowAborted) break;
    const initialSize = foundMap.size;

    // Scrape tweet articles from list timeline
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    for (const art of articles) {
      // Filter out spam / giveaway / weak junk posts
      const text = (art.innerText || '').toLowerCase();
      if (text.includes('airdrop bot') || text.includes('send 0.1 eth') || text.includes('giveaway bot') || text.includes('dm to claim')) {
        continue;
      }

      // Filter out comments / replies strictly
      const artText = (art.innerText || '');
      const hasReplyingText = /replying to/i.test(artText);
      const hasThreadConnector = !!art.querySelector('div[style*="width: 2px"], div[style*="width: 0.125rem"]');
      const hasReplyLink = Array.from(art.querySelectorAll('a, div')).some(el => /replying to/i.test(el.innerText || ''));
      if (hasReplyingText || hasThreadConnector || hasReplyLink) continue;

      const timeEl = art.querySelector('time');
      const timeStr = timeEl ? timeEl.getAttribute('datetime') : null;
      const timestamp = timeStr ? new Date(timeStr).getTime() : Date.now();
      const ageMs = Date.now() - timestamp;
      if (ageMs > freshnessMs) continue;

      let handle = '';
      const userEl = art.querySelector('div[data-testid="User-Name"]');
      if (userEl) {
        const textMatch = (userEl.innerText || '').match(/@([a-zA-Z0-9_]{1,25})/);
        if (textMatch && textMatch[1]) {
          handle = textMatch[1].toLowerCase().trim();
        }
      }

      if (!handle || ['home', 'explore', 'notifications', 'messages', 'i', 'compose'].includes(handle) || handle === loggedInHandle) {
        continue;
      }

      const replyBtn = art.querySelector('button[data-testid="reply"], div[data-testid="reply"]');
      const likeBtn = art.querySelector('button[data-testid="like"], div[data-testid="like"]');
      const repliesCount = extractTwitterMetric(replyBtn);
      const likesCount = extractTwitterMetric(likeBtn);
      const score = (repliesCount * 5) + likesCount + (sortBy === 'recent' ? Math.round(timestamp / 100000000) : 0);

      const existing = foundMap.get(handle);
      if (!existing || score > existing.score) {
        foundMap.set(handle, {
          cleanHandle: handle,
          handle: `@${handle}`,
          name: handle,
          score,
          timestamp,
          repliesCount
        });
      }
    }

    if (foundMap.size >= targetCount * 2) break;

    if (foundMap.size === initialSize) {
      consecutiveEmptyScrolls++;
    } else {
      consecutiveEmptyScrolls = 0;
    }

    // If 5-6 scrolls find no fresh tweets, re-hydrate feed without reloading page
    if (consecutiveEmptyScrolls >= 5) {
      console.log('[ATOMX FOLLOWERS] 5-6 scrolls found no new tweets. Re-hydrating feed...');
      await humanSmoothScroll(-800, { settlePause: 600 });
      consecutiveEmptyScrolls = 0;
      continue;
    }

    await smoothScrollAndHydrate(700, 900);
  }

  const sorted = Array.from(foundMap.values())
    .sort((a, b) => sortBy === 'recent' ? b.timestamp - a.timestamp : b.score - a.score)
    .slice(0, targetCount);

  return { success: true, profiles: sorted, totalFound: sorted.length };
}

// =========================================================================
// AGENT 1: AUDIENCE BUILDER — DISCOVER TOP ENGAGED TWEETS FROM LIST TIMELINE
// Finds highest reply count tweets within timeframe, refreshing after 5-6 scrolls
// =========================================================================
async function discoverTopEngagedListTweets(params = {}) {
  isWorkflowAborted = false;
  const targetCount = Number(params.targetCount || 10);
  const freshness = params.freshness || '2h';
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();

  let freshnessMs = 2 * 3600 * 1000;
  if (freshness === '15m') freshnessMs = 15 * 60 * 1000;
  else if (freshness === '30m') freshnessMs = 30 * 60 * 1000;
  else if (freshness === '1h') freshnessMs = 60 * 60 * 1000;
  else if (freshness === '2h') freshnessMs = 2 * 3600 * 1000;
  else if (freshness === '6h') freshnessMs = 6 * 3600 * 1000;
  else if (freshness === '12h') freshnessMs = 12 * 3600 * 1000;
  else if (freshness === '24h') freshnessMs = 24 * 3600 * 1000;
  else if (freshness === '3d') freshnessMs = 3 * 24 * 3600 * 1000;
  else if (freshness === '7d') freshnessMs = 7 * 24 * 3600 * 1000;

  const topTweetsMap = new Map();
  let consecutiveEmptyScrolls = 0;
  let consecutiveOlderCount = 0;
  const maxScrolls = 50;

  console.log(`[ATOMX AUDIENCE] Scanning full timeframe (${freshness}) for highest engaged tweets...`);

  for (let s = 0; s < maxScrolls; s++) {
    if (isWorkflowAborted) break;

    const stopCheck = await chrome.storage?.local?.get(['atomx_agent_workflow', 'atomx_active_hud']).catch(() => ({}));
    if (stopCheck?.atomx_agent_workflow?.isStopped || stopCheck?.atomx_active_hud?.stateBadge === 'STOPPED' || stopCheck?.atomx_agent_workflow?.active === false) {
      isWorkflowAborted = true;
      break;
    }

    while (isHudWorkflowPaused && !isWorkflowAborted) {
      await sleep(1000);
    }

    const initialCount = topTweetsMap.size;
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    let foundOlderInPass = 0;

    for (const art of articles) {
      if (isWorkflowAborted) break;

      const timeEl = art.querySelector('time');
      const timeStr = timeEl ? timeEl.getAttribute('datetime') : null;
      const timestamp = timeStr ? new Date(timeStr).getTime() : Date.now();
      const ageMs = Date.now() - timestamp;
      if (ageMs > freshnessMs) {
        foundOlderInPass++;
        continue;
      }

      // Filter out comments / replies strictly
      const artText = (art.innerText || '');
      const hasReplyingText = /replying to/i.test(artText);
      const hasThreadConnector = !!art.querySelector('div[style*="width: 2px"], div[style*="width: 0.125rem"]');
      const hasReplyLink = Array.from(art.querySelectorAll('a, div')).some(el => /replying to/i.test(el.innerText || ''));
      if (hasReplyingText || hasThreadConnector || hasReplyLink) continue;

      // STRICT: Root post only, skip retweets / reposts
      const socialContext = art.querySelector('div[data-testid="socialContext"], span[data-testid="socialContext"]');
      const isRetweet = !!socialContext || !!art.querySelector('svg[data-testid="icon-retweet"]') || /reposted|retweeted/i.test(socialContext?.innerText || '') || /reposted|retweeted/i.test(artText.slice(0, 120));
      if (isRetweet) continue;

      const replyBtn = art.querySelector('button[data-testid="reply"], div[data-testid="reply"]');
      const repliesCount = extractTwitterMetric(replyBtn) || 0;

      const statusLink = art.querySelector('a[href*="/status/"]');
      if (!statusLink) continue;
      const href = statusLink.getAttribute('href') || '';
      const fullUrl = href.startsWith('http') ? href : `https://x.com${href}`;

      const tweetData = extractTweetData(art);
      const author = (tweetData.authorHandle || '').replace(/^@/, '').trim();
      if (author && author.toLowerCase() === loggedInHandle) continue;

      if (!topTweetsMap.has(fullUrl)) {
        topTweetsMap.set(fullUrl, {
          url: fullUrl,
          repliesCount,
          author,
          timestamp
        });
      }
    }

    if (topTweetsMap.size === initialCount) {
      consecutiveEmptyScrolls++;
    } else {
      consecutiveEmptyScrolls = 0;
    }

    // If bottom tweets are consistently beyond user's timeframe (after at least 6 scrolls), stop scanning
    if (foundOlderInPass > 5 && s >= 6) {
      consecutiveOlderCount++;
      if (consecutiveOlderCount >= 4) {
        console.log(`[ATOMX AUDIENCE] Reached timeframe boundary (${freshness}). Completed deep scan.`);
        break;
      }
    } else {
      consecutiveOlderCount = 0;
    }

    // Provide live scan progress on HUD
    const maxRepliesFound = Array.from(topTweetsMap.values()).reduce((max, t) => Math.max(max, t.repliesCount || 0), 0);
    updateFloatingHud({
      title: 'CrowdFi',
      stateBadge: 'SCANNING',
      statusText: `Scanning list (${freshness})... Found ${topTweetsMap.size} posts (Highest: ${maxRepliesFound} comments)`
    });

    if (consecutiveEmptyScrolls >= 8) {
      // Reached bottom of timeline without new DOM elements
      break;
    }

    await smoothScrollAndHydrate(650, 900);
  }

  // Filter & prioritize tweets with genuine engagement (avoid 2-3 comment posts)
  const allCandidates = Array.from(topTweetsMap.values());
  const highReplyCandidates = allCandidates.filter(t => t.repliesCount >= 3);
  const filtered = highReplyCandidates.length > 0 ? highReplyCandidates : allCandidates.filter(t => t.repliesCount >= 1);
  const finalCandidates = filtered.length > 0 ? filtered : allCandidates;

  // Sort descending by highest replies count
  const sorted = finalCandidates.sort((a, b) => b.repliesCount - a.repliesCount);

  console.log(`[ATOMX AUDIENCE] Selected ${sorted.length} top engaged list tweets:`, sorted.slice(0, 5));

  return {
    success: true,
    topTweets: sorted,
    aborted: isWorkflowAborted
  };
}

/**
 * Visibly moves virtual cursor to target tweet card and clicks to open its status thread
 */
async function clickAndOpenTargetPost(postUrl, targetAuthor) {
  ensureVirtualCursorActive();
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  let targetArticle = null;

  for (const art of articles) {
    const links = Array.from(art.querySelectorAll('a[href*="/status/"]'));
    if (links.some(a => a.href && postUrl && a.href.includes(postUrl.split('/status/')[1]))) {
      targetArticle = art;
      break;
    }
  }

  if (!targetArticle && targetAuthor) {
    for (const art of articles) {
      const userEl = art.querySelector('div[data-testid="User-Name"]');
      if (userEl && userEl.innerText.toLowerCase().includes(targetAuthor.toLowerCase())) {
        targetArticle = art;
        break;
      }
    }
  }

  if (!targetArticle && articles.length > 0) {
    targetArticle = articles[0];
  }

  if (targetArticle) {
    await humanScrollElementIntoView(targetArticle, 'center');
    await sleep(250);

    const statusLink = targetArticle.querySelector('a[href*="/status/"] time')?.closest('a') ||
                       targetArticle.querySelector('a[href*="/status/"]') ||
                       targetArticle;

    console.log('[ATOMX] Moving virtual cursor to target post and clicking to open...');
    await performHumanClick(statusLink, {
      pulseColor: '#38BDF8',
      scroll: false,
      hoverDwell: 320,
      postPause: 500
    });
    return { success: true, clicked: true };
  }
  return { success: false };
}

// =========================================================================
// AGENT 4: FOLLOWERS INCREASE — DISCOVER TOP ACTIVE/RECENT POSTS FROM LIST
// Scans timeline within timeframe, extracts candidate posts for queue-based execution.
// =========================================================================
async function discoverTopActiveListTweets(params = {}) {
  isWorkflowAborted = false;
  const targetCount = Number(params.targetCount || 8);
  const freshness = params.freshness || '1h';
  const sortPriority = params.sortPriority || 'active'; // 'active' (Most Active) vs 'recent' (Newest First)
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();

  let freshnessMs = 60 * 60 * 1000;
  if (freshness === '15m') freshnessMs = 15 * 60 * 1000;
  else if (freshness === '30m') freshnessMs = 30 * 60 * 1000;
  else if (freshness === '1h') freshnessMs = 60 * 60 * 1000;
  else if (freshness === '2h') freshnessMs = 2 * 3600 * 1000;
  else if (freshness === '6h') freshnessMs = 6 * 3600 * 1000;
  else if (freshness === '12h') freshnessMs = 12 * 3600 * 1000;
  else if (freshness === '24h') freshnessMs = 24 * 3600 * 1000;
  else if (freshness === '3d') freshnessMs = 3 * 24 * 3600 * 1000;
  else if (freshness === '7d') freshnessMs = 7 * 24 * 3600 * 1000;

  const stored = await new Promise(r => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['atomx_follower_engaged_tweets', 'atomx_follower_engaged_history'], r);
    } else r({});
  });
  const engagedTweets = (stored?.atomx_follower_engaged_tweets && typeof stored.atomx_follower_engaged_tweets === 'object')
    ? stored.atomx_follower_engaged_tweets : {};
  const engagedAuthors = (stored?.atomx_follower_engaged_history && typeof stored.atomx_follower_engaged_history === 'object')
    ? stored.atomx_follower_engaged_history : {};

  const isNewest = sortPriority === 'recent';
  const candidateMap = new Map();
  let consecutiveOlderCount = 0;
  let consecutiveEmptyScrolls = 0;
  let skippedCount = 0;
  const maxScanScrolls = isNewest ? 4 : 50;

  console.log(`[ATOMX FOLLOWERS] Collecting posts. Mode: ${isNewest ? 'Newest First' : 'Most Active'}, Target: ${targetCount}`);

  // Ensure tweet articles are rendered on the page
  await waitForElement('article[data-testid="tweet"]', 10000);

  for (let s = 0; s < maxScanScrolls; s++) {
    if (isWorkflowAborted) break;

    const stopCheck = await chrome.storage?.local?.get(['atomx_agent_workflow', 'atomx_active_hud']).catch(() => ({}));
    if (stopCheck?.atomx_agent_workflow?.isStopped || stopCheck?.atomx_active_hud?.stateBadge === 'STOPPED' || stopCheck?.atomx_agent_workflow?.active === false) {
      isWorkflowAborted = true;
      break;
    }

    while (isHudWorkflowPaused && !isWorkflowAborted) {
      await sleep(1000);
    }

    const initialCandidateCount = candidateMap.size;
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    let foundOlderInPass = 0;

    for (const art of articles) {
      if (isWorkflowAborted) break;

      const tweetData = extractTweetData(art);
      const tweetId = tweetData.id || tweetData.tweetUrl;
      const authorHandle = (tweetData.authorHandle || '').replace(/^@/, '').toLowerCase().trim();
      if (!tweetId || !authorHandle) continue;

      // Skip own tweets
      if (authorHandle === loggedInHandle) continue;

      // Check freshness: ONLY enforce for 'active' mode. For 'newest', feed is already sorted newest first!
      const timeEl = art.querySelector('time');
      const timeStr = timeEl ? timeEl.getAttribute('datetime') : null;
      const timestamp = timeStr ? new Date(timeStr).getTime() : Date.now();
      const ageMs = Date.now() - timestamp;
      if (!isNewest && ageMs > freshnessMs) {
        foundOlderInPass++;
        continue;
      }

      // Check already engaged or already liked
      if (engagedTweets[tweetId] || engagedAuthors[authorHandle]) {
        skippedCount++;
        continue;
      }

      const alreadyLiked = art.querySelector('button[data-testid="unlike"]');
      if (alreadyLiked) {
        engagedTweets[tweetId] = Date.now();
        skippedCount++;
        continue;
      }

      // STRICT: Root post only, skip retweets / reposts
      const socialContext = art.querySelector('div[data-testid="socialContext"], span[data-testid="socialContext"]');
      const isRetweet = !!socialContext || !!art.querySelector('svg[data-testid="icon-retweet"]') || /reposted|retweeted/i.test(socialContext?.innerText || '');
      if (isRetweet) continue;

      // STRICT: Root post only, skip replies/comments
      const artText = (art.innerText || '');
      const hasReplyingText = /replying to/i.test(artText);
      const hasThreadConnector = !!art.querySelector('div[style*="width: 2px"], div[style*="width: 0.125rem"]');
      const hasReplyLink = Array.from(art.querySelectorAll('a, div')).some(el => /replying to/i.test(el.innerText || ''));
      if (hasReplyingText || hasThreadConnector || hasReplyLink) continue;

      // Weak & Spam filter
      const tweetText = (tweetData.text || '').trim();
      const words = tweetText.split(/\s+/).filter(Boolean);
      if (tweetText.length < 15 || words.length < 4) continue;
      const lowerText = tweetText.toLowerCase();
      const spamKeywords = [
        'airdrop', 'send 0.1 eth', 'send eth', 'giveaway bot', 'dm to claim',
        'presale', 'free mint', 'claim your free', 'airdrop bot', 'pump',
        'drop wallet', 'drop address', 'whitelist slot'
      ];
      if (spamKeywords.some(kw => lowerText.includes(kw))) continue;

      // Extract replies count
      const replyBtn = art.querySelector('button[data-testid="reply"], div[data-testid="reply"]');
      const repliesCount = extractTwitterMetric(replyBtn) || 0;

      const statusLink = art.querySelector('a[href*="/status/"]');
      let tweetUrl = statusLink ? (statusLink.getAttribute('href') || '') : '';
      if (tweetUrl && !tweetUrl.startsWith('http')) tweetUrl = `https://x.com${tweetUrl}`;
      if (!tweetUrl && authorHandle && tweetId) tweetUrl = `https://x.com/${authorHandle}/status/${tweetId}`;

      if (!candidateMap.has(tweetId)) {
        candidateMap.set(tweetId, {
          tweetUrl,
          tweetId,
          authorHandle,
          authorName: tweetData.authorName || authorHandle,
          text: tweetText,
          repliesCount,
          timestamp,
          ageMs
        });

        // Fast exit inside pass if newest first and target count + reserve buffer reached
        if (isNewest && candidateMap.size >= targetCount + 3) {
          break;
        }
      }
    }

    // Fast exit if newest first and target posts reached
    if (isNewest && candidateMap.size >= targetCount) {
      console.log(`[ATOMX FOLLOWERS] Found ${candidateMap.size} newest posts directly from top of timeline. Scan complete.`);
      updateFloatingHud({
        title: 'GrowthFi',
        agentId: 'followers',
        stateBadge: 'ENGAGING',
        statusText: `Selected top ${Math.min(candidateMap.size, targetCount)} newest posts. Starting engagement...`,
        skipped: skippedCount
      });
      break;
    }

    if (candidateMap.size === initialCandidateCount) {
      consecutiveEmptyScrolls++;
    } else {
      consecutiveEmptyScrolls = 0;
    }

    // Timeframe cutoff guard: Give active mode enough scrolls (at least 6 scrolls) and demand consistent older tweets
    if (!isNewest && foundOlderInPass >= 8 && scrollPass >= 6) {
      consecutiveOlderCount++;
      if (consecutiveOlderCount >= 4) {
        console.log(`[ATOMX FOLLOWERS] Reached timeframe boundary (${freshness}) after ${scrollPass} scrolls. Deep scan complete.`);
        break;
      }
    } else {
      consecutiveOlderCount = 0;
    }

    if (isNewest) {
      updateFloatingHud({
        title: 'GrowthFi',
        agentId: 'followers',
        stateBadge: 'ENGAGING',
        statusText: `Getting newest posts... Found ${candidateMap.size}/${targetCount}`,
        skipped: skippedCount
      });
    } else {
      const maxReplies = Array.from(candidateMap.values()).reduce((m, c) => Math.max(m, c.repliesCount || 0), 0);
      updateFloatingHud({
        title: 'GrowthFi',
        agentId: 'followers',
        stateBadge: 'SCANNING',
        statusText: `Scanning list (${freshness})... Found ${candidateMap.size} posts (Highest: ${maxReplies} comments)`,
        skipped: skippedCount
      });
    }

    if (consecutiveEmptyScrolls >= 5) break;
    await smoothScrollAndHydrate(600, 800);
  }

  const allCandidates = Array.from(candidateMap.values());
  let sorted = [];
  if (sortPriority === 'active') {
    sorted = allCandidates.sort((a, b) => b.repliesCount - a.repliesCount);
  } else {
    sorted = allCandidates.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  console.log(`[ATOMX FOLLOWERS] Discovered ${sorted.length} unengaged candidate posts (${skippedCount} skipped from top).`);

  return {
    success: true,
    topTweets: sorted,
    skippedCount,
    aborted: isWorkflowAborted
  };
}

// =========================================================================
// AGENT 4: FOLLOWERS INCREASE — DIRECT TIMELINE ENGAGEMENT ENGINE
// Engages directly on the List's recent posts (not comments) within timeframe.
// Skips weak tweets (< 15 chars, < 4 words, spam keywords).
// Auto-refreshes list if 5-6 scrolls yield no new tweets.
// =========================================================================
async function executeFollowersListCycle(params = {}) {
  isWorkflowAborted = false;
  const targetCount = Number(params.targetCount || 8);
  const freshness = params.freshness || '1h';
  const sortPriority = params.sortPriority || 'active'; // 'active' (Most Active) vs 'recent' (Newest Tweets First)
  const likePosts = params.likePosts !== false;
  const replyPosts = params.replyPosts !== false;
  const repostPosts = params.repostPosts === true;
  const autoFollow = params.autoFollow !== false;
  const style = params.style || 'Natural & Concise';
  const stylePrompt = params.stylePrompt || null;
  const backendUrl = (params.backendUrl || 'https://twixor.onrender.com').replace(/\/+$/, '');
  const loggedInHandle = (getLoggedInUserHandle() || '').toLowerCase().replace(/^@/, '').trim();

  let freshnessMs = 60 * 60 * 1000;
  if (freshness === '15m') freshnessMs = 15 * 60 * 1000;
  else if (freshness === '30m') freshnessMs = 30 * 60 * 1000;
  else if (freshness === '1h') freshnessMs = 60 * 60 * 1000;
  else if (freshness === '2h') freshnessMs = 2 * 3600 * 1000;
  else if (freshness === '6h') freshnessMs = 6 * 3600 * 1000;
  else if (freshness === '12h') freshnessMs = 12 * 3600 * 1000;
  else if (freshness === '24h') freshnessMs = 24 * 3600 * 1000;
  else if (freshness === '3d') freshnessMs = 3 * 24 * 3600 * 1000;
  else if (freshness === '7d') freshnessMs = 7 * 24 * 3600 * 1000;

  const stored = await new Promise(r => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get(['atomx_follower_engaged_tweets', 'atomx_follower_engaged_history', 'atomx_safety_settings'], r);
    } else r({});
  });
  const engagedTweets = (stored?.atomx_follower_engaged_tweets && typeof stored.atomx_follower_engaged_tweets === 'object')
    ? stored.atomx_follower_engaged_tweets : {};
  const engagedAuthors = (stored?.atomx_follower_engaged_history && typeof stored.atomx_follower_engaged_history === 'object')
    ? stored.atomx_follower_engaged_history : {};
  const safety = stored?.atomx_safety_settings || {};
  let engagedCount = 0;
  let skippedCount = 0;
  let lastBreakEngagedCount = 0;
  let nextBreakInterval = 0;
  const processedTweetIds = new Set();

  console.log(`[ATOMX FOLLOWERS] Starting Followers Increase engine. Mode: ${sortPriority === 'active' ? 'Most Active' : 'Newest First'}, Target: ${targetCount}, Freshness: ${freshness}`);

  // Helper: Execute engagement actions on a single tweet element
  async function performActionsOnTweet(art, tweetData, tweetId, authorHandle) {
    try {
      const skipCheckFollowers = await chrome.storage.local.get(['atomx_skip_current']).catch(() => ({}));
    if (skipCheckFollowers?.atomx_skip_current || isWorkflowItemSkipped) {
      isWorkflowItemSkipped = false;
      closeAnyOpenTwitterDialog();
      await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
      skippedCount++;
      updateFloatingHud({
        skipped: skippedCount,
        statusText: `Skipped @${authorHandle || 'user'}'s post. Moving to next...`
      });
      await humanSmoothScroll(500, { settlePause: 350 });
      return;
    }

    // Global Rule: Scroll post into center of screen and ensure visible before acting
    await scrollElementIntoViewAndEnsureVisible(art, 'center');
    await sleep(350);

    if (isWorkflowItemSkipped) {
      isWorkflowItemSkipped = false;
      closeAnyOpenTwitterDialog();
      await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
      skippedCount++;
      updateFloatingHud({
        skipped: skippedCount,
        statusText: `Skipped @${authorHandle || 'user'}'s post. Moving to next...`
      });
      await humanSmoothScroll(500, { settlePause: 350 });
      return;
    }

    // Global Rule: If post is already liked, auto-skip immediately!
    if (isPostAlreadyLiked(art)) {
      console.log(`[ATOMX FOLLOWERS] Post by @${authorHandle || 'user'} is already liked. Auto-skipping as per global rule.`);
      skippedCount++;
      updateFloatingHud({
        skipped: skippedCount,
        statusText: `Post by @${authorHandle || 'user'} already liked. Auto-skipping to next...`
      });
      await humanSmoothScroll(500, { settlePause: 350 });
      return;
    }

    // DYNAMIC SYNC: Re-read latest user action toggles from storage in case user paused & changed settings in popup
    const latestSync = await chrome.storage.local.get(['atomx_follower_settings', 'atomx_agent_workflow']).catch(() => ({}));
    const dynamicOpts = latestSync?.atomx_agent_workflow?.options || latestSync?.atomx_follower_settings || {};
    const actLike = typeof dynamicOpts.likePosts === 'boolean' ? dynamicOpts.likePosts : likePosts;
    const actReply = typeof dynamicOpts.replyPosts === 'boolean' ? dynamicOpts.replyPosts : replyPosts;
    const actRepost = typeof dynamicOpts.repostPosts === 'boolean' ? dynamicOpts.repostPosts : repostPosts;
    const actFollow = typeof dynamicOpts.autoFollow === 'boolean' ? dynamicOpts.autoFollow : autoFollow;

    // Respect pause before engaging
    while (isHudWorkflowPaused && !isWorkflowAborted && !isWorkflowItemSkipped) {
      await sleep(500);
    }
    if (isWorkflowAborted || isWorkflowItemSkipped) return;

    const statusMsg = `Engaging post [${engagedCount + 1}/${targetCount}] by @${authorHandle || 'user'}...`;
    updateFloatingHud({
      title: 'GrowthFi',
      stateBadge: 'ENGAGING',
      indicator: `${engagedCount}/${targetCount}`,
      done: engagedCount,
      collected: targetCount,
      skipped: skippedCount,
      progressPercent: Math.round((engagedCount / targetCount) * 100),
      statusText: statusMsg,
      nextAction: `Post [${Math.min(engagedCount + 1, targetCount)}/${targetCount}]`
    });

    // 1. ❤️ Like
    if (actLike && !isWorkflowAborted) {
      if (isWorkflowItemSkipped) {
        isWorkflowItemSkipped = false;
        closeAnyOpenTwitterDialog();
        await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
        skippedCount++;
        await humanSmoothScroll(500, { settlePause: 350 });
        return;
      }
      await simulateHumanLikeClick(art);
      await sleep(400);
    }

    // 2. 🔁 Repost
    if (actRepost && !isWorkflowAborted) {
      if (isWorkflowItemSkipped) {
        isWorkflowItemSkipped = false;
        closeAnyOpenTwitterDialog();
        await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
        skippedCount++;
        await humanSmoothScroll(500, { settlePause: 350 });
        return;
      }
      await simulateHumanRepostClick(art);
      await sleep(400);
    }

    // 3. 💬 Comment
    if (actReply && !isWorkflowAborted) {
      if (isWorkflowItemSkipped) {
        isWorkflowItemSkipped = false;
        closeAnyOpenTwitterDialog();
        await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
        skippedCount++;
        await humanSmoothScroll(500, { settlePause: 350 });
        return;
      }
      const tweetText = (tweetData.text || '').trim();
      let replyContent = '';
      try {
        const aiRes = await chrome.runtime.sendMessage({
          type: 'GENERATE_INLINE_REPLY',
          tweetText,
          tweetAuthor: `@${authorHandle}`,
          tweetAuthorName: tweetData.authorName || authorHandle,
          style,
          stylePrompt
        });
        if (aiRes?.reply) replyContent = aiRes.reply.trim();
      } catch (e) {
        console.warn('[ATOMX FOLLOWERS] AI reply error:', e);
      }

      if (!replyContent) {
        replyContent = twxPickFallbackComment();
      }

      replyContent = sanitizeClientComment(replyContent, extractMaxWordsFromPrompt(params?.stylePrompt || params?.style || stylePrompt || style));
      if (replyContent && !isWorkflowAborted) {
        if (isWorkflowItemSkipped) {
          isWorkflowItemSkipped = false;
          closeAnyOpenTwitterDialog();
          await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
          skippedCount++;
          await humanSmoothScroll(500, { settlePause: 350 });
          return;
        }
        const comRes = await postCommentOnTargetArticle(art, replyContent);
        if (comRes?.skipped || isWorkflowItemSkipped) {
          isWorkflowItemSkipped = false;
          await clearAnyDraftComment();
          art.setAttribute('data-atomx-skipped', 'true');
          art.setAttribute('data-atomx-engaged', 'true');
          if (tweetId) {
            engagedTweets[tweetId] = Date.now();
            await chrome.storage?.local?.set({ atomx_follower_engaged_tweets: engagedTweets, atomx_skip_current: false }).catch(() => null);
          } else {
            await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
          }
          skippedCount++;
          await humanSmoothScroll(500, { settlePause: 350 });
          return;
        }
        if (comRes?.commentsRestricted) {
          console.log(`[ATOMX FOLLOWERS] Comments restricted on post by @${authorHandle || 'user'}. Modal closed.`);
          updateFloatingHud({
            statusText: `Comments restricted for @${authorHandle || 'user'}. Continuing...`
          });
          dismissAnyTwitterModal();
        }
        await sleep(600);
      }
    }

    // 4. ➕ Follow author
    if (actFollow && authorHandle && !isWorkflowAborted) {
      if (isWorkflowItemSkipped) {
        isWorkflowItemSkipped = false;
        closeAnyOpenTwitterDialog();
        await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
        await humanSmoothScroll(500, { settlePause: 350 });
        return;
      }
      updateFloatingHud({
        statusText: `Following author @${authorHandle}...`
      });
      await performFollowOnTweetAuthor(art, authorHandle);
      await sleep(400);
    }

    engagedCount++;
    engagedTweets[tweetId] = Date.now();
    if (authorHandle) engagedAuthors[authorHandle] = Date.now();

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({
        atomx_follower_engaged_tweets: engagedTweets,
        atomx_follower_engaged_history: engagedAuthors
      }).catch(() => null);
    }

    updateFloatingHud({
      title: 'GrowthFi',
      stateBadge: engagedCount >= targetCount ? 'DONE' : 'ENGAGING',
      indicator: `${engagedCount}/${targetCount}`,
      done: engagedCount,
      collected: targetCount,
      skipped: skippedCount,
      progressPercent: Math.round((engagedCount / targetCount) * 100),
      statusText: `✓ Engaged [${engagedCount}/${targetCount}] on @${authorHandle || 'user'}'s post`,
      nextAction: engagedCount >= targetCount ? 'Workflow Completed' : `Post [${engagedCount + 1}/${targetCount}]`
    });

    if (engagedCount >= targetCount || isWorkflowAborted) return;

    // Dynamically retrieve user's latest Safety Settings (Profile Wait & Batch Rest)
    const curSafetyRes = await chrome.storage?.local?.get(['atomx_safety_settings']).catch(() => ({}));
    const curSafety = curSafetyRes?.atomx_safety_settings || safety || {};

    // 1. Check for Batch Rest Break (Take Break After X actions)
    let bMin = curSafety.breakActionsMin !== undefined ? Number(curSafety.breakActionsMin) : (curSafety.breakActions || 35);
    let bMax = curSafety.breakActionsMax !== undefined ? Number(curSafety.breakActionsMax) : (curSafety.breakActions || 40);
    if (bMin > bMax) [bMin, bMax] = [bMax, bMin];
    if (nextBreakInterval <= 0 && (bMin > 0 || bMax > 0)) {
      nextBreakInterval = Math.floor(bMin + Math.random() * (bMax - bMin + 1));
    }
    const actionsSinceBreak = engagedCount - lastBreakEngagedCount;
    const isBatchBreak = (bMin > 0 || bMax > 0) && (engagedCount > 0) && (nextBreakInterval > 0) && (actionsSinceBreak >= nextBreakInterval);
    if (isBatchBreak) {
      lastBreakEngagedCount = engagedCount;
      nextBreakInterval = Math.floor(bMin + Math.random() * (bMax - bMin + 1));
    }

    let waitSec = 0;
    if (isBatchBreak) {
      let rdMin = curSafety.restDurationMin !== undefined ? Number(curSafety.restDurationMin) : (curSafety.restDuration || 10);
      let rdMax = curSafety.restDurationMax !== undefined ? Number(curSafety.restDurationMax) : (curSafety.restDuration || 15);
      if (rdMin > rdMax) [rdMin, rdMax] = [rdMax, rdMin];
      waitSec = Math.floor(rdMin * 60 + Math.random() * ((rdMax - rdMin) * 60 + 1));
    } else {
      // 2. Profile Wait (Between Accounts): strictly obey the user's slider setting (e.g. 0-5s)
      let pMin = curSafety.profileWaitMin !== undefined ? Number(curSafety.profileWaitMin) : (curSafety.profileWait !== undefined ? Math.max(0, Number(curSafety.profileWait) - 2) : 0);
      let pMax = curSafety.profileWaitMax !== undefined ? Number(curSafety.profileWaitMax) : (curSafety.profileWait !== undefined ? Number(curSafety.profileWait) : 5);
      if (pMin > pMax) [pMin, pMax] = [pMax, pMin];
      waitSec = Math.floor(pMin + Math.random() * (pMax - pMin + 1));
    }

    if (waitSec > 0) {
      for (let sec = waitSec; sec > 0 && !isWorkflowAborted; sec--) {
        const check = await chrome.storage?.local?.get(['atomx_agent_workflow', 'atomx_active_hud', 'atomx_skip_current']).catch(() => ({}));
        if (check?.atomx_agent_workflow?.active === false || check?.atomx_agent_workflow?.isStopped || check?.atomx_active_hud?.isStopped || check?.atomx_active_hud?.stateBadge === 'STOPPED') {
          isWorkflowAborted = true;
          break;
        }
        if (isWorkflowItemSkipped || check?.atomx_skip_current) {
          isWorkflowItemSkipped = false;
          closeAnyOpenTwitterDialog();
          await chrome.storage?.local?.set({ atomx_skip_current: false }).catch(() => null);
          console.log('[ATOMX FOLLOWERS] Skip signal received during pacing delay. Advancing to next post.');
          break;
        }
        updateFloatingHud({
          stateBadge: isBatchBreak ? 'BATCH_BREAK' : 'ENGAGING',
          nextAction: isBatchBreak ? `Batch Rest (${Math.ceil(sec / 60)}m left)` : `Post [${Math.min(engagedCount + 1, targetCount)}/${targetCount}]`,
          countdownText: isBatchBreak ? `☕ Batch Rest cooldown: ${Math.ceil(sec / 60)}m...` : `⏱️ Next post in ${sec}s...`,
          timerBadge: isBatchBreak ? `☕ ${Math.ceil(sec / 60)}m` : `⏱️ ${sec}s`
        });
        await sleep(1000);
        if (isWorkflowAborted) break;
      }
    }
  } catch (actErr) {
    console.warn(`[ATOMX FOLLOWERS] Error engaging tweet ${tweetId || ''}:`, actErr);
    skippedCount++;
  }
}

  // =========================================================================
  // STRATEGY 1: "MOST ACTIVE" (Sort by highest replies within timeframe)
  // =========================================================================
  if (sortPriority === 'active') {
    const candidateMap = new Map();
    let consecutiveOlderCount = 0;
    let consecutiveEmptyScrolls = 0;
    const maxScanScrolls = 50;

    for (let s = 0; s < maxScanScrolls; s++) {
      if (isWorkflowAborted) break;

      const stopCheck = await chrome.storage?.local?.get(['atomx_agent_workflow', 'atomx_active_hud']).catch(() => ({}));
      if (stopCheck?.atomx_agent_workflow?.isStopped || stopCheck?.atomx_active_hud?.stateBadge === 'STOPPED' || stopCheck?.atomx_agent_workflow?.active === false) {
        isWorkflowAborted = true;
        break;
      }

      while (isHudWorkflowPaused && !isWorkflowAborted && !isWorkflowItemSkipped) {
        await sleep(500);
      }

      const initialCandidateCount = candidateMap.size;
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      let foundOlderInPass = 0;

      for (const art of articles) {
        if (isWorkflowAborted) break;

        const tweetData = extractTweetData(art);
        const tweetId = tweetData.id || tweetData.tweetUrl;
        const authorHandle = (tweetData.authorHandle || '').replace(/^@/, '').toLowerCase().trim();
        if (!tweetId) continue;

        // Skip own tweets
        if (authorHandle && authorHandle === loggedInHandle) continue;

        // Check freshness
        const timeEl = art.querySelector('time');
        const timeStr = timeEl ? timeEl.getAttribute('datetime') : null;
        const timestamp = timeStr ? new Date(timeStr).getTime() : Date.now();
        const ageMs = Date.now() - timestamp;
        if (ageMs > freshnessMs) {
          foundOlderInPass++;
          continue;
        }

        // Already engaged -> Skip and keep scrolling
        if (engagedTweets[tweetId]) {
          if (!processedTweetIds.has(tweetId)) {
            processedTweetIds.add(tweetId);
            skippedCount++;
          }
          continue;
        }

        if (isPostAlreadyLiked(art)) {
          engagedTweets[tweetId] = Date.now();
          if (!processedTweetIds.has(tweetId)) {
            processedTweetIds.add(tweetId);
            skippedCount++;
          }
          continue;
        }

        // STRICT: Root post only, skip retweets / reposts
        const socialContext = art.querySelector('div[data-testid="socialContext"], span[data-testid="socialContext"]');
        const isRetweet = !!socialContext || !!art.querySelector('svg[data-testid="icon-retweet"]') || /reposted|retweeted/i.test(socialContext?.innerText || '');
        if (isRetweet) continue;

        // STRICT: Root post only, skip replies/comments
        const artText = (art.innerText || '');
        const hasReplyingText = /replying to/i.test(artText);
        const hasThreadConnector = !!art.querySelector('div[style*="width: 2px"], div[style*="width: 0.125rem"]');
        const hasReplyLink = Array.from(art.querySelectorAll('a, div')).some(el => /replying to/i.test(el.innerText || ''));
        if (hasReplyingText || hasThreadConnector || hasReplyLink) continue;

        // Weak & Spam filter
        const tweetText = (tweetData.text || '').trim();
        const words = tweetText.split(/\s+/).filter(Boolean);
        if (tweetText.length < 15 || words.length < 4) continue;
        const lowerText = tweetText.toLowerCase();
        const spamKeywords = [
          'airdrop', 'send 0.1 eth', 'send eth', 'giveaway bot', 'dm to claim',
          'presale', 'free mint', 'claim your free', 'airdrop bot', 'pump',
          'drop wallet', 'drop address', 'whitelist slot'
        ];
        if (spamKeywords.some(kw => lowerText.includes(kw))) continue;

        // Extract replies count
        const replyBtn = art.querySelector('button[data-testid="reply"], div[data-testid="reply"]');
        const repliesCount = extractTwitterMetric(replyBtn) || 0;

        if (!candidateMap.has(tweetId)) {
          candidateMap.set(tweetId, {
            art,
            tweetData,
            tweetId,
            authorHandle,
            repliesCount,
            timestamp,
            ageMs
          });
        }
      }

      if (candidateMap.size === initialCandidateCount) {
        consecutiveEmptyScrolls++;
      } else {
        consecutiveEmptyScrolls = 0;
      }

      // Timeframe cutoff guard: Give active mode enough scrolls (at least 6 scrolls) and demand consistent older tweets
      if (foundOlderInPass >= 8 && s >= 6) {
        consecutiveOlderCount++;
        if (consecutiveOlderCount >= 4) {
          console.log(`[ATOMX FOLLOWERS] Reached timeframe boundary (${freshness}) after ${s} scrolls. Scan complete.`);
          break;
        }
      } else {
        consecutiveOlderCount = 0;
      }

      updateFloatingHud({
        title: 'GrowthFi',
        stateBadge: 'SCANNING',
        statusText: `Scanning (${freshness}). Found ${candidateMap.size} unengaged posts (${skippedCount} skipped)...`,
        skipped: skippedCount
      });

      if (consecutiveEmptyScrolls >= 8) break;
      await smoothScrollAndHydrate(700, 1000);
    }

    if (candidateMap.size === 0 && !isWorkflowAborted) {
      console.log(`[ATOMX FOLLOWERS] No unengaged posts found in timeframe (${freshness}).`);
      const emptyMsg = `No unengaged posts found in selected timeframe (${freshness}).`;
      updateFloatingHud({
        title: 'GrowthFi',
        stateBadge: 'DONE',
        statusText: emptyMsg,
        timerBadge: '✓ Finished',
        done: 0,
        collected: targetCount,
        skipped: skippedCount,
        progressPercent: 100,
        countdownText: ''
      });
      return {
        success: true,
        engagedCount: 0,
        targetCount,
        emptyTimeframe: true,
        statusText: emptyMsg,
        aborted: false
      };
    }

    // Sort descending by highest replies count
    const rankedCandidates = Array.from(candidateMap.values())
      .sort((a, b) => b.repliesCount - a.repliesCount)
      .slice(0, targetCount);

    console.log(`[ATOMX FOLLOWERS] Engaging top ${rankedCandidates.length} most active posts:`, rankedCandidates);

    for (const item of rankedCandidates) {
      if (engagedCount >= targetCount || isWorkflowAborted) break;
      let targetArt = (item.art && item.art.isConnected) ? item.art : null;
      if (!targetArt) {
        targetArt = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).find(a => {
          const d = extractTweetData(a);
          return (d.tweetId && d.tweetId === item.tweetId) || (item.tweetId && a.innerHTML.includes(item.tweetId));
        });
      }
      if (!targetArt) {
        if (window.scrollY > 0) {
          await humanSmoothScroll(-window.scrollY, { settlePause: 400 });
        }
        for (let pass = 0; pass < 20 && !targetArt; pass++) {
          if (isWorkflowAborted) break;
          targetArt = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).find(a => {
            const d = extractTweetData(a);
            return (d.tweetId && d.tweetId === item.tweetId) || (item.tweetId && a.innerHTML.includes(item.tweetId));
          });
          if (targetArt) break;
          await humanSmoothScroll(650, { settlePause: 350 });
        }
      }
      if (!targetArt) {
        console.warn(`[ATOMX FOLLOWERS] Candidate tweet ${item.tweetId} not found in DOM after search. Skipping.`);
        skippedCount++;
        continue;
      }
      await performActionsOnTweet(targetArt, item.tweetData, item.tweetId, item.authorHandle);
    }
  }

  // =========================================================================
  // STRATEGY 2: "NEWEST TWEETS FIRST" (Chronological downward engagement from top)
  // Engages directly on timeline cards from top to bottom until targetCount is met.
  // Skips already-engaged posts and advances to next post down.
  // =========================================================================
  else {
    const maxRecentScrolls = 75;
    let consecutiveEmptyScrolls = 0;

    for (let s = 0; s < maxRecentScrolls; s++) {
      if (isWorkflowAborted || engagedCount >= targetCount) break;

      const stopCheck = await chrome.storage?.local?.get(['atomx_agent_workflow', 'atomx_active_hud']).catch(() => ({}));
      if (stopCheck?.atomx_agent_workflow?.isStopped || stopCheck?.atomx_active_hud?.stateBadge === 'STOPPED' || stopCheck?.atomx_agent_workflow?.active === false) {
        isWorkflowAborted = true;
        break;
      }

      while (isHudWorkflowPaused && !isWorkflowAborted && !isWorkflowItemSkipped) {
        await sleep(500);
      }

      const initialEngaged = engagedCount;
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      let foundNewInPass = 0;

      for (const art of articles) {
        if (isWorkflowAborted || engagedCount >= targetCount) break;

        const tweetData = extractTweetData(art);
        const tweetId = tweetData.tweetId || tweetData.id || tweetData.tweetUrl;
        const authorHandle = (tweetData.authorHandle || '').replace(/^@/, '').toLowerCase().trim();

        if (!tweetId || processedTweetIds.has(tweetId)) continue;
        processedTweetIds.add(tweetId);
        foundNewInPass++;

        // Skip own tweets
        if (authorHandle && authorHandle === loggedInHandle) continue;

        // Skip if already engaged on this tweet -> Skip and advance to next post down!
        const isEngagedAlready = engagedTweets[tweetId] || (tweetData.tweetUrl && engagedTweets[tweetData.tweetUrl]) || (tweetData.tweetId && engagedTweets[tweetData.tweetId]);
        if (isEngagedAlready) {
          skippedCount++;
          updateFloatingHud({
            skipped: skippedCount,
            statusText: `Skipping already engaged post by @${authorHandle || 'user'}... Continuing down...`
          });
          continue;
        }

        if (isPostAlreadyLiked(art)) {
          engagedTweets[tweetId] = Date.now();
          skippedCount++;
          updateFloatingHud({
            skipped: skippedCount,
            statusText: `Skipping already liked post by @${authorHandle || 'user'}... Continuing down...`
          });
          continue;
        }

        // STRICT: Root posts only (skip retweets/reposts in timeline)
        const socialContext = art.querySelector('div[data-testid="socialContext"], span[data-testid="socialContext"]');
        const isRetweet = !!socialContext || !!art.querySelector('svg[data-testid="icon-retweet"]') || /reposted|retweeted/i.test(socialContext?.innerText || '');
        if (isRetweet) continue;

        // STRICT: Root posts only (skip comments/replies in timeline)
        const artText = (art.innerText || '');
        const hasReplyingText = /replying to/i.test(artText);
        const hasThreadConnector = !!art.querySelector('div[style*="width: 2px"], div[style*="width: 0.125rem"]');
        const hasReplyLink = Array.from(art.querySelectorAll('a, div')).some(el => /replying to/i.test(el.innerText || ''));
        if (hasReplyingText || hasThreadConnector || hasReplyLink) continue;

        // Filter out spam
        const tweetText = (tweetData.text || '').trim();
        const words = tweetText.split(/\s+/).filter(Boolean);
        if (tweetText.length < 10 || words.length < 3) continue;
        const lowerText = tweetText.toLowerCase();
        const spamKeywords = [
          'airdrop bot', 'send 0.1 eth', 'send eth', 'giveaway bot', 'dm to claim',
          'presale', 'free mint', 'claim your free', 'drop wallet', 'drop address', 'whitelist slot'
        ];
        if (spamKeywords.some(kw => lowerText.includes(kw))) continue;

        // QUALIFYING RECENT POST FROM TOP FOUND — ENGAGE DIRECTLY ON TIMELINE CARD!
        console.log(`[ATOMX FOLLOWERS] Engaging post [${engagedCount + 1}/${targetCount}] by @${authorHandle || 'user'}`);
        await performActionsOnTweet(art, tweetData, tweetId, authorHandle);
      }

      if (engagedCount >= targetCount) break;

      if (foundNewInPass > 0 || engagedCount > initialEngaged) {
        consecutiveEmptyScrolls = 0;
      } else {
        consecutiveEmptyScrolls++;
      }

      if (consecutiveEmptyScrolls >= 12) {
        console.log('[ATOMX FOLLOWERS] Reached end of scrollable feed.');
        break;
      }

      // Smooth scroll down to bring next tweets into view
      await smoothScrollAndHydrate(850, 1000);
    }

    if (engagedCount === 0 && !isWorkflowAborted) {
      console.log(`[ATOMX FOLLOWERS] No unengaged posts found in current feed.`);
      const emptyMsg = `No unengaged posts found in current list feed.`;
      updateFloatingHud({
        title: 'GrowthFi',
        stateBadge: 'DONE',
        statusText: emptyMsg,
        timerBadge: '✓ Finished',
        done: 0,
        collected: targetCount,
        skipped: skippedCount,
        progressPercent: 100,
        countdownText: ''
      });
      return {
        success: true,
        engagedCount: 0,
        targetCount,
        emptyTimeframe: true,
        statusText: emptyMsg,
        aborted: false
      };
    }
  }

  if (isWorkflowAborted) {
    updateFloatingHud({
      stateBadge: 'STOPPED',
      statusText: 'Workflow stopped by user.',
      timerBadge: '🛑 Stopped',
      countdownText: '',
      isStopped: true,
      active: false
    });
  }

  return {
    success: true,
    engagedCount,
    targetCount,
    aborted: isWorkflowAborted
  };
}

// =========================================================================
// AGENT 13: COMMENTER RECIPROCATOR PROFILE ENGAGEMENT ENGINE
// =========================================================================
async function executeReciprocalProfileEngagement(params = {}) {
  isWorkflowAborted = false;

  // 1-to-1 Verified Account Enforcement
  if (params.verifiedXHandle) {
    const lockCheck = await verifyAccountLockOrAbort(params.verifiedXHandle);
    if (!lockCheck.ok) {
      return {
        success: false,
        error: lockCheck.error,
        unauthorizedAccount: true
      };
    }
  }

  const targetHandle = (params.handle || '').replace(/^@/, '').trim();
  const likePost = params.likePost !== false;
  const followUser = !!params.followUser;
  const style = params.style || 'Natural & Concise';
  const stylePrompt = params.stylePrompt || null;
  const backendUrl = (params.backendUrl || 'https://twixor.onrender.com').replace(/\/+$/, '');

  let likeDone = false;
  let replyDone = false;
  let followDone = false;
  let replyText = '';
  let tweetUrl = '';

  try {
    // 1. Optional Follow user right at top of their profile while header & avatar are in full view
    if (followUser) {
      const followButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const followBtn = followButtons.find(b => {
        const txt = (b.innerText || '').trim();
        const testId = b.getAttribute('data-testid') || '';
        return (txt === 'Follow' || testId.endsWith('-follow')) && !txt.includes('Following') && !testId.includes('unfollow');
      });
      if (followBtn) {
        await simulateHumanFollowClick(followBtn);
        followDone = true;
        await sleep(400);
      }
    }

    // 2. Smoothly scroll past profile header/bio to reveal recent posts
    await humanSmoothScroll(550, { settlePause: 400 });

    // 3. Find recent tweets, skip pinned tweets
    let allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (allArticles.length === 0) {
      await humanSmoothScroll(450, { settlePause: 400 });
      allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    }

    if (allArticles.length === 0) {
      return { success: false, reason: 'NO_POSTS_FOUND', error: 'No posts found on this user profile' };
    }

    const nonPinnedArticles = allArticles.filter(art => {
      const socialCtx = art.querySelector('div[data-testid="socialContext"]')?.innerText?.toLowerCase() || '';
      return !socialCtx.includes('pinned') && !socialCtx.includes('pin');
    });

    const targetArticle = nonPinnedArticles[0] || allArticles[0];
    if (!targetArticle) {
      return { success: false, reason: 'NO_TARGET_POST', error: 'Could not select target post' };
    }

    // Gently scroll target post into view without jerking
    await gentleScrollIntoView(targetArticle);
    await sleep(400);

    if (isWorkflowAborted) return { success: false, aborted: true };

    const tweetData = extractTweetData(targetArticle);
    const tweetText = tweetData.text || '';
    tweetUrl = tweetData.tweetUrl || '';

    // 4. Like the target post
    if (likePost) {
      const ok = await simulateHumanLikeClick(targetArticle);
      if (ok) {
        likeDone = true;
        await sleep(500);
      }
    }

    if (isWorkflowAborted) return { success: false, aborted: true, likeDone };

    // 5. Generate contextual AI reply for this commenter's post
    try {
      const aiRes = await chrome.runtime.sendMessage({
        type: 'GENERATE_AI_REPLY',
        tweetText: tweetText || 'Great post!',
        tweetAuthor: `@${targetHandle}`,
        style,
        stylePrompt
      });
      if (aiRes?.success && aiRes.reply) {
        replyText = aiRes.reply.trim();
      }
    } catch (e) {}

    if (!replyText) {
      try {
        const stored = (typeof chrome !== 'undefined' && chrome.storage?.local)
          ? await chrome.storage.local.get(['currentUser', 'user', 'verifiedXHandle']).catch(() => ({}))
          : {};
        const uHandle = stored?.verifiedXHandle || stored?.currentUser?.handle || stored?.user?.handle || '@user';
        const uEmail = stored?.currentUser?.email || stored?.user?.email || '';
        const uId = stored?.currentUser?.id || stored?.user?.id || null;

        const directRes = await fetch(`${backendUrl}/api/generate-reply`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-user-handle': uHandle,
            'x-user-id': uId ? String(uId) : '1'
          },
          body: JSON.stringify({
            tweetText: tweetText || 'Great post!',
            tweetAuthor: `@${targetHandle}`,
            style,
            stylePrompt,
            userHandle: uHandle,
            userEmail: uEmail,
            userId: uId
          })
        }).then(r => r.json()).catch(() => null);
        if (directRes?.reply) replyText = directRes.reply.trim();
      } catch (e) {}
    }

    if (!replyText) {
      replyText = twxPickFallbackComment();
    }

    // Sanitize comment (dynamic word limit if specified in prompt)
    replyText = sanitizeClientComment(replyText, extractMaxWordsFromPrompt(params?.stylePrompt || params?.style));

    // 6. Post AI reply on target post using universal robust posting engine
    const commentRes = await postCommentOnTargetArticle(targetArticle, replyText);
    if (commentRes && commentRes.success) {
      replyDone = true;
      console.log(`[ATOMX RECIPROCAL] Successfully posted reply on @${targetHandle}: "${replyText}"`);
      await sleep(800);
    } else if (commentRes?.skipped || commentRes?.aborted || isWorkflowAborted || isWorkflowItemSkipped) {
      console.log('[ATOMX RECIPROCAL] Reply skipped or aborted by user.');
    } else {
      console.warn('[ATOMX RECIPROCAL] Could not post reply:', commentRes?.error);
    }

    return {
      success: true,
      handle: targetHandle,
      likeDone,
      replyDone,
      replyText,
      tweetUrl,
      followDone
    };
  } catch (err) {
    return { success: false, error: err.message, likeDone, replyDone };
  }
}

// Auto-initialize TG Liker engine on page load (if active workflow matches this tab)
if (typeof TgLikerNativeEngine !== 'undefined') {
  TgLikerNativeEngine.init().catch(() => null);
}

