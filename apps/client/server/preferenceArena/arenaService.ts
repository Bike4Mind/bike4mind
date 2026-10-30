import {
  arenaRaterStanding,
  arenaVoteTransactionId,
  CreditHolderType,
  ForbiddenError,
  isArenaVerifiedUser,
  judgeArenaVote,
  NotFoundError,
  PREFERENCE_ARENA_REWARD_REASON,
  type ArenaChoice,
  type ArenaEligibilityFields,
  type ArenaIneligibleReason,
  type ArenaModelWinRate,
  type ArenaNextResponse,
  type ArenaPairImport,
  type ArenaPairView,
  type ArenaRejectReason,
  type ArenaStats,
  type ArenaVoteRequest,
  type ArenaVoteResponse,
  type PreferenceArenaSettings,
} from '@bike4mind/common';
import type { ArenaPairRepository, ArenaVoteRepository, IArenaPairDocument } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { creditService } from '@bike4mind/services';
import { accountBlockReasons, type AccountStateFields } from '@bike4mind/services/userService/accountState';

export type ArenaUser = ArenaEligibilityFields & AccountStateFields;

type AddCredits = typeof creditService.addCreditsWithLedgerRow;

export type ArenaServiceDeps = {
  pairs: Pick<
    ArenaPairRepository,
    'findById' | 'insertMany' | 'sampleUnseen' | 'listPage' | 'setActive' | 'countsForStats' | 'findByIds'
  >;
  votes: Pick<
    ArenaVoteRepository,
    | 'findOutstanding'
    | 'findForPair'
    | 'seenPairIds'
    | 'serve'
    | 'claim'
    | 'recordVote'
    | 'releaseClaim'
    | 'goldRecord'
    | 'countCreditedSince'
    | 'creditsEarned'
    | 'totals'
    | 'rejectionCounts'
    | 'goldRaters'
    | 'distinctRaterCount'
    | 'votesByRaters'
    | 'deleteUnclaimedServed'
  >;
  loadUser: (userId: string) => Promise<ArenaUser | null>;
  loadSettings: () => Promise<PreferenceArenaSettings>;
  /** Credits the ledger already holds under this transaction id, or null when it has no such row. */
  findPaidCredits: (transactionId: string) => Promise<number | null>;
  addCredits: AddCredits;
  creditAdapters: Parameters<AddCredits>[1];
  logger: Pick<Logger, 'error' | 'warn'>;
  now?: () => Date;
  random?: () => number;
};

/** A claim older than this is presumed crashed and may be taken over by a retry. */
const CLAIM_STALE_MS = 60_000;

const opposite = (choice: ArenaChoice): ArenaChoice => (choice === 'a' ? 'b' : choice === 'b' ? 'a' : 'tie');

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toView(pair: IArenaPairDocument, swapped: boolean): ArenaPairView {
  const [first, second] = pair.answers;
  return {
    pairId: pair.id,
    prompt: pair.prompt,
    taskType: pair.taskType,
    answerA: (swapped ? second : first).text,
    answerB: (swapped ? first : second).text,
  };
}

export type AdminArenaPairRow = {
  id: string;
  prompt: string;
  taskType: string;
  source: IArenaPairDocument['source'];
  modelIds: [string, string];
  isGold: boolean;
  active: boolean;
  createdAt: Date;
};

