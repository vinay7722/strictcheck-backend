const jwt = require('jsonwebtoken');
const db = require('../config/db');

module.exports = async function (req, res, next) {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ message: 'No authorization header found, access denied' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Token formatting error, access denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_ai_resume_analyzer_key_123!');
    const [rows] = await db.query('SELECT id, name, email, credits, role FROM users WHERE id = ?', [decoded.id]);
    
    if (rows.length === 0) {
      return res.status(401).json({ message: 'User matching this token does not exist' });
    }

    req.user = rows[0];
    next();
  } catch (error) {
    console.error('JWT Verification error:', error.message);
    res.status(401).json({ message: 'Token is invalid or expired' });
  }
};
