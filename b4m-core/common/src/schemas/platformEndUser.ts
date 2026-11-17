import { z } from 'zod';

export const PLATFORM_END_USER_ID_MAX_LENGTH = 64;
export const PLATFORM_END_USER_ID_PATTERN = /^[A-Za-z0-9_:-]+$/;

/**
 * `end_user_id` on the AI routes that accept one (completions, text-to-speech). Shared so every
 * route validates and documents it the same way. The character set excludes `@`, so it cannot
 * carry an email address.
 */
export const PlatformEndUserIdSchema = z
  .string()
  .min(1)
  .max(PLATFORM_END_USER_ID_MAX_LENGTH)
  .regex(PLATFORM_END_USER_ID_PATTERN, 'end_user_id may contain only letters, digits, "_", ":" and "-"')
  .describe(
    "Your own opaque id for the end user this request is made for, 1-64 characters of letters, digits, `_`, `:` and `-`. Requires an API key with the `ai:end-user-attribution` scope, which Bike4Mind grants on request; any other caller that sends it is refused with `400`. It is combined with the key owner's id and hashed before it reaches a model provider, so providers attribute the request to that end user. Do not send names, email addresses or other personal data."
  );