export function createArenaService(deps: ArenaServiceDeps) {
  const { pairs, votes, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  async function ineligibleReason(
    userId: string,
    settings: PreferenceArenaSettings
  ): Promise<ArenaIneligibleReason | null> {
    if (!settings.enabled) return 'disabled';
    const user = await deps.loadUser(userId);
    if (!user) return 'unverified';
    if (accountBlockReasons(user).length > 0 || user.moderation?.status === 'suspend_pending') return 'blocked';
    if (!isArenaVerifiedUser(user)) return 'unverified';
    return null;
  }

  async function pickUnseenPair(userId: string, settings: PreferenceArenaSettings) {
    const preferGold = random() * 100 < settings.goldRatePercent;
    const pools = preferGold ? (['gold', 'regular'] as const) : (['regular', 'gold'] as const);
    const seen = await votes.seenPairIds(userId);
    for (const pool of pools) {
      const pair = await pairs.sampleUnseen(pool, seen);
      if (pair) return pair;
    }
    return null;
  }

  async function viewOutstanding(userId: string): Promise<ArenaNextResponse | null> {
    const outstanding = await votes.findOutstanding(userId);
    if (!outstanding) return null;
    const pair = await pairs.findById(outstanding.pairId);
    if (pair?.active) return { status: 'ready', pair: toView(pair, outstanding.swapped) };
    // The pair was retired under a served row; drop it so the user is not stuck on it.
    await votes.deleteUnclaimedServed(outstanding.id, new Date(now().getTime() - CLAIM_STALE_MS));
    return null;
  }

  async function serveNextPair(userId: string): Promise<ArenaNextResponse> {
    const settings = await deps.loadSettings();
    const reason = await ineligibleReason(userId, settings);
    if (reason) return { status: 'ineligible', reason };

    const existing = await viewOutstanding(userId);
    if (existing) return existing;

    const pair = await pickUnseenPair(userId, settings);
    if (!pair) return { status: 'empty' };

    const swapped = random() < 0.5;
    const served = await votes.serve({ userId, pairId: pair.id, swapped, isGold: !!pair.goldChoice });
    if (served) return { status: 'ready', pair: toView(pair, swapped) };

    // A concurrent request served this user first; show that pair rather than a second one.
    const winner = await viewOutstanding(userId);
    // No outstanding row means the duplicate was this user's already-voted {userId, pairId}.
    return winner ?? { status: 'empty' };
  }

  async function grantCredits(userId: string, voteId: string, pairId: string, credits: number): Promise<void> {
    try {
      await deps.addCredits(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits,
          type: 'generic_add',
          transactionId: arenaVoteTransactionId(voteId),
          reason: PREFERENCE_ARENA_REWARD_REASON,
          description: 'Preference arena vote reward',
          metadata: { voteId, pairId },
        },
        deps.creditAdapters
      );
    } catch (err) {
      logger.error('[preference-arena] reward grant failed', err, { userId, voteId });
      throw err;
    }
  }

  async function submitVote(userId: string, request: ArenaVoteRequest): Promise<ArenaVoteResponse> {
    const settings = await deps.loadSettings();
    if (await ineligibleReason(userId, settings)) throw new ForbiddenError('Preference arena is not available');

    const pairId = request.pairId.toLowerCase();
    const row = await votes.findForPair(userId, pairId);
    if (!row) throw new NotFoundError('Pair was not served to this user');
    if (row.status === 'voted') return { creditsAwarded: row.creditsAwarded };

    const pair = await pairs.findById(pairId);
    if (!pair?.active) {
      await votes.deleteUnclaimedServed(row.id, new Date(now().getTime() - CLAIM_STALE_MS));
      throw new NotFoundError('Pair is no longer available');
    }

    // One submit wins the claim and alone judges, pays and records: two racing submits judged
    // differently (one too fast, one on time) would otherwise pay without the row saying so.
    const votedAt = now();
    const claimed = await votes.claim(userId, pairId, votedAt, new Date(votedAt.getTime() - CLAIM_STALE_MS));
    if (!claimed) {
      const settled = await votes.findForPair(userId, pairId);
      return { creditsAwarded: settled?.status === 'voted' ? settled.creditsAwarded : 0 };
    }

    if (row.claimedAt) {
      // A crashed submit may have paid before dying; honor the ledger instead of judging again.
      const paid = await deps.findPaidCredits(arenaVoteTransactionId(row.id));
      if (paid !== null) {
        logger.warn('[preference-arena] stale claim taken over after the ledger already paid', {
          userId,
          voteId: row.id,
          paid,
        });
        const choice = row.swapped ? opposite(request.choice) : request.choice;
        const recorded = await votes.recordVote(userId, pairId, votedAt, {
          choice,
          votedAt,
          responseMs: Math.max(0, votedAt.getTime() - row.servedAt.getTime()),
          goldCorrect: pair.goldChoice ? choice === pair.goldChoice : null,
          credited: true,
          creditsAwarded: paid,
        });
        return { creditsAwarded: recorded?.creditsAwarded ?? paid };
      }
    }

    const responseMs = Math.max(0, votedAt.getTime() - row.servedAt.getTime());
    const choice = row.swapped ? opposite(request.choice) : request.choice;
    const goldCorrect = pair.goldChoice ? choice === pair.goldChoice : null;

    // The row stays 'served' until recordVote, so no second pair can be served and voted while
    // this one is judged and paid: the cap counts below cannot go stale.
    const [priorGold, creditedVotesToday, creditsEarnedLifetime] = await Promise.all([
      votes.goldRecord(userId),
      votes.countCreditedSince(userId, startOfUtcDay(votedAt)),
      votes.creditsEarned(userId),
    ]);
    const judgement = judgeArenaVote({
      settings,
      responseMs,
      goldCorrect,
      goldAnswered: priorGold.answered + (goldCorrect === null ? 0 : 1),
      goldCorrectTotal: priorGold.correct + (goldCorrect ? 1 : 0),
      creditedVotesToday,
      creditsEarnedLifetime,
    });

    let outcome: { credited: true; creditsAwarded: number } | { credited: false; rejectReason: ArenaRejectReason };
    if (!judgement.accepted) {
      outcome = { credited: false, rejectReason: judgement.reason };
    } else {
      try {
        await grantCredits(userId, row.id, pairId, judgement.credits);
      } catch (err) {
        // The ledger dedupes on the vote's transaction id, so the retry re-judges and pays once.
        await votes.releaseClaim(userId, pairId, votedAt);
        throw err;
      }
      outcome = { credited: true, creditsAwarded: judgement.credits };
    }

    const recorded = await votes.recordVote(userId, pairId, votedAt, {
      choice,
      votedAt,
      responseMs,
      goldCorrect,
      ...outcome,
    });
    if (recorded) return { creditsAwarded: recorded.creditsAwarded };
    // Only a stale-claim takeover gets here; both claimants share the vote's transaction id, so the
    // ledger paid once.
    logger.error('[preference-arena] vote claim was taken over before recording', undefined, {
      userId,
      voteId: row.id,
    });
    const settled = await votes.findForPair(userId, pairId);
    return { creditsAwarded: settled?.creditsAwarded ?? 0 };
  }

  // Append-only: no dedupe, so re-importing a file duplicates pairs; admins retire duplicates.
  async function importPairs(adminUserId: string, imports: ArenaPairImport[]): Promise<number> {
    return pairs.insertMany(imports.map(pair => ({ ...pair, active: true, createdBy: adminUserId })));
  }

  async function listPairs(options: { page: number; limit: number }) {
    const { data, total } = await pairs.listPage((options.page - 1) * options.limit, options.limit);
    const rows: AdminArenaPairRow[] = data.map(pair => ({
      id: pair.id,
      prompt: pair.prompt,
      taskType: pair.taskType,
      source: pair.source,
      modelIds: [pair.answers[0].modelId, pair.answers[1].modelId],
      isGold: !!pair.goldChoice,
      active: pair.active,
      createdAt: pair.createdAt,
    }));
    return { rows, page: options.page, limit: options.limit, total };
  }

  async function setPairActive(pairId: string, active: boolean): Promise<void> {
    if (!(await pairs.setActive(pairId, active))) throw new NotFoundError('Pair not found');
  }

  async function computeWinRates(qualifiedUserIds: string[]): Promise<ArenaModelWinRate[]> {
    if (qualifiedUserIds.length === 0) return [];
    const ratedVotes = await votes.votesByRaters(qualifiedUserIds);
    const pairById = new Map(
      (
        await pairs.findByIds([...new Set(ratedVotes.map(vote => vote.pairId))], {
          taskType: 1,
          'answers.modelId': 1,
        })
      ).map(pair => [pair.id, pair])
    );
    const tallies = new Map<string, ArenaModelWinRate>();
    const tally = (taskType: string, modelId: string): ArenaModelWinRate => {
      const key = `${taskType}\u0000${modelId}`;
      const existing = tallies.get(key);
      if (existing) return existing;
      const created = { taskType, modelId, wins: 0, losses: 0, ties: 0 };
      tallies.set(key, created);
      return created;
    };
    for (const vote of ratedVotes) {
      const pair = pairById.get(vote.pairId);
      if (!pair) continue;
      const [first, second] = [
        tally(pair.taskType, pair.answers[0].modelId),
        tally(pair.taskType, pair.answers[1].modelId),
      ];
      if (vote.choice === 'tie') {
        first.ties += 1;
        second.ties += 1;
        continue;
      }
      const [winner, loser] = vote.choice === 'a' ? [first, second] : [second, first];
      winner.wins += 1;
      loser.losses += 1;
    }
    return [...tallies.values()].sort(
      (x, y) => x.taskType.localeCompare(y.taskType) || y.wins - x.wins || x.modelId.localeCompare(y.modelId)
    );
  }

  async function getArenaStats(): Promise<ArenaStats> {
    const settings = await deps.loadSettings();
    const [pairCounts, totals, rejections, raterTotal, goldRaters] = await Promise.all([
      pairs.countsForStats(),
      votes.totals(),
      votes.rejectionCounts(),
      votes.distinctRaterCount(),
      votes.goldRaters(),
    ]);
    const standings = goldRaters.map(rater => ({ rater, standing: arenaRaterStanding(rater, settings) }));
    const qualified = standings.filter(entry => entry.standing === 'qualified').map(entry => entry.rater);
    const flagged = standings.filter(entry => entry.standing === 'flagged').length;
    return {
      pairs: pairCounts,
      votes: { total: totals.votes, credited: totals.credited, creditsAwarded: totals.creditsAwarded },
      raters: { total: raterTotal, qualified: qualified.length, flagged },
      rejections,
      winRates: await computeWinRates(qualified.map(rater => rater.userId)),
    };
  }

  return { serveNextPair, submitVote, importPairs, listPairs, setPairActive, getArenaStats };
}

export type ArenaService = ReturnType<typeof createArenaService>;
