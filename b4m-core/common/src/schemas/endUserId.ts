import { z } from 'zod';

export const END_USER_ID_MAX_LENGTH = 64;
export const END_USER_ID_PATTERN = /^[A-Za-z0-9_:-]+$/;

/**
 * `end_user_id` on the AI routes: a platform key's own opaque id for the end user a request is for.
 * Deliberately a loose string so a malformed value never fails contract validation with a 422; the
 * format is checked by `isValidEndUserId` in `resolvePlatformEndUser`, which answers a 400.
 */
export const EndUserIdSchema = z
  .string()
  .describe(
    'Your own opaque identifier for the end user this request is for (1-64 characters: letters, digits, ' +
      '`_`, `:`, `-`; never an email). A malformed value is refused with a 400 ' +
      '(`errorCode: "invalid_end_user_id"`). Accepted only on an API key holding `ai:end-user-id`, which an ' +
      'administrator grants to keys that serve many end users; any other credential sending it is refused ' +
      'with a 400 (`errorCode: "end_user_id_not_allowed"`). On models served directly by OpenAI or ' +
      'Anthropic, the provider then receives an identifier derived from your account and this value instead of ' +
      'one for your whole account; other providers receive no end-user identifier.'
  );

/** The charset already excludes `@`; the explicit check keeps an email out should the charset widen. */
export function isValidEndUserId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= END_USER_ID_MAX_LENGTH &&
    END_USER_ID_PATTERN.test(value) &&
    !value.includes('@')
  );
}

export const INVALID_END_USER_ID_MESSAGE =
  'end_user_id must be 1-64 characters: letters, digits, "_", ":" and "-" only, and never an email address';

export const END_USER_ID_NOT_ALLOWED_MESSAGE =
  'end_user_id needs an API key holding the ai:end-user-id scope; omit it on this credential';
