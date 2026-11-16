const db = require('./config/db');
const aiService = require('./services/aiService');
const dotenv = require('dotenv');

dotenv.config();

async function testConnection() {
  console.log('--- Database & Service Verification ---');
  console.log('1. Initializing database schema...');
  try {
    await db.initializeDatabase();
    console.log('✓ Database connected and tables verified.');

    // Print summary stats
    const [userRows] = await db.query('SELECT COUNT(*) AS count FROM users');
    console.log(`✓ System has ${userRows[0].count} users configured.`);

    const [adminRows] = await db.query('SELECT name, email, role FROM users WHERE role = "admin"');
    console.log('✓ Registered Admin accounts:');
    adminRows.forEach(admin => {
      console.log(`  - ${admin.name} (${admin.email})`);
    });

    console.log('\n2. Verifying AI Service mode...');
    if (process.env.GEMINI_API_KEY) {
      console.log('✓ GEMINI_API_KEY detected. Running in Google Gemini AI Mode.');
    } else {
      console.log('⚠️ No GEMINI_API_KEY detected. Running in high-fidelity Mock AI Mode.');
    }

    // Try a mock test
    console.log('\n3. Running basic AI pipeline verification...');
    const analysis = await aiService.analyzeResume("John Doe. Software Developer. JavaScript, React, SQL.");
    console.log('✓ AI Analysis parsed successfully:');
    console.log(`  - Mock ATS Score: ${analysis.ats_score}%`);
    console.log(`  - Suggested Keywords: ${analysis.keyword_analysis.slice(0, 80)}...`);

    console.log('\n=======================================');
    console.log('Verification Success: All systems operational.');
    console.log('=======================================');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Verification Failed:', error.message);
    process.exit(1);
  }
}

testConnection();
