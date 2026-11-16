const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const adminMiddleware = require('../middleware/adminMiddleware');

// Protect all routes here with admin middleware
router.use(authMiddleware);
router.use(adminMiddleware);

// @route   GET /api/admin/stats
// @desc    Get dashboard metrics and analysis stats
router.get('/stats', async (req, res) => {
  try {
    // 1. Total users
    const [userCountRows] = await db.query('SELECT COUNT(*) AS total FROM users');
    const totalUsers = userCountRows[0].total;

    // 2. Active credits in system
    const [creditPoolRows] = await db.query('SELECT SUM(credits) AS total FROM users');
    const activeCreditsPool = creditPoolRows[0].total || 0;

    // 3. Total analyses conducted
    const [analysesCountRows] = await db.query('SELECT COUNT(*) AS total FROM resume_analyses');
    const totalAnalyses = analysesCountRows[0].total;

    // 4. Total optimizations conducted
    const [optimizationsCountRows] = await db.query('SELECT COUNT(*) AS total FROM resume_optimizations');
    const totalOptimizations = optimizationsCountRows[0].total;

    // 5. Total cover letters generated
    const [letterCountRows] = await db.query('SELECT COUNT(*) AS total FROM cover_letters');
    const totalCoverLetters = letterCountRows[0].total;

    // 6. Total mock interviews
    const [mockCountRows] = await db.query('SELECT COUNT(*) AS total FROM mock_interviews');
    const totalMockInterviews = mockCountRows[0].total;

    // 7. Credits purchased vs used
    const [transactionsStats] = await db.query(`
      SELECT 
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS totalPurchased,
        ABS(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END)) AS totalConsumed
      FROM credit_transactions
    `);
    const totalPurchased = transactionsStats[0].totalPurchased || 0;
    const totalConsumed = transactionsStats[0].totalConsumed || 0;

    res.json({
      totalUsers,
      activeCreditsPool,
      totalAnalyses,
      totalOptimizations,
      totalCoverLetters,
      totalMockInterviews,
      totalPurchased,
      totalConsumed
    });
  } catch (error) {
    console.error('Fetch Admin Stats Error:', error.message);
    res.status(500).json({ message: 'Server error retrieving system metrics' });
  }
});

// @route   GET /api/admin/users
// @desc    Get list of all users
router.get('/users', async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT id, name, email, credits, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(users);
  } catch (error) {
    console.error('Fetch Users Error:', error.message);
    res.status(500).json({ message: 'Server error retrieving users list' });
  }
});

// @route   PUT /api/admin/users/:id/credits
// @desc    Manually update a user's credit balance
router.put('/users/:id/credits', async (req, res) => {
  const { credits } = req.body;

  if (credits === undefined || isNaN(credits)) {
    return res.status(400).json({ message: 'Please provide a valid credit balance number' });
  }

  const userId = req.params.id;

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // 1. Fetch current credits
    const [userRows] = await connection.query('SELECT credits, name FROM users WHERE id = ?', [userId]);
    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const oldCredits = userRows[0].credits;
    const userName = userRows[0].name;
    const difference = credits - oldCredits;

    if (difference === 0) {
      connection.release();
      return res.json({ message: 'Credits balance is already at target value', credits });
    }

    // 2. Update user
    await connection.query('UPDATE users SET credits = ? WHERE id = ?', [credits, userId]);

    // 3. Log transaction
    const transactionType = difference > 0 ? 'purchase' : 'use';
    const description = `Admin manually adjusted balance from ${oldCredits} to ${credits} (${difference > 0 ? '+' : ''}${difference} credits)`;
    
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [userId, difference, transactionType, description]
    );

    await connection.commit();
    res.json({ message: `Successfully adjusted credits for ${userName}`, credits });

  } catch (error) {
    await connection.rollback();
    console.error('Adjust Credits Error:', error.message);
    res.status(500).json({ message: 'Server error adjusting credit balance' });
  } finally {
    connection.release();
  }
});

// @route   DELETE /api/admin/users/:id
// @desc    Delete a user
router.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;

  if (Number(userId) === req.user.id) {
    return res.status(400).json({ message: 'Access denied: You cannot delete your own admin account' });
  }

  try {
    const [result] = await db.query('DELETE FROM users WHERE id = ?', [userId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ message: 'User account deleted successfully' });
  } catch (error) {
    console.error('Delete User Error:', error.message);
    res.status(500).json({ message: 'Server error deleting user account' });
  }
});

