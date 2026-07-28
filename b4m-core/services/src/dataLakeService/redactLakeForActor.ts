import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { canManageLake } from './authorizeLakeWrite';

/**
 * Strip the editor-only fields from a lake document that is about to leave the server, unless
 * the caller may MANAGE it. Today that is `systemPrompt`: it steers answers for everyone who
 * queries the lake, but its wording is readable only by the lake's editors (creator or admin).
 *
 * Needed because the READ-gated exits are gated on access, which is deliberately wider than
 * manage: `assertLakeAccess` hands back a stranger's PUBLISHED lake (public arm, crosses orgs),
 * and the archived/deleted management views hand an org member a lake they don't own. Every
 * READ-gated exit must therefore pass through here: `GET /api/data-lakes/:id`, `/archived`,
 * `/deleted`. The write/lifecycle paths (PUT, DELETE, /visibility, /lifecycle, /files/:fabFileId)
 * serialize raw documents too, but each enforces admin-or-creator in its own service first, so
 * they intentionally do NOT call this. The actor-aware LIST projection has its own gate (see
 * toManageableConfig in listDataLakes) since it returns configs, not documents.
 *
 * Deletes the key rather than blanking it, so a reader cannot tell an unset prompt from a
 * withheld one, and a round-tripped document can never write '' back over a real prompt.
 */
export function redactLakeForActor(
  lake: IDataLakeDocument,
  actor: Pick<AccessContext, 'userId' | 'isAdmin'>
): IDataLakeDocument {
  if (canManageLake(lake, actor)) return lake;
  const { systemPrompt: _redacted, ...visible } = lake;
  return visible;
}

/** `redactLakeForActor` over a list - the archived/deleted management views. */
export function redactLakesForActor(
  lakes: IDataLakeDocument[],
  actor: Pick<AccessContext, 'userId' | 'isAdmin'>
): IDataLakeDocument[] {
  return lakes.map(lake => redactLakeForActor(lake, actor));
}
