import { UnprocessableEntityError } from '@bike4mind/common';

const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

/** The `Idempotency-Key` header of a generation create route, or undefined when absent; malformed is a 422. */
export const readIdempotencyKey = (header: string | string[] | undefined): string | undefined => {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new UnprocessableEntityError('Idempotency-Key must be 1-255 printable ASCII characters', {
      errorCode: 'invalid_idempotency_key',
    });
  }
  return header;
};
