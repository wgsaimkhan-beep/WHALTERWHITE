# ATOMX — Agent Architecture, Workflow & Global Rules Specification

> **Version:** 2.4.0  
> **Target Platform:** Twitter / X (x.com)  
> **Extension Architecture:** Manifest V3 (Service Worker `background.js` + Isolated Content Script `content.js` + Main World Protector `prevent-tab-close.js`)

---

## 1. Executive Summary & Core Philosophy

AtomX is an autonomous, human-mimicking Twitter/X engagement platform. It operates under two unbreakable golden rules:
1. **Indistinguishable from Human Behavior:** All interactions (mouse movements, clicks, pauses, typing speeds, and scrolls) must mimic authentic human physics. No instant synthetic clicks, no machine-like rigid scrolling, and no immediate burst actions.
2. **Fail-Safe Robustness & Non-Destructive Flow:** The extension must never crash the tab, get stuck in infinite deadlocks, re-engage skipped posts, or trigger Twitter's disruptive "Save post? Draft" prompts.

---

## 2. Global Human Interaction Engine (Global Rules)

### 2.1. Virtual Cursor & Bezier Movement
- **Visual Cursor:** A floating glowing cursor element (`#atomx-virtual-cursor`) rendered over the page.
- **Trajectory:** Mouse paths do not follow straight mathematical vectors. They follow **Cubic Bézier curves** with randomized control points and subtle micro-jitters (1-3px variance) simulating hand tremor.
- **Timing:** Cursor flight time is dynamically calculated based on Euclidean distance:
  $$\text{Flight Duration} = \min(850\text{ms}, \max(350\text{ms}, \text{distance} \times 0.65))$$
- **Pre-Click Dwell (Hover):** Upon reaching the target element's bounding box, the cursor dwells for 220ms – 450ms before depressing the mouse button.
- **Click Pulse & Feedback:** A radial ripple pulse illuminates over the target element upon mousedown.
- **Post-Click Pause:** After click release, an organic human pause (280ms – 520ms) occurs before any subsequent action.

### 2.2. Human Typing Engine (`simulateHumanTyping`)
- Never injects text via instant `input.value = text`.
- Types character-by-character using synthetic `KeyboardEvent('keydown')`, `InputEvent('beforeinput')`, and `InputEvent('input')`.
- **Keystroke Variance:** Typing interval varies organically between 35ms and 110ms per character.
- **Punctuation Pauses:** After commas (`,`), periods (`.`), or question marks (`?`), an extended thinking pause of 180ms – 400ms is naturally inserted.
- **Random Typos & Corrections:** Periodically simulates an accidental keystroke, pauses for 150ms, backspaces, and re-types the correct character.

---

## 3. Global Scroll Architecture (`humanSmoothScroll`)

Scrolling on Twitter/X is dangerous if done naively because Twitter employs **virtualized DOM lists** (tweets outside the viewport are dynamically detached from the DOM). AtomX uses a physics-based, multi-stage scroll engine:

### 3.1. The Scroll Guard (Critical Safety Rule)
```javascript
// Never scroll while a modal dialog, compose sheet, or confirmation prompt is open!
if (document.querySelector('div[role="dialog"], div[aria-modal="true"], div[data-testid="confirmationSheetDialog"]')) {
  return; // FREEZE SCROLL IMMEDIATELY
}
```
- **Why this exists:** While typing a comment or handling a skip, if the background timeline scrolls, Twitter's fixed modal shifts visual context, disorients the user, and causes element coordinate miscalculations.

### 3.2. Physics & Easing
- **Chunked Steps:** Instead of one massive `window.scrollTo`, distance is broken into variable-sized increments (18px – 48px).
- **Easing Curve:** Quadratic ease-out or sinusoidal decelerations.
- **Micro-Jitters:** Small 2px – 5px reverse or lateral scroll fluctuations mimic finger lift on a mouse wheel or trackpad.
- **Settlement Pause (`settlePause`):** After reaching the target distance, a resting pause of 350ms – 600ms is strictly maintained to allow Twitter's virtualized feed to hydrate new tweet DOM nodes.

### 3.3. Element Alignment (`scrollElementIntoViewAndEnsureVisible`)
- When a target post is identified, it is brought smoothly to the **center of the viewport** (`block: 'center'`).
- The script waits 350ms for layout shifts or sticky headers (`[data-testid="TopNavBar"]`) to settle before calculating bounding rectangles for buttons.

### 3.4. Post-Engagement Progression
- Once a post is engaged or skipped, the page performs a **500px – 550px downward scroll** to move the finished post out of focus and bring fresh, un-evaluated tweets into the active viewport.

