# ATOMX ENGAGE — Chrome Extension (Manifest V3)

> Production-ready, unpacked Chrome Extension for **ATOMX ENGAGE**. Injects 1-click AI replies directly into Twitter/X feeds and features a popup interface that mirrors the desktop design system.

---

## 🔒 Security Architecture Highlights
1. **Zero Secret Keys in Client Bundle:** The OpenAI secret key and Stripe keys NEVER exist inside this extension.
2. **Server-Side Credit Verification:** Balances are strictly validated and atomically deducted on the backend server (`POST /api/generate-reply`).
3. **1 Credit = 1 AI Reply:** Every generation call decrements the user's balance on the server ledger.

---

## 📦 How to Load in Chrome / Brave / Edge

1. Open your browser and navigate to the Extensions management page:
   - Chrome / Brave: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable **Developer mode** toggle in the top-right corner.
3. Click the **Load unpacked** button in the top-left toolbar.
4. Select this directory:
   `C:\Users\user\Documents\VsCode\Next.js\PlayGround\AtomX\chrome-extension`
5. Pin the **ATOMX ENGAGE** icon to your browser toolbar!

---

## ⚡ Features Included
- **Popup UI (420×620):**
  - Live server credit counter (e.g. 10,000 Credits)
  - Auto-detects currently open Tweet on Twitter/X with one click
  - Tone Selector: *Natural & Concise*, *Professional*, *Engaging Question*, *Friendly*, *Witty*
  - AI Engine Selector: *GPT-4o*, *GPT-4o-mini*, *Claude 3.5 Sonnet*
  - Length presets: Short (<100 chars), Medium (~160 chars), Long (280 chars)
  - 1-click "Insert into Tweet" and "Copy to Clipboard"
  - Active Campaign tracking & Pacing statistics
  - Generation audit trail & recent history
- **Twitter/X Content Script (`content.js`):**
  - Injects a discrete branded `AtomX` action button directly beside tweet engagement bars
  - Reads tweet content, communicates with background worker, and automatically types into Twitter's composer
- **Background Service Worker (`background.js`):**
  - Manifest V3 compliant service worker
  - Adds browser Context Menu: *"ATOMX: Generate AI Reply for selection"*
- **Options Page (`options.html`):**
  - Configure target backend API endpoint (e.g., `http://localhost:5000` or production domain)
  - Connection health check tester
