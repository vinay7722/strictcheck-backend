const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// @route   POST /api/auth/register
// @desc    Register a new user
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Please provide name, email, and password' });
  }

  try {
    // Check if user exists
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert user (default 100 credits)
    const [result] = await db.query(
      'INSERT INTO users (name, email, password, credits, role) VALUES (?, ?, ?, ?, ?)',
      [name, email, hashedPassword, 100, 'client']
    );

    const userId = result.insertId;

    // Log registration transaction (100 welcome credits)
    await db.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [userId, 100, 'purchase', 'Welcome bonus credits']
    );

    // Create JWT
    const payload = { id: userId, role: 'client' };
    const token = jwt.sign(payload, process.env.JWT_SECRET || 'super_secret_ai_resume_analyzer_key_123!', {
      expiresIn: '24h',
    });

    res.status(201).json({
      token,
      user: {
        id: userId,
        name,
        email,
        credits: 100,
        role: 'client',
      },
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide email and password' });
  }

  try {
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Create JWT
    const payload = { id: user.id, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET || 'super_secret_ai_resume_analyzer_key_123!', {
      expiresIn: '24h',
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Profile is already set on req.user by authMiddleware
    res.json({ user: req.user });
  } catch (error) {
    console.error('Fetch profile error:', error.message);
    res.status(500).json({ message: 'Server error fetching user profile' });
  }
});

// @route   POST /api/auth/auto-login
// @desc    Auto login/register via cross-domain payload
router.post('/auto-login', async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ message: 'No data provided' });

  const cryptoHelper = require('../helpers/cryptoHelper');
  const payload = cryptoHelper.decryptPayload(data);
  if (!payload) return res.status(400).json({ message: 'Invalid or expired data' });

  const { email, name, source, orderId, amount, packageName, paymentvia } = payload;
  if (!email) return res.status(400).json({ message: 'Email not found in payload' });

  try {
    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    let user;
    if (users.length === 0) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(email, salt); // Password is email
      const [result] = await db.query(
        'INSERT INTO users (name, email, password, credits, role) VALUES (?, ?, ?, ?, ?)',
        [name || email.split('@')[0], email, hashedPassword, 100, 'client']
      );
      
      const userId = result.insertId;
      await db.query(
        'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
        [userId, 100, 'purchase', 'Welcome bonus credits (Auto-login)']
      );
      
      user = { id: userId, name: name || email.split('@')[0], email, credits: 100, role: 'client' };
    } else {
      user = users[0];
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'super_secret_ai_resume_analyzer_key_123!', {
      expiresIn: '24h',
    });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits,
        role: user.role,
      },
      streakchatData: { source, orderId, amount, packageName, paymentvia }
    });
  } catch (error) {
    console.error('Auto-login error:', error.message);
    res.status(500).json({ message: 'Server error during auto-login' });
  }
});

module.exports = router;
