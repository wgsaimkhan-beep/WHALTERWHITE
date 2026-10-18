/**
 * TWIXOR - CENTRAL COMMENT RULES (single source of truth)
 *
 * Every generated comment MUST be:
 *   - 50 to 80 characters long (spaces included)
 *   - lowercase english letters a to z and ordinary spaces only
 *
 * No uppercase, punctuation, hyphens, dashes, emojis, numbers or special characters.
 *
 * This module is applied AFTER the model answers, so no tone prompt, custom prompt
 * or model mistake can bypass it. The Chrome extension carries a byte-for-byte
 * equivalent of normalizeComment()/validateComment() (see chrome-extension/content.js)
 * as a last gate before anything is typed into X.
 */

const MIN_CHARS = 50;
const MAX_CHARS = 80;
const ALLOWED_RE = /^[a-z]+(?: [a-z]+)*$/; // lowercase words separated by single spaces

// Words we do not want a truncated comment to end on
const DANGLING = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'as', 'is', 'are', 'was', 'be', 'that', 'this', 'its', 'it', 'your', 'their', 'our', 'my'
]);

// Compliant emergency comments (used only when every provider attempt failed validation)
const SAFE_FALLBACKS = [
  'solid progress and the direction here makes a lot of sense to me',
  'this kind of steady building is what keeps a community moving forward',
  'clear thinking behind this and i like where the project is heading',
  'really like how focused the execution looks on this latest update',
  'strong signal here and the long term vision feels well thought out',
  'good to see real progress shipped instead of just big promises'
];

function stripNoise(text) {
  let t = String(text == null ? '' : text);
  // reasoning models sometimes leak their chain of thought
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/<\/?think>/gi, ' ');
  // labels like "Reply:" or "Comment:"
  t = t.replace(/^\s*(?:final\s+)?(?:reply|comment|tweet|response|ai reply|output|answer)\s*:\s*/i, '');
  // links, @mentions, #hashtags
  t = t.replace(/https?:\/\/\S+/gi, ' ').replace(/(^|\s)[@#][\w]+/g, ' ');
  // only the first line if the model produced several
  const firstLine = t.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return firstLine || '';
}

/**
 * Turn any text into the strict alphabet: lowercase a-z + single spaces.
 * Does NOT change the length beyond removing disallowed characters.
 */
function normalizeComment(raw, authorHandle = '', authorName = '') {
  let t = stripNoise(raw);

  // never mention the post author
  const cleanHandle = String(authorHandle || '').replace(/^@/, '').trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (cleanHandle.length >= 3) t = t.replace(new RegExp(esc(cleanHandle), 'gi'), ' ');
  const cleanName = String(authorName || '').trim();
  if (cleanName.length >= 3) t = t.replace(new RegExp(esc(cleanName), 'gi'), ' ');

  t = t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // accents -> base letters
    .toLowerCase()
    .replace(/['’‘`]/g, '')  // don't -> dont (no gap inside a word)
    .replace(/[^a-z]+/g, ' ')          // everything else (digits, punctuation, dashes, emoji, symbols) -> space
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/** Strict check used everywhere. Returns { valid, length, reason } */
function validateComment(text) {
  if (typeof text !== 'string' || !text) return { valid: false, length: 0, reason: 'empty' };
  const length = text.length;
  if (!ALLOWED_RE.test(text)) return { valid: false, length, reason: 'contains characters other than lowercase a to z and single spaces' };
  if (length < MIN_CHARS) return { valid: false, length, reason: `too short (${length} characters, need ${MIN_CHARS} to ${MAX_CHARS})` };
  if (length > MAX_CHARS) return { valid: false, length, reason: `too long (${length} characters, need ${MIN_CHARS} to ${MAX_CHARS})` };
  return { valid: true, length, reason: '' };
}

/** Cut an over-long (already normalized) comment at a word boundary, avoiding dangling words */
function truncateToLimit(text) {
  if (text.length <= MAX_CHARS) return text;
  let words = text.split(' ');
  while (words.length > 1 && words.join(' ').length > MAX_CHARS) words.pop();
  while (words.length > 1 && DANGLING.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/**
 * Safe correction. Returns a VALID comment or '' when the text cannot be repaired
 * without inventing content (too short, or empty after cleaning).
 */
function correctComment(raw, authorHandle = '', authorName = '') {
  let t = normalizeComment(raw, authorHandle, authorName);
  if (!t) return '';
  t = truncateToLimit(t);
  return validateComment(t).valid ? t : '';
}

function pickSafeFallback() {
  return SAFE_FALLBACKS[Math.floor(Math.random() * SAFE_FALLBACKS.length)];
}

/**
 * Remove lines from a tone prompt that contradict the global rules
 * (old word-count limits, "end with a question" and similar). The global rules are
 * also appended AFTER the tone text, this just removes the conflict at the source.
 */
function neutralizeToneConflicts(tonePrompt) {
  if (!tonePrompt) return '';
  const conflicting = [
    /\b\d+\s*(?:-|to|and)\s*\d+\s*words?\b/i,
    /\b(?:max(?:imum)?|up to|not exceed|under|exactly|around)\s*\d+\s*words?\b/i,
    /\bunder\s*\d+\s*characters?\b/i,
    /\b\d+\s*-?\s*\d*\s*sentences?\b/i,
    /\b(?:ending|ends|conclud(?:e|es|ing)|finish(?:es|ing)?)\s+(?:with|in)\s+(?:an?\s+)?(?:\w+\s+)?question\b/i
  ];
  return String(tonePrompt)
    .split(/\r?\n/)
    .filter(line => !conflicting.some(re => re.test(line)))
    .join('\n')
    .trim();
}

/** Global formatting block. Always placed LAST in the prompt so it wins over any tone. */
const GLOBAL_FORMAT_RULES = [
  'FINAL OUTPUT RULES (HIGHEST PRIORITY, OVERRIDE ANY CONFLICTING STYLE DIRECTIVE ABOVE):',
  `1. The comment must be between ${MIN_CHARS} and ${MAX_CHARS} characters long including spaces. Aim for about 10 to 13 short words, roughly 65 characters.`,
  '2. Use only lowercase english letters a to z and ordinary single spaces.',
  '3. Never use uppercase letters.',
  '4. Never use punctuation of any kind: no periods, commas, question marks, exclamation marks, colons, semicolons, apostrophes or quotation marks.',
  '5. Never use hyphens, short dashes, long dashes or em dashes.',
  '6. Never use emojis, numbers, digits, hashtags, mentions, symbols or any special character.',
  '7. Write contractions without apostrophes (dont, cant, its) and spell numbers out as words only if truly needed.',
  '8. Output exactly one comment on a single line with no label, no preamble and no quotation marks.',
  '9. Count the characters before answering. If the comment is shorter than 50 or longer than 80 characters rewrite it.'
].join('\n');

module.exports = {
  MIN_CHARS,
  MAX_CHARS,
  GLOBAL_FORMAT_RULES,
  normalizeComment,
  validateComment,
  correctComment,
  truncateToLimit,
  neutralizeToneConflicts,
  pickSafeFallback,
  SAFE_FALLBACKS
};
