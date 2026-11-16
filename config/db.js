const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
};

let pool;

async function initializeDatabase() {
  try {
    // Connect without database selected first
    const connection = await mysql.createConnection(dbConfig);

    // Create DB if not exists
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'ai_resume_db'}\``);
    await connection.end();

    // Reconnect with database selected
    pool = mysql.createPool({
      ...dbConfig,
      database: process.env.DB_NAME || 'ai_resume_db',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    console.log('Database connection pool established successfully.');

    // Run table creation scripts
    await createTables();

    // Seed admin user
    await seedAdmin();

  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
}

async function createTables() {
  const usersTable = `
    CREATE TABLE IF NOT EXISTS \`users\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`name\` VARCHAR(255) NOT NULL,
      \`email\` VARCHAR(255) NOT NULL UNIQUE,
      \`password\` VARCHAR(255) NOT NULL,
      \`credits\` INT DEFAULT 100,
      \`role\` ENUM('client', 'admin') DEFAULT 'client',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `;

  const resumesTable = `
    CREATE TABLE IF NOT EXISTS \`resumes\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`filename\` VARCHAR(255) NOT NULL,
      \`filepath\` VARCHAR(255) NOT NULL,
      \`filetype\` VARCHAR(50) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const creditTransactionsTable = `
    CREATE TABLE IF NOT EXISTS \`credit_transactions\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`amount\` INT NOT NULL,
      \`type\` ENUM('purchase', 'use') NOT NULL,
      \`description\` VARCHAR(255) NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const resumeAnalysesTable = `
    CREATE TABLE IF NOT EXISTS \`resume_analyses\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`resume_id\` INT NOT NULL,
      \`ats_score\` INT NOT NULL,
      \`grammar_check\` TEXT,
      \`keyword_analysis\` TEXT,
      \`missing_skills\` TEXT,
      \`formatting_suggestions\` TEXT,
      \`cost\` INT DEFAULT 5,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`resume_id\`) REFERENCES \`resumes\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const resumeOptimizationsTable = `
    CREATE TABLE IF NOT EXISTS \`resume_optimizations\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`resume_id\` INT NOT NULL,
      \`job_description\` TEXT,
      \`optimized_resume_text\` LONGTEXT,
      \`skill_recommendations\` TEXT,
      \`keyword_improvements\` TEXT,
      \`cost\` INT DEFAULT 10,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
      FOREIGN KEY (\`resume_id\`) REFERENCES \`resumes\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const coverLettersTable = `
    CREATE TABLE IF NOT EXISTS \`cover_letters\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`job_title\` VARCHAR(255),
      \`company\` VARCHAR(255),
      \`job_description\` TEXT,
      \`cover_letter_text\` LONGTEXT,
      \`cost\` INT DEFAULT 3,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const interviewQuestionsTable = `
    CREATE TABLE IF NOT EXISTS \`interview_questions\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`job_title\` VARCHAR(255) NOT NULL,
      \`experience\` VARCHAR(100) NOT NULL,
      \`questions_json\` TEXT,
      \`cost\` INT DEFAULT 5,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const mockInterviewsTable = `
    CREATE TABLE IF NOT EXISTS \`mock_interviews\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`user_id\` INT NOT NULL,
      \`job_title\` VARCHAR(255) NOT NULL,
      \`experience\` VARCHAR(100) NOT NULL,
      \`total_questions\` INT DEFAULT 5,
      \`questions_json\` TEXT,
      \`status\` ENUM('in_progress', 'completed') DEFAULT 'in_progress',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const mockInterviewDialoguesTable = `
    CREATE TABLE IF NOT EXISTS \`mock_interview_dialogues\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`interview_id\` INT NOT NULL,
      \`question\` TEXT NOT NULL,
      \`answer\` TEXT,
      \`feedback\` TEXT,
      \`score\` INT DEFAULT 0,
      \`cost\` INT DEFAULT 2,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (\`interview_id\`) REFERENCES \`mock_interviews\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const pricingPlansTable = `
    CREATE TABLE IF NOT EXISTS \`pricing_plans\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`credits\` INT NOT NULL,
      \`price\` INT NOT NULL,
      \`popular\` TINYINT DEFAULT 0,
      \`description\` VARCHAR(255) NOT NULL,
      \`features\` TEXT NOT NULL,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `;

  const systemSettingsTable = `
    CREATE TABLE IF NOT EXISTS \`system_settings\` (
      \`key_name\` VARCHAR(100) PRIMARY KEY,
      \`key_value\` TEXT NOT NULL
    ) ENGINE=InnoDB;
  `;

  const paymentOrdersTable = `
    CREATE TABLE IF NOT EXISTS \`payment_orders\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`order_id\` VARCHAR(100) UNIQUE NOT NULL,
      \`user_id\` INT NOT NULL,
      \`package_id\` INT NOT NULL,
      \`amount\` INT NOT NULL,
      \`credits\` INT NOT NULL,
      \`gateway\` VARCHAR(50) NOT NULL,
      \`status\` ENUM('pending', 'success', 'failed') NOT NULL DEFAULT 'pending',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  await pool.query(usersTable);
  await pool.query(resumesTable);
  await pool.query(creditTransactionsTable);
  await pool.query(resumeAnalysesTable);
  await pool.query(resumeOptimizationsTable);
  await pool.query(coverLettersTable);
  await pool.query(interviewQuestionsTable);
  await pool.query(mockInterviewsTable);
  await pool.query(mockInterviewDialoguesTable);
  await pool.query(pricingPlansTable);
  await pool.query(systemSettingsTable);
  await pool.query(paymentOrdersTable);

  try {
    await pool.query('ALTER TABLE `payment_orders` MODIFY COLUMN `gateway` VARCHAR(50) NOT NULL');
  } catch (err) {
    // Ignore if column is already modified
  }
}

async function seedAdmin() {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', ['admin@resume.com']);
    if (rows.length === 0) {
      const hashedPassword = await bcrypt.hash('adminpassword', 10);
      await pool.query(
        'INSERT INTO users (name, email, password, credits, role) VALUES (?, ?, ?, ?, ?)',
        ['System Admin', 'admin@resume.com', hashedPassword, 999999, 'admin']
      );
      console.log('Seeded default admin user: admin@resume.com / adminpassword');
    }

    // Seed pricing plans
    const [plans] = await pool.query('SELECT * FROM pricing_plans');
    if (plans.length === 0) {
      const initialPlans = [
        [20, 149, 0, 'Perfect for basic resume optimization and a short practice session.', '["20 System credits", "All AI features unlocked", "Real-time ATS reports", "Secure payment processing"]'],
        [50, 249, 1, 'Most Popular. Complete cover letter creation & mock interviews.', '["50 System credits", "All AI features unlocked", "Priority AI processing queue", "Secure payment processing"]'],
        [100, 449, 0, 'Perfect for active job seekers targeting multiple roles.', '["100 System credits", "All AI features unlocked", "Dedicated support logs access", "Secure payment processing"]'],
        [250, 999, 0, 'Ultimate package for extensive practice and matching.', '["250 System credits", "All AI features unlocked", "Bulk file scan capabilities", "Secure payment processing"]']
      ];
      for (const plan of initialPlans) {
        await pool.query(
          'INSERT INTO pricing_plans (credits, price, popular, description, features) VALUES (?, ?, ?, ?, ?)',
          plan
        );
      }
      console.log('Seeded default pricing plans.');
    }

    // Seed system settings
    const [settings] = await pool.query('SELECT * FROM system_settings');
    if (settings.length === 0) {
      const initialSettings = [
        ['referral_commission_percent', '10'],
        ['min_payout_amount', '500'],
        ['payout_methods', '["UPI", "Bank Transfer"]'],
        ['cost_analyze', '5'],
        ['cost_optimize', '10'],
        ['cost_cover_letter', '3'],
        ['cost_interview_prep', '5'],
        ['cost_mock_interview', '2']
      ];
      for (const setting of initialSettings) {
        await pool.query(
          'INSERT INTO system_settings (key_name, key_value) VALUES (?, ?)',
          setting
        );
      }
      console.log('Seeded default system settings.');
    }

    // Seed default legal policies individually if they do not exist
    const policiesToSeed = [
      ['privacy_policy', '<h1>Privacy Policy</h1><p>Welcome to AI Resume Pro. We value your privacy. Your career documents uploaded to our pipelines are parsed directly in-memory, scanned securely via Gemini AI instances, and immediately garbage-collected without persistence.</p>'],
      ['terms_conditions', '<h1>Terms & Conditions</h1><p>By using AI Resume Pro, you agree to our terms. We provide career optimization diagnostic reports based on generative AI models. All system credit purchases are processed securely via our payment gateway.</p>'],
      ['refund_policy', '<h1>Refund Policy</h1><p>Since we provide immediate access to digital services and system credits, purchases are generally non-refundable. For any discrepancies or issues, please contact our support team at strictcheckai@gmail.com.</p>']
    ];
    for (const [key, value] of policiesToSeed) {
      const [exists] = await pool.query('SELECT 1 FROM system_settings WHERE key_name = ?', [key]);
      if (exists.length === 0) {
        await pool.query('INSERT INTO system_settings (key_name, key_value) VALUES (?, ?)', [key, value]);
      }
    }
  } catch (error) {
    console.error('Error seeding admin user or settings:', error.message);
  }
}

module.exports = {
  initializeDatabase,
  query: (sql, params) => pool.query(sql, params),
  getPool: () => pool
};
