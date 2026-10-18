/**
 * TWIXOR — MAIN SERVER ENTRY POINT (Render / Node / Vercel compatible)
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');

// Optional hardening packages: a missing module must never crash the whole API (login included)
function optionalRequire(name) {
  try { return require(name); } catch (e) { console.warn(`[boot] optional package "${name}" not installed — continuing without it`); return null; }
}
const helmet = optionalRequire('helmet');
const compression = optionalRequire('compression');
const rateLimit = optionalRequire('express-rate-limit');

const persistence = require('./services/persistence');
persistence.install();
const supabase = require('./config/supabase');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Behind Render's proxy: without this EVERY user shares one IP and the rate limiter blocks logins
app.set('trust proxy', 1);
app.disable('x-powered-by');

if (compression) app.use(compression({ threshold: 1024 }));
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));
}

app.use(cors({
  origin: true, // reflect origin: web app, chrome-extension://, anything
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'x-admin-password', 'x-admin-key', 'x-admin-token', 'x-user-handle', 'x-user-email'],
  maxAge: 86400
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- Rate limiters (per real client IP) ----------
function limiter(opts) {
  if (!rateLimit) return (req, res, next) => next();
  return rateLimit({ standardHeaders: true, legacyHeaders: false, validate: { xForwardedForHeader: false }, ...opts });
}
const authLimiter = limiter({
  windowMs: 15 * 60 * 1000, max: 120, skipSuccessfulRequests: true,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' }
});
const aiLimiter = limiter({
  windowMs: 60 * 1000, max: 60,
  message: { error: 'AI generation rate limit exceeded. Please wait a moment before sending another request.' }
});
const generalLimiter = limiter({
  windowMs: 15 * 60 * 1000, max: 3000,
  skip: (req) => req.path.startsWith('/admin'),
  message: { error: 'Too many requests. Please slow down.' }
});

// ---------- Health (cheap; used by Render + keep-alive) ----------
app.get(['/health', '/healthz'], async (req, res) => {
  const out = {
    status: 'healthy',
    service: 'Twixor API',
    version: '1.1.0',
    database: supabase ? 'configured' : 'MISSING (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  };
  if (req.query.deep && supabase) { // /health?deep=1 verifies the database really answers
    try {
      const t0 = Date.now();
      const { error } = await supabase.from('users').select('id', { count: 'exact', head: true });
      out.databaseReachable = !error;
      out.databaseLatencyMs = Date.now() - t0;
      if (error) out.databaseError = error.message;
    } catch (e) { out.databaseReachable = false; out.databaseError = e.message; }
  }
  res.json(out);
});

// ---------- Restore admin settings from DB before the first real request ----------
const restoreReady = Promise.race([
  persistence.restore().catch(() => null),
  new Promise(r => setTimeout(r, 10000))
]);
app.use(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/healthz') return next();
  await restoreReady;
  next();
});

// ---------- Friendly JSON error when the database is not configured ----------
const DB_FREE_PATHS = ['/auth/admin-login', '/auth/verify-admin-key'];
app.use('/api', (req, res, next) => {
  if (supabase) return next();
  const p = req.path;
  const needsDb = (p.startsWith('/auth/') && !DB_FREE_PATHS.includes(p)) ||
    p.startsWith('/credits') || p.startsWith('/tweets') || p.startsWith('/campaigns') ||
    p.startsWith('/queue') || p === '/generate-reply' || p === '/ai/generate';
  if (!needsDb) return next();
  return res.status(503).json({
    error: 'Server database is not configured. The server owner must set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on Render.',
    code: 'DB_NOT_CONFIGURED'
  });
});

// ---------- Request log (skip noisy polling) ----------
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path.startsWith('/api/admin') || req.path === '/health')) return next();
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.url}`);
  next();
});

app.use('/api/auth/', authLimiter);
app.use('/api/generate-reply', aiLimiter);
app.use('/api/ai/generate', aiLimiter);
app.use('/api/', generalLimiter);

// ---------- API ----------
app.use('/api', apiRoutes);

// ---------- Static frontend (admin panel) ----------
const frontendCandidates = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'backend', 'public'),
  path.join(process.cwd(), 'public'),
  path.join(__dirname, '..')
];
const frontendPath = frontendCandidates.find(p => fs.existsSync(path.join(p, 'index.html'))) || path.join(__dirname, 'public');
app.use(express.static(frontendPath, {
  etag: true,
  maxAge: '10m',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/health')) return next();
  const indexPath = path.join(frontendPath, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.send('<!DOCTYPE html><html><head><title>Twixor</title></head><body style="background:#0b0f19;color:#fff;font-family:sans-serif;padding:40px;"><h2>Twixor</h2><p>API &amp; Backend Active.</p></body></html>');
});

app.use('/api', (req, res) => res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` }));

// ---------- Global error handler (always JSON) ----------
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Internal Server Error', message: err.message });
});

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// ---------- Start ----------
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`  ⚡ TWIXOR SERVER RUNNING ON PORT ${PORT}`);
    console.log(`  🗄️  Database: ${supabase ? 'Supabase connected' : 'NOT CONFIGURED'}`);
    if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'atomx2026') console.warn(`  ⚠️  Default ADMIN_PASSWORD in use — set a strong one!`);
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('atomx_super_secret')) console.warn(`  ⚠️  Default JWT_SECRET in use — set a random one!`);
    console.log(`======================================================\n`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // Render free plan sleeps after ~15 min idle (next request then takes ~50 s). Self-ping keeps it awake.
  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
  if (publicUrl && String(process.env.KEEP_ALIVE || 'true').toLowerCase() !== 'false') {
    setInterval(() => { fetch(`${publicUrl.replace(/\/+$/, '')}/health`).catch(() => null); }, 10 * 60 * 1000).unref();
    console.log(`[keep-alive] pinging ${publicUrl}/health every 10 minutes`);
  }

  const shutdown = () => { try { persistence.flushAll(); } catch (e) {} setTimeout(() => process.exit(0), 800); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
