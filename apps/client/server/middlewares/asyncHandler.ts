import { RequestHandler } from 'express';

/**
 * @todo We can stop using this function now that we're using Next.js API routes.
 * Delete this function once we've confirmed that it's no longer in use.
 *
 * @deprecated This function is no longer needed since we're using Next.js API routes.
 */
export const asyncHandler =
  <
    P,
    ResBody = unknown,
    ReqBody = unknown,
    ReqQuery = unknown,
    LocalsObj extends Record<string, unknown> = Record<string, unknown>,
  >(
    fn: (...args: Parameters<RequestHandler<P, ResBody, ReqBody, ReqQuery, LocalsObj>>) => void
  ) =>
  async (...args: Parameters<RequestHandler<P, ResBody, ReqBody, ReqQuery, LocalsObj>>) => {
    await fn(...args);
  };