### 3.5. Long Post & Modal Composer Alignment (`ensureCommentBoxComfortablyVisible`)
- **The Challenge:** When an original tweet is very long (multiple paragraphs, attached media, or embedded quote tweets), opening Twitter's reply modal pushes the comment textarea (`div[data-testid="tweetTextarea_0"]`) down to the very bottom cutoff of the modal dialog, partially or completely hidden behind bottom toolbars.
- **The Rule:** Before typing begins, `typeTextHumanLike` checks if the composer is pushed down (`rect.bottom > vh - 170` or `rect.bottom > containerRect.bottom - 70`).
- **The Execution:** ONLY when this condition is met, the engine performs a gentle, smooth scroll (`scrollContainer.scrollBy({ top: delta, behavior: 'smooth' })` or `editor.scrollIntoView({ behavior: 'smooth', block: 'center' })`) on the modal's internal scroll container.
- **Result:** The long tweet shifts upward slightly, placing the user's avatar, composer box, and typed text cleanly in the upper-middle of the modal. The user can see every word being typed with full visibility. Background window scroll position is strictly preserved (`window.scrollTo(0, initialWinY)`).

---

## 4. Skip & Clean-Up Protocol (No "Save Post?" Prompts)

### 4.1. The Problem
When skipping a post while the reply modal is open and has text typed:
- Clicking the Close (`X`) button triggers Twitter's confirmation sheet:  
  *"Save post? You can save this to send later from your drafts."* ➔ Options: `Save` or `Discard`.
- If unhandled or misclicked, it causes modal lockups, prompt loops, or inadvertent tab reloads.

### 4.2. The AtomX Solution: Direct Discard Click Protocol
1. **Instant Discard Detection:** If Twitter's "Save post?" confirmation sheet is already on screen, the **Discard** button is immediately located and clicked using authentic pointer events (`dispatchEnhancedHumanEvents`).
2. **Close (X) -> Discard Flow:** If the reply modal is open, the top-left Close (`X`) button is clicked. Twitter will trigger the "Save post?" confirmation sheet. The instant it appears, AtomX clicks **Discard**.
3. **Strict Discard Matching:** The selector strictly looks for elements containing text "Discard" (and explicitly excludes "Save").
4. **No Escape Key Dispatching:** Discarding does not dispatch synthetic `Escape` keys to prevent Twitter router loops or accidental tab close.
5. **Tab & Window Close Guard:** All `window.close()` and dangerous `history.back()` calls are neutralized in both the isolated content script and the main browser world (`prevent-tab-close.js`).

### 4.3. Anti-Repeat Protection (Never Re-Comment Skipped Posts)
To guarantee the bot never attempts to comment on the same skipped post again:
1. **DOM Tagging:** The article DOM node receives permanent attributes:
   ```javascript
   art.setAttribute('data-atomx-skipped', 'true');
   art.setAttribute('data-atomx-engaged', 'true');
   ```
2. **Memory Set:** The post's ID is pushed into the active runtime `alreadyEngagedSet`.
3. **Persistent Storage:** `tweetId` is saved to `chrome.storage.local` under `engagedTweetIds` and `atomx_follower_engaged_tweets`.
4. **Pre-Check Filter:** Every agent checks:
   ```javascript
   if (art.getAttribute('data-atomx-skipped') === 'true' || alreadyEngagedSet.has(tweetId)) {
     continue; // Skip silently
   }
   ```

---

## 5. Detailed Specifications for All 12 Agents

---

### 5.1. Agent 1: Telegram Group Engage (`telegram`)
- **Primary Goal:** Parse raid and engagement links from Telegram pods/chats and execute humanized engagement (Like, Repost, Bookmark, AI Reply) across all target tweets.
- **Workflow & Lifecycle:**
  1. **Input Parsing:** Ingests raw chat messages, links, or text containing `x.com` or `twitter.com` status URLs.
  2. **Deduplication & Hygiene:** Auto-cleans duplicates and filters out already engaged tweets (`engagedTweetIds`).
  3. **Execution Loop (Single Reused Tab):**
     - Navigates to each tweet sequentially in a single persistent browser tab (`tgWorkingTabId`).
     - Auto-Like: Moves glowing virtual cursor, hovers, and pulses rose (`simulateHumanLikeClick`).
     - Auto-Repost: Clicks retweet, awaits confirmation dropdown, confirms repost (`simulateHumanRepostClick`).
     - Auto-Bookmark: Clicks bookmark button without skipping (`isBookmarked` validation).
     - Auto-Comment (AI Voice): Contextually generates AI reply via `/api/generate-reply` using the selected tone, sanitizes prompt, types with human micro-cadence, and single-clicks submit with no duplicate click retries.
  4. **Credit Cost:** 1 credit per AI comment (atomically deducted on server). Pure Like/Repost raids are governed by platform settings.
  5. **HUD Controls:** Live Floating HUD shows Done, Collected, Skipped, Pause/Resume, Stop, and Skip.

---

