# Twixor — Render (Free plan) deploy

1. **Supabase**: SQL Editor -> paste `backend/database/render_setup.sql` -> Run (once).
2. **GitHub**: push this folder to your repo (do NOT commit `.env`).
3. **Render**: New + -> Blueprint -> select the repo. Fill:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase -> Project Settings -> API)
   - `ADMIN_PASSWORD` (what you type on the admin login)
   - AI keys are optional (can be added from the admin panel).
4. Open `https://<your-service>.onrender.com/health?deep=1` — it must show `"databaseReachable": true`.
5. Admin panel = the same URL (`/`). Extension: set the same URL in `chrome-extension/popup.js` + `background.js`
   (`DEFAULT_BACKEND_URL`) or in the extension Options page.

Notes: the server pings itself every 10 min so the free instance stays awake; admin settings are mirrored
into Supabase (`app_kv`) so they survive restarts/redeploys.
