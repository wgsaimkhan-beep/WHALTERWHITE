/**
 * TWIXOR — PERSISTENT SETTINGS (Render free plan friendly)
 *
 * Render's free plan has an EPHEMERAL disk: every spin-down / redeploy wipes files, so admin settings
 * saved into backend/data/*.json (AI keys & models, tone styles, curated lists, agent switches,
 * offers, referrals, plans) would silently revert.
 *
 * This module mirrors those JSON files into one Supabase table (app_kv):
 *   - on boot  : restore the files from the database before any request is served
 *   - on write : (debounced) copy the file content to the database
 * No other code has to change: it simply watches fs.writeFileSync on the data directory.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const supabase = require('../config/supabase');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PERSIST = new Set([
  'aiSettings.json', 'toneStyles.json', 'curatedLists.json', 'agentsStatus.json',
  'specialOffers.json', 'referrals.json', 'plans.json', 'apiKeys.json'
]);

const origWriteFileSync = fs.writeFileSync.bind(fs);
const pending = new Map();
let warned = false;
let installed = false;

function warnTable(err) {
  if (warned) return;
  warned = true;
  console.warn('[persistence] Table "app_kv" not usable — run backend/database/render_setup.sql in Supabase SQL Editor. (' + (err?.message || err) + ')');
}

async function pushNow(name, text) {
  if (!supabase) return;
  try {
    const value = JSON.parse(text);
    const { error } = await supabase.from('app_kv').upsert({ key: name, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) warnTable(error);
  } catch (e) { /* not JSON / network hiccup: next write retries */ }
}

function schedule(name, data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  clearTimeout(pending.get(name)?.timer);
  const timer = setTimeout(() => { pending.delete(name); pushNow(name, text); }, 1500);
  pending.set(name, { timer, text });
}

function install() {
  if (installed) return;
  installed = true;
  fs.writeFileSync = function patchedWriteFileSync(file, data, ...rest) {
    const result = origWriteFileSync(file, data, ...rest);
    try {
      if (supabase && typeof file === 'string' && path.dirname(path.resolve(file)) === DATA_DIR) {
        const name = path.basename(file);
        if (PERSIST.has(name)) schedule(name, data);
      }
    } catch (e) {}
    return result;
  };
}

async function restore() {
  if (!supabase) return { restored: 0 };
  let restored = 0;
  try {
    const { data, error } = await supabase.from('app_kv').select('key,value');
    if (error) { warnTable(error); return { restored: 0 }; }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const row of data || []) {
      if (!PERSIST.has(row.key)) continue;
      try {
        origWriteFileSync(path.join(DATA_DIR, row.key), JSON.stringify(row.value, null, 2), 'utf8');
        for (const dir of [os.tmpdir(), '/tmp']) { try { fs.unlinkSync(path.join(dir, row.key)); } catch (e) {} } // stale tmp copies win reads otherwise
        restored++;
      } catch (e) {}
    }
  } catch (e) { warnTable(e); }
  if (restored) console.log(`[persistence] Restored ${restored} settings file(s) from database.`);
  return { restored };
}

function flushAll() {
  for (const [name, p] of pending.entries()) { clearTimeout(p.timer); pushNow(name, p.text); }
  pending.clear();
}

module.exports = { install, restore, flushAll };
