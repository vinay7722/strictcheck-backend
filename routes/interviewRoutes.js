const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const aiService = require('../services/aiService');

// Multer Setup - Memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

// Text Extraction Helper
async function extractTextFromBuffer(buffer, originalname, mimetype) {
  const ext = path.extname(originalname).toLowerCase();
  try {
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
      return buffer.toString('utf8');
    }
  } catch (err) {
    console.error('Error parsing file buffer in interview prep:', err.message);
    return '';
  }
}

// Helper to extract text from saved resume file
async function getResumeText(resumeId, userId) {
  if (!resumeId) return '';
  try {
    const [rows] = await db.query('SELECT filepath FROM resumes WHERE id = ? AND user_id = ?', [resumeId, userId]);
    if (rows.length > 0) {
      const filePath = rows[0].filepath;
      if (fs.existsSync(filePath)) {
        // If it's a binary file (pdf/docx), reading it as utf8 directly won't give clean text.
        // But for mock/simple fallback, or if we read text, we can use this.
        // Better yet: we can just check if we have a parsed cached version, or just read the first 2000 chars of stringified buffer.
        // To be safe, we will try to read it.
        const content = fs.readFileSync(filePath, 'utf8');
        return content.replace(/[^\x20-\x7E\n\r]/g, '').slice(0, 5000); // clean non-printable chars
      }
    }
  } catch (err) {
    console.error('Error reading resume file for interview prep:', err.message);
  }
  return '';
}

// @route   POST /api/interview/questions
// @desc    Generate a list of interview questions (Cost: 5 Credits)
router.post('/questions', authMiddleware, upload.single('resume'), async (req, res) => {
  const { jobTitle, experience, resumeId } = req.body;

  if (!jobTitle || !experience) {
    return res.status(400).json({ message: 'Please provide Job Title and Experience Level' });
  }

  // 1. Check credits
  let COST = 5;
  try {
    const [rows] = await db.query('SELECT key_value FROM system_settings WHERE key_name = "cost_interview_prep"');
    if (rows.length > 0) {
      COST = Number(rows[0].key_value);
    }
  } catch (e) {
    console.error('Error fetching cost_interview_prep:', e);
  }
  if (req.user.credits < COST) {
    return res.status(400).json({ message: `Insufficient credits. This action requires ${COST} credits.` });
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // 2. Fetch resume text if file uploaded, else check resumeId from db
    let resumeText = '';
    if (req.file) {
      resumeText = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
    } else if (resumeId) {
      resumeText = await getResumeText(resumeId, req.user.id);
    }

    // 3. Generate questions
    const questions = await aiService.generateInterviewQuestions(jobTitle, experience, resumeText);

    // 4. Deduct credits and log transaction
    await connection.query('UPDATE users SET credits = credits - ? WHERE id = ?', [COST, req.user.id]);
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, -COST, 'use', `Interview Question Generation for: ${jobTitle}`]
    );

    // 5. Save to DB
    await connection.query(
      'INSERT INTO interview_questions (user_id, job_title, experience, questions_json, cost) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, jobTitle, experience, JSON.stringify(questions), COST]
    );

    await connection.commit();

    // Get updated credits
    const [userRows] = await connection.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    res.json({
      message: 'Questions generated successfully',
      credits: userRows[0].credits,
      questions
    });

  } catch (error) {
    await connection.rollback();
    console.error('Question Generation Error:', error.message);
    res.status(500).json({ message: 'Error generating interview questions' });
  } finally {
    connection.release();
  }
});

// @route   POST /api/interview/mock/start
// @desc    Start a new mock interview session (No initial cost; 2 credits per question answered)
router.post('/mock/start', authMiddleware, upload.single('resume'), async (req, res) => {
  const { jobTitle, experience, resumeId } = req.body;

  if (!jobTitle || !experience) {
    return res.status(400).json({ message: 'Please provide Job Title and Experience Level' });
  }

  try {
    let resumeText = '';
    if (req.file) {
      resumeText = await extractTextFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
    } else if (resumeId) {
      resumeText = await getResumeText(resumeId, req.user.id);
    }

    // Pre-generate the set of questions for the mock interview
    const questions = await aiService.generateInterviewQuestions(jobTitle, experience, resumeText);

    const [result] = await db.query(
      'INSERT INTO mock_interviews (user_id, job_title, experience, total_questions, questions_json, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, jobTitle, experience, questions.length, JSON.stringify(questions), 'in_progress']
    );

    res.json({
      message: 'Mock interview session started',
      interviewId: result.insertId,
      questions: questions,
      firstQuestion: questions[0]
    });
  } catch (error) {
    console.error('Start Mock Interview Error:', error.message);
    res.status(500).json({ message: 'Error starting mock interview session' });
  }
});

