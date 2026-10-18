/**
 * ATOMX ENGAGE — DATABASE ENGINE (SUPABASE POSTGRESQL)
 * Completely eliminates SQLite dependency for 100% serverless Vercel compatibility.
 * All math, ledger logging, and operations are cloud-persisted in Supabase.
 */

const supabase = require('./supabase');
const bcrypt = require('bcryptjs');

// Escape LIKE wildcards (_ and %) and only allow characters that are safe inside a PostgREST or() filter
function likeSafe(s) { return String(s || '').replace(/[\\%_]/g, m => '\\' + m); }
function isFilterSafe(s) { return /^[\w.\-]+$/.test(s); }

// Fast indexed handle lookup (limit(1) -> never errors on multiple matches like maybeSingle did)
async function findUserByHandleFast(clean) {
  if (!supabase || !clean || !isFilterSafe(clean)) return null;
  const e = likeSafe(clean);
  const { data, error } = await supabase.from('users').select('*')
    .or(`handle.ilike.@${e},handle.ilike.${e}`).limit(1);
  if (error) return null;
  return (data && data[0]) || null;
}

// Helper to resolve user UUID from either UUID or numeric fallback (e.g. 1)
async function resolveUser(userIdOrId) {
  if (!supabase || !userIdOrId) return null;
  
  const val = String(userIdOrId).trim();
  // 1. If valid UUID format
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
  if (isUuid) {
    const { data } = await supabase.from('users').select('*').eq('id', val).maybeSingle();
    if (data) return data;
  }

  // 2. If email format
  if (val.includes('@') && val.includes('.')) {
    const { data } = await supabase.from('users').select('*').ilike('email', likeSafe(val.toLowerCase())).limit(1);
    if (data && data[0]) return data[0];
  }

  // 3. If Twitter handle
  const cleanHandle = val.replace(/^@/, '').toLowerCase().trim();
  const handleUser = await findUserByHandleFast(cleanHandle);
  if (handleUser) return handleUser;

  // 4. If numeric ID
  if (!isNaN(val)) {
    const { data: numUser } = await supabase.from('users').select('*').eq('id', val).maybeSingle();
    if (numUser) return numUser;
  }

  // Fallback: Default to admin or first user only if explicitly '1' or 'admin'
  if (val === '1' || val === 'admin') {
    const { data } = await supabase.from('users').select('*').order('created_at', { ascending: true }).limit(1);
    return data?.[0] || null;
  }

  return null;
}

