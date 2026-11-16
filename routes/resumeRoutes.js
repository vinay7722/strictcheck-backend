const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const aiService = require('../services/aiService');

// Multer Setup - Memory storage (to parse buffer directly)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /pdf|docx|txt|octet-stream/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname || mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only PDF, DOCX, and TXT files are allowed'));
  }
});

// Text Extraction Helper
async function extractTextFromBuffer(buffer, originalname, mimetype) {
  const ext = path.extname(originalname).toLowerCase();
  if (mimetype === 'application/pdf' || ext === '.pdf') {
    const parsed = await pdfParse(buffer);
    return parsed.text;
  } else if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else {
    // Treat as plain text
    return buffer.toString('utf8');
  }
}

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Save file to disk helper
function saveFileToDisk(buffer, filename) {
  const filePath = path.join(uploadsDir, Date.now() + '_' + filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// @route   POST /api/resume/analyze
// @desc    Upload resume and perform ATS analysis (Cost: 5 Credits)
router.post('/analyze', authMiddleware, upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Please upload a resume file' });
  }

  // 1. Check credits
  let COST = 5;
  try {
    const [rows] = await db.query('SELECT key_value FROM system_settings WHERE key_name = "cost_analyze"');
    if (rows.length > 0) {
      COST = Number(rows[0].key_value);
    }
  } catch (e) {
    console.error('Error fetching cost_analyze:', e);
  }
  if (req.user.credits < COST) {
    return res.status(400).json({ message: `Insufficient credits. This action requires ${COST} credits.` });
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // 2. Extract text from file
    const resumeText = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!resumeText || resumeText.trim().length < 50) {
      throw new Error('Unable to extract meaningful text from this resume file.');
    }

    // 3. Save resume file to disk and DB
    const savedPath = saveFileToDisk(req.file.buffer, req.file.originalname);
    const [resumeResult] = await connection.query(
      'INSERT INTO resumes (user_id, filename, filepath, filetype) VALUES (?, ?, ?, ?)',
      [req.user.id, req.file.originalname, savedPath, req.file.mimetype]
    );
    const resumeId = resumeResult.insertId;

    // 4. Run AI Analysis
    const analysisResult = await aiService.analyzeResume(resumeText);

    // 5. Deduct credits and log transaction
    await connection.query('UPDATE users SET credits = credits - ? WHERE id = ?', [COST, req.user.id]);
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, -COST, 'use', `Resume analysis for file: ${req.file.originalname}`]
    );

    // 6. Save Analysis to DB
    await connection.query(
      `INSERT INTO resume_analyses 
      (user_id, resume_id, ats_score, grammar_check, keyword_analysis, missing_skills, formatting_suggestions, cost) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        resumeId,
        analysisResult.ats_score,
        analysisResult.grammar_check,
        analysisResult.keyword_analysis,
        analysisResult.missing_skills,
        analysisResult.formatting_suggestions,
        COST
      ]
    );

    await connection.commit();

    // Get updated credits
    const [userRows] = await connection.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    res.json({
      message: 'Analysis completed successfully',
      credits: userRows[0].credits,
      analysis: analysisResult
    });

  } catch (error) {
    await connection.rollback();
    console.error('Resume Analysis Error:', error.message);
    res.status(500).json({ message: error.message || 'Error processing resume analysis' });
  } finally {
    connection.release();
  }
});

// @route   POST /api/resume/optimize
// @desc    Upload resume + paste Job Description for AI optimization (Cost: 10 Credits)
router.post('/optimize', authMiddleware, upload.single('resume'), async (req, res) => {
  const { jobDescription } = req.body;

  if (!req.file) {
    return res.status(400).json({ message: 'Please upload a resume file' });
  }
  if (!jobDescription || jobDescription.trim().length < 50) {
    return res.status(400).json({ message: 'Please provide a detailed Job Description' });
  }

  // 1. Check credits
  let COST = 10;
  try {
    const [rows] = await db.query('SELECT key_value FROM system_settings WHERE key_name = "cost_optimize"');
    if (rows.length > 0) {
      COST = Number(rows[0].key_value);
    }
  } catch (e) {
    console.error('Error fetching cost_optimize:', e);
  }
  if (req.user.credits < COST) {
    return res.status(400).json({ message: `Insufficient credits. This action requires ${COST} credits.` });
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // 2. Extract text from file
    const resumeText = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!resumeText || resumeText.trim().length < 50) {
      throw new Error('Unable to extract text from this resume file.');
    }

    // 3. Save resume to disk and DB
    const savedPath = saveFileToDisk(req.file.buffer, req.file.originalname);
    const [resumeResult] = await connection.query(
      'INSERT INTO resumes (user_id, filename, filepath, filetype) VALUES (?, ?, ?, ?)',
      [req.user.id, req.file.originalname, savedPath, req.file.mimetype]
    );
    const resumeId = resumeResult.insertId;

    // 4. Run AI Optimization
    const optimizationResult = await aiService.optimizeResume(resumeText, jobDescription);

    // 5. Deduct credits and log transaction
    await connection.query('UPDATE users SET credits = credits - ? WHERE id = ?', [COST, req.user.id]);
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, -COST, 'use', `Resume optimization for: ${req.file.originalname}`]
    );

    // 6. Save Optimization to DB
    await connection.query(
      `INSERT INTO resume_optimizations 
      (user_id, resume_id, job_description, optimized_resume_text, skill_recommendations, keyword_improvements, cost) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        resumeId,
        jobDescription,
        optimizationResult.optimized_resume_text,
        optimizationResult.skill_recommendations,
        optimizationResult.keyword_improvements,
        COST
      ]
    );

    await connection.commit();

    // Get updated credits
    const [userRows] = await connection.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    res.json({
      message: 'Optimization completed successfully',
      credits: userRows[0].credits,
      optimization: optimizationResult
    });

  } catch (error) {
    await connection.rollback();
    console.error('Resume Optimization Error:', error.message);
    res.status(500).json({ message: error.message || 'Error processing resume optimization' });
  } finally {
    connection.release();
  }
});

