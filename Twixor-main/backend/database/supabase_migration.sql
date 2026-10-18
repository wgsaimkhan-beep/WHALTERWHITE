-- =====================================================================
-- ATOMX ENGAGE — SUPABASE MIGRATION SCRIPT (RLS & AUTOMATION)
-- =====================================================================

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

-- 1. Users can read their own profile, Admins can read all
CREATE POLICY "Users can view own profile"
  ON users FOR SELECT
  USING (auth.uid() = id OR EXISTS (
    SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'OWNER')
  ));

-- 2. Strictly prohibit direct client updates to the 'credits' column
CREATE POLICY "Users can only view their own credit ledger"
  ON credits_ledger FOR SELECT
  USING (auth.uid() = user_id OR EXISTS (
    SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('ADMIN', 'OWNER')
  ));

-- 3. Stored Procedure: Atomic Server-Side Credit Deduction (1 Credit = 1 AI Reply)
CREATE OR REPLACE FUNCTION deduct_credit_for_ai_reply(
    target_user_id UUID,
    reply_reason TEXT DEFAULT 'Generated reply'
) RETURNS INTEGER AS $$
DECLARE
    current_bal INTEGER;
    new_bal INTEGER;
BEGIN
    SELECT credits INTO current_bal FROM users WHERE id = target_user_id FOR UPDATE;
    
    IF current_bal IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF current_bal < 1 THEN
        RAISE EXCEPTION 'Insufficient credits';
    END IF;

    new_bal := current_bal - 1;

    -- Update balance
    UPDATE users SET credits = new_bal WHERE id = target_user_id;

    -- Record immutable ledger entry
    INSERT INTO credits_ledger (user_id, amount, balance_after, action, admin_source, reason)
    VALUES (target_user_id, -1, new_bal, 'AI Reply', 'Server System', reply_reason);

    RETURN new_bal;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Stored Procedure: Admin Approves Request and Allocates 100 Free Credits
CREATE OR REPLACE FUNCTION approve_access_request(
    request_id UUID,
    admin_id UUID
) RETURNS UUID AS $$
DECLARE
    req_record RECORD;
    new_user_id UUID;
BEGIN
    SELECT * INTO req_record FROM access_requests WHERE id = request_id;
    IF req_record IS NULL THEN
        RAISE EXCEPTION 'Access request not found';
    END IF;

    -- Create active user with 100 free approved credits
    INSERT INTO users (email, password_hash, full_name, role, status, plan_tier, credits, avatar_initials)
    VALUES (
        req_record.email,
        'approved_user_hash',
        req_record.full_name,
        'USER',
        'ACTIVE',
        'FREE',
        100,
        UPPER(SUBSTRING(req_record.full_name, 1, 2))
    ) RETURNING id INTO new_user_id;

    -- Mark request as approved
    UPDATE access_requests
    SET status = 'APPROVED', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = admin_id
    WHERE id = request_id;

    -- Credit ledger entry
    INSERT INTO credits_ledger (user_id, amount, balance_after, action, admin_source, reason)
    VALUES (new_user_id, 100, 100, 'Initial Grant', 'Admin Approval', 'Approved onboarding with 100 free credits');

    RETURN new_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
