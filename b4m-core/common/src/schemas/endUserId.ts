import { z } from 'zod';

export const END_USER_ID_MAX_LENGTH = 64;
export const END_USER_ID_PATTERN = /^[A-Za-z0-9_:-]+$/;

/**
 * `end_user_id` on the AI routes: a platform key's own opaque id for the end user a request is for.
 * The charset already excludes `@`; the explicit refine keeps an email from ever passing should the
 * charset widen.
 */
export const EndUserIdSchema = z
  .string()
  .min(1)
  .max(END_USER_ID_MAX_LENGTH)
  .regex(END_USER_ID_PATTERN, 'end_user_id may contain only letters, digits, "_", ":" and "-"')
  .refine(value => !value.includes('@'), 'end_user_id must not be an email address')
  .describe(
    'Your own opaque identifier for the end user this request is for (1-64 characters: letters, digits, ' +
      '`_`, `:`, `-`; never an email). Accepted only on an API key holding `ai:end-user-id`, which an ' +
      'administrator grants to keys that serve many end users; any other credential sending it is refused ' +
      'with a 400 (`errorCode: "end_user_id_not_allowed"`). The model provider then receives an identifier ' +
      'derived from your account and this value instead of one for your whole account.'
  );

export const END_USER_ID_NOT_ALLOWED_MESSAGE =
  'end_user_id needs an API key holding the ai:end-user-id scope; omit it on this credential';
