/**
 * ATOMX ENGAGE — SUPABASE CLIENT & REPOSITORY SERVICE
 * Connected using SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 */
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    console.log('✓ [Supabase] Client initialized successfully with Service Role Key');
  } catch (err) {
    console.warn('⚠️ [Supabase] Failed to initialize client:', err.message);
  }
} else {
  console.warn('⚠️ [Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}

module.exports = supabase;
