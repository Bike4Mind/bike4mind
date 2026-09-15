import { z } from 'zod';

/**
 * Password validation rules enforced across the application.
 */
export const PASSWORD_RULES = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: true,
} as const;

/**
 * Error messages for password validation failures.
 */
export const PASSWORD_ERROR_MESSAGES = {
  minLength: `Password must be at least ${PASSWORD_RULES.minLength} characters long`,
  uppercase: 'Password must contain at least one uppercase letter',
  lowercase: 'Password must contain at least one lowercase letter',
  number: 'Password must contain at least one number',
  specialChar: 'Password must contain at least one special character',
} as const;

/**
 * Zod schema for password validation.
 * Use this for client-side form validation with react-hook-form.
 *
 * @example
 * ```ts
 * const formSchema = z.object({
 *   password: passwordSchema,
 *   // ... other fields
 * });
 * ```
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_RULES.minLength, PASSWORD_ERROR_MESSAGES.minLength)
  .regex(/[A-Z]/, PASSWORD_ERROR_MESSAGES.uppercase)
  .regex(/[a-z]/, PASSWORD_ERROR_MESSAGES.lowercase)
  .regex(/[0-9]/, PASSWORD_ERROR_MESSAGES.number)
  .regex(/[^A-Za-z0-9]/, PASSWORD_ERROR_MESSAGES.specialChar);

/**
 * Validates a password string against all password rules.
 * Returns an error message if validation fails, or null if valid.
 *
 * Use this for imperative validation (e.g., in event handlers).
 *
 * @param password - The password string to validate
 * @returns Error message string if invalid, null if valid
 *
 * @example
 * ```ts
 * const error = validatePassword('weak');
 * if (error) {
 *   toast.error(error);
 *   return;
 * }
 * ```
 */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_RULES.minLength) {
    return PASSWORD_ERROR_MESSAGES.minLength;
  }
  if (PASSWORD_RULES.requireUppercase && !/[A-Z]/.test(password)) {
    return PASSWORD_ERROR_MESSAGES.uppercase;
  }
  if (PASSWORD_RULES.requireLowercase && !/[a-z]/.test(password)) {
    return PASSWORD_ERROR_MESSAGES.lowercase;
  }
  if (PASSWORD_RULES.requireNumber && !/[0-9]/.test(password)) {
    return PASSWORD_ERROR_MESSAGES.number;
  }
  if (PASSWORD_RULES.requireSpecialChar && !/[^A-Za-z0-9]/.test(password)) {
    return PASSWORD_ERROR_MESSAGES.specialChar;
  }
  return null;
}

/**
 * Server-side password validation that throws BadRequestError on failure.
 * Use this in API endpoints.
 *
 * @param password - The password string to validate
 * @param BadRequestError - The error class to throw (imported from server utils)
 * @throws BadRequestError with validation message
 *
 * @example
 * ```ts
 * import { BadRequestError } from '@server/utils/errors';
 *
 * validatePasswordServer(newPassword, BadRequestError);
 * ```
 */
export function validatePasswordServer(password: string, BadRequestError: new (message: string) => Error): void {
  const error = validatePassword(password);
  if (error) {
    throw new BadRequestError(error);
  }
}
