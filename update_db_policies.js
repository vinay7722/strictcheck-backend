const mysql = require('mysql2/promise');
require('dotenv').config();

async function updateDb() {
  try {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'ai_resume_pro',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    console.log('Updating system_settings policies...');
    await pool.query(`UPDATE system_settings SET key_value = '<h1>Terms & Conditions</h1><p>By using AI Resume Pro, you agree to our terms. We provide career optimization diagnostic reports based on generative AI models. All system credit purchases are processed securely via our payment gateway.</p>' WHERE key_name = 'terms_conditions'`);
    await pool.query(`UPDATE system_settings SET key_value = '<h1>Refund Policy</h1><p>Since we provide immediate access to digital services and system credits, purchases are generally non-refundable. For any discrepancies or issues, please contact our support team at strictcheckai@gmail.com.</p>' WHERE key_name = 'refund_policy'`);

    console.log('Updating pricing_plans features...');
    await pool.query(`UPDATE pricing_plans SET features = REPLACE(features, 'Sandbox payment mode', 'Secure payment processing')`);

    console.log('Database updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error updating DB:', error);
    process.exit(1);
  }
}

updateDb();
