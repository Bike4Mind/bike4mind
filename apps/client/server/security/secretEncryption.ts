/**
 * Secret Encryption Utility
 *
 * Provides AES-256-GCM encryption for storing sensitive secrets in the database.
 *
 * Security features:
 * - AES-256-GCM (authenticated encryption with associated data)
 * - Random IV per encryption
 * - Authentication tag prevents tampering
 *
 * TODO(TECH-DEBT): JWT_SECRET in database is a TEMPORARY SOLUTION
 * This should be migrated to AWS Secrets Manager when available.
 * Current tradeoff: Database storage (encrypted) vs SSM (requires redeploy)
 * Expected removal: when a centralized Secrets Manager architecture is implemented
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 *
 * @param plaintext - The secret to encrypt
 * @param key - 32-byte hex-encoded encryption key
 * @returns Encrypted string in format: iv:authTag:ciphertext (all hex-encoded)
 */
export function encryptSecret(plaintext: string, key: string): string {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty plaintext');
  }

  if (!key || key.length !== KEY_LENGTH * 2) {
    throw new Error(`Encryption key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted (all hex-encoded)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an encrypted secret using AES-256-GCM.
 *
 * @param encrypted - Encrypted string in format: iv:authTag:ciphertext
 * @param key - 32-byte hex-encoded encryption key
 * @returns Decrypted plaintext
 * @throws Error if decryption fails (invalid format, wrong key, or tampered data)
 */
export function decryptSecret(encrypted: string, key: string): string {
  if (!encrypted) {
    throw new Error('Cannot decrypt empty ciphertext');
  }

  if (!key || key.length !== KEY_LENGTH * 2) {
    throw new Error(`Encryption key must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
  }

  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format. Expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, encryptedData] = parts;

  if (ivHex.length !== IV_LENGTH * 2) {
    throw new Error(`Invalid IV length. Expected ${IV_LENGTH * 2} hex characters`);
  }

  if (authTagHex.length !== AUTH_TAG_LENGTH * 2) {
    throw new Error(`Invalid auth tag length. Expected ${AUTH_TAG_LENGTH * 2} hex characters`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Checks if a string appears to be in encrypted format.
 *
 * @param value - String to check
 * @returns true if the string matches the encrypted format pattern
 */
export function isEncrypted(value: string): boolean {
  if (!value) {
    return false;
  }

  // Check if value matches encrypted format: iv(32 hex):authTag(32 hex):data(hex)
  const pattern = /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i;
  return pattern.test(value);
}

/**
 * Generates a new random encryption key suitable for AES-256-GCM.
 *
 * @returns 32-byte hex-encoded key
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Validates that an encryption key is properly formatted.
 *
 * @param key - Key to validate
 * @returns true if the key is valid
 */
export function isValidEncryptionKey(key: string): boolean {
  if (!key || key.length !== KEY_LENGTH * 2) {
    return false;
  }
  return /^[a-f0-9]+$/i.test(key);
}
