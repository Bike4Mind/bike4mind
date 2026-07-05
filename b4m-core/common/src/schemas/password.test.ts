import { describe, it, expect } from 'vitest';
import { validatePassword, passwordSchema, validatePasswordServer, PASSWORD_ERROR_MESSAGES } from './password';

describe('validatePassword', () => {
  describe('valid passwords', () => {
    it('should return null for a valid password with all requirements', () => {
      const result = validatePassword('Password123!');
      expect(result).toBeNull();
    });

    it('should accept password with 8 characters', () => {
      const result = validatePassword('Pass123!');
      expect(result).toBeNull();
    });

    it('should accept password with multiple special characters', () => {
      const result = validatePassword('P@ssw0rd!#$');
      expect(result).toBeNull();
    });

    it('should accept password with numbers at different positions', () => {
      const result = validatePassword('1Password!');
      expect(result).toBeNull();
    });
  });

  describe('minimum length validation', () => {
    it('should fail for password with less than 8 characters', () => {
      const result = validatePassword('Pass1!');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.minLength);
    });

    it('should fail for empty password', () => {
      const result = validatePassword('');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.minLength);
    });

    it('should fail for password with exactly 7 characters', () => {
      const result = validatePassword('Pass1!a');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.minLength);
    });
  });

  describe('uppercase validation', () => {
    it('should fail for password without uppercase letter', () => {
      const result = validatePassword('password123!');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.uppercase);
    });

    it('should succeed with uppercase at beginning', () => {
      const result = validatePassword('Password123!');
      expect(result).toBeNull();
    });

    it('should succeed with uppercase at end', () => {
      const result = validatePassword('password123!A');
      expect(result).toBeNull();
    });

    it('should succeed with uppercase in middle', () => {
      const result = validatePassword('passWord123!');
      expect(result).toBeNull();
    });
  });

  describe('lowercase validation', () => {
    it('should fail for password without lowercase letter', () => {
      const result = validatePassword('PASSWORD123!');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.lowercase);
    });

    it('should succeed with lowercase at beginning', () => {
      const result = validatePassword('pASSWORD123!');
      expect(result).toBeNull();
    });

    it('should succeed with lowercase at end', () => {
      const result = validatePassword('PASSWORD123!a');
      expect(result).toBeNull();
    });
  });

  describe('number validation', () => {
    it('should fail for password without number', () => {
      const result = validatePassword('Password!');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.number);
    });

    it('should succeed with number at beginning', () => {
      const result = validatePassword('1Password!');
      expect(result).toBeNull();
    });

    it('should succeed with number at end', () => {
      const result = validatePassword('Password!1');
      expect(result).toBeNull();
    });

    it('should succeed with multiple numbers', () => {
      const result = validatePassword('P4ssw0rd!');
      expect(result).toBeNull();
    });
  });

  describe('special character validation', () => {
    it('should fail for password without special character', () => {
      const result = validatePassword('Password123');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.specialChar);
    });

    it('should succeed with common special characters', () => {
      const specialChars = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+'];
      specialChars.forEach(char => {
        const result = validatePassword(`Password123${char}`);
        expect(result).toBeNull();
      });
    });

    it('should succeed with bracket special characters', () => {
      const brackets = ['[', ']', '{', '}', '<', '>'];
      brackets.forEach(char => {
        const result = validatePassword(`Password123${char}`);
        expect(result).toBeNull();
      });
    });

    it('should succeed with punctuation special characters', () => {
      const punctuation = ['.', ',', ':', ';', '?', '/', '\\', '|'];
      punctuation.forEach(char => {
        const result = validatePassword(`Password123${char}`);
        expect(result).toBeNull();
      });
    });
  });

  describe('edge cases', () => {
    it('should handle password with spaces', () => {
      // Spaces are special characters (not alphanumeric)
      const result = validatePassword('Pass word1 ');
      expect(result).toBeNull();
    });

    it('should handle password with unicode characters', () => {
      const result = validatePassword('Pässwörd1!');
      expect(result).toBeNull();
    });

    it('should fail for password with only uppercase and lowercase', () => {
      const result = validatePassword('PasswordPassword');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.number);
    });

    it('should fail for password with only uppercase and numbers', () => {
      const result = validatePassword('PASSWORD123');
      expect(result).toBe(PASSWORD_ERROR_MESSAGES.lowercase);
    });
  });
});

describe('passwordSchema', () => {
  it('should validate correct password', () => {
    const result = passwordSchema.safeParse('Password123!');
    expect(result.success).toBe(true);
  });

  it('should reject password that is too short', () => {
    const result = passwordSchema.safeParse('Pass1!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(PASSWORD_ERROR_MESSAGES.minLength);
    }
  });

  it('should reject password without uppercase', () => {
    const result = passwordSchema.safeParse('password123!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(PASSWORD_ERROR_MESSAGES.uppercase);
    }
  });

  it('should reject password without lowercase', () => {
    const result = passwordSchema.safeParse('PASSWORD123!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(PASSWORD_ERROR_MESSAGES.lowercase);
    }
  });

  it('should reject password without number', () => {
    const result = passwordSchema.safeParse('Password!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(PASSWORD_ERROR_MESSAGES.number);
    }
  });

  it('should reject password without special character', () => {
    const result = passwordSchema.safeParse('Password123');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(PASSWORD_ERROR_MESSAGES.specialChar);
    }
  });
});

describe('validatePasswordServer', () => {
  class MockBadRequestError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BadRequestError';
    }
  }

  it('should not throw for valid password', () => {
    expect(() => {
      validatePasswordServer('Password123!', MockBadRequestError);
    }).not.toThrow();
  });

  it('should throw BadRequestError for invalid password', () => {
    expect(() => {
      validatePasswordServer('weak', MockBadRequestError);
    }).toThrow(MockBadRequestError);
  });

  it('should throw with correct error message for short password', () => {
    expect(() => {
      validatePasswordServer('Pass1!', MockBadRequestError);
    }).toThrow(PASSWORD_ERROR_MESSAGES.minLength);
  });

  it('should throw with correct error message for missing uppercase', () => {
    expect(() => {
      validatePasswordServer('password123!', MockBadRequestError);
    }).toThrow(PASSWORD_ERROR_MESSAGES.uppercase);
  });

  it('should throw with correct error message for missing lowercase', () => {
    expect(() => {
      validatePasswordServer('PASSWORD123!', MockBadRequestError);
    }).toThrow(PASSWORD_ERROR_MESSAGES.lowercase);
  });

  it('should throw with correct error message for missing number', () => {
    expect(() => {
      validatePasswordServer('Password!', MockBadRequestError);
    }).toThrow(PASSWORD_ERROR_MESSAGES.number);
  });

  it('should throw with correct error message for missing special character', () => {
    expect(() => {
      validatePasswordServer('Password123', MockBadRequestError);
    }).toThrow(PASSWORD_ERROR_MESSAGES.specialChar);
  });
});
