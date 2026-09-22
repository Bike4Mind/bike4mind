import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeAccessGrantRepository,
  dataLakeCorpusActionRepository,
  dataLakeFindingRepository,
  dataLakeRepository,
  fabFileRepository,
  lakeMembershipRemovalRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { LAKE_CORPUS_ACTION_NOTE_MAX_CHARS, MAX_LAKE_FILE_TAG_NAME_LENGTH } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

/**
 * The three corpus actions, as a discriminated union rather than a partial patch: they touch
 * different documents in different ways and share no field but the note, so a body that could carry
 * two of them would have to answer what happens when one half succeeds.
 */
const ActionBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('merge'),
    keepFabFileId: z.string().trim().min(1),
    // Bounded because every id costs a removal, each of which recomputes the lake's stats. A
    // finding carries at most LAKE_FINDING_SOURCE_MAX sources and the service refuses any id the
    // finding does not cite, so this is a second, cheaper fence rather than the only one.
    retireFabFileIds: z.array(z.string().trim().min(1)).min(1).max(20),
    note: z.string().trim().max(LAKE_CORPUS_ACTION_NOTE_MAX_CHARS).optional(),
  }),
  z.object({
    action: z.literal('supersede'),
    keepFabFileId: z.string().trim().min(1),
    retireFabFileId: z.string().trim().min(1),
    note: z.string().trim().max(LAKE_CORPUS_ACTION_NOTE_MAX_CHARS).optional(),
  }),
  z.object({
    action: z.literal('unsupersede'),
    fabFileId: z.string().trim().min(1),
    note: z.string().trim().max(LAKE_CORPUS_ACTION_NOTE_MAX_CHARS).optional(),
  }),
  z.object({
    action: z.literal('retag'),
    fabFileId: z.string().trim().min(1),
    // The COMPLETE desired set under the lake's prefix - `setDataLakeFileTags` is replace
    // semantics, so an omitted name is a name removed. Same per-name cap as the tag door's own
    // route, since the two write through the same service.
    tags: z.array(z.string().max(MAX_LAKE_FILE_TAG_NAME_LENGTH)),
    note: z.string().trim().max(LAKE_CORPUS_ACTION_NOTE_MAX_CHARS).optional(),
  }),
]);

/**
 * POST /api/data-lakes/:id/findings/:findingId/corpus-action - act on a detected corpus problem by
 * changing the corpus (#3046).
 *
 * The sibling `POST /findings/:findingId` records what a curator DECIDED and mutates nothing else;
 * this is the door that carries a decision out. They are deliberately separate routes rather than
 * more actions on one: everything on that route is a judgement about a finding, everything here
 * moves a customer's documents, and folding them together would put an action that removes lake
 * membership behind a body shape whose other arms promise to remove nothing.
 *
 * WRITE-scoped rather than read-scoped, unlike both sibling findings routes: those return document
 * excerpts and are manage-gated because of the PROSE they carry, while this one mutates. The
 * service applies the manage gate on top, through `canManageLake` plus a resolved manage rung, so
 * an API key with the write scope still cannot act on a lake it does not manage.
 *
 * CURATOR-INITIATED ONLY, which is the issue's guardrail and is enforced in `applyCorpusAction`
 * rather than here - a route-level rule would be a rule about one caller. See that module for the
 * three structural properties, and its guardrail test for the assertion that nothing scheduled
 * reaches it.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const { id, findingId } = req.query as { id: string; findingId: string };
    const body = ActionBody.parse(req.body);
    const ctx = await toAccessContext(req);

    // The delegated doors recompute lake stats, which can flip a draft lake active and emit a
    // config-change row; `auditPrincipal` is what keeps a key-driven call from being recorded as
    // the human, on that row and on this action's own.
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };

    const result = await dataLakeService.applyCorpusAction(actor, id, findingId, body, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        fabFiles: fabFileRepository,
        dataLakeFindings: dataLakeFindingRepository,
        dataLakeCorpusActions: dataLakeCorpusActionRepository,
        // The removal door's restore record - required, not optional: without it "Undo" on a
        // merge silently does nothing.
        lakeMembershipRemovals: lakeMembershipRemovalRepository,
        // `adminSettings` is NOT listed here: `lakeConfigAuditDb` below already carries it, and
        // the tag door's required `findAll`/`findBySettingNames` are satisfied from there.
        scopedSettings: scopedSettingsRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json({ data: result });
  });

export const config = { api: { externalResolver: true } };

export default handler;