### 5.2. Agent 2: Audience Builder (`audience`)
- **Primary Goal:** Identify high-intent, active commentators inside curated Twitter Lists and niche communities to build a high-signal, reciprocal audience.
- **Feed Ingestion & Filtering:**
  - When given a Twitter List URL (`https://x.com/i/lists/{listId}`), constructs the live search query:
    `https://x.com/search?q=list:{listId} lang:en -filter:retweets -filter:replies exclude:replies&f=live`
- **Execution Flow:**
  1. Discovers top parent posts within the specified freshness window (`15m` to `24h`).
  2. Opens each target post in the SAME reused tab and scans commenter articles (`article[data-testid="tweet"]`).
  3. Filters out the original author, self-comments, and spam bots.
  4. Likes the comment, visits the commenter's profile, likes their latest original root post, optionally leaves an AI comment, and follows.
- **Credit Cost:** 1 credit per AI reply generated.

---

### 5.3. Agent 3: Increase Sorsa Score (`sorsa`)
- **Primary Goal:** Boost on-chain Sorsa & Walchain influencer score by strategically interacting with top-tier verified creators and high-score Web3 accounts.
- **Execution Flow:**
  1. Targets high-weight influencers and curated Sorsa scoring lists.
  2. Aligns posts to viewport center and executes high-value contextual AI replies formatted to score high on algorithmic quality metrics.
  3. Follows and bookmarks qualifying posts to establish reciprocal network clusters.
- **Credit Cost:** 1 credit per generated AI comment.

---

### 5.4. Agent 4: Reply Back Loop (`replyback`) *(Upcoming / Not Live Yet)*
- **Primary Goal:** Continuous reciprocal auto-pilot for the user's own published tweets—automatically liking and replying to all genuine incoming comments from followers and community members.
- **Credit Cost:** 1 credit per generated AI reply loop.

---

### 5.5. Agent 5: Followers Increase (`followers`)
- **Primary Goal:** Drive organic follower growth by systematically engaging top accounts inside curated niche Twitter Lists.
- **The Search Live Rule:** Never uses raw list pages; always constructs:
  `https://x.com/search?q=list:{listId} -filter:replies -filter:retweets&f=live`
- **Supported Modes:**
  1. **Newest Tweet First (`sortPriority: 'recent'`):** Chronological top-down engagement of original parent posts.
  2. **Most Active (`sortPriority: 'active'`):** Ranks candidate posts descending by reply velocity within the selected freshness window (`15m` to `7d`) and engages the top ranked targets.
- **Credit Cost:** 1 credit per generated AI comment.

---

### 5.6. Agent 6: Auto Unfollow (`unfollow`)
- **Primary Goal:** Audit the user's Following list (`https://x.com/{username}/following`), filter non-reciprocal accounts (does not follow back or low score), and cleanly unfollow them.
- **Credit Economics Rule:**
  - **5 unfollows = 1 credit** (`workflow.successCount % 5 === 0`).
  - Recorded in cloud database ledger under action `"Auto Unfollow"`.
- **Execution Pipeline:**
  1. Inspects each `div[data-testid="UserCell"]` for `"Follows you"` badge or whitelist status.
  2. If non-reciprocal: centers cell, hovers Following button, clicks with red pulse, waits for confirmation sheet (`confirmationSheetConfirm`), and clicks confirm.
  3. Governed by central Safety Controls (15–20s pacing delay, batch breaks).

---

### 5.7. Agent 7: Favorite Creators Radar (`creators`) *(Upcoming / Not Live Yet)*
- **Primary Goal:** Monitor specific priority creator handles and place instant, high-visibility comments within seconds of their posts going live.
- **Credit Cost:** 1 credit per posted AI comment.

---

### 5.8. Agent 8: Find Defaulters (`defaulter`)
- **Primary Goal:** Comment Pod Auditor—scans all comments under a tweet post URL and cross-references them against an expected member/raid list to detect members who skipped commenting.
- **Credit Economics Rule:**
  - **1 scan / use = 1 credit** (`state.credits < 1` check, deducts 1 credit upon completed audit).
- **Execution Flow:**
  1. Accepts post URL (or auto-detects active tab).
  2. Ingests raw handles or chat logs and auto-cleans handles with regex parser.
  3. Scrolls comments to the end (up to 100 scroll passes), collects unique author handles.
  4. Generates an instant breakdown of Compliant Members vs Defaulters, with a 1-click "Copy All Defaulters" clipboard tool.

---

### 5.9. Agent 9: Commenter Reciprocator (`reciprocator`)
- **Primary Goal:** Scans comments on the user's own post, likes unliked comments, visits the commenter's profile, and posts an authentic AI reply on their latest tweet.
- **Credit Cost:** 1 credit per posted reciprocal AI comment.

---