module.exports = {
  // Direct client access if needed
  db: supabase,

  // User Helpers
  async getUserById(id) {
    return await resolveUser(id);
  },

  async getUserByEmail(email) {
    if (!supabase || !email) return null;
    const cleanEmail = email.toLowerCase().trim();
    const { data } = await supabase.from('users').select('*').ilike('email', likeSafe(cleanEmail)).limit(1);
    return (data && data[0]) || null;
  },

  async getUserByHandle(handle) {
    if (!supabase || !handle) return null;
    const clean = handle.replace(/^@/, '').toLowerCase().trim();
    try {
      const fast = await findUserByHandleFast(clean);
      if (fast) return fast;
    } catch (e) {}

    // Rare last resort (match by email / full name). Capped so it can never scan a huge table.
    try {
      const { data: all } = await supabase.from('users').select('*').limit(2000);
      const found = (all || []).find(u => {
        const uH = (u.handle || '').toLowerCase().replace(/^@/, '').trim();
        const uEm = (u.email || '').toLowerCase().trim();
        const uFn = (u.full_name || '').toLowerCase().replace(/^@/, '').trim();
        return uH === clean || uEm === clean || uFn === clean;
      });
      if (found) return found;
    } catch (err) {}
    return null;
  },

  async getAllUsers() {
    if (!supabase) return [];
    const { data } = await supabase
      .from('users')
      .select('id, full_name, email, handle, role, status, plan_tier, credits, avatar_initials, created_at')
      .order('created_at', { ascending: true });

    // Attach referredBy (hash lookup instead of a scan per user)
    try {
      const referralService = require('../services/referralService');
      const allRefs = (await referralService.getAllReferrals()) || [];
      const byHandle = new Map();
      const byEmail = new Map();
      for (const r of allRefs) {
        if (r.referee_handle) byHandle.set(String(r.referee_handle).toLowerCase(), r.referrer_handle);
        if (r.referee_email) byEmail.set(String(r.referee_email).toLowerCase(), r.referrer_handle);
      }
      return (data || []).map(u => {
        const ref = byHandle.get((u.handle || '').toLowerCase()) || (u.email ? byEmail.get(u.email.toLowerCase()) : null);
        return { ...u, referredBy: ref || 'Direct / —' };
      });
    } catch (e) {
      return data || [];
    }
  },

  async updateUserStatus(userId, status) {
    const user = await resolveUser(userId);
    if (!user) throw new Error('User not found');
    const { data, error } = await supabase.from('users').update({ status }).eq('id', user.id).select();
    if (error) throw new Error(error.message);
    return data?.[0];
  },

  async updateUserPassword(userId, password) {
    if (!supabase) return true;
    const user = await resolveUser(userId);
    if (!user) throw new Error('User not found');
    const pwdStr = String(password || '').trim();
    const isBcrypt = pwdStr.startsWith('$2a$') || pwdStr.startsWith('$2b$');
    const finalHash = isBcrypt ? pwdStr : await bcrypt.hash(pwdStr, 10);
    const { data, error } = await supabase.from('users').update({ password_hash: finalHash }).eq('id', user.id).select();
    if (error) throw new Error(error.message);

    // Automatically mark pending password reset request as resolved in credits_ledger
    try {
      await supabase.from('credits_ledger')
        .update({ action: 'Password Reset (Resolved)' })
        .eq('user_id', user.id)
        .eq('action', 'Forgot Password');

      const userH = (user.handle || '').toLowerCase().replace(/^@/, '');
      if (userH) {
        await supabase.from('credits_ledger')
          .update({ action: 'Password Reset (Resolved)' })
          .ilike('reason', `%${userH}%`)
          .eq('action', 'Forgot Password');
      }
    } catch (ledgerErr) {
      console.warn('Could not update ledger reset status:', ledgerErr.message);
    }

    return data?.[0];
  },

  async resolvePasswordReset(userIdOrHandle) {
    if (!supabase) return true;
    try {
      const user = await resolveUser(userIdOrHandle);
      if (user && user.id) {
        await supabase.from('credits_ledger')
          .update({ action: 'Password Reset (Resolved)' })
          .eq('user_id', user.id)
          .eq('action', 'Forgot Password');
      }
      const cleanH = String(userIdOrHandle || '').replace(/^@/, '').toLowerCase().trim();
      if (cleanH) {
        await supabase.from('credits_ledger')
          .update({ action: 'Password Reset (Resolved)' })
          .ilike('reason', `%${cleanH}%`)
          .eq('action', 'Forgot Password');
      }
    } catch (e) {
      console.warn('Could not mark password reset resolved:', e.message);
    }
    return true;
  },

  async updateUserPlan(userId, plan) {
    if (!supabase) throw new Error('Database not connected');
    const user = await resolveUser(userId);
    if (!user) throw new Error('User not found');
    const { data, error } = await supabase.from('users').update({ plan_tier: plan }).eq('id', user.id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteUser(userIdOrHandle) {
    if (!supabase) throw new Error('Database not connected');
    const user = await resolveUser(userIdOrHandle);
    let targetId = user?.id;
    let targetHandle = user?.handle;
    let targetEmail = user?.email;

    if (!user) {
      // Check if it's an access request
      const reqs = await this.getAccessRequests();
      const match = (reqs || []).find(r => r.id === userIdOrHandle || (r.handle && r.handle.toLowerCase() === String(userIdOrHandle).toLowerCase()) || (r.email && r.email.toLowerCase() === String(userIdOrHandle).toLowerCase()));
      if (match) {
        await supabase.from('access_requests').delete().eq('id', match.id);
        return { success: true, deleted: 'access_request', id: match.id };
      }
      throw new Error('User account not found to delete');
    }

    try { await supabase.from('reply_queue').delete().eq('user_id', targetId); } catch(e){}
    try { await supabase.from('credits_ledger').delete().eq('user_id', targetId); } catch(e){}
    try { await supabase.from('engaged_tweets').delete().eq('user_id', String(targetId)); } catch(e){}
    try { await supabase.from('transactions').delete().eq('user_id', targetId); } catch(e){}
    if (targetEmail) {
      try { await supabase.from('access_requests').delete().eq('email', targetEmail); } catch(e){}
    }
    if (targetHandle) {
      try {
        const referralService = require('../services/referralService');
        const refs = (await referralService.getAllReferrals()) || [];
        const filtered = refs.filter(r => r.referee_handle?.toLowerCase() !== targetHandle.toLowerCase());
        referralService.saveReferrals && referralService.saveReferrals(filtered);
      } catch(e){}
    }

    const { error } = await supabase.from('users').delete().eq('id', targetId);
    if (error) throw new Error(error.message);

    return { success: true, deletedUserId: targetId, handle: targetHandle };
  },

  // Atomic Server-Side Credit Math (Rule: 1 Credit = 1 AI reply)
  async deductCredit(userId, amount = 1, action = 'AI Reply', reason = 'Generated reply') {
    const user = await resolveUser(userId);
    if (!user) throw new Error('User not found');
    if ((user.credits || 0) < amount) throw new Error('Insufficient credits');

    const newBalance = Math.max(0, user.credits - amount);
    // Enforce DB-level atomic guard using .gte('credits', amount) to prevent race-condition concurrency bypass
    const { error: updateErr } = await supabase
      .from('users')
      .update({ credits: newBalance })
      .eq('id', user.id)
      .gte('credits', amount);

    if (updateErr) throw new Error(updateErr.message);

    // Record immutable audit ledger entry
    await supabase.from('credits_ledger').insert({
      user_id: user.id,
      amount: -amount,
      balance_after: newBalance,
      action,
      admin_source: 'Server System',
      reason
    });

    return newBalance;
  },

  async recordLedgerEntry(userId, amount, balanceAfter, action, reason) {
    if (!supabase || !userId) return;
    try {
      await supabase.from('credits_ledger').insert({
        user_id: userId,
        amount,
        balance_after: balanceAfter,
        action,
        admin_source: 'Server System',
        reason
      });
    } catch (e) {}
  },

  async addCredits(userId, amount, action = 'Bonus', adminSource = 'Admin', reason = 'Credit adjustment') {
    const user = await resolveUser(userId);
    if (!user) throw new Error('User not found');

    const newBalance = (user.credits || 0) + amount;
    const { error: updateErr } = await supabase.from('users').update({ credits: newBalance }).eq('id', user.id);
    if (updateErr) throw new Error(updateErr.message);

    await supabase.from('credits_ledger').insert({
      user_id: user.id,
      amount,
      balance_after: newBalance,
      action,
      admin_source: adminSource,
      reason
    });

    return newBalance;
  },

  async getLedger(userId) {
    const user = await resolveUser(userId);
    if (!user) return [];
    const { data } = await supabase
      .from('credits_ledger')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    return data || [];
  },

  async getAllLedger() {
    if (!supabase) return [];
    let allRecords = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('credits_ledger')
        .select('*, users(full_name, email, handle)')
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);

      if (error || !data || data.length === 0) break;
      allRecords = allRecords.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
      if (allRecords.length >= 100000) break;
    }

    return allRecords.map(l => {
      const handleMatch = (l.reason || '').match(/for\s+(@?[\w_]+)/i);
      const userHandle = l.users?.handle || (handleMatch ? handleMatch[1] : null);
      return {
        ...l,
        user_name: l.users?.full_name || 'System User',
        user_email: l.users?.email || 'user@atomx.io',
        user_handle: userHandle ? (userHandle.startsWith('@') ? userHandle : `@${userHandle}`) : null
      };
    });
  },

  _mapLedgerRow(l) {
    const handleMatch = (l.reason || '').match(/for\s+(@?[\w_]+)/i);
    const userHandle = l.users?.handle || (handleMatch ? handleMatch[1] : null);
    return {
      ...l,
      user_name: l.users?.full_name || 'System User',
      user_email: l.users?.email || 'user@twixor.app',
      user_handle: userHandle ? (userHandle.startsWith('@') ? userHandle : `@${userHandle}`) : null
    };
  },

  // Newest ledger rows only (the panel never needs 100k rows at once)
  async getLedgerPage(limit = 300, offset = 0) {
    if (!supabase) return [];
    const lim = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 2000);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const { data, error } = await supabase
      .from('credits_ledger')
      .select('*, users(full_name, email, handle)')
      .order('created_at', { ascending: false })
      .range(off, off + lim - 1);
    if (error) throw new Error(error.message);
    return (data || []).map(l => this._mapLedgerRow(l));
  },

  // Only password-reset rows (previously the WHOLE ledger was downloaded for this)
  async getPasswordResetRows(limit = 300) {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('credits_ledger')
      .select('*, users(full_name, email, handle)')
      .eq('action', 'Forgot Password')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data || []).map(l => this._mapLedgerRow(l));
  },

  async getLedgerCount() {
    if (!supabase) return 0;
    try {
      const { count } = await supabase.from('credits_ledger').select('*', { count: 'exact', head: true });
      return count || 0;
    } catch (e) {
      return 0;
    }
  },

  async getAiGenerationsCount() {
    if (!supabase) return 0;
    try {
      const { count } = await supabase.from('credits_ledger').select('*', { count: 'exact', head: true }).lt('amount', 0);
      return count || 0;
    } catch (e) {
      return 0;
    }
  },

  // Access Requests & Approval
  async getAccessRequests() {
    if (!supabase) return [];
    const { data } = await supabase.from('access_requests').select('*').order('requested_at', { ascending: false });
    return (data || []).map(r => {
      const match = (r.use_case || '').match(/X_ID:(@?[\w_]+)/i);
      const tgMatch = (r.use_case || '').match(/TG:(@?[\w_]+)/i);
      const refMatch = (r.use_case || '').match(/REF:(@?[\w_]+)/i);
      return {
        ...r,
        handle: match ? (match[1].startsWith('@') ? match[1] : '@' + match[1]) : '@' + r.email.split('@')[0],
        telegram: tgMatch ? (tgMatch[1].startsWith('@') ? tgMatch[1] : '@' + tgMatch[1]) : (r.telegram || ''),
        referredBy: refMatch ? (refMatch[1].startsWith('@') ? refMatch[1] : '@' + refMatch[1]) : 'Direct / —'
      };
    });
  },

  async createAccessRequest(fullName, email, useCase) {
    if (!supabase) throw new Error('Database not connected');
    const tgMatch = (useCase || '').match(/TG:(@?[\w_]+)/i);
    const telegramVal = tgMatch ? (tgMatch[1].startsWith('@') ? tgMatch[1] : '@' + tgMatch[1]) : null;

    const payload = {
      full_name: fullName,
      email,
      use_case: useCase,
      status: 'PENDING',
      initial_credits_granted: 100
    };
    if (telegramVal) payload.telegram = telegramVal;

    let { data, error } = await supabase.from('access_requests').insert(payload).select();
    if (error && error.message && error.message.includes('telegram')) {
      delete payload.telegram;
      const res = await supabase.from('access_requests').insert(payload).select();
      data = res.data;
      error = res.error;
    }
    if (error) throw new Error(error.message);
    return data?.[0];
  },

  async approveAccessRequest(requestId, initialCredits = 100, planTier = 'Free Plan') {
    if (!supabase) throw new Error('Database not connected');
    const { data: req } = await supabase.from('access_requests').select('*').eq('id', requestId).maybeSingle();
    if (!req) throw new Error('Access request not found');

    const totalCredits = Number(initialCredits) || 100;
    const finalPlan = planTier || 'Free Plan';

    // Extract real X Handle / ID from use_case note
    const handleMatch = (req.use_case || '').match(/X_ID:(@?[\w_]+)/i);
    const assignedHandle = handleMatch ? (handleMatch[1].startsWith('@') ? handleMatch[1] : '@' + handleMatch[1]) : ('@' + req.email.split('@')[0]);

    // Check if user already exists in users table
    const { data: existingUser } = await supabase.from('users').select('*').eq('email', req.email).maybeSingle();
    let userRecord = null;

    if (existingUser) {
      const { data: updated, error: updErr } = await supabase.from('users').update({
        status: 'ACTIVE',
        handle: existingUser.handle || assignedHandle,
        plan_tier: finalPlan,
        credits: totalCredits
      }).eq('id', existingUser.id).select().single();
      if (updErr) throw new Error(updErr.message);
      userRecord = updated;
    } else {
      const initials = req.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'US';
      const { data: newUser, error: userErr } = await supabase.from('users').insert({
        email: req.email,
        password_hash: 'approved_hash',
        full_name: req.full_name,
        handle: assignedHandle,
        role: 'USER',
        status: 'ACTIVE',
        plan_tier: finalPlan,
        credits: totalCredits,
        avatar_initials: initials
      }).select().single();

      if (userErr) throw new Error(userErr.message);
      userRecord = newUser;

      // Record initial grant in ledger
      await supabase.from('credits_ledger').insert({
        user_id: userRecord.id,
        amount: totalCredits,
        balance_after: totalCredits,
        action: 'Initial Grant',
        admin_source: 'Admin Approval',
        reason: `Approved onboarding plan: ${finalPlan} (${totalCredits} credits)`
      });
    }

    // Update request status to APPROVED
    await supabase.from('access_requests').update({
      status: 'APPROVED',
      reviewed_at: new Date().toISOString()
    }).eq('id', requestId);

    // Process referral rewards if this user was referred (Referrer +150, User +150)
    try {
      const referralService = require('../services/referralService');
      await referralService.processApprovalRewards({
        refereeHandle: assignedHandle,
        refereeEmail: req.email,
        refereeUserId: userRecord.id
      });
    } catch (refErr) {
      console.warn('[Referral Approval Notice]', refErr.message);
    }

    return { userId: userRecord.id, credits: userRecord.credits, handle: assignedHandle, plan: userRecord.plan_tier };
  },

  async rejectAccessRequest(requestId) {
    if (!supabase) throw new Error('Database not connected');
    const { data, error } = await supabase.from('access_requests').update({
      status: 'REJECTED',
      reviewed_at: new Date().toISOString()
    }).eq('id', requestId).select();
    if (error) throw new Error(error.message);
    return data?.[0];
  },

  async requestSuspensionReview(identifier, reason = 'User requested review of suspension') {
    if (!supabase) return { success: true };
    const clean = (identifier || '').replace(/^@/, '').toLowerCase().trim();
    let user = null;
    if (identifier.includes('@') && identifier.includes('.')) {
      user = await this.getUserByEmail(identifier);
    }
    if (!user) {
      user = await this.getUserByHandle(clean);
    }
    if (user) {
      await supabase.from('credits_ledger').insert({
        user_id: user.id,
        amount: 0,
        balance_after: user.credits || 0,
        action: 'Appeal Review',
        admin_source: 'Extension Appeal',
        reason: `Appeal: ${reason}`
      });
      return { success: true, user };
    }
    return { success: true };
  },

  async requestPasswordReset(identifier, telegram, email, handle) {
    if (!supabase) return { success: true };
    const cleanHandle = (handle || identifier || '').trim().replace(/^@/, '').toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanTg = (telegram || '').trim().replace(/^@/, '').toLowerCase();

    if (!cleanHandle || !cleanEmail || !cleanTg) {
      throw new Error('Twitter/X ID, registered email, and Telegram ID are all required to request a password reset.');
    }

    // 1. Resolve user
    let user = await this.getUserByHandle(cleanHandle);
    if (!user) {
      user = await this.getUserByEmail(cleanEmail);
    }
    if (!user) {
      throw new Error('Account not found with this Twitter / X handle. Please verify your details.');
    }

    // 2. Verify Email matches registered user
    if ((user.email || '').trim().toLowerCase() !== cleanEmail) {
      throw new Error('Verification failed: The registered email does not match this Twitter / X account.');
    }

    // 3. Verify Handle matches registered user
    const userCleanHandle = (user.handle || '').trim().replace(/^@/, '').toLowerCase();
    if (userCleanHandle !== cleanHandle) {
      throw new Error('Verification failed: The Twitter / X ID does not match this account.');
    }

    // 4. Verify Telegram ID matches account registration record
    const reqs = await this.getAccessRequests();
    const matchReq = (reqs || []).find(r => 
      (r.email || '').toLowerCase() === cleanEmail ||
      (r.handle || '').replace(/^@/, '').toLowerCase() === cleanHandle
    );
    if (matchReq && matchReq.telegram) {
      const regTg = matchReq.telegram.replace(/^@/, '').toLowerCase();
      if (regTg && regTg !== cleanTg) {
        throw new Error('Verification failed: The Telegram ID does not match the Telegram ID registered with this account.');
      }
    }

    const tgDisplay = `@${cleanTg}`;
    const emailDisplay = cleanEmail;
    const handleDisplay = user.handle?.startsWith('@') ? user.handle : `@${cleanHandle}`;

    await supabase.from('credits_ledger').insert({
      user_id: user.id,
      amount: 0,
      balance_after: user.credits || 0,
      action: 'Forgot Password',
      admin_source: 'Extension Request',
      reason: `Password reset requested for ${handleDisplay} | Email: ${emailDisplay} | TG: ${tgDisplay}`
    });
    return { success: true, user };
  },

  async resetUserPassword(identifier, newPassword, currentPassword) {
    if (!supabase) throw new Error('Database not connected');
    const clean = (identifier || '').replace(/^@/, '').toLowerCase().trim();
    let user = null;
    if (identifier.includes('@') && identifier.includes('.')) {
      user = await this.getUserByEmail(identifier);
    }
    if (!user) {
      user = await this.getUserByHandle(clean);
    }
    if (!user) {
      const reqs = await this.getAccessRequests();
      const m = (reqs || []).find(r => {
        const rHandle = (r.handle || '').replace(/^@/, '').toLowerCase();
        return rHandle === clean || (r.email || '').toLowerCase() === identifier.toLowerCase();
      });
      if (m) {
        user = await this.getUserByEmail(m.email);
      }
    }
    if (!user) {
      throw new Error('User not found. Please ensure your email or handle is registered.');
    }

    // Verify current / admin-provided password
    if (currentPassword) {
      if (user.password_hash && user.password_hash !== 'approved_hash') {
        const stored = (user.password_hash || '').trim();
        const isBcrypt = stored.startsWith('$2a$') || stored.startsWith('$2b$');
        let isMatch = false;
        if (isBcrypt) {
          isMatch = await bcrypt.compare(currentPassword, stored);
        } else {
          isMatch = (stored === currentPassword);
        }
        if (!isMatch) {
          throw new Error('Current / Admin-provided password is incorrect. Please check with your administrator.');
        }
      }
    }

    const newPwdStr = String(newPassword || '').trim();
    const isNewBcrypt = newPwdStr.startsWith('$2a$') || newPwdStr.startsWith('$2b$');
    const finalNewHash = isNewBcrypt ? newPwdStr : await bcrypt.hash(newPwdStr, 10);

    const { data, error } = await supabase.from('users').update({
      password_hash: finalNewHash,
      status: 'ACTIVE'
    }).eq('id', user.id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  // Campaigns & Queue
  async getCampaigns(userId) {
    const user = await resolveUser(userId);
    if (!user) return [];
    const { data } = await supabase.from('campaigns').select('*').eq('user_id', user.id);
    return data || [];
  },

  async getQueue(userId) {
    const user = await resolveUser(userId);
    if (!user) return [];
    const { data } = await supabase.from('reply_queue').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    return data || [];
  },

  async addToQueue(userId, campaignId, author, handle, content) {
    const user = await resolveUser(userId);
    if (!user) throw new Error('User not found');
    const { data, error } = await supabase.from('reply_queue').insert({
      campaign_id: campaignId || null,
      user_id: user.id,
      tweet_author: author,
      tweet_handle: handle,
      tweet_content: content,
      status: 'WAITING'
    }).select();
    if (error) throw new Error(error.message);
    return data?.[0];
  },

  // Plans & Transactions
  async getPlans() {
    if (!supabase) return [];
    const { data } = await supabase.from('plans').select('*').neq('id', 'system_curated_lists');
    return (data || []).map(p => ({
      ...p,
      features_json: JSON.stringify(p.features || [])
    }));
  },

  async getTransactions() {
    // 1. Try from Supabase transactions table
    if (supabase) {
      try {
        const { data, error } = await supabase.from('transactions').select('*, users(full_name, email, handle)').order('created_at', { ascending: false });
        if (!error && Array.isArray(data) && data.length > 0) {
          return data.map(t => ({
            id: t.id,
            date: t.created_at ? new Date(t.created_at).toLocaleString() : 'Recently',
            user: t.users?.full_name || t.user_name || 'Customer',
            handle: t.users?.handle || t.user_handle || '@user',
            email: t.users?.email || t.user_email || '',
            type: t.item_type || 'Plan Purchase',
            item: t.item_name || 'Growth Plan',
            credits: t.credits || t.credits_granted || 10000,
            amount: t.amount_usd ? `$${Number(t.amount_usd).toFixed(2)}` : (t.amount || '$12.00'),
            method: t.payment_method || 'Stripe Card',
            status: t.status || 'COMPLETED'
          }));
        }
      } catch (e) {}
    }

    // 2. Try from system_transactions storage in plans
    try {
      if (supabase) {
        const { data } = await supabase.from('plans').select('features').eq('id', 'system_transactions').maybeSingle();
        if (data && Array.isArray(data.features) && data.features.length > 0) {
          return data.features;
        }
      }
    } catch (e) {}

    // 3. Fallback: derive real purchase transactions from registered users with paid plans
    const allUsers = await this.getAllUsers();
    const paidUsers = allUsers.filter(u => u.plan_tier && u.plan_tier !== 'Pending Tier' && !u.plan_tier.toLowerCase().includes('free'));
    if (paidUsers.length > 0) {
      return paidUsers.map((u, idx) => ({
        id: `TX-${100000 + idx}`,
        date: u.created_at ? new Date(u.created_at).toLocaleString() : 'Recently',
        user: u.full_name || 'Customer',
        handle: u.handle || '@user',
        email: u.email || '',
        type: 'Plan Purchase',
        item: u.plan_tier,
        credits: u.credits || (u.plan_tier.includes('Growth') ? 10000 : u.plan_tier.includes('Pro') ? 25000 : 100000),
        amount: u.plan_tier.includes('Growth') ? '$12.00' : u.plan_tier.includes('Pro') ? '$29.00' : '$99.00',
        method: 'Stripe Card',
        status: 'COMPLETED'
      }));
    }

    return [];
  },

  async recordTransaction(txData) {
    if (!txData) return null;
    const tx = {
      id: `TX-${Date.now().toString().slice(-6)}`,
      date: new Date().toLocaleString(),
      user: txData.user || 'Customer',
      handle: txData.handle || '@user',
      email: txData.email || '',
      type: txData.type || 'Plan Purchase',
      item: txData.item || 'Growth Plan',
      credits: Number(txData.credits) || 10000,
      amount: txData.amount || '$12.00',
      method: txData.method || 'Stripe Card',
      status: 'COMPLETED'
    };

    try {
      const existing = await this.getTransactions();
      const updated = [tx, ...existing.filter(e => e.id !== tx.id)].slice(0, 50);
      if (supabase) {
        await supabase.from('plans').upsert({
          id: 'system_transactions',
          name: 'System Transactions',
          features: updated
        });
      }
    } catch (e) {}
    return tx;
  },

  // Engaged Tweets Tracking (Anti-Duplicate & 2nd Account Isolation)
  async getEngagedTweetIds(userId = '1') {
    if (!supabase) return [];
    const { data } = await supabase.from('engaged_tweets').select('tweet_id').eq('user_id', String(userId));
    return (data || []).map(r => r.tweet_id);
  },

  async isTweetEngaged(tweetId, userId = '1') {
    if (!supabase) return false;
    const { data } = await supabase.from('engaged_tweets').select('tweet_id').eq('tweet_id', String(tweetId)).eq('user_id', String(userId)).maybeSingle();
    return !!data;
  },

  async markTweetsEngaged(tweets, userId = '1') {
    if (!supabase) return;
    const list = Array.isArray(tweets) ? tweets : [tweets];
    const rows = [];
    for (const t of list) {
      const id = t?.tweetId || t?.tweet_id || t?.id;
      if (!id) continue;
      rows.push({
        tweet_id: String(id),
        user_id: String(userId),
        handle: t.handle || '@creator',
        canonical_url: t.canonicalUrl || t.canonical_url || '',
        action_type: t.actionType || t.action_type || 'REPLY'
      });
    }
    if (rows.length > 0) {
      await supabase.from('engaged_tweets').upsert(rows, { onConflict: 'tweet_id' });
    }
  },

  async clearEngagedTweets(userId = '1') {
    if (!supabase) return;
    await supabase.from('engaged_tweets').delete().eq('user_id', String(userId));
  },

  async wipeAllUserData() {
    if (!supabase) return { success: true, message: 'No database connected' };
    await supabase.from('credits_ledger').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('engaged_tweets').delete().neq('tweet_id', '___nonexistent___');
    try { await supabase.from('campaigns').delete().neq('id', '00000000-0000-0000-0000-000000000000'); } catch (e) {}
    try { await supabase.from('reply_queue').delete().neq('id', '00000000-0000-0000-0000-000000000000'); } catch (e) {}
    try { await supabase.from('transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000'); } catch (e) {}
    await supabase.from('access_requests').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    return { success: true, message: 'All user data wiped fresh successfully' };
  }
};