// @route   GET /api/admin/transactions
// @desc    Get audit trail of all transactions in the system
router.get('/transactions', async (req, res) => {
  try {
    const [transactions] = await db.query(`
      SELECT 
        ct.id, 
        ct.user_id, 
        u.name AS user_name, 
        u.email AS user_email, 
        ct.amount, 
        ct.type, 
        ct.description, 
        ct.created_at 
      FROM credit_transactions ct
      JOIN users u ON ct.user_id = u.id
      ORDER BY ct.created_at DESC
    `);
    res.json(transactions);
  } catch (error) {
    console.error('Fetch All Transactions Error:', error.message);
    res.status(500).json({ message: 'Server error retrieving transaction records' });
  }
});

// @route   GET /api/admin/plans
// @desc    Get all pricing plans for editing
router.get('/plans', async (req, res) => {
  try {
    const [plans] = await db.query('SELECT * FROM pricing_plans ORDER BY credits ASC');
    res.json(plans);
  } catch (error) {
    console.error('Fetch Admin Plans Error:', error.message);
    res.status(500).json({ message: 'Server error retrieving pricing plans' });
  }
});

// @route   POST /api/admin/plans
// @desc    Create a new pricing plan
router.post('/plans', async (req, res) => {
  const { name, credits, price, popular, description, features } = req.body;

  if (!name || credits === undefined || price === undefined || !description || !features) {
    return res.status(400).json({ message: 'Please provide name, credits, price, description, and features list' });
  }

  try {
    const featuresStr = typeof features === 'string' ? features : JSON.stringify(features);
    await db.query(
      'INSERT INTO pricing_plans (name, credits, price, popular, description, features) VALUES (?, ?, ?, ?, ?, ?)',
      [name, Number(credits), Number(price), popular ? 1 : 0, description, featuresStr]
    );
    res.status(201).json({ message: 'Pricing plan created successfully' });
  } catch (error) {
    console.error('Create Plan Error:', error.message);
    res.status(500).json({ message: 'Server error creating pricing plan' });
  }
});

// @route   PUT /api/admin/plans/:id
// @desc    Update a pricing plan
router.put('/plans/:id', async (req, res) => {
  const { name, credits, price, popular, description, features } = req.body;
  const planId = req.params.id;

  if (!name || credits === undefined || price === undefined || !description || !features) {
    return res.status(400).json({ message: 'Please provide name, credits, price, description, and features list' });
  }

  try {
    const featuresStr = typeof features === 'string' ? features : JSON.stringify(features);
    const [result] = await db.query(
      'UPDATE pricing_plans SET name = ?, credits = ?, price = ?, popular = ?, description = ?, features = ? WHERE id = ?',
      [name, Number(credits), Number(price), popular ? 1 : 0, description, featuresStr, planId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Pricing plan not found' });
    }
    res.json({ message: 'Pricing plan updated successfully' });
  } catch (error) {
    console.error('Update Plan Error:', error.message);
    res.status(500).json({ message: 'Server error updating pricing plan' });
  }
});

// @route   DELETE /api/admin/plans/:id
// @desc    Delete a pricing plan
router.delete('/plans/:id', async (req, res) => {
  const planId = req.params.id;

  try {
    const [result] = await db.query('DELETE FROM pricing_plans WHERE id = ?', [planId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Pricing plan not found' });
    }
    res.json({ message: 'Pricing plan deleted successfully' });
  } catch (error) {
    console.error('Delete Plan Error:', error.message);
    res.status(500).json({ message: 'Server error deleting pricing plan' });
  }
});

// @route   GET /api/admin/settings
// @desc    Get all system settings
router.get('/settings', async (req, res) => {
  try {
    const [settings] = await db.query('SELECT * FROM system_settings');
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key_name] = s.key_value;
    });
    res.json(settingsMap);
  } catch (error) {
    console.error('Fetch Admin Settings Error:', error.message);
    res.status(500).json({ message: 'Server error retrieving system settings' });
  }
});

// @route   POST /api/admin/settings
// @desc    Update system settings
router.post('/settings', async (req, res) => {
  const { settings } = req.body;

  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ message: 'Please provide settings object to update' });
  }

  try {
    for (const [key, value] of Object.entries(settings)) {
      const valStr = typeof value === 'object' ? JSON.stringify(value) : (typeof value === 'string' ? String(value).trim() : String(value));
      await db.query(
        'INSERT INTO system_settings (key_name, key_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE key_value = ?',
        [key, valStr, valStr]
      );
    }
    res.json({ message: 'System settings updated successfully' });
  } catch (error) {
    console.error('Update Settings Error:', error.message);
    res.status(500).json({ message: 'Server error updating system settings' });
  }
});

module.exports = router;