### 5.10. Agent 10: Home Feed Engager (`feedengager`)
- **Primary Goal:** Autonomous daily engagement on `https://x.com/home` (Following / For You feed).
- **Filters:** Strictly skips own tweets, promoted ads, retweets, and reply chains. Pure root posts only.
- **Credit Cost:** 1 credit per AI comment generated.

---

### 5.11. Agent 11: Niche Search Engager (`nicheengager`)
- **Primary Goal:** Searches any target keyword (e.g., `"web3 builder"`, `"ai agents"`) on Twitter Search Live and engages original posts with contextual replies.
- **Credit Cost:** 1 credit per AI comment generated.

---

### 5.12. Agent 12: TG Liker (Raid & Repost) (`tgliker`)
- **Primary Goal:** High-speed, mass engagement on profile reposts (`/reposts`), quotes, or active X tabs.
- **Credit Economics Rule:**
  - **100% Free (0 credits).** No credit deduction is ever performed for TG Liker.
- **Capabilities:** Multi-action checkboxes (❤️ Like, 🔁 Repost, 🔖 Bookmark), session continuation (`atomx_tgliker_seen`), and Anti-Ban Pacing Breaks.

---

## 6. Credit System & Transaction Economics Specification

The AtomX credit system enforces strict, server-side atomic guarantees:

### 6.1. The Golden Transaction Lifecycle
```text
BEGIN
  1. Resolve User by JWT, handle, or email.
  2. Check status: If SUSPENDED -> 403 Forbidden.
  3. Atomic Check & Reserve:
     UPDATE users SET credits = credits - 1 
     WHERE id = user.id AND credits >= 1;
  4. If balance was 0 -> 402 Insufficient credits immediately (Blocks race conditions).
  5. Dispatch AI Request to Provider (OpenAI, Gemini, Groq, OpenRouter).
  6. If AI Provider succeeds -> COMMIT transaction, log in credits_ledger, return remainingCredits.
  7. If AI Provider throws ERROR:
     ROLLBACK & Auto-Refund:
     UPDATE users SET credits = credits + 1 WHERE id = user.id;
     Log 'AI Reply Refund' in credits_ledger.
     Return 500 without deducting user's credit!
COMMIT
```

### 6.2. Credit Deduction Matrix
- **AI Comment / Reply Generation:** Exactly 1 credit per reply. Pre-reserved to prevent parallel request bypass; auto-refunded on any provider error.
- **Auto Unfollow Agent:** Exactly 1 credit per 5 successful unfollows (`workflow.successCount % 5 === 0`).
- **Find Defaulters Agent:** Exactly 1 credit per completed audit run.
- **TG Liker (Raid & Repost):** 0 credits (Free utility).
- **Single Source of Truth:** Credit deductions are verified on the backend. When an AI comment is generated, the server deducts the credit; client workflows do not double-deduct.

---

## 7. HUD (Heads-Up Display) Interaction Architecture

The floating HUD (`#atomx-floating-hud`) provides transparent visibility and user control:

| Button / State | Functionality | Architecture Behavior |
| :--- | :--- | :--- |
| **Pause (`⏸️`)** | Temporarily halts workflow | Loops in background checking `atomx_workflow_paused`. Freezes scrolling and clicking. |
| **Resume (`▶️`)** | Continues workflow | Releases the pause loop; resumes from the current active post. |
| **Skip (`⏭️`)** | Aborts current post | **Instantly unpauses**, erases any open draft comment, dismisses modal, tags post as skipped, scrolls down, and moves to next tweet cleanly without skipping the subsequent post. |
| **Stop (`⏹️`)** | Cancels entire workflow | Sets `isWorkflowAborted = true`, clears storage active flags, removes HUD smoothly across tab & extension. |

---

## 8. Storage Keys Reference

| Storage Key | Type | Description |
| :--- | :--- | :--- |
| `atomx_agent_workflow` | `Object` | Active workflow descriptor (agentId, targetCount, successCount, options). |
| `atomx_workflow_paused` | `Boolean` | Flag indicating if the current execution is paused. |
| `atomx_skip_current` | `Boolean` | Ephemeral flag signaling immediate skip of the active item (auto-cleared after each step). |
| `engagedTweetIds` | `Array<string>` | Master array of all engaged & skipped tweet IDs to prevent duplicate actions. |
| `atomx_follower_engaged_tweets` | `Object` | Map of `{ tweetId: timestamp }` specific to the Followers Increase engine. |
| `atomx_tgliker_seen` | `Object` | Map of `{ targetUrl: [tweetIds] }` preserving handled posts for TG Liker continuation. |
| `atomx_tgliker_last_stats` | `Object` | Last run telemetry (handled, liked, reposted, bookmarked, skipped). |
| `atomx_safety_settings` | `Object` | Min/max intervals, typing delays, and daily engagement ceilings. |

---
*Created and maintained for AtomX AI Agentic Suite.*