// @route   POST /api/interview/mock/answer
// @desc    Submit answer to a mock interview question (Cost: 2 Credits)
router.post('/mock/answer', authMiddleware, async (req, res) => {
  const { interviewId, questionIndex, question, answer } = req.body;

  if (interviewId === undefined || questionIndex === undefined || !question || !answer) {
    return res.status(400).json({ message: 'Please provide interviewId, questionIndex, question, and answer' });
  }

  // 1. Check credits
  let COST = 2;
  try {
    const [rows] = await db.query('SELECT key_value FROM system_settings WHERE key_name = "cost_mock_interview"');
    if (rows.length > 0) {
      COST = Number(rows[0].key_value);
    }
  } catch (e) {
    console.error('Error fetching cost_mock_interview:', e);
  }
  if (req.user.credits < COST) {
    return res.status(400).json({ message: `Insufficient credits. Answering a mock question costs ${COST} credits.` });
  }

  const connection = await db.getPool().getConnection();
  try {
    await connection.beginTransaction();

    // Verify interview belongs to user and is in progress
    const [interviews] = await connection.query(
      'SELECT job_title, experience, questions_json FROM mock_interviews WHERE id = ? AND user_id = ? AND status = "in_progress"',
      [interviewId, req.user.id]
    );

    if (interviews.length === 0) {
      throw new Error('Active mock interview session not found');
    }

    const { job_title, experience, questions_json } = interviews[0];
    const questions = JSON.parse(questions_json);

    // 2. Evaluate answer using AI
    const evaluation = await aiService.evaluateMockAnswer(job_title, experience, question, answer);

    // 3. Deduct credits and log transaction
    await connection.query('UPDATE users SET credits = credits - ? WHERE id = ?', [COST, req.user.id]);
    await connection.query(
      'INSERT INTO credit_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
      [req.user.id, -COST, 'use', `Mock interview Q#${Number(questionIndex) + 1} evaluation`]
    );

    // 4. Save dialogue to database
    await connection.query(
      'INSERT INTO mock_interview_dialogues (interview_id, question, answer, feedback, score, cost) VALUES (?, ?, ?, ?, ?, ?)',
      [interviewId, question, answer, evaluation.feedback, evaluation.score, COST]
    );

    // 5. Check if it was the last question
    const isLastQuestion = Number(questionIndex) >= questions.length - 1;
    let nextQuestion = null;

    if (isLastQuestion) {
      // Mark mock interview as completed
      await connection.query('UPDATE mock_interviews SET status = "completed" WHERE id = ?', [interviewId]);
    } else {
      nextQuestion = questions[Number(questionIndex) + 1];
    }

    await connection.commit();

    // Get updated credits
    const [userRows] = await connection.query('SELECT credits FROM users WHERE id = ?', [req.user.id]);

    res.json({
      feedback: evaluation.feedback,
      score: evaluation.score,
      credits: userRows[0].credits,
      isLastQuestion,
      nextQuestion
    });

  } catch (error) {
    await connection.rollback();
    console.error('Evaluate Answer Error:', error.message);
    res.status(500).json({ message: error.message || 'Error processing response evaluation' });
  } finally {
    connection.release();
  }
});

// @route   GET /api/interview/mock/summary/:id
// @desc    Get summary of a completed mock interview
router.get('/mock/summary/:id', authMiddleware, async (req, res) => {
  try {
    const [interviews] = await db.query(
      'SELECT id, job_title, experience, status, created_at FROM mock_interviews WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (interviews.length === 0) {
      return res.status(404).json({ message: 'Mock interview session not found' });
    }

    const [dialogues] = await db.query(
      'SELECT question, answer, feedback, score, created_at FROM mock_interview_dialogues WHERE interview_id = ? ORDER BY id ASC',
      [req.params.id]
    );

    let averageScore = 0;
    if (dialogues.length > 0) {
      const sum = dialogues.reduce((acc, curr) => acc + curr.score, 0);
      averageScore = Math.round(sum / dialogues.length);
    }

    res.json({
      interview: interviews[0],
      dialogues,
      averageScore
    });
  } catch (error) {
    console.error('Fetch Summary Error:', error.message);
    res.status(500).json({ message: 'Error retrieving mock interview summary' });
  }
});

module.exports = router;
