const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const db = require('../config/db');

dotenv.config();

let cachedApiKey = null;
let cachedGenAI = null;

async function getGenAI() {
  try {
    const [rows] = await db.query('SELECT key_value FROM system_settings WHERE key_name = "gemini_api_key"');
    const dbKey = (rows.length > 0 && rows[0].key_value.trim()) ? rows[0].key_value.trim() : null;
    const activeKey = dbKey || process.env.GEMINI_API_KEY || null;

    if (activeKey !== cachedApiKey) {
      cachedApiKey = activeKey;
      cachedGenAI = activeKey ? new GoogleGenerativeAI(activeKey) : null;
    }
  } catch (err) {
    console.error("Error fetching gemini_api_key from db, checking env:", err);
    const activeKey = process.env.GEMINI_API_KEY || null;
    if (activeKey !== cachedApiKey) {
      cachedApiKey = activeKey;
      cachedGenAI = activeKey ? new GoogleGenerativeAI(activeKey) : null;
    }
  }
  return cachedGenAI;
}

// Helper: Safely parse JSON from a markdown code block or plain text
function cleanAndParseJson(text, fallback) {
  try {
    // Remove markdown code fence if present
    let cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (err) {
    console.warn("Failed to parse JSON from AI response, using regex extraction or fallback.", err);
    return fallback;
  }
}

// -------------------------------------------------------------
// Real Gemini AI Methods
// -------------------------------------------------------------

// Free-tier Gemini models in priority order.
// On 429 (quota exhausted) or 404 (model unavailable) the next is tried.
const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite-preview-06-17",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro-latest",
];

async function runGeminiPrompt(prompt) {
  const aiInstance = await getGenAI();
  if (!aiInstance) throw new Error("Gemini API not configured");

  let lastError;
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = aiInstance.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      console.log(`Gemini: success with model "${modelName}"`);
      return response.text();
    } catch (err) {
      const msg = String(err?.message ?? err?.status ?? "");
      const isQuota     = msg.includes("429");
      const isNotFound  = msg.includes("404");
      const isOverloaded = msg.includes("503") || msg.toLowerCase().includes("high demand") || msg.toLowerCase().includes("service unavailable");
      if (isQuota || isNotFound || isOverloaded) {
        const reason = isQuota ? "quota" : isNotFound ? "not found" : "overloaded";
        console.warn(`Gemini model "${modelName}" failed (${reason}), trying next...`);
        lastError = err;
        continue;
      }
      // Non-retriable error (e.g. 400 bad key) — throw immediately
      throw err;
    }
  }
  throw lastError ?? new Error("All Gemini models exhausted");
}

async function analyzeResumeReal(resumeText) {
  const prompt = `
    You are an expert ATS (Applicant Tracking System) reviewer and hiring manager.
    Analyze the following resume text and provide a structured JSON response.
    Return ONLY a valid JSON object matching this structure:
    {
      "ats_score": 75, // integer between 0 and 100
      "grammar_check": "Detailed feedback on grammar, typos, and tone.",
      "keyword_analysis": "Identify key industries, concepts, and terminologies found in the resume.",
      "missing_skills": "List critical skills or keywords that are missing relative to industry standards.",
      "formatting_suggestions": "Bullet point advice on structure, font spacing, and layout issues."
    }

    Resume text:
    ${resumeText}
  `;
  try {
    const text = await runGeminiPrompt(prompt);
    return cleanAndParseJson(text, mockAnalyzeResume(resumeText));
  } catch (err) {
    console.error("Gemini analyzeResume failed, falling back to mock", err);
    return mockAnalyzeResume(resumeText);
  }
}

async function optimizeResumeReal(resumeText, jobDescription) {
  const prompt = `
    You are an AI Resume Optimizer.
    Analyze the following resume against the job description.
    Provide suggestions and an optimized draft.
    Return ONLY a valid JSON object matching this structure:
    {
      "optimized_resume_text": "A full, professional rewritten text version of the resume aligned with the job description.",
      "skill_recommendations": "Specific skills to add or highlight based on the job requirements.",
      "keyword_improvements": "Keywords from the job description that should be integrated, explaining where."
    }

    Resume:
    ${resumeText}

    Job Description:
    ${jobDescription}
  `;
  try {
    const text = await runGeminiPrompt(prompt);
    return cleanAndParseJson(text, mockOptimizeResume(resumeText, jobDescription));
  } catch (err) {
    console.error("Gemini optimizeResume failed, falling back to mock", err);
    return mockOptimizeResume(resumeText, jobDescription);
  }
}

async function generateCoverLetterReal(jobTitle, company, jobDescription, resumeText) {
  const prompt = `
    You are an AI Cover Letter Writer.
    Write a tailored, professional cover letter for the role of ${jobTitle} at ${company || 'the target company'}.
    Use the candidate's resume for skills and match the job description's tone.
    Return ONLY the cover letter text, properly spaced and professionally formatted.

    Job Description:
    ${jobDescription}

    Candidate Resume:
    ${resumeText}
  `;
  try {
    return await runGeminiPrompt(prompt);
  } catch (err) {
    console.error("Gemini generateCoverLetter failed, falling back to mock", err);
    return mockGenerateCoverLetter(jobTitle, company, jobDescription, resumeText);
  }
}

