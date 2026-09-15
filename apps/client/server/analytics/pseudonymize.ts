import crypto from 'crypto';
import { Config } from '@server/utils/config';

// Pure helper: accepts explicit salt for testability.
// Production callers use pseudonymizeUserId() which reads the configured salt.
export function pseudonymize(userId: string, salt: string): string {
  return crypto.createHmac('sha256', salt).update(userId).digest('hex');
}

// NEVER rotate OVERWATCH_PSEUDONYM_SALT - rotating re-pseudonymizes all users,
// breaks OverwatchUserDay dedup, and resets retention history.
export function pseudonymizeUserId(userId: string): string {
  return pseudonymize(userId, Config.OVERWATCH_PSEUDONYM_SALT ?? '');
}
