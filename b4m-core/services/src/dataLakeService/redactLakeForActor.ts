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
 * `/deleted`. The write/lifecycle paths (POST /api/data-lakes, PUT, DELETE, /visibility, /lifecycle)
 * serialize raw documents too, but each enforces admin-or-creator in its own service first - and a
 * create's author is by definition its editor - so they intentionally do NOT call this. The
 * actor-aware LIST projection has its own gate (see toManageableConfig in listDataLakes) since it
 * returns configs, not documents.
 *
 * Deletes the key rather than blanking it, so a reader cannot tell an unset prompt from a
 * withheld one, and a round-tripped document can never write '' back over a real prompt.
 *
 * For an editor, a whitespace-only prompt is reported as absent rather than echoed verbatim. That
 * keeps this endpoint's answer identical to the list projection's (see toManageableConfig), which
 * already treats blank as unset - otherwise the same lake reads as "has a prompt" here and "has
 * none" there, and an editor seeding a form from either one gets a different result.
 */
export function redactLakeForActor(
  lake: IDataLakeDocument,
  actor: Pick<AccessContext, 'userId' | 'isAdmin'>
): IDataLakeDocument {
  const blankPrompt = lake.systemPrompt !== undefined && !lake.systemPrompt.trim();
  if (canManageLake(lake, actor) && !blankPrompt) return lake;
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