async function generateInterviewQuestionsReal(jobTitle, experience, resumeText) {
  const prompt = `
    You are an experienced interviewer. 
    Generate a list of 5 interview questions for a candidate applying for the "${jobTitle}" position with "${experience}" of experience.
    Use the provided resume text to make them contextual.
    Include 2 Technical questions, 2 Behavioral questions (STAR method), and 1 general HR/Fit question.
    Return ONLY a valid JSON array matching this structure:
    [
      { "question": "Question 1", "type": "Technical" },
      { "question": "Question 2", "type": "Behavioral" },
      ...
    ]

    Resume Text:
    ${resumeText || 'No resume uploaded.'}
  `;
  try {
    const text = await runGeminiPrompt(prompt);
    return cleanAndParseJson(text, mockGenerateQuestions(jobTitle, experience, resumeText));
  } catch (err) {
    console.error("Gemini generateQuestions failed, falling back to mock", err);
    return mockGenerateQuestions(jobTitle, experience, resumeText);
  }
}

async function evaluateMockAnswerReal(jobTitle, experience, question, answer) {
  const prompt = `
    You are a technical recruiter. Evaluate the candidate's answer for the following question.
    Job: ${jobTitle}
    Experience: ${experience}
    Question: ${question}
    Candidate's Answer: ${answer}

    Provide feedback, score (1 to 100), and a suggestion for improving the answer.
    Return ONLY a valid JSON object matching this structure:
    {
      "feedback": "Detailed constructive evaluation of their response.",
      "score": 82 // integer from 0 to 100
    }
  `;
  try {
    const text = await runGeminiPrompt(prompt);
    return cleanAndParseJson(text, mockEvaluateAnswer(jobTitle, experience, question, answer));
  } catch (err) {
    console.error("Gemini evaluateMockAnswer failed, falling back to mock", err);
    return mockEvaluateAnswer(jobTitle, experience, question, answer);
  }
}


// -------------------------------------------------------------
// High-Fidelity Mock AI Fallbacks
// -------------------------------------------------------------

