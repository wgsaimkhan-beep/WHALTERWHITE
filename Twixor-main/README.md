# ATOMX ENGAGE — Production Workspace & System Architecture

> **ATOMX ENGAGE** is an original, luxury AI-powered engagement and content workspace engineered across Desktop Web, Chrome Extension (Manifest V3), Mobile Web / PWA, and Admin Control Panel — all sharing one unified design system, backend API, and server-controlled security architecture.

---

## 🎨 Unified Design System & Visual Identity

* **Brand Wordmark:** Geometric `ATOMX` (bold) + `ENGAGE` (lighter sub-mark).
* **Personality:** Minimal SaaS, Luxury, Clean, Professional, High-End. No neon, no dark gaming, no cyberpunk.
* **Canvas Background:** `#F7F8FA`
* **Card & Surface Background:** `#FFFFFF` (12–18px border-radius, 1px `#E7E9ED` subtle border, soft diffuse shadows)
* **Primary Text:** `#111318`
* **Secondary Text:** `#6B7280`
* **Muted Text:** `#9CA3AF`
* **Primary Brand Blue:** `#3157E6`
* **Soft Blue Tint:** `#EAF0FF`
* **Success Green:** `#22A06B`
* **Warning Amber:** `#D99000`
* **Error Red:** `#D64545`
* **Typography:** Inter / SF Pro (Google Fonts Inter included)

---

## 🔒 Security & Business Logic Rules

1. **Server as Single Source of Truth:**
   - Credit balances are maintained and calculated strictly on the backend database.
   - The frontend never controls or trusts client-side credit math.
2. **OpenAI API Key Isolation:**
   - The OpenAI API secret key is **never** bundled inside the Chrome Extension or frontend scripts.
   - All AI generation requests route through `POST /api/generate-reply` where the backend validates authentication, checks `credits >= 1`, executes the generation, deducts 1 credit, and returns the result.
3. **1 Credit = 1 AI Reply:**
   - Free account automatically receives 100 credits upon admin approval.
   - Paid tiers (Growth: 10,000 credits, Pro: 25,000 credits) replenish credit balances atomically via Stripe webhooks.

---

## 🧩 Architectural Components

```
AtomX/
├── index.html                    # Unified Desktop & Responsive presentation SPA
├── style.css                     # Complete Design System & responsive transforms
├── app.js                        # Interactive state machine & 19 interactive screens
│
├── chrome-extension/             # Unpacked Chrome Extension (Manifest V3)
│   ├── manifest.json             # MV3 manifest definition with permissions & content scripts
│   ├── popup.html                # 420×620 Luxury popup with live credits & tweet detection
│   ├── popup.css                 # Matching ATOMX design system stylesheet
│   ├── popup.js                  # Extension controller (no client secrets)
│   ├── background.js             # Service worker with context menu & message router
│   ├── content.js                # Twitter/X content script for inline 'AtomX' reply injection
│   ├── content.css               # Discrete styled action buttons on Twitter/X feeds
│   ├── options.html              # Extension backend endpoint and preferences configuration
│   ├── options.js                # Settings persistence controller
│   ├── icons/                    # Standalone PNG & SVG brand icons (16, 32, 48, 128)
│   └── README.md                 # Unpacked loading guide for Chrome/Edge/Brave
│
├── backend/                      # Production Node.js & Express API Backend
│   ├── package.json              # Express, CORS, Dotenv configuration
│   ├── server.js                 # Unified API server + static frontend host
│   ├── .env.example              # Environment variables template
│   ├── config/
│   │   └── db.js                 # Relational database engine with atomic credit math & seed
│   ├── services/
│   │   └── openaiService.js      # Server-isolated OpenAI integration with fallback synthesis
│   ├── controllers/
│   │   ├── authController.js     # Login, Access requests, current user
│   │   ├── creditController.js   # Server-truth balances & ledger audits
│   │   ├── aiController.js       # Atomic 1-credit reply generation
│   │   ├── campaignController.js # Queue & workflow pacing (10-15s delays, breaks)
│   │   └── adminController.js    # User management, 100 free credit approvals, status toggle
│   ├── routes/
│   │   └── apiRoutes.js          # RESTful routing definition
│   ├── database/
│   │   ├── schema.sql            # PostgreSQL production schema
│   │   └── supabase_migration.sql# Supabase RLS policies and atomic deduction triggers
│   └── test/
│       └── api.test.js           # Automated test suite (6 passing test suites)
│
├── Dockerfile                    # Multi-stage production container
├── docker-compose.yml            # Containerized backend + PostgreSQL service
├── Procfile                      # Railway & Heroku process definition
├── railway.json                  # Railway deployment specifications
└── vercel.json                   # Vercel serverless deployment specification
```

---

## 🚀 How to Run Locally

### 1. Web App Prototype (Standalone)
Open `index.html` directly in any web browser. Use the top presentation toolbar to inspect any of the **19 screens** or test **Mobile**, **Tablet**, **Chrome Extension**, and **Desktop** viewports.

### 2. Full-Stack Backend Server
```bash
cd backend
npm install
npm test       # Runs the automated test suite (6/6 tests passing)
npm start      # Starts server on http://localhost:5000
```
When running, visit:
- **API Health:** `http://localhost:5000/health`
- **API Endpoints:** `http://localhost:5000/api/...`
- **Integrated Full-Stack App:** `http://localhost:5000`

### 3. Load the Chrome Extension (Manifest V3)
1. Open Google Chrome, Brave, or Edge and go to `chrome://extensions` (or `edge://extensions`).
2. Toggle on **Developer mode** in the top right.
3. Click **Load unpacked** and select the folder:
   `AtomX/chrome-extension`
4. Click the pinned ATOMX icon to open the popup, or visit `x.com`/`twitter.com` to see inline reply buttons.

---

## 🚢 Production Deployment

### Docker & Docker Compose
```bash
docker-compose up --build -d
```
Starts the Node.js API container on port 5000 alongside PostgreSQL 16 with pre-configured schemas.

### Railway / Render
Use the included [railway.json](file:///c:/Users/user/Documents/VsCode/Next.js/PlayGround/AtomX/railway.json) or [Procfile](file:///c:/Users/user/Documents/VsCode/Next.js/PlayGround/AtomX/Procfile). Set `OPENAI_API_KEY` in environment variables.

### Vercel
Deploy directly using [vercel.json](file:///c:/Users/user/Documents/VsCode/Next.js/PlayGround/AtomX/vercel.json) to host the static UI and serverless API endpoints simultaneously.

---

## 🎨 Standalone UI Screenshots Status (Screens 14–19)
- **Live Interactive Experience:** All Screens 14 to 19 are rendered and functional in the interactive application via the top screen switcher.
- **Image Generation Quota:** Standalone photorealistic renders for Screens 01–13 exist; generation for Screens 14–19 will resume once the API quota resets. Pre-engineered luxury prompts are ready to execute.
