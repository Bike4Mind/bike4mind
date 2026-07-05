import { z } from 'zod';

/**
 * A Zod schema for a string booleans to be converted to actual booleans
 */
export const StringBooleanSchema = z.preprocess(val => {
  if (typeof val === 'string') {
    if (val.toLowerCase() === 'true') return true;
    if (val.toLowerCase() === 'false') return false;
  }
  return val;
}, z.boolean());
