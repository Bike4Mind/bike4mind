import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@server/utils/config';
import { dataLakeRepository, dataLakeProposalRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { Resource } from 'sst';
import { Request } from 'express';

/**
 * E2E-only producer stand-in for the acquisition queue.
 *
 * The queue's real producer is a research run, which does not exist yet, so without this there is
 * no way to put a proposal in front of a reviewer on a preview environment (its Mongo is inside the
 * VPC and unreachable from a test runner). That would leave the entire review surface - the thing
 * this feature IS - unverifiable outside unit tests.
 *
 * NOT a backdoor around the queue. It calls the same `proposeDataLakeContent` seam a real producer
 * calls, so dedup, tombstone suppression, tag sanitization and excerpt truncation all run exactly as
 * they would in production, and the returned outcome lets a test assert on them. What it creates is
 * always a PENDING row, which admits nothing until a human approves it - so even if the guards below
 * failed open, this could not put content into a lake.
 *
 * Guards mirror `create-user.ts` exactly, all three: non-production stages only (`isE2EEnabled`),
 * the shared E2E secret, and a restriction on WHAT the secret can be used to create - here the
 * target lake, where `create-user.ts` restricts the target email. Any change to that pattern belongs
 * in both files.
 */

/**
 * Guard 3's marker, the counterpart of `create-user.ts`'s `-e2e@test.com` email pattern. The shared
 * secret is ONE value for a whole stage, so without a restriction on the TARGET, anyone holding it
 * could seed a real reviewer's queue on a shared preview with attacker-chosen content for a lake they
 * do not manage - betting on the reviewer trusting a card that looks like a legitimate producer run.
 * Scoped to lakes an e2e run created for itself; `slug` is caller-supplied at lake creation
 * (`createDataLake` only lowercases it), so a spec opts its own lake in by name.
 */
const E2E_LAKE_SLUG_PATTERN = /(^|-)e2e(-|$)/;

interface ProposeLakeContentBody {
  /** The target lake, by id or slug. */
  dataLake: string;
  sourceUrl: string;
  title: string;
  /** Candidate text. The service hashes and truncates it; never pass a pre-computed hash. */
  text?: string;
  proposedTags?: string[];
  confidence?: number;
  /** Defaults to an e2e-labelled producer so a seeded row is identifiable in the UI. */
  producer?: string;
  runId?: string;
  query?: string;
}

const handler = baseApi({ auth: false }).post(
  asyncHandler(async (req: Request<unknown, unknown, ProposeLakeContentBody>, res) => {
    // Guard 1: never production.
    if (!isE2EEnabled()) {
      return res.status(403).json({ error: 'Proposal seeding is only available in development/preview' });
    }

    // Guard 2: shared secret - SST secret locally/staging, env var on preview deploys.
    const secret = req.headers['x-e2e-cleanup-secret'];
    const expectedSecret = Resource.E2E_CLEANUP_SECRET?.value || process.env.E2E_CLEANUP_SECRET;
    if (!expectedSecret || expectedSecret === 'not-configured' || secret !== expectedSecret) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    const { dataLake, sourceUrl, title, text, proposedTags, confidence, producer, runId, query } = req.body;
    if (!dataLake || !sourceUrl || !title) {
      return res.status(400).json({ error: 'dataLake, sourceUrl and title are required' });
    }

    // `.catch(() => null)` is load-bearing, not defensive noise: findById REJECTS on a
    // non-ObjectId string, so without it a slug never reaches the findBySlug fallback and the
    // route 404s for every by-slug caller. Same shape as assertLakeAccess.ts:146.
    const lake =
      (await dataLakeRepository.findById(dataLake).catch(() => null)) ??
      (await dataLakeRepository.findBySlug(dataLake));
    if (!lake) {
      return res.status(404).json({ error: 'Data lake not found' });
    }

    // Guard 3: only into a lake an e2e run created for itself. See E2E_LAKE_SLUG_PATTERN.
    if (!E2E_LAKE_SLUG_PATTERN.test(lake.slug)) {
      return res
        .status(400)
        .json({ error: 'Proposals may only be seeded into a lake whose slug carries an e2e marker' });
    }

    const outcome = await dataLakeService.proposeDataLakeContent(
      lake,
      {
        sourceUrl,
        title,
        text,
        proposedTags,
        confidence,
        provenance: {
          producer: producer ?? 'e2e_seed',
          runId,
          query,
          retrievedAt: new Date(),
        },
      },
      { db: { dataLakeProposals: dataLakeProposalRepository, fabFiles: fabFileRepository } }
    );

    // The full outcome, not just an id: a dedup test asserts on `duplicate_pending` /
    // `suppressed_by_tombstone` / `already_in_lake` directly rather than inferring them from a count.
    return res.status(201).json(outcome);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
