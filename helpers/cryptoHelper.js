const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = process.env.CROSS_DOMAIN_SECRET_KEY
  ? process.env.CROSS_DOMAIN_SECRET_KEY.replace(/^["']|["']$/g, '').trim()
  : undefined;

/**
 * Encrypts a payload into a URL-safe Base64 string.
 * @param {Object|string} payload 
 * @returns {string} Encrypted base64url string
 */
function encryptPayload(payload) {
  if (!SECRET_KEY) {
    throw new Error('CROSS_DOMAIN_SECRET_KEY is not defined in environment variables.');
  }
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const data = JSON.stringify({
    iv: iv.toString('base64'),
    encryptedData: encrypted
  });
  
  return Buffer.from(data).toString('base64url');
}

/**
 * Decrypts a base64url encrypted payload back into its original object.
 * @param {string} encryptedString 
 * @returns {Object|null} Decrypted payload object
 */
function decryptPayload(encryptedString) {
  if (!SECRET_KEY) {
    throw new Error('CROSS_DOMAIN_SECRET_KEY is not defined in environment variables.');
  }
  try {
    const raw = Buffer.from(encryptedString, 'base64url').toString('utf8');
    const { iv, encryptedData } = JSON.parse(raw);
    
    const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
    let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Payload decryption failed:', error);
    return null;
  }
}

/**
 * Generates an HMAC-SHA256 signature for verification.
 * @param {Object|string} data 
 * @returns {string} Hex signature
 */
function generateSignature(data) {
  if (!SECRET_KEY) {
    throw new Error('CROSS_DOMAIN_SECRET_KEY is not defined in environment variables.');
  }
  const key = crypto.createHash('sha256').update(SECRET_KEY).digest();
  const rawString = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto
    .createHmac('sha256', key)
    .update(rawString)
    .digest('hex');
}

/**
 * Verifies an HMAC-SHA256 signature.
 * @param {Object|string} data 
 * @param {string} signature 
 * @returns {boolean} True if signature is valid
 */
function verifySignature(data, signature) {
  if (!signature) return false;
  try {
    const expected = generateSignature(data);
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = {
  encryptPayload,
  decryptPayload,
  generateSignature,
  verifySignature
};
