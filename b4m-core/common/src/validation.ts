import { z } from 'zod';
import { isZodError, InternalServerError, UnprocessableEntityError } from './errors';

export function secureParameters<S extends z.ZodType>(params: unknown, schema: S): z.output<S> {
  try {
    return schema.parse(params) as z.output<S>;
  } catch (e) {
    if (isZodError(e)) {
      throw new UnprocessableEntityError(e.issues.map(err => `${err.path.join('.')}: ${err.message}`).join(', '));
    }
    throw new InternalServerError();
  }
}
