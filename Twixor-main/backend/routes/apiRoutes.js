/**
 * ATOMX ENGAGE — API ROUTES
 */
const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const creditController = require('../controllers/creditController');
const aiController = require('../controllers/aiController');
const campaignController = require('../controllers/campaignController');
const adminController = require('../controllers/adminController');
const { requireAdmin, optionalUser } = require('../middleware/authMiddleware');

// API Root & Health Overview
router.get('/', (req, res) => {
  res.json({
    service: 'ATOMX ENGAGE — Multi-Provider API Network',
    status: 'online',
    version: '1.0.0',
    webApp: 'http://localhost:5000/',
    adminDashboard: 'http://localhost:5000/#admin',
    endpoints: {
      activeModel: '/api/admin/active-model',
      providers: '/api/providers',
      toneStyles: '/api/tone-styles',
      credits: '/api/credits/balance',
      engagedTweets: '/api/tweets/engaged'
    }
  });
});

// Auth & Access
router.post('/auth/login', authController.login);
router.post('/auth/admin-login', authController.adminLogin);
router.get('/auth/verify-admin-key', authController.verifyAdminKey);
router.post('/auth/request-access', authController.requestAccess);
router.get('/auth/check-status', authController.checkAccessStatus);
router.post('/auth/set-password', authController.setPassword);
router.post('/auth/request-password-reset', authController.requestPasswordReset);
router.post('/auth/reset-password', authController.resetPassword);
router.post('/auth/change-password', authController.changePassword);
router.post('/auth/request-review', authController.requestReview);
router.get('/auth/me', optionalUser, authController.getCurrentUser);

// Server-Controlled Credits
router.get('/credits/balance', optionalUser, creditController.getBalance);
router.post('/credits/deduct', optionalUser, creditController.deductCredit);
router.get('/credits/ledger', optionalUser, creditController.getLedger);

// AI Generation & Multi-Provider Engine
router.get('/providers', aiController.getProviders);
router.get('/providers/:provider/models', optionalUser, aiController.getProviderModels);
router.post('/generate-reply', optionalUser, aiController.generateReply);
router.post('/ai/generate', optionalUser, aiController.generateReply);

// Campaigns & Queue
router.get('/campaigns', optionalUser, campaignController.getCampaigns);
router.get('/queue', optionalUser, campaignController.getQueue);
router.post('/queue', optionalUser, campaignController.addToQueue);

// Smart Tweet Extraction, Format Normalization & Anti-Duplicate Engine
router.post('/tweets/parse-and-filter', optionalUser, campaignController.parseAndFilterTweets);
router.get('/tweets/engaged', optionalUser, campaignController.getEngagedTweets);
router.post('/tweets/mark-engaged', optionalUser, campaignController.markTweetsEngaged);
router.post('/tweets/clear-engaged', optionalUser, campaignController.clearEngagedTweets);

// Admin Control Panel (Strictly protected with requireAdmin)
router.get('/admin/stats', requireAdmin, adminController.getStats);
router.get('/admin/users', requireAdmin, adminController.getUsers);
router.post('/admin/toggle-user-status', requireAdmin, adminController.toggleUserStatus);
router.get('/admin/access-requests', requireAdmin, adminController.getAccessRequests);
router.post('/admin/approve-request', requireAdmin, adminController.approveRequest);
router.post('/admin/reject-request', requireAdmin, adminController.rejectRequest);
router.post('/admin/adjust-credits', requireAdmin, adminController.adjustCredits);
router.post('/admin/set-user-password', requireAdmin, adminController.setUserPassword);
router.post('/admin/update-user-plan', requireAdmin, adminController.updateUserPlan);
router.post('/admin/delete-user', requireAdmin, adminController.deleteUser);
router.get('/admin/password-requests', requireAdmin, adminController.getPasswordRequests);
router.post('/admin/resolve-password-request', requireAdmin, adminController.resolvePasswordRequest);
router.get('/admin/plans', requireAdmin, adminController.getPlans);
router.get('/plans', adminController.getPlans);
router.post('/admin/save-plans', requireAdmin, adminController.savePlans);
router.get('/admin/transactions', requireAdmin, adminController.getTransactions);
router.post('/admin/transactions', requireAdmin, adminController.createTransaction);
router.get('/admin/ledger', requireAdmin, adminController.getGlobalLedger);
router.post('/admin/clean-all-data', requireAdmin, adminController.wipeAllUsers);
router.post('/admin/wipe-all-users', requireAdmin, adminController.wipeAllUsers);

// Curated Lists & Sorsa Score Targets Management
router.get('/curated-lists', adminController.getCuratedLists);
router.post('/admin/curated-lists', requireAdmin, adminController.saveCuratedLists);

// Active AI Provider & Model Management
router.get('/admin/active-model', requireAdmin, adminController.getActiveModel);
router.post('/admin/active-model', requireAdmin, adminController.saveActiveModel);

// Failover Cascade Providers Chain (Max 5 Providers)
router.get('/admin/failover-providers', requireAdmin, adminController.getFailoverProviders);
router.post('/admin/failover-providers', requireAdmin, adminController.saveFailoverProviders);
router.post('/admin/test-failover-chain', requireAdmin, adminController.testFailoverChain);

// Dynamic AI API Keys Management
router.get('/admin/api-keys', requireAdmin, adminController.getApiKeys);
router.post('/admin/api-keys', requireAdmin, adminController.saveApiKey);
router.post('/admin/save-provider-config', requireAdmin, adminController.saveProviderConfig);
router.post('/admin/test-single-key', requireAdmin, adminController.testSingleKey);

// Tone & Style Templates Management
router.get('/tone-styles', adminController.getToneStyles);
router.post('/admin/tone-styles', requireAdmin, adminController.saveToneStyles);

// Live AI API Telemetry & Key Health Testing
router.get('/admin/api-logs', requireAdmin, adminController.getApiLogs);
router.get('/admin/test-keys', requireAdmin, adminController.testProviderKeys);

// Referral Management & User Referral Stats
router.get('/referrals/stats', (req, res) => {
  const referralService = require('../services/referralService');
  const stats = referralService.getUserReferralStats(req.query.handle || req.query.user);
  res.json(stats);
});
router.get('/admin/referrals', requireAdmin, adminController.getReferrals);
router.post('/admin/referrals/approve', requireAdmin, adminController.approveReferral);

// Promotional Special Offers (FOUNDING 100)
router.get('/offers/current', adminController.getOffer);
router.post('/admin/offers', requireAdmin, adminController.saveOffer);

// Universal Version & Update Engine
router.get('/system/version', adminController.getSystemVersion);

// Agent Status & Killswitch Management (Admin on/off with custom maintenance reason)
router.get('/agents/status', adminController.getAgentStatus);
router.get('/admin/agents/status', requireAdmin, adminController.getAgentStatus);
router.post('/admin/agents/status', requireAdmin, adminController.saveAgentStatus);

module.exports = router;
