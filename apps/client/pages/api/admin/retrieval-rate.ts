import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError } from '@server/utils/errors';
import { summarizeOptionalPathRetrieval, type RetrievalRateInput } from '@bike4mind/common';

/**
 * How often the model retrieves when the knowledge tools are merely OFFERED (#1394).
 *
 * The measurement that decides whether per-turn retrieval routing is worth building. See
 * `summarizeOptionalPathRetrieval` for what the populations mean, and `mode` on
 * RetrievalSummarySchema for why the window matters.
 */

/**
 * Ceiling on turns folded into one response. A rollup wants the whole window, but the filter below
 * has no dedicated index (`promptMeta.retrieval` + `timestamp`), so an unbounded window on a large
 * deployment is a long collection scan inside a request. Past this the response says so via
 * `truncated` rather than quietly reporting a rate for a prefix of the window - narrow the dates
 * and read the buckets separately.
 */
const MAX_TURNS_SCANNED = 50_000;

const querySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

const parseDate = (value: string | undefined, label: string): Date | undefined => {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // Loud, not a silent fallback to "all time": a mistyped bound would otherwise return a
    // number for a window the caller did not ask for and cannot tell apart from the one they did.
    throw new z.ZodError([
      { code: 'custom', path: [label], message: `${label} is not a parseable date`, input: value },
    ]);
  }
  return parsed;
};

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const params = querySchema.parse(req.query);
    const startDate = parseDate(params.startDate, 'startDate');
    const endDate = parseDate(params.endDate, 'endDate');

    // `retrieval` is written for every turn that could have retrieved - forced retrieval enabled,
    // or the knowledge tool offered - so its presence IS the population. Turns with no knowledge
    // in scope never carry the field and are excluded without a second predicate.
    const query: Record<string, unknown> = { 'promptMeta.retrieval': { $exists: true } };
    if (startDate || endDate) {
      query.timestamp = {
        ...(startDate ? { $gte: startDate } : {}),
        ...(endDate ? { $lte: endDate } : {}),
      };
    }

    // Only the three fields the fold reads. `dataLakeTags` stays in the database: naming which
    // lakes a turn touched is not needed to count turns (see RetrievalRateInput).
    const rows = await Quest.find(query)
      .select(
        'promptMeta.retrieval.attempted promptMeta.retrieval.mode promptMeta.retrieval.forcedSkipReason timestamp'
      )
      .sort({ timestamp: -1 })
      .limit(MAX_TURNS_SCANNED + 1)
      .lean();

    const truncated = rows.length > MAX_TURNS_SCANNED;
    const scanned = truncated ? rows.slice(0, MAX_TURNS_SCANNED) : rows;
    if (truncated) {
      req.logger?.warn('[retrieval-rate] window exceeds the scan ceiling; reporting a partial window', {
        maxTurnsScanned: MAX_TURNS_SCANNED,
        startDate: params.startDate,
        endDate: params.endDate,
      });
    }

    const summary = summarizeOptionalPathRetrieval(
      scanned.map(row => row.promptMeta?.retrieval as RetrievalRateInput | undefined)
    );

    res.json({
      summary,
      window: {
        startDate: startDate?.toISOString() ?? null,
        endDate: endDate?.toISOString() ?? null,
        // The newest and oldest turn actually folded in. On a truncated window these are what the
        // numbers describe, and they are what the caller should narrow against.
        newestTurnAt: scanned[0]?.timestamp?.toISOString() ?? null,
        oldestTurnAt: scanned[scanned.length - 1]?.timestamp?.toISOString() ?? null,
      },
      turnsScanned: scanned.length,
      truncated,
      maxTurnsScanned: MAX_TURNS_SCANNED,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
