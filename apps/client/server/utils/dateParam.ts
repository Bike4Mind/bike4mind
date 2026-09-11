import { z } from 'zod';
import { BadRequestError } from '@server/utils/errors';

// A caller-supplied date string that does not parse becomes an Invalid Date, and an Invalid
// Date on a Date-typed filter throws a Mongoose CastError. errorHandler only maps a cast on
// `_id` back to a 404, so an unguarded one answers the caller with a 500 and an `error`-level
// log. Reject it at the edge instead. An empty value is allowed through: every call site
// skips a falsy date, so rejecting it would fail a request that used to succeed.

export const isParseableDate = (value: string): boolean => !Number.isNaN(Date.parse(value));

/** Throws BadRequestError (400) when `value` is present and unparseable. */
export const assertParseableDate = (name: string, value: string | undefined): void => {
  if (value && !isParseableDate(value)) {
    throw new BadRequestError(`Invalid ${name}: must be a parseable date`);
  }
};

/** Zod equivalent for routes that validate their query with a schema; answers 422. */
export const dateParam = z.string().refine(value => value === '' || isParseableDate(value), {
  message: 'Must be a parseable date',
});

// The checks above only cover the parse. A date that parses can still be pushed out of range
// by arithmetic applied afterwards -- a timezone shift, an end-of-day `setUTCHours`, a
// `setDate` offset -- and the result is the same Invalid Date and the same 500. Anything that
// mutates a date after validating it needs the assertion below, placed AFTER the mutation:
// a check before a mutator can only inspect the arguments the mutator is about to be given.

/** Throws BadRequestError (400) when a date has been mutated out of the representable range. */
export const assertDateInRange = (name: string, value: Date): Date => {
  if (Number.isNaN(value.getTime())) {
    throw new BadRequestError(`Invalid ${name}: date out of range`);
  }
  return value;
};

/**
 * Parses an hours/days-style integer query param and clamps it into `[min, max]`, so the
 * arithmetic built on it cannot overflow a Date. An absent or empty value takes `fallback`;
 * a present but non-numeric one throws. That is the split every caller wanted: a bad value
 * is the caller's error, an absent one is a default.
 *
 * `||` rather than `??` is deliberate, and matches the empty-value rule stated at the top of
 * this module: `?hours=` arrives as '' and has always meant "unset", so `??` would forward it
 * to parseInt and 400 a request that used to succeed.
 */
export const clampedIntParam = (
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = parseInt(value || String(fallback), 10);
  if (Number.isNaN(parsed)) {
    throw new BadRequestError(`Invalid ${name}: must be a number`);
  }
  return Math.min(Math.max(parsed, min), max);
};
