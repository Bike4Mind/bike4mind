import { ForbiddenError } from '@bike4mind/common';
import type { AdminCheck, ApiBuilder } from './types';

export interface TutorialSummary {
  id: string;
  title: string;
  enabled: boolean;
}

export interface SummaryRouteOptions {
  api: ApiBuilder;
  isAdmin: AdminCheck;
  list: () => Promise<TutorialSummary[]>;
}

/** GET: a bare array of id, title and switch, and nothing else. Outside the owner's own switch. */
export function summaryRoute({ api, isAdmin, list }: SummaryRouteOptions) {
  return api().get(async (req, res) => {
    if (!(await isAdmin(req))) throw new ForbiddenError('Only full administrators can list tutorials.');
    return res.json((await list()).map(({ id, title, enabled }) => ({ id, title, enabled })));
  });
}
