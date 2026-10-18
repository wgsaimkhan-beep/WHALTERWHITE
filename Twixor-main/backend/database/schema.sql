-- =====================================================================
-- ATOMX ENGAGE — POSTGRESQL / SUPABASE PRODUCTION DATABASE SCHEMA
-- Strictly server-controlled credits, atomic transactions, audit ledgers
-- =====================================================================

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    handle VARCHAR(80),
    role VARCHAR(20) DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN', 'OWNER')),
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED')),
    plan_tier VARCHAR(50) DEFAULT 'FREE',
    credits INTEGER DEFAULT 100 CHECK (credits >= 0),
    avatar_initials VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. ACCESS REQUESTS (Screen 02 / Screen 13)
CREATE TABLE IF NOT EXISTS access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(120) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    use_case TEXT,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    initial_credits_granted INTEGER DEFAULT 100,
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by UUID REFERENCES users(id)
);

-- 3. CREDITS LEDGER (Screen 09 / Screen 15 / Screen 17)
-- Strictly immutable audit trail of every credit spent or added
CREATE TABLE IF NOT EXISTS credits_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, -- Negative for AI reply (-1), Positive for purchase/bonus (+10000)
    balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
    action VARCHAR(50) NOT NULL, -- 'AI Reply', 'Purchase', 'Bonus', 'Admin Adjustment', 'Thread Gen'
    admin_source VARCHAR(80) DEFAULT 'System',
    reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. CAMPAIGNS (Screen 05)
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    provider VARCHAR(50) DEFAULT 'OpenAI',
    reply_style VARCHAR(80) DEFAULT 'Natural & Concise',
    pacing_delay_sec INTEGER DEFAULT 12 CHECK (pacing_delay_sec >= 1),
    break_after_count INTEGER DEFAULT 30,
    break_duration_sec INTEGER DEFAULT 60,
    is_running BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. REPLY QUEUE (Screen 06 / Screen 07)
CREATE TABLE IF NOT EXISTS reply_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tweet_author VARCHAR(100) NOT NULL,
    tweet_handle VARCHAR(100) NOT NULL,
    tweet_content TEXT NOT NULL,
    reply_content TEXT,
    tone VARCHAR(60) DEFAULT 'Natural & Concise',
    model VARCHAR(60) DEFAULT 'gpt-4o-mini',
    status VARCHAR(20) DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'PROCESSING', 'COMPLETED', 'FAILED')),
    error_message TEXT,
    credit_cost INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 6. SUBSCRIPTION PLANS (Screen 10 / Screen 16)
CREATE TABLE IF NOT EXISTS plans (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    price_monthly NUMERIC(10, 2) NOT NULL,
    credits_monthly INTEGER NOT NULL,
    is_popular BOOLEAN DEFAULT FALSE,
    features JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. TRANSACTIONS / INVOICES (Screen 17)
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) REFERENCES plans(id),
    amount_usd NUMERIC(10, 2) NOT NULL,
    credits_added INTEGER NOT NULL,
    stripe_session_id VARCHAR(255),
    status VARCHAR(20) DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED', 'REFUNDED', 'FAILED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES FOR HIGH-THROUGHPUT QUEUES & LEDGERS
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_ledger_user_date ON credits_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_user_status ON reply_queue(user_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);

-- 8. ENGAGED TWEETS TABLE (Anti-Duplicate & History Tracker)
CREATE TABLE IF NOT EXISTS engaged_tweets (
    tweet_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) DEFAULT '1',
    handle VARCHAR(80),
    canonical_url TEXT,
    action_type VARCHAR(50) DEFAULT 'REPLY',
    engaged_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_engaged_user ON engaged_tweets(user_id);

