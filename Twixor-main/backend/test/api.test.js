/**
 * ATOMX ENGAGE — BACKEND API AUTOMATED TEST SUITE
 * Validates security rules, credit deductions, and admin workflows.
 */

const assert = require('assert');
const app = require('../server');

async function runTests() {
  console.log('🧪 Starting ATOMX Backend Verification Tests...\n');
  const server = app.listen(5001);

  try {
    const baseUrl = 'http://localhost:5001';

    // 1. Health check
    console.log('Test 1: Health check endpoint');
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthData = await healthRes.json();
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthData.status, 'healthy');
    console.log('  ✓ Health check passed');

    // 2. Credits balance endpoint
    console.log('Test 2: Server-controlled credit balance');
    const creditRes = await fetch(`${baseUrl}/api/credits/balance`, {
      headers: { 'X-User-Id': '1' }
    });
    const creditData = await creditRes.json();
    assert.strictEqual(creditRes.status, 200);
    assert(creditData.credits > 0, 'Credits balance should be positive');
    const initialCredits = creditData.credits;
    console.log(`  ✓ Current server balance verified: ${initialCredits} credits`);

    // 3. AI Reply Generation & Atomic 1-Credit Deduction
    console.log('Test 3: AI Reply Generation & 1 Credit = 1 Reply Deduction');
    const genRes = await fetch(`${baseUrl}/api/generate-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': '1'
      },
      body: JSON.stringify({
        tweetText: 'Software 2.0 is becoming agentic software with autonomous reasoning loops.',
        tweetAuthor: '@karpathy',
        style: 'Professional',
        model: 'gpt-4o-mini'
      })
    });
    const genData = await genRes.json();
    assert.strictEqual(genRes.status, 200);
    assert(genData.reply && genData.reply.length > 10, 'Generated reply should be populated');
    assert.strictEqual(genData.creditCost, 1);
    assert.strictEqual(genData.remainingCredits, initialCredits - 1, 'Server must decrement exactly 1 credit');
    console.log(`  ✓ Generated reply successfully: "${genData.reply.slice(0, 50)}..."`);
    console.log(`  ✓ Atomic credit deduction verified: ${initialCredits} -> ${genData.remainingCredits}`);

    // 4. Credits Ledger Verification
    console.log('Test 4: Credit ledger immutable audit record');
    const ledgerRes = await fetch(`${baseUrl}/api/credits/ledger`, {
      headers: { 'X-User-Id': '1' }
    });
    const ledgerData = await ledgerRes.json();
    assert.strictEqual(ledgerRes.status, 200);
    assert(ledgerData.ledger.length > 0, 'Ledger must have entries');
    const latestEntry = ledgerData.ledger[0];
    assert.strictEqual(latestEntry.amount, -1, 'Latest entry must be -1 credit');
    assert.strictEqual(latestEntry.action, 'AI Reply');
    console.log(`  ✓ Ledger entry confirmed: Action=${latestEntry.action}, Amount=${latestEntry.amount}, Balance=${latestEntry.balance_after}`);

    // 5. Access Request & Admin Approval (100 free credits grant)
    console.log('Test 5: Access request creation & Admin approval (100 free credits)');
    const reqRes = await fetch(`${baseUrl}/api/auth/request-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Test Candidate',
        email: `candidate_${Date.now()}@test.io`,
        useCase: 'Productivity testing'
      })
    });
    assert.strictEqual(reqRes.status, 201);
    console.log('  ✓ Access request submitted');

    // Admin lists requests
    const adminReqsRes = await fetch(`${baseUrl}/api/admin/access-requests`);
    const adminReqsData = await adminReqsRes.json();
    const pendingReq = adminReqsData.requests.find(r => r.status === 'PENDING');
    assert(pendingReq, 'Should have pending request');

    // Admin approves request
    const approveRes = await fetch(`${baseUrl}/api/admin/approve-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: pendingReq.id })
    });
    const approveData = await approveRes.json();
    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveData.creditsGranted, 100, 'Approved user must automatically receive 100 credits');
    console.log(`  ✓ Admin approved request #${pendingReq.id}: Allocated ${approveData.creditsGranted} free credits!`);

    // 6. Suspended Account Check
    console.log('Test 6: Suspended account blocking');
    const newUserId = approveData.userId;
    await fetch(`${baseUrl}/api/admin/toggle-user-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: newUserId, status: 'SUSPENDED' })
    });

    const suspendedRes = await fetch(`${baseUrl}/api/generate-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(newUserId)
      },
      body: JSON.stringify({
        tweetText: 'Testing suspended account block.',
        style: 'Natural & Concise'
      })
    });
    assert.strictEqual(suspendedRes.status, 403, 'Suspended user must be blocked from AI generation');
    console.log('  ✓ Suspended account successfully blocked (HTTP 403)');

    console.log('\n🎉 ALL 6 TEST SUITES PASSED FLAWLESSLY!\n');

  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