// @route   POST /api/resume/cover-letter
// @desc    Generate Cover Letter from prompt (Cost: 3 Credits)
router.post('/cover-letter', authMiddleware, upload.single('resume'), async (req, res) => {
  const { jobTitle, company, jobDescription } = req.body;

  if (!jobTitle || !jobDescription) {
    return res.status(400).json({ message: 'Please provide Job Title and Job Description' });
  }

  // 1. Check credits
  let COST = 3;
  try {
    const [rows] = await db.query('SELECT key_value FROM system_settings WHERE key_name = "cost_cover_letter"');
    if (rows.length > 0) {
      COST = Number(rows[0].key_value);
    }
  } catch (e) {
    console.error('Error fetching cost_cover_letter:', e);
  }
  if (req.user.credits < COST) {
    return res.status(400).json({ message: `Insufficient credits. This action requires ${COST} credits.` });
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // 2. Extract resume text if uploaded, otherwise use blank
    let resumeText = '';
    if (req.file) {
      resumeText = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    // 3. Generate Cover Letter
    const coverLetterText = await aiService.generateCoverLetter(jobTitle, company, jobDescription, resumeText);

    // 4. Deduct credits and log transaction
    await connection.query('UPDATE users SET credits = credits - ? WHERE id = ?', [COST, req.user.id]);
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, -COST, 'use', `Cover letter generation: ${jobTitle} at ${company || 'Unknown'}`]
    );

    // 5. Save to DB
    await connection.query(
      `INSERT INTO cover_letters 
      (user_id, job_title, company, job_description, cover_letter_text, cost) 
      VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, jobTitle, company || 'Unknown', jobDescription, coverLetterText, COST]
    );

    await connection.commit();

    // Get updated credits
    const [userRows] = await connection.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    res.json({
      message: 'Cover letter generated successfully',
      credits: userRows[0].credits,
      coverLetter: coverLetterText
    });

  } catch (error) {
    await connection.rollback();
    console.error('Cover Letter Generation Error:', error.message);
    res.status(500).json({ message: error.message || 'Error generating cover letter' });
  } finally {
    connection.release();
  }
});

module.exports = router;
