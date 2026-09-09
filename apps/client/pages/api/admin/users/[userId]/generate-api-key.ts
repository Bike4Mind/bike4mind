import { userApiKeyService, dataLakeService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { toObjectIdString } from '@server/utils/objectId';
import { UserApiKeyEvents } from '@bike4mind/common';
import { ADMIN_ONLY_API_KEY_SCOPES, USER_API_KEY_SCOPE_VALUES } from '@client/app/constants/apiKeyScopes';

// Scopes this admin endpoint may mint: the standard self-service set plus the
// admin-provisioned ingest scopes. ADMIN and CC_BRIDGE are still excluded -
// those must come through their own dedicated flows.
const ADMIN_ENDPOINT_MINTABLE_SCOPES = new Set<string>([
  ...USER_API_KEY_SCOPE_VALUES,
  ...ADMIN_ONLY_API_KEY_SCOPES.map(s => s.value),
]);

/**
 * Bounds the lake screen below, which dedupes and then spends one `findById` per id before
 * `createUserApiKey`'s own `.max(25)` is ever reached. Same 25, applied to the RAW array rather
 * than to the deduped set the service counts - so 26 entries that dedupe to 23 are refused here
 * and would have been accepted there. Deliberate: the looser reading would put the cap after the
 * dedupe, which is the walk it exists to bound.
 *
 * Deliberately larger than sessions/create.ts's per-SESSION cap: a key is a ceiling spanning many
 * sessions, so the two bound different things and are not a mismatch to be reconciled.
 */
const MAX_PREAUTHORIZED_LAKES = 25;

interface RequestQuery {
  userId: string;
}

interface CreateApiKeyBody {
  name: string;
  scopes: string[];
  expiresAt?: string;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  /** Lake ids to bind this key to for the manage-but-not-member session admission. Admin-only. */
  preauthorizedLakeIds?: string[];
}

/**
 * Screen an admin-supplied lake binding against the TARGET user.
 *
 * The binding is a CEILING, never a grant: pages/api/sessions/create.ts requires the key's list to
 * contain the lake AND independently re-checks the acting user's live manage rights, and the read
 * path re-derives those every turn (dataLakeService.filterStillManagedLakes). So an id the target
 * cannot manage escalates nothing - it just makes the binding fail to narrow anything, which is
 * the only thing the field is for. Screening here turns that silent no-op into a 400 at mint time,
 * rather than a confusing "You do not manage data lake X" the first time someone uses the key.
 *
 * Ids are lowercased, not merely shape-checked: both stores are `type: [String]`, so the
 * containment check in sessions/create is byte equality against a lake's own (always lowercase)
 * `id` virtual. An uppercase-hex id persists happily here and then never matches.
 *
 * The manage check reuses `filterStillManagedLakes` rather than open-coding a rule, so the mint
 * gate, the session-create gate and the per-turn re-check cannot drift apart. That helper bakes in
 * `isAdmin: false`, which is the subtle part: platform-adminness is deliberately not a manage rung
 * for this admission, so a target whose only relationship to the lake is being a platform admin is
 * refused here exactly as sessions/create would refuse them.
 */
async function screenPreauthorizedLakeIds(raw: unknown, targetUserId: string): Promise<string[] | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new BadRequestError('preauthorizedLakeIds must be an array of data lake ids');
  }
  // Capped on the RAW array, before the loop below rather than on its deduped result: the body
  // cap admits tens of thousands of ids, so a cap applied afterwards would bound the reads and
  // leave the walk over `raw` unbounded. The Set is the other half - deduping via `ids.includes`
  // would be quadratic in the input even with this cap in place.
  if (raw.length > MAX_PREAUTHORIZED_LAKES) {
    throw new BadRequestError(`At most ${MAX_PREAUTHORIZED_LAKES} pre-authorized data lakes per key`);
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? toObjectIdString(entry) : undefined;
    if (!id) {
      // The echoed value is unvalidated input, so bound it.
      throw new BadRequestError(`Invalid data lake id: ${String(entry).slice(0, 64)}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return undefined;

  // Every way this field can be wrong answers BadRequest, not the NotFound/Forbidden
  // sessions/create returns for the same conditions: there the lake id is the request's subject,
  // here it is one field of a mint body.
  const fetched = await Promise.all(ids.map(id => dataLakeRepository.findById(id)));
  const byId = new Map(ids.map((id, i) => [id, fetched[i]]));
  const missing = ids.filter(id => !byId.get(id));
  if (missing.length > 0) {
    throw new BadRequestError(`Data lake not found: ${missing.join(', ')}`);
  }
  // Reported apart from a miss because an admin picking from the lake list CAN see a draft lake,
  // and "not found" for a lake on their screen reads as a bug. `status` is the same gate
  // unionPreauthorizedLakeAccess applies before its own re-check.
  const inactive = ids.filter(id => byId.get(id)!.status !== 'active');
  if (inactive.length > 0) {
    throw new BadRequestError(`Data lake is not active: ${inactive.join(', ')}`);
  }
  const lakes = ids.map(id => byId.get(id)!);
  const manageable = await dataLakeService.filterStillManagedLakes(lakes, targetUserId, {
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    organizations: organizationRepository,
  });
  const manageableIds = new Set(manageable.map(lake => lake.id));
  const unmanaged = ids.filter(id => !manageableIds.has(id));
  if (unmanaged.length > 0) {
    throw new BadRequestError(
      `User does not manage data lake(s): ${unmanaged.join(', ')}. Grant the user access to the lake first.`
    );
  }
  return ids;
}

/**
 * POST /api/admin/users/[userId]/generate-api-key
 *
 * Admin-only endpoint to generate an API key on behalf of any user.
 * Useful for creating service account keys without logging in as the target user.
 */
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { userId } = req.query as RequestQuery;

      if (typeof userId !== 'string' || !userId) {
        throw new BadRequestError('Invalid user ID');
      }

      const targetUser = await userRepository.findById(userId);
      if (!targetUser) {
        throw new BadRequestError('User not found');
      }
      // Canonical target id for everything below, NOT the `userId` URL segment: findById casts to
      // ObjectId and resolves the user under any hex casing, but every field this id is compared
      // against afterwards is a `type: String` matched by byte equality - the key's own `userId`,
      // and each manage rung the lake screen walks. A non-canonical segment minted a key that
      // authenticates (apiKeyAuth casts too) yet findByUserId never returns: invisible in the
      // owner's key list, uncounted by the per-user cap, unreachable by the owner-scoped revoke.
      const targetUserId = targetUser.id;

      const { name, scopes, expiresAt, rateLimit, preauthorizedLakeIds } = req.body as CreateApiKeyBody;

      // Reject any scope outside the mintable allowlist, including admin:* and cc-bridge:connect.
      const requestedScopes = Array.isArray(scopes) ? scopes : [];
      const invalidScopes = requestedScopes.filter(s => !ADMIN_ENDPOINT_MINTABLE_SCOPES.has(s));
      if (invalidScopes.length > 0) {
        throw new BadRequestError(`Scope not allowed: ${invalidScopes.join(', ')}`);
      }

      const lakeBinding = await screenPreauthorizedLakeIds(preauthorizedLakeIds, targetUserId);

      const newApiKey = await userApiKeyService.createUserApiKey(
        targetUserId,
        {
          name,
          scopes: scopes as Parameters<typeof userApiKeyService.createUserApiKey>[1]['scopes'],
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          rateLimit,
          preauthorizedLakeIds: lakeBinding,
          metadata: {
            clientIP: req.ip,
            userAgent: req.headers['user-agent'],
            createdFrom: 'dashboard' as const,
          },
        },
        {
          db: {
            userApiKeys: userApiKeyRepository,
          },
        }
      );

      // Log analytics event attributed to the target user. The lake binding rides along because it
      // is the one part of this mint that reaches another tenant's asset and it is invisible on the
      // lake side - it grants nothing there, so it appears in no grant listing. Recording it here
      // makes "which keys are bound to this lake" answerable without grepping logs.
      await logEvent(
        {
          userId: targetUserId,
          type: UserApiKeyEvents.CREATED,
          metadata: {
            keyId: newApiKey.id,
            name: newApiKey.name,
            scopes: newApiKey.scopes,
            expiresAt: newApiKey.expiresAt?.toISOString(),
            createdFrom: 'dashboard',
            preauthorizedLakeIds: lakeBinding,
          },
        },
        { ability: req.ability }
      );

      // Audit trail with admin details. Every free-form field goes through JSON.stringify - the
      // same surrounding quotes for any ordinary value - so a newline cannot forge a sibling entry
      // now that this line is the audit record for a cross-tenant lake binding. `username` is only
      // `{ type: String, unique: true }` on UserModel, so it carries no schema-level shape
      // constraint; both ids are canonical ObjectId strings and need no escaping.
      req.logger.info(
        `Admin ${JSON.stringify(req.user.username)} (${req.user.id}) generated API key ${JSON.stringify(name)} for user ${JSON.stringify(targetUser.username)} (${targetUserId})` +
          (lakeBinding ? ` bound to data lake(s) ${lakeBinding.join(', ')}` : '')
      );

      return res.status(201).json(newApiKey);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
