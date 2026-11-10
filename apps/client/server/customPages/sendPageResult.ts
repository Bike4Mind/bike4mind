import type { Response } from 'express';
import { z } from 'zod';
import { PageWidgetSchema } from '@bike4mind/common';
import type { customPageService } from '@bike4mind/services';
import { respond } from '@server/utils/respond';

const pageSummaryShape = {
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  icon: z.string().nullish(),
  description: z.string().nullish(),
  orchestratorSessionId: z.string(),
  version: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const pageListResponseSchema = z.object({ pages: z.array(z.object(pageSummaryShape)) });
export const pageResponseSchema = z.object({
  page: z.object({
    ...pageSummaryShape,
    state: z.record(z.string(), z.unknown()),
    widgets: z.array(PageWidgetSchema),
  }),
});

const STATUS_BY_CODE: Record<customPageService.CustomPageErrorCode, number> = {
  not_found: 404,
  invalid: 400,
  state_too_large: 413,
  too_many_widgets: 409,
  conflict: 409,
};

/** Shared by the /api/pages mutation routes: `{ page }` on success, `{ error, issues? }` otherwise. */
export function sendPageResult(res: Response, result: customPageService.CustomPageResult) {
  if (result.ok) return respond(res, pageResponseSchema, { page: result.page });
  return res
    .status(STATUS_BY_CODE[result.code])
    .json({ error: result.message, code: result.code, ...(result.issues ? { issues: result.issues } : {}) });
}
