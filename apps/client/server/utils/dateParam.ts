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
