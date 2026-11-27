import { ForbiddenError } from '@bike4mind/common';
import type { draftStore } from '../drafts/store';
import { DraftPostSchema } from '../drafts/store';
import type { AdminCheck, ApiBuilder } from './types';

export interface DraftsRouteOptions {
  api: ApiBuilder;
  isAdmin: AdminCheck;
  store: ReturnType<typeof draftStore>;
}

/**
 * GET/POST: tutorials an admin makes from a session of their own. GET lists every draft with its content, the
 * module it plays as, the rules it breaks, and whether it is approved and switched on. POST takes one `action`:
 * `capture`, `save`, `sheet`, `approve`, `enable` or `delete`. Any content change clears the approval and
 * switches the draft off.
 */
export function draftsRoute({ api, isAdmin, store }: DraftsRouteOptions) {
  const requireAdmin = async (req: Parameters<AdminCheck>[0]) => {
    if (!(await isAdmin(req))) throw new ForbiddenError('Only full administrators can make tutorials.');
  };
  return api()
    .get(async (req, res) => {
      await requireAdmin(req);
      return res.json(await store.list());
    })
    .post(async (req, res) => {
      await requireAdmin(req);
      const parsed = DraftPostSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return res.status(400).json({ error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` });
      }
      const actorId = req.user!.id;
      const outcome = await store.act(parsed.data, actorId);
      if (outcome) return res.status(outcome.status).json(outcome.body);
      req.logger?.info(
        { actorId, moduleId: parsed.data.moduleId, action: parsed.data.action },
        'Tutorial draft changed'
      );
      return res.json(await store.list());
    });
}
