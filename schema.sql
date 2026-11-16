CREATE DATABASE IF NOT EXISTS `ai_resume_db`;
USE `ai_resume_db`;

-- Users Table
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password` VARCHAR(255) NOT NULL,
  `credits` INT DEFAULT 100,
  `role` ENUM('client', 'admin') DEFAULT 'client',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Resumes Table
CREATE TABLE IF NOT EXISTS `resumes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `filepath` VARCHAR(255) NOT NULL,
  `filetype` VARCHAR(50) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Credit Transactions Table
CREATE TABLE IF NOT EXISTS `credit_transactions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `amount` INT NOT NULL,
  `type` ENUM('purchase', 'use') NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Resume Analyses Table (ATS Score, Grammar, Keywords, Missing Skills, Formatting)
CREATE TABLE IF NOT EXISTS `resume_analyses` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `resume_id` INT NOT NULL,
  `ats_score` INT NOT NULL,
  `grammar_check` TEXT,
  `keyword_analysis` TEXT,
  `missing_skills` TEXT,
  `formatting_suggestions` TEXT,
  `cost` INT DEFAULT 5,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Resume Optimizations Table (Resume + Job Description)
CREATE TABLE IF NOT EXISTS `resume_optimizations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `resume_id` INT NOT NULL,
  `job_description` TEXT,
  `optimized_resume_text` LONGTEXT,
  `skill_recommendations` TEXT,
  `keyword_improvements` TEXT,
  `cost` INT DEFAULT 10,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`resume_id`) REFERENCES `resumes`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Cover Letters Table
CREATE TABLE IF NOT EXISTS `cover_letters` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `job_title` VARCHAR(255),
  `company` VARCHAR(255),
  `job_description` TEXT,
  `cover_letter_text` LONGTEXT,
  `cost` INT DEFAULT 3,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Interview Questions Table
CREATE TABLE IF NOT EXISTS `interview_questions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `job_title` VARCHAR(255) NOT NULL,
  `experience` VARCHAR(100) NOT NULL,
  `questions_json` TEXT,
  `cost` INT DEFAULT 5,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Mock Interviews Table
CREATE TABLE IF NOT EXISTS `mock_interviews` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `job_title` VARCHAR(255) NOT NULL,
  `experience` VARCHAR(100) NOT NULL,
  `total_questions` INT DEFAULT 5,
  `questions_json` TEXT,
  `status` ENUM('in_progress', 'completed') DEFAULT 'in_progress',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Mock Interview Dialogues Table
CREATE TABLE IF NOT EXISTS `mock_interview_dialogues` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `interview_id` INT NOT NULL,
  `question` TEXT NOT NULL,
  `answer` TEXT,
  `feedback` TEXT,
  `score` INT DEFAULT 0,
  `cost` INT DEFAULT 2,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`interview_id`) REFERENCES `mock_interviews`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
