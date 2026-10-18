/**
 * ATOMX ENGAGE — REFERRAL & REWARD SERVICE (LEVEL 1 DIRECT ONLY)
 * Rules:
 * 1. Direct Level-1 referrals only. No MLM / multi-tier.
 * 2. Referrals are rewarded ONLY upon Admin Account Approval:
 *    - Referrer: +150 Credits
 *    - Referred New User: +150 Credits
 * 3. First paid plan purchase reward: Referrer earns 10% equivalent credits on the initial purchase.
 * 4. All rewards are in Credits, never cash.
 */

const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const supabase = require('../config/supabase');

const REFERRALS_FILE = path.join(__dirname, '../data/referrals.json');
const TMP_REFERRALS_FILE = path.join('/tmp', 'referrals.json');

let inMemoryReferrals = null;
let isDbLoaded = false;

function ensureDataDir() {
  try {
    const dir = path.dirname(REFERRALS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(REFERRALS_FILE)) {
      fs.writeFileSync(REFERRALS_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  } catch (e) {
    // Read-only filesystem on Vercel serverless /var/task is expected
  }
}

function loadReferrals() {
  if (Array.isArray(inMemoryReferrals)) {
    return inMemoryReferrals;
  }

  // Fallback to local files if available
  try {
    if (fs.existsSync(TMP_REFERRALS_FILE)) {
      const raw = fs.readFileSync(TMP_REFERRALS_FILE, 'utf8');
      inMemoryReferrals = JSON.parse(raw);
      return inMemoryReferrals;
    }
  } catch (e) {}

  try {
    if (fs.existsSync(REFERRALS_FILE)) {
      const raw = fs.readFileSync(REFERRALS_FILE, 'utf8');
      inMemoryReferrals = JSON.parse(raw);
      return inMemoryReferrals;
    }
  } catch (e) {}

  inMemoryReferrals = [];
  return inMemoryReferrals;
}

// Async preloader from Supabase
async function initReferralsFromSupabase() {
  if (isDbLoaded || !supabase) return;
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('features')
      .eq('id', 'system_referrals')
      .maybeSingle();

    if (!error && data && Array.isArray(data.features)) {
      inMemoryReferrals = data.features;
      isDbLoaded = true;
    }
  } catch (e) {
    console.warn('[Referral] Supabase load warning:', e.message);
  }
}

// Trigger initial async fetch
initReferralsFromSupabase().catch(() => {});

function saveReferrals(records) {
  inMemoryReferrals = Array.isArray(records) ? records : [];

  // 1. Persist to Supabase cloud database
  if (supabase) {
    supabase.from('plans').upsert({
      id: 'system_referrals',
      name: 'System Referrals Storage',
      price_monthly: 0,
      credits_monthly: 0,
      is_popular: false,
      is_active: false,
      features: inMemoryReferrals
    }, { onConflict: 'id' }).then(({ error }) => {
      if (error) console.warn('[Referral] Supabase upsert error:', error.message);
      else console.log('✓ [Referral] Referrals persisted to Supabase cloud');
    }).catch(err => console.warn('[Referral] Supabase exception:', err.message));
  }

  // 2. Safe local file write (try /tmp first, then local if writable)
  try {
    fs.writeFileSync(TMP_REFERRALS_FILE, JSON.stringify(inMemoryReferrals, null, 2), 'utf8');
  } catch (e) {}

  try {
    ensureDataDir();
    fs.writeFileSync(REFERRALS_FILE, JSON.stringify(inMemoryReferrals, null, 2), 'utf8');
  } catch (fsErr) {
    // EROFS on Vercel is safely ignored
  }
}

module.exports = {
  /**
   * Register a new pending referral upon access request
   */
  recordPendingReferral({ referrerHandle, refereeHandle, refereeEmail, refereeName }) {
    if (!referrerHandle || !refereeHandle) return null;
    const cleanReferrer = '@' + referrerHandle.replace(/^@/, '').toLowerCase().trim();
    const cleanReferee = '@' + refereeHandle.replace(/^@/, '').toLowerCase().trim();

    if (cleanReferrer === cleanReferee) return null; // Prevent self-referral

    const referrals = loadReferrals();
    // Check if referee was already recorded
    const existing = referrals.find(r => r.referee_handle.toLowerCase() === cleanReferee.toLowerCase());
    if (existing) return existing;

    const record = {
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      referrer_handle: cleanReferrer,
      referee_handle: cleanReferee,
      referee_email: refereeEmail || '',
      referee_name: refereeName || '',
      status: 'PENDING',
      referrer_reward: 150,
      referee_reward: 150,
      created_at: new Date().toISOString(),
      approved_at: null,
      first_purchase_status: 'NONE',
      first_purchase_amount: 0,
      purchase_reward_credits: 0
    };

    referrals.push(record);
    saveReferrals(referrals);
    return record;
  },

  /**
   * Triggered when admin approves a user account:
   * Grants 150 Credits to Referrer + 150 Credits to Referee
   */
  async processApprovalRewards({ refereeHandle, refereeEmail, refereeUserId }) {
    const cleanReferee = '@' + (refereeHandle || '').replace(/^@/, '').toLowerCase().trim();
    const referrals = loadReferrals();
    const refIndex = referrals.findIndex(r => 
      r.referee_handle.toLowerCase() === cleanReferee.toLowerCase() ||
      (refereeEmail && r.referee_email.toLowerCase() === refereeEmail.toLowerCase())
    );

    if (refIndex === -1) return null;
    const ref = referrals[refIndex];

    if (ref.status === 'APPROVED') return ref; // Already processed

    ref.status = 'APPROVED';
    ref.approved_at = new Date().toISOString();

    // 1. Award +150 Credits to Referrer
    try {
      const referrerUser = await db.getUserByHandle(ref.referrer_handle);
      if (referrerUser) {
        await db.addCredits(
          referrerUser.id,
          150,
          'Referral Bonus',
          'Referral System',
          `Referral reward for inviting ${cleanReferee}`
        );
      }
    } catch (e) {
      console.warn('[Referral] Error rewarding referrer:', e.message);
    }

    // 2. Award +150 Credits to Referee
    try {
      const targetUserId = refereeUserId || (await db.getUserByHandle(cleanReferee))?.id;
      if (targetUserId) {
        await db.addCredits(
          targetUserId,
          150,
          'Referral Welcome Bonus',
          'Referral System',
          `Welcome bonus for joining via ${ref.referrer_handle}`
        );
      }
    } catch (e) {
      console.warn('[Referral] Error rewarding referee:', e.message);
    }

    saveReferrals(referrals);
    return ref;
  },

  /**
   * Reward Referrer when Referred User makes their first paid plan purchase
   */
  async recordPurchaseReward({ userHandle, userEmail, planPrice = 10, planName = 'Growth Plan' }) {
    const cleanUser = '@' + (userHandle || '').replace(/^@/, '').toLowerCase().trim();
    const referrals = loadReferrals();
    const refIndex = referrals.findIndex(r => 
      r.referee_handle.toLowerCase() === cleanUser.toLowerCase() ||
      (userEmail && r.referee_email.toLowerCase() === userEmail.toLowerCase())
    );

    if (refIndex === -1) return null;
    const ref = referrals[refIndex];

    if (ref.first_purchase_status === 'REWARDED') return ref; // One-time reward only

    // 10% of purchase price in credits (e.g. $10 plan * 10% = 1.0 or 1,000 credits equivalent)
    const priceNum = Number(planPrice) || 10;
    const rewardCredits = Math.round(priceNum * 100); // e.g. $10 -> 1,000 Credits reward!

    ref.first_purchase_status = 'REWARDED';
    ref.first_purchase_amount = priceNum;
    ref.purchase_reward_credits = rewardCredits;
    ref.purchased_at = new Date().toISOString();

    try {
      const referrerUser = await db.getUserByHandle(ref.referrer_handle);
      if (referrerUser) {
        await db.addCredits(
          referrerUser.id,
          rewardCredits,
          'Referral Purchase Reward',
          'Referral System',
          `10% First Purchase reward from ${cleanUser}'s ${planName} purchase ($${priceNum})`
        );
      }
    } catch (e) {
      console.warn('[Referral] Purchase reward error:', e.message);
    }

    saveReferrals(referrals);
    return ref;
  },

  /**
   * Get all referrals for Admin Dashboard (syncs fresh with Supabase)
   */
  async getAllReferrals() {
    await initReferralsFromSupabase();
    return loadReferrals();
  },

  /**
   * Synchronize referral records dynamically with the active users database
   */
  async syncReferralsWithDatabase() {
    await initReferralsFromSupabase();
    let referrals = loadReferrals() || [];

    try {
      const users = await db.getAllUsers();
      const requests = await db.getAccessRequests();

      // 1. Discover any registered users who have referral attribution not yet tracked
      users.forEach(u => {
        const refBy = u.referred_by || (u.use_case && u.use_case.match(/REF:(@?[\w_]+)/i) ? u.use_case.match(/REF:(@?[\w_]+)/i)[1] : null);
        if (refBy && refBy !== 'Direct / —' && refBy !== 'Direct') {
          const cleanRef = refBy.startsWith('@') ? refBy : `@${refBy}`;
          const uHandle = u.handle ? (u.handle.startsWith('@') ? u.handle : `@${u.handle}`) : `@${u.email.split('@')[0]}`;
          const existing = referrals.find(r => 
            (r.referee_handle || '').toLowerCase() === uHandle.toLowerCase() ||
            (r.referee_email && u.email && r.referee_email.toLowerCase() === u.email.toLowerCase())
          );

          if (!existing) {
            referrals.push({
              id: `ref_u_${u.id}`,
              referrer_handle: cleanRef,
              referee_handle: uHandle,
              referee_name: u.full_name || u.name || 'User',
              referee_email: u.email,
              status: u.status === 'ACTIVE' ? 'APPROVED' : 'PENDING',
              referrer_reward: 150,
              referee_reward: 150,
              created_at: u.created_at || new Date().toISOString(),
              approved_at: u.status === 'ACTIVE' ? (u.created_at || new Date().toISOString()) : null,
              first_purchase_status: u.plan_tier && !u.plan_tier.toLowerCase().includes('free') ? 'REWARDED' : 'NONE',
              first_purchase_amount: u.plan_tier && u.plan_tier.toLowerCase().includes('pro') ? 29 : (u.plan_tier && u.plan_tier.toLowerCase().includes('growth') ? 12 : 0),
              purchase_reward_credits: u.plan_tier && !u.plan_tier.toLowerCase().includes('free') ? 1200 : 0
            });
          }
        }
      });

      // 2. Discover pending requests with referral attribution
      requests.forEach(r => {
        const refBy = r.referred_by || (r.use_case && r.use_case.match(/REF:(@?[\w_]+)/i) ? r.use_case.match(/REF:(@?[\w_]+)/i)[1] : null);
        if (refBy && refBy !== 'Direct / —' && refBy !== 'Direct') {
          const cleanRef = refBy.startsWith('@') ? refBy : `@${refBy}`;
          const rHandle = r.handle ? (r.handle.startsWith('@') ? r.handle : `@${r.handle}`) : `@${r.email.split('@')[0]}`;
          const existing = referrals.find(d => 
            (d.referee_handle || '').toLowerCase() === rHandle.toLowerCase() ||
            (d.referee_email && r.email && d.referee_email.toLowerCase() === r.email.toLowerCase())
          );

          if (!existing) {
            referrals.push({
              id: `ref_r_${r.id}`,
              referrer_handle: cleanRef,
              referee_handle: rHandle,
              referee_name: r.full_name || r.name || 'Applicant',
              referee_email: r.email,
              status: 'PENDING',
              referrer_reward: 150,
              referee_reward: 150,
              created_at: r.created_at || new Date().toISOString(),
              approved_at: null,
              first_purchase_status: 'NONE',
              first_purchase_amount: 0,
              purchase_reward_credits: 0
            });
          }
        }
      });

      // 3. Complete sync pass: cross-check every referral against active users table
      for (const ref of referrals) {
        const cleanRefHandle = (ref.referee_handle || '').toLowerCase().replace(/^@/, '');
        const cleanRefEmail = (ref.referee_email || '').toLowerCase();

        const userMatch = users.find(u => {
          const uh = (u.handle || '').toLowerCase().replace(/^@/, '');
          const ue = (u.email || '').toLowerCase();
          return (uh && uh === cleanRefHandle) || (ue && ue === cleanRefEmail);
        });

        if (userMatch) {
          if (userMatch.status === 'ACTIVE') {
            ref.status = 'APPROVED';
            ref.approved_at = ref.approved_at || userMatch.created_at || new Date().toISOString();
          }
          if (userMatch.plan_tier && !userMatch.plan_tier.toLowerCase().includes('free')) {
            ref.first_purchase_status = 'REWARDED';
            ref.first_purchase_amount = userMatch.plan_tier.toLowerCase().includes('pro') ? 29 : (userMatch.plan_tier.toLowerCase().includes('growth') ? 12 : 10);
            ref.purchase_reward_credits = ref.first_purchase_amount * 100;
          }
        }
      }

      saveReferrals(referrals);
    } catch (e) {
      console.warn('[Referral Sync Warning]', e.message);
    }

    return referrals;
  },

  /**
   * Manually approve a referral from admin panel
   */
  async approveReferral(idOrHandle) {
    await initReferralsFromSupabase();
    const referrals = loadReferrals();
    const clean = String(idOrHandle).toLowerCase().replace(/^@/, '');
    const ref = referrals.find(r => 
      r.id === idOrHandle || 
      (r.referee_handle || '').toLowerCase().replace(/^@/, '') === clean
    );

    if (!ref) throw new Error('Referral record not found');
    ref.status = 'APPROVED';
    ref.approved_at = new Date().toISOString();

    // Reward referrer & referee if user records exist
    try {
      const referrerUser = await db.getUserByHandle(ref.referrer_handle);
      if (referrerUser) {
        await db.addCredits(referrerUser.id, 150, 'Referral Bonus', 'Referral System', `Referral bonus for ${ref.referee_handle}`);
      }
      const refereeUser = await db.getUserByHandle(ref.referee_handle);
      if (refereeUser) {
        await db.addCredits(refereeUser.id, 150, 'Referral Welcome Bonus', 'Referral System', `Welcome bonus via ${ref.referrer_handle}`);
      }
    } catch (e) {
      console.warn('[Referral Reward Notice]', e.message);
    }

    saveReferrals(referrals);
    return ref;
  },

  saveReferrals,

  /**
   * Get summary for an individual user
   */
  getUserReferralStats(userHandle) {
    if (!userHandle) return { total: 0, approved: 0, pending: 0, totalEarned: 0, list: [] };
    const clean = '@' + userHandle.replace(/^@/, '').toLowerCase().trim();
    const referrals = loadReferrals();
    const myReferrals = referrals.filter(r => r.referrer_handle.toLowerCase() === clean.toLowerCase());

    const approved = myReferrals.filter(r => r.status === 'APPROVED');
    const pending = myReferrals.filter(r => r.status === 'PENDING');
    
    const approvalCredits = approved.length * 150;
    const purchaseCredits = approved.reduce((sum, r) => sum + (r.purchase_reward_credits || 0), 0);
    const totalEarned = approvalCredits + purchaseCredits;

    return {
      referrerHandle: clean,
      totalReferrals: myReferrals.length,
      approvedCount: approved.length,
      pendingCount: pending.length,
      totalEarnedCredits: totalEarned,
      referralLink: `https://atomxengage.com/ref/${clean.replace(/^@/, '')}`,
      list: myReferrals.map(r => ({
        user: r.referee_name || r.referee_handle,
        handle: r.referee_handle,
        status: r.status,
        date: r.created_at ? new Date(r.created_at).toLocaleDateString() : 'Recent',
        approvalDate: r.approved_at ? new Date(r.approved_at).toLocaleDateString() : '—',
        reward: r.status === 'APPROVED' ? `150 + ${r.purchase_reward_credits || 0} Cr` : 'Pending'
      }))
    };
  }
};