function extractSkills(text) {
  if (!text) return [];
  const commonSkills = [
    'javascript', 'typescript', 'react', 'node', 'express', 'mysql', 'mongodb', 'python',
    'java', 'c++', 'html', 'css', 'git', 'aws', 'docker', 'kubernetes', 'rest api', 'graphql',
    'project management', 'agile', 'scrum', 'sql', 'postgres', 'nosql', 'devops', 'ci/cd'
  ];
  const found = [];
  const clean = text.toLowerCase();
  commonSkills.forEach(skill => {
    if (clean.includes(skill)) {
      // capitalize
      found.push(skill.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
    }
  });
  return found;
}

function mockAnalyzeResume(resumeText) {
  const skills = extractSkills(resumeText);
  const atsScore = Math.min(95, Math.max(45, 50 + skills.length * 5));
  
  const missingSkills = [];
  const allCore = ['React', 'NodeJS', 'Express', 'MySQL', 'Git', 'AWS', 'TypeScript', 'Docker'];
  allCore.forEach(c => {
    if (!skills.includes(c) && !skills.map(s => s.toLowerCase()).includes(c.toLowerCase())) {
      missingSkills.push(c);
    }
  });
  if (missingSkills.length === 0) missingSkills.push('Docker', 'CI/CD Pipelines');

  return {
    ats_score: atsScore,
    grammar_check: "• The grammar and syntax look professional throughout.\n• Good usage of action verbs like 'Developed', 'Led', 'Optimized'.\n• Recommended tweak: Ensure dates have a consistent format (e.g. Month Year or MM/YYYY) across all roles.",
    keyword_analysis: `• Strong indicators found for: ${skills.join(', ') || 'General Development'}.\n• Good density of technical terminology.\n• Recommend expanding on impact and metrics rather than listing only tasks.`,
    missing_skills: missingSkills.join(', '),
    formatting_suggestions: "• Avoid multi-column templates as they sometimes parse poorly in older ATS scanners.\n• Ensure margins are at least 0.75 inches on all sides.\n• Check that your header only contains clean text - no icons, tables or text boxes for phone/email."
  };
}

function mockOptimizeResume(resumeText, jobDescription) {
  const jdSkills = extractSkills(jobDescription);
  const resumeSkills = extractSkills(resumeText);
  
  const recommendedAdditions = jdSkills.filter(x => !resumeSkills.includes(x));
  const improvements = recommendedAdditions.length > 0
    ? `Integrate keywords like: ${recommendedAdditions.join(', ')} into your experience bullets.`
    : "Your skills match the job description keywords well! Focus on highlighting measurable metrics (e.g., 'increased performance by 25%').";

  let optimizedResume = resumeText || "Candidate Resume Text\n\nExperience:\n- Software Engineer\n- Developed applications using React and Node.";
  if (recommendedAdditions.length > 0) {
    optimizedResume += `\n\n[Optimized Technical Skills Section: Added ${recommendedAdditions.join(', ')}]`;
  }

  return {
    optimized_resume_text: optimizedResume + "\n\n(Optimized for ATS with enhanced keywords match and action verb adjustments)",
    skill_recommendations: recommendedAdditions.join(', ') || "No major missing skills identified, optimize your projects section to use STAR format.",
    keyword_improvements: improvements
  };
}

function mockGenerateCoverLetter(jobTitle, company, jobDescription, resumeText) {
  const nameMatch = resumeText ? resumeText.match(/([A-Z][a-z]+ [A-Z][a-z]+)/) : null;
  const name = nameMatch ? nameMatch[0] : "John Doe";
  const skills = extractSkills(resumeText).slice(0, 4);

  return `Dear Hiring Team,

I am writing to express my strong interest in the ${jobTitle || 'Software Engineer'} position at ${company || 'your company'}. With a strong background in developing scalable solutions and a proven track record of driving technical efficiency, I am excited about the opportunity to contribute to your team.

My technical expertise aligns well with your requirements, particularly in:
${skills.map(s => `- ${s}`).join('\n') || '- Modern Full-Stack Development\n- Relational Database Management\n- Version Control and CI/CD'}

In my previous roles, I have consistently focused on writing clean, maintainable code and collaborating with cross-functional teams to deliver high-quality products. I am confident that my experience with software architecture and system optimization makes me a valuable candidate.

Thank you for your time and consideration. I look forward to discussing how my skills and experience can support your goals.

Sincerely,
${name}`;
}

function mockGenerateQuestions(jobTitle, experience, resumeText) {
  const cleanTitle = (jobTitle || "Software Engineer").toLowerCase();
  
  let tech1 = "Describe your experience with React hooks and virtual DOM optimization.";
  let tech2 = "How do you design a database schema in MySQL for high-concurrency transactions?";
  
  if (cleanTitle.includes('python') || cleanTitle.includes('data')) {
    tech1 = "Explain the difference between list comprehensions and generator expressions in Python.";
    tech2 = "How do you optimize an slow-running SQL query containing multiple joins?";
  } else if (cleanTitle.includes('java')) {
    tech1 = "What are the key differences between a HashMap and ConcurrentHashMap in Java?";
    tech2 = "Explain how Java garbage collection works and how you would troubleshoot a memory leak.";
  }

  return [
    { question: tech1, type: "Technical" },
    { question: tech2, type: "Technical" },
    { question: `Tell me about a challenging project where you had to work under a tight deadline and how you managed it.`, type: "Behavioral" },
    { question: `Describe a situation where you had a disagreement with a team member or stakeholder. How did you resolve it?`, type: "Behavioral" },
    { question: `Why are you interested in this ${jobTitle || 'Software Engineer'} role and how does your ${experience || '3 years'} of experience make you a good fit?`, type: "HR" }
  ];
}

function mockEvaluateAnswer(jobTitle, experience, question, answer) {
  const wordCount = answer ? answer.trim().split(/\s+/).length : 0;
  let score = 50;
  let feedback = "";

  if (wordCount < 10) {
    score = 40;
    feedback = "Your answer is very brief. Try to elaborate by providing a specific context, your action, and the result (STAR format).";
  } else if (wordCount < 30) {
    score = 65;
    feedback = "Good start, but lacks depth. Elaborate on the specific technologies or methodologies used to show your hands-on expertise.";
  } else {
    score = Math.min(98, 70 + Math.floor(wordCount / 5));
    feedback = "Strong and detailed response. You effectively addressed the key points of the question. To make it even better, focus on clear outcomes (e.g. metrics, performance improvement, user feedback).";
  }

  return {
    feedback,
    score
  };
}

// -------------------------------------------------------------
// Exposed Interface
// -------------------------------------------------------------

module.exports = {
  analyzeResume: async (resumeText) => {
    const aiInstance = await getGenAI();
    return aiInstance ? await analyzeResumeReal(resumeText) : mockAnalyzeResume(resumeText);
  },
  optimizeResume: async (resumeText, jobDescription) => {
    const aiInstance = await getGenAI();
    return aiInstance ? await optimizeResumeReal(resumeText, jobDescription) : mockOptimizeResume(resumeText, jobDescription);
  },
  generateCoverLetter: async (jobTitle, company, jobDescription, resumeText) => {
    const aiInstance = await getGenAI();
    return aiInstance ? await generateCoverLetterReal(jobTitle, company, jobDescription, resumeText) : mockGenerateCoverLetter(jobTitle, company, jobDescription, resumeText);
  },
  generateInterviewQuestions: async (jobTitle, experience, resumeText) => {
    const aiInstance = await getGenAI();
    return aiInstance ? await generateInterviewQuestionsReal(jobTitle, experience, resumeText) : mockGenerateQuestions(jobTitle, experience, resumeText);
  },
  evaluateMockAnswer: async (jobTitle, experience, question, answer) => {
    const aiInstance = await getGenAI();
    return aiInstance ? await evaluateMockAnswerReal(jobTitle, experience, question, answer) : mockEvaluateAnswer(jobTitle, experience, question, answer);
  }
};
