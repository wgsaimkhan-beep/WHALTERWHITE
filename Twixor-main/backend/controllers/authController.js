/**
 * ATOMX ENGAGE — AUTH CONTROLLER (SUPABASE PERSISTENT)
 */
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { generateToken } = require('../middleware/authMiddleware');

exports.login = async (req, res) => {
  try {
    const { identifier, email, handle, xHandle, username, password } = req.body;
    const loginKey = (identifier || email || handle || xHandle || username || '').trim();
    if (!loginKey) {
      return res.status(400).json({ error: 'Please enter your Twitter / X ID or email.' });
    }

    const cleanHandle = loginKey.replace(/^@/, '').toLowerCase().trim();

    let user = null;
    // 1. If loginKey has @ and ., try exact email match
    if (loginKey.includes('@') && loginKey.includes('.')) {
      user = await db.getUserByEmail(loginKey.toLowerCase().trim());
    }
    // 2. Try handle directly
    if (!user && db.getUserByHandle) {
      user = await db.getUserByHandle(cleanHandle);
    }
    // 3. If loginKey is an email address, also check the prefix before '@' as handle
    if (!user && loginKey.includes('@')) {
      const emailPrefix = loginKey.split('@')[0].trim().toLowerCase();
      if (emailPrefix && db.getUserByHandle) {
        user = await db.getUserByHandle(emailPrefix);
      }
    }
    // 4. Try getUserByEmail with clean handle or loginKey
    if (!user && db.getUserByEmail) {
      user = await db.getUserByEmail(loginKey.toLowerCase().trim());
    }
    // 5. Fallback: search by resolveUser from db
    if (!user && typeof db.getUserById === 'function') {
      user = await db.getUserById(loginKey);
    }
    // 6. Comprehensive fallback: match against all active users in database
    if (!user && typeof db.getAllUsers === 'function') {
      const allUsers = await db.getAllUsers();
      const normInput = cleanHandle.toLowerCase();
      user = allUsers.find(u => {
        const h = (u.handle || '').toLowerCase().replace(/^@/, '').trim();
        const em = (u.email || '').toLowerCase().trim();
        const emPrefix = em.split('@')[0].trim();
        const fn = (u.full_name || '').toLowerCase().replace(/^@/, '').trim();
        return h === normInput || em === normInput || emPrefix === normInput || fn === normInput;
      }) || null;
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials. Account not found. Please request access if not registered.' });
    }

    if (user.status === 'SUSPENDED') {
      return res.status(403).json({
        error: 'Account Suspended',
        message: 'Your account is currently suspended. Please contact support@atomx.io to appeal.'
      });
    }

    // STRICT BCRYPT PASSWORD VERIFICATION
    const providedPass = (password || '').trim();
    if (!providedPass) {
      return res.status(400).json({ error: 'Password is required to sign in.' });
    }

    const storedPass = (user.password_hash || '').trim();
    if (!storedPass || storedPass === 'approved_hash') {
      return res.status(403).json({
        needsPasswordSetup: true,
        error: 'Password not set yet. Please click "Set Password" to initialize your credentials.'
      });
    }

    const isBcrypt = storedPass.startsWith('$2a$') || storedPass.startsWith('$2b$');
    let isMatch = false;
    if (isBcrypt) {
      isMatch = await bcrypt.compare(providedPass, storedPass);
    } else {
      const cleanStored = storedPass.replace(/^@/, '');
      const cleanProvided = providedPass.replace(/^@/, '');
      if (storedPass === providedPass || cleanStored === cleanProvided || cleanStored.toLowerCase() === cleanProvided.toLowerCase()) {
        isMatch = true;
        // Transparently upgrade legacy plaintext password to secure bcrypt hash
        db.updateUserPassword(user.id, providedPass).catch(console.error);
      }
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please verify your password and try again.' });
    }

    const userHandle = user.handle ? (user.handle.startsWith('@') ? user.handle : '@' + user.handle) : `@${cleanHandle || 'user'}`;
    const token = generateToken({
      userId: user.id,
      handle: userHandle,
      email: user.email,
      role: user.role || 'USER'
    }, '14d');

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        handle: userHandle,
        role: user.role,
        status: user.status,
        plan: user.plan_tier,
        credits: user.credits,
        maxCredits: user.credits,
        avatar: user.avatar_initials
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const referralService = require('../services/referralService');

exports.requestAccess = async (req, res) => {
  const { fullName, email, handle, xHandle, password, useCase, telegram, referredBy, ref } = req.body;
  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ error: 'Full name is required.' });
  }

  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const rawHandle = (handle || xHandle || '').trim().replace(/^@/, '');
  if (!rawHandle) {
    return res.status(400).json({ error: 'Your Twitter / X handle is required to verify your account.' });
  }

  const rawTelegram = (telegram || '').trim().replace(/^@/, '');
  if (!rawTelegram) {
    return res.status(400).json({ error: 'Your Telegram ID is required.' });
  }

  const formattedHandle = '@' + rawHandle;
  const formattedTelegram = '@' + rawTelegram;
  const cleanTelegramLower = rawTelegram.toLowerCase();
  const cleanHandleLower = rawHandle.toLowerCase();

  const rawReferrer = (referredBy || ref || '').trim().replace(/^@/, '');
  const formattedReferrer = rawReferrer && rawReferrer.toLowerCase() !== cleanHandleLower ? '@' + rawReferrer : '';

  try {
    const existingReqs = await db.getAccessRequests();

    // 1. Strict 1 account per email (Zero duplicates in users and access_requests)
    const existingEmail = await db.getUserByEmail(cleanEmail);
    if (existingEmail) {
      return res.status(400).json({ error: `An account with this email (${cleanEmail}) already exists. Multiple accounts with the same email are strictly prohibited.` });
    }
    const duplicateEmailReq = (existingReqs || []).find(r => (r.email || '').toLowerCase() === cleanEmail && (r.status === 'PENDING' || r.status === 'APPROVED'));
    if (duplicateEmailReq) {
      return res.status(400).json({ 
        error: `An access request with this email (${cleanEmail}) already exists (${duplicateEmailReq.status}). Multiple accounts with the same email are strictly prohibited.`,
        alreadyApproved: duplicateEmailReq.status === 'APPROVED'
      });
    }

    // 2. Strict 1 account per Twitter / X ID (Zero duplicates in users and access_requests)
    const existingHandleUser = await db.getUserByHandle(rawHandle);
    if (existingHandleUser) {
      return res.status(400).json({ 
        error: `This Twitter / X handle (${formattedHandle}) is already registered. Multiple accounts with the same Twitter / X ID are strictly prohibited.`,
        alreadyApproved: true
      });
    }
    const duplicateHandleReq = (existingReqs || []).find(r => {
      const h = (r.handle || '').replace(/^@/, '').toLowerCase();
      return h === cleanHandleLower && (r.status === 'PENDING' || r.status === 'APPROVED');
    });
    if (duplicateHandleReq) {
      return res.status(400).json({ 
        error: `An access request for Twitter / X ID ${formattedHandle} has already been submitted (${duplicateHandleReq.status}). Multiple accounts with the same Twitter / X ID are strictly prohibited.`,
        alreadyApproved: duplicateHandleReq.status === 'APPROVED'
      });
    }

    // 3. Strict 1 account per Telegram ID (Zero duplicates in access_requests)
    const duplicateTgReq = (existingReqs || []).find(r => {
      const tg = (r.telegram || '').replace(/^@/, '').toLowerCase();
      return tg && tg === cleanTelegramLower && (r.status === 'PENDING' || r.status === 'APPROVED');
    });
    if (duplicateTgReq) {
      return res.status(400).json({
        error: `This Telegram ID (${formattedTelegram}) is already registered with another account (${duplicateTgReq.status}). Multiple accounts with the same Telegram ID are strictly prohibited.`
      });
    }

    const note = `X_ID:${formattedHandle} | TG:${formattedTelegram}${formattedReferrer ? ` | REF:${formattedReferrer}` : ''} | Note: ${useCase || 'User access request'}`;
    await db.createAccessRequest(fullName, cleanEmail, note, formattedHandle, password);

    // 4. Record pending referral if referred
    if (formattedReferrer) {
      referralService.recordPendingReferral({
        referrerHandle: formattedReferrer,
        refereeHandle: formattedHandle,
        refereeEmail: cleanEmail,
        refereeName: fullName
      });
    }

    res.status(201).json({
      message: `Access request submitted for ${formattedHandle}! Waiting for admin approval.`,
      status: 'PENDING',
      handle: formattedHandle,
      telegram: formattedTelegram,
      referredBy: formattedReferrer || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.checkAccessStatus = async (req, res) => {
  try {
    const rawHandle = (req.query.handle || req.query.xHandle || '').trim().replace(/^@/, '').toLowerCase();
    const email = (req.query.email || '').trim().toLowerCase();

    if (!rawHandle && !email) {
      return res.status(400).json({ error: 'Please provide handle or email to check status' });
    }

    // 1. Check if user already exists and is active in users table
    let user = null;
    if (rawHandle && db.getUserByHandle) {
      user = await db.getUserByHandle(rawHandle);
    }
    if (!user && email && db.getUserByEmail) {
      user = await db.getUserByEmail(email);
    }

    if (user) {
      const userHandle = user.handle ? (user.handle.startsWith('@') ? user.handle : '@' + user.handle) : `@${rawHandle}`;
      const needsPasswordSetup = !user.password_hash || user.password_hash === 'approved_hash';
      return res.json({
        status: user.status === 'ACTIVE' ? (needsPasswordSetup ? 'APPROVED' : 'ACTIVE') : user.status,
        handle: userHandle,
        email: user.email,
        fullName: user.full_name,
        needsPasswordSetup,
        credits: user.credits,
        plan: user.plan_tier
      });
    }

    // 2. Check access_requests table
    const requests = await db.getAccessRequests();
    const match = (requests || []).find(r => {
      const rHandle = (r.handle || '').replace(/^@/, '').toLowerCase();
      const rEmail = (r.email || '').toLowerCase();
      return (rawHandle && rHandle === rawHandle) || (email && rEmail === email);
    });

    if (match) {
      // Check if user already got created/activated in users table
      let userFromReq = null;
      if (match.email && db.getUserByEmail) {
        userFromReq = await db.getUserByEmail(match.email);
      }
      if (!userFromReq && match.handle && db.getUserByHandle) {
        userFromReq = await db.getUserByHandle(match.handle.replace(/^@/, ''));
      }

      if (userFromReq) {
        const needsPasswordSetup = !userFromReq.password_hash || userFromReq.password_hash === 'approved_hash';
        return res.json({
          status: userFromReq.status === 'ACTIVE' ? (needsPasswordSetup ? 'APPROVED' : 'ACTIVE') : userFromReq.status,
          handle: userFromReq.handle || match.handle,
          email: userFromReq.email || match.email,
          fullName: userFromReq.full_name || match.full_name,
          needsPasswordSetup,
          credits: userFromReq.credits,
          plan: userFromReq.plan_tier
        });
      }

      return res.json({
        status: match.status, // 'PENDING', 'APPROVED', or 'REJECTED'
        handle: match.handle,
        email: match.email,
        fullName: match.full_name,
        needsPasswordSetup: match.status === 'APPROVED'
      });
    }

    res.json({ status: 'NOT_FOUND' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.setPassword = async (req, res) => {
  try {
    const { identifier, handle, email, password } = req.body;
    const loginKey = (identifier || handle || email || '').trim();
    const cleanHandle = loginKey.replace(/^@/, '').toLowerCase();
    const inputEmail = (email || (loginKey.includes('@') ? loginKey : '')).trim().toLowerCase();

    if (!loginKey || !password) {
      return res.status(400).json({ error: 'Handle/Email and new password are required' });
    }

    // Find user in users table
    let user = null;
    if (inputEmail) {
      user = await db.getUserByEmail(inputEmail);
    }
    if (!user && cleanHandle && db.getUserByHandle) {
      user = await db.getUserByHandle(cleanHandle);
    }
    if (!user && loginKey) {
      user = await db.getUserByEmail(loginKey);
    }

    if (!user) {
      // Check if request is in access_requests
      const requests = await db.getAccessRequests();
      const match = (requests || []).find(r => {
        const rHandle = (r.handle || '').replace(/^@/, '').toLowerCase();
        const rEmail = (r.email || '').toLowerCase();
        return (cleanHandle && rHandle === cleanHandle) || 
               (inputEmail && rEmail === inputEmail) || 
               (loginKey && rEmail === loginKey.toLowerCase());
      });

      if (match) {
        if (match.status === 'APPROVED' || match.status === 'PENDING') {
          const approvedRes = await db.approveAccessRequest(match.id);
          user = await db.getUserById(approvedRes.userId);
        }
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'Approved account not found. Please ensure your request has been submitted.' });
    }

    // If account already has a real password set, do NOT allow overwriting it via setPassword!
    const hasRealPassword = user.password_hash && user.password_hash !== 'approved_hash';
    if (hasRealPassword) {
      return res.status(400).json({ 
        error: 'This account is already approved and has a password set. Please sign in directly or use Forgot Password to reset.',
        alreadyHasPassword: true
      });
    }

    // Update password in database and set ACTIVE
    if (db.updateUserPassword) {
      await db.updateUserPassword(user.id, password);
    }
    if (db.updateUserStatus) {
      await db.updateUserStatus(user.id, 'ACTIVE');
    }

    // Reload fresh user
    user = await db.getUserById(user.id) || user;

    const userHandle = user.handle ? (user.handle.startsWith('@') ? user.handle : '@' + user.handle) : (cleanHandle ? `@${cleanHandle}` : '@user');
    const token = generateToken({
      userId: user.id,
      handle: userHandle,
      email: user.email,
      role: user.role || 'USER'
    }, '14d');

    res.json({
      success: true,
      message: '✓ Password set successfully! You are now logged in.',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        handle: userHandle,
        role: user.role,
        status: 'ACTIVE',
        plan: user.plan_tier || 'Free Plan',
        credits: user.credits !== undefined ? user.credits : 100,
        maxCredits: user.credits !== undefined ? user.credits : 100,
        avatar: user.avatar_initials || 'UX'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.requestReview = async (req, res) => {
  try {
    const { handle, email, reason } = req.body;
    const identifier = handle || email || 'user';
    await db.requestSuspensionReview(identifier, reason || 'Account suspension review requested from extension');
    res.json({
      success: true,
      message: 'Review request submitted to Administrator. Please await manual review.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.requestPasswordReset = async (req, res) => {
  try {
    const { identifier, handle, email, telegram } = req.body;
    const cleanHandle = (handle || identifier || '').trim();
    const cleanEmail = (email || '').trim();
    const cleanTelegram = (telegram || '').trim();

    if (!cleanHandle || !cleanEmail || !cleanTelegram) {
      return res.status(400).json({ error: 'All 3 fields (Twitter / X handle, registered email, and Telegram ID) are required to request a password reset.' });
    }

    const result = await db.requestPasswordReset(cleanHandle, cleanTelegram, cleanEmail, cleanHandle);
    res.json({
      success: true,
      message: `✓ Password reset request sent to Admin! Admin will review your account and message your temporary login password to your Telegram (${cleanTelegram.startsWith('@') ? cleanTelegram : '@' + cleanTelegram}).`,
      user: result.user
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { identifier, email, handle, currentPassword, newPassword } = req.body;
    const loginKey = (identifier || email || handle || '').trim();
    if (!loginKey || !newPassword) {
      return res.status(400).json({ error: 'Account handle/email and new password are required' });
    }
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current / Admin-provided password is required' });
    }
    const updatedUser = await db.resetUserPassword(loginKey, newPassword, currentPassword);
    res.json({
      success: true,
      message: '✓ Password reset successfully! You can now log in with your new password.',
      handle: updatedUser.handle
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { handle, email, identifier, currentPassword, newPassword } = req.body;
    const loginKey = (handle || email || identifier || '').trim();
    if (!loginKey) {
      return res.status(400).json({ error: 'Account handle or email is required' });
    }
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current / Temporary password is required' });
    }
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must have at least 4 characters' });
    }
    const updatedUser = await db.resetUserPassword(loginKey, newPassword, currentPassword);
    res.json({
      success: true,
      message: '✓ Password updated successfully! Your account is now secured with your new password.',
      handle: updatedUser.handle
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};


exports.getCurrentUser = async (req, res) => {
  try {
    const userId = req.user?.userId || req.headers['x-user-id'] || 1;
    const user = await db.getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      handle: user.handle,
      role: user.role,
      status: user.status,
      plan: user.plan_tier,
      credits: user.credits,
      maxCredits: user.credits,
      avatar: user.avatar_initials
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin Login using Password / Master Access Key from .env
exports.adminLogin = (req, res) => {
  const { password, accessKey } = req.body;
  const input = (password || accessKey || '').trim();
  const configuredPassword = (process.env.ADMIN_PASSWORD || process.env.ADMIN_ACCESS_KEY || 'atomx2026').trim();

  if (!input || input !== configuredPassword) {
    return res.status(401).json({
      success: false,
      error: 'Invalid Admin Password. Please check the ADMIN_PASSWORD in your backend .env file.'
    });
  }

  const token = generateToken({
    role: 'ADMIN',
    name: 'Administrator',
    email: 'admin@atomx.io'
  }, '7d');

  res.json({
    success: true,
    token,
    role: 'ADMIN',
    admin: {
      name: 'Administrator',
      email: 'admin@atomx.io',
      role: 'ADMIN',
      permissions: ['ALL_PERMISSIONS']
    },
    message: '✓ Admin authentication successful!'
  });
};

// Verify if an Admin Password / Key is valid
exports.verifyAdminKey = (req, res) => {
  const key = req.headers['x-admin-password'] || req.headers['x-admin-key'] || req.query.password || req.query.key;
  const configuredPassword = (process.env.ADMIN_PASSWORD || process.env.ADMIN_ACCESS_KEY || 'atomx2026').trim();
  const isValid = Boolean(key && key.trim() === configuredPassword);
  res.json({ valid: isValid });
};
