import { BadRequestError } from '@server/utils/errors';

/**
 * Reads the optional `targetSurface` field of a clone/fork/move body: `undefined` when absent
 * (inherit), otherwise a surface string or `null` for the main notebook list. 400s anything else.
 */
export function parseTargetSurface(body: unknown): string | null | undefined {
  if (!body || typeof body !== 'object' || !('targetSurface' in body)) return undefined;
  const { targetSurface } = body as { targetSurface: unknown };
  if (targetSurface === undefined || targetSurface === null || typeof targetSurface === 'string') return targetSurface;
  throw new BadRequestError('targetSurface must be a string or null');
}
