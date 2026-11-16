const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { initializeDatabase } = require('./config/db');

// Route imports
const authRoutes = require('./routes/authRoutes');
const creditRoutes = require('./routes/creditRoutes');
const resumeRoutes = require('./routes/resumeRoutes');
const interviewRoutes = require('./routes/interviewRoutes');
const adminRoutes = require('./routes/adminRoutes');

// Initialize config
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// Serve static uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const paymentRoutes = require('./routes/paymentRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/interview', interviewRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentRoutes);

// Public endpoints for pricing plans and settings
app.get('/api/public/plans', async (req, res) => {
  const db = require('./config/db');
  try {
    const [plans] = await db.query('SELECT * FROM pricing_plans ORDER BY credits ASC');
    res.json(plans);
  } catch (error) {
    console.error('Fetch public plans error:', error.message);
    res.status(500).json({ message: 'Error fetching pricing plans' });
  }
});

app.get('/api/public/settings', async (req, res) => {
  const db = require('./config/db');
  try {
    const [settings] = await db.query('SELECT * FROM system_settings WHERE key_name NOT IN ("gemini_api_key", "razorpay_secret", "cashfree_secret_key", "phonepe_client_secret", "phonepe_webhook_password", "payu_merchant_salt")');
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key_name] = s.key_value;
    });
    res.json(settingsMap);
  } catch (error) {
    console.error('Fetch public settings error:', error.message);
    res.status(500).json({ message: 'Error fetching system settings' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Serve static client build files from 'admin' directory in production
app.use(express.static(path.join(__dirname, 'admin')));

// Wildcard routing to serve React app for client-side navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// 404 handler for API routes (always return JSON, never HTML)
app.use('/api', (req, res) => {
  res.status(404).json({ message: `API route not found: ${req.method} ${req.originalUrl}. Please restart the backend server.` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err.message);
  res.status(500).json({ message: err.message || 'An internal server error occurred' });
});

// Connect to Database and start Server
async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  });
}

startServer();
