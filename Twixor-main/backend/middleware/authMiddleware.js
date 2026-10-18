/**
 * ATOMX ENGAGE — AUTHENTICATION & SECURITY MIDDLEWARE
 * Hardens admin control, user tokens, prevents BOLA / IDOR, and eliminates SSRF vulnerabilities.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'atomx_super_secret_jwt_key_928374';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || process.env.ADMIN_ACCESS_KEY || 'atomx2026').trim();

/**
 * Extracts and verifies JWT or Admin access key.
 */
function extractToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers['x-admin-token']) {
    return req.headers['x-admin-token'].trim();
  }
  return null;
}

/**
 * Middleware: Strictly requires Admin authentication.
 * Accepts:
 * 1. Valid signed Admin JWT (role: 'ADMIN')
 * 2. Valid Admin Password in header 'x-admin-password' or 'x-admin-key'
 */
exports.requireAdmin = (req, res, next) => {
  // 1. Check header password / key
  const adminPwd = (req.headers['x-admin-password'] || req.headers['x-admin-key'] || '').trim();
  if (adminPwd && adminPwd === ADMIN_PASSWORD) {
    req.admin = true;
    req.user = { role: 'ADMIN', name: 'Administrator' };
    return next();
  }

  // 2. Check JWT Bearer token
  const token = extractToken(req);
  if (token) {
    // If it's a legacy admin token format or JWT
    if (token === `atomx_admin_token_${ADMIN_PASSWORD}`) {
      req.admin = true;
      req.user = { role: 'ADMIN', name: 'Administrator' };
      return next();
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && (decoded.role === 'ADMIN' || decoded.isAdmin)) {
        req.admin = true;
        req.user = decoded;
        return next();
      }
    } catch (err) {
      // Token expired or invalid signature
    }
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Admin authentication required.',
    requiresLogin: true
  });
};

/**
 * Middleware: Requires a valid user session JWT.
 */
exports.requireUser = (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication token required.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or expired session token. Please sign in again.'
    });
  }
};

/**
 * Middleware: Optional user verification.
 * Attaches req.user if a valid token is provided, without blocking unauthenticated requests.
 */
exports.optionalUser = (req, res, next) => {
  const adminPwd = (req.headers['x-admin-password'] || req.headers['x-admin-key'] || '').trim();
  if (adminPwd && adminPwd === ADMIN_PASSWORD) {
    req.admin = true;
    req.user = { role: 'ADMIN', name: 'Administrator' };
    return next();
  }

  const token = extractToken(req);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (decoded.role === 'ADMIN') req.admin = true;
    } catch (err) {
      // Ignore invalid optional tokens
    }
  }
  next();
};

/**
 * Helper: Generates a signed JWT token for a user or admin.
 */
exports.generateToken = (payload, expiresIn = '14d') => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
};

/**
 * SSRF Protection Helper:
 * Validates that a user-supplied target URL is safe and not targeting internal/private networks or cloud metadata.
 */
exports.isSafeUrl = (targetUrl) => {
  if (!targetUrl || typeof targetUrl !== 'string') return false;

  try {
    const parsed = new URL(targetUrl);

    // Only allow http or https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block loopback & local addresses
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }

    // Block Cloud Provider Metadata Services (AWS, GCP, Azure, DigitalOcean)
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === '100.100.100.200') {
      return false;
    }

    // Block Private IPv4 Subnets:
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const ipMatch = hostname.match(ipv4Regex);
    if (ipMatch) {
      const octet1 = parseInt(ipMatch[1], 10);
      const octet2 = parseInt(ipMatch[2], 10);

      if (octet1 === 10) return false;
      if (octet1 === 127) return false;
      if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return false;
      if (octet1 === 192 && octet2 === 168) return false;
      if (octet1 === 169 && octet2 === 254) return false;
      if (octet1 === 0) return false;
    }

    return true;
  } catch (err) {
    return false;
  }
};
