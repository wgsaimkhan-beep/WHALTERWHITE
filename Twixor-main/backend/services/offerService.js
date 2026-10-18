/**
 * ATOMX ENGAGE — PROMOTIONAL OFFERS SERVICE (CLOUD & LOCAL PERSISTENT)
 * Handles "FIRST LAUNCH OFFER" / "FOUNDING 100" with countdown timers and admin controls
 */

const fs = require('fs');
const path = require('path');
const supabase = require('../config/supabase');

const OFFERS_FILE = path.join(__dirname, '../data/specialOffers.json');
const TMP_OFFERS_FILE = path.join('/tmp', 'specialOffers.json');

let inMemoryOffer = null;

function ensureDataDir() {
  try {
    const dir = path.dirname(OFFERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function getDefaultOffer() {
  // Default: Founding 100 Launch Offer expiring in 3 days
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: 'launch_founding_100',
    name: 'FOUNDING 100',
    badge: 'FIRST LAUNCH OFFER',
    originalPrice: 5.00,
    launchPrice: 2.00,
    credits: 5000,
    limitUsers: 100,
    claimedUsers: 14,
    isActive: true,
    expiresAt: expiry,
    createdAt: new Date().toISOString(),
    features: [
      '5,000 AI replies',
      'All automation agents',
      'Human-like pacing',
      'Priority processing',
      'Early feature access',
      'Dedicated support'
    ]
  };
}

function loadOffer() {
  if (inMemoryOffer) return inMemoryOffer;

  try {
    if (fs.existsSync(TMP_OFFERS_FILE)) {
      inMemoryOffer = JSON.parse(fs.readFileSync(TMP_OFFERS_FILE, 'utf8'));
      return inMemoryOffer;
    }
  } catch (e) {}

  try {
    if (fs.existsSync(OFFERS_FILE)) {
      inMemoryOffer = JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8'));
      return inMemoryOffer;
    }
  } catch (e) {}

  const def = getDefaultOffer();
  inMemoryOffer = def;
  saveOffer(def);
  return def;
}

function saveOffer(offer) {
  inMemoryOffer = offer;

  // 1. Supabase persistence
  if (supabase) {
    try {
      supabase.from('plans').upsert({
        id: 'system_special_offer',
        name: 'Special Offer Config',
        features: offer
      }).then(() => {}).catch(() => {});
    } catch (e) {}
  }

  // 2. Safe file writes
  try {
    fs.writeFileSync(TMP_OFFERS_FILE, JSON.stringify(offer, null, 2), 'utf8');
  } catch (e) {}

  try {
    ensureDataDir();
    fs.writeFileSync(OFFERS_FILE, JSON.stringify(offer, null, 2), 'utf8');
  } catch (e) {}
}

// Preload from Supabase
if (supabase) {
  supabase.from('plans').select('features').eq('id', 'system_special_offer').maybeSingle()
    .then(({ data, error }) => {
      if (!error && data && data.features) {
        inMemoryOffer = data.features;
      }
    }).catch(() => {});
}

module.exports = {
  getCurrentOffer(realClaimedCount = null) {
    const offer = loadOffer();
    const now = Date.now();
    const expiryTime = new Date(offer.expiresAt).getTime();
    const isExpired = now >= expiryTime;

    return {
      ...offer,
      claimedUsers: realClaimedCount !== null ? realClaimedCount : (offer.claimedUsers || 0),
      isExpired,
      secondsRemaining: Math.max(0, Math.floor((expiryTime - now) / 1000))
    };
  },

  updateOffer(updates) {
    const current = loadOffer();
    const updated = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    saveOffer(updated);
    return updated;
  }
};
