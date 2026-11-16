const express = require('express');
const router = express.Router();
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// @route   GET /api/credits/history
// @desc    Get user credit transaction history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const [transactions] = await db.query(
      'SELECT id, amount, type, description, created_at FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(transactions);
  } catch (error) {
    console.error('Fetch transaction history error:', error.message);
    res.status(500).json({ message: 'Server error fetching transaction history' });
  }
});

// @route   POST /api/credits/purchase
// @desc    Simulate purchasing credits
router.post('/purchase', authMiddleware, async (req, res) => {
  const { amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ message: 'Please provide a valid credit amount to purchase' });
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // 1. Update user credits
    await connection.query(
      'UPDATE users SET credits = credits + ? WHERE id = ?',
      [amount, req.user.id]
    );

    // 2. Insert transaction log
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, amount, 'purchase', `Purchased ${amount} credits (Simulated Payment)`]
    );

    await connection.commit();

    // Fetch updated credits
    const [rows] = await connection.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);
    const updatedCredits = rows[0].credits;

    res.json({
      message: `Successfully purchased ${amount} credits`,
      credits: updatedCredits
    });
  } catch (error) {
    await connection.rollback();
    console.error('Credit purchase transaction error:', error.message);
    res.status(500).json({ message: 'Server error processing transaction' });
  } finally {
    connection.release();
  }
});

// @route   GET /api/credits/costs
// @desc    Get dynamic credit costs for all tools
router.get('/costs', authMiddleware, async (req, res) => {
  try {
    const [settings] = await db.query('SELECT * FROM system_settings');
    const costs = {
      cost_analyze: 5,
      cost_optimize: 10,
      cost_cover_letter: 3,
      cost_interview_prep: 5,
      cost_mock_interview: 2
    };
    settings.forEach(s => {
      if (s.key_name === 'cost_analyze') costs.cost_analyze = Number(s.key_value);
      if (s.key_name === 'cost_optimize') costs.cost_optimize = Number(s.key_value);
      if (s.key_name === 'cost_cover_letter') costs.cost_cover_letter = Number(s.key_value);
      if (s.key_name === 'cost_interview_prep') costs.cost_interview_prep = Number(s.key_value);
      if (s.key_name === 'cost_mock_interview') costs.cost_mock_interview = Number(s.key_value);
    });
    res.json(costs);
  } catch (error) {
    console.error('Fetch credit costs error:', error.message);
    res.status(500).json({ message: 'Server error fetching dynamic costs' });
  }
});

module.exports = router;
