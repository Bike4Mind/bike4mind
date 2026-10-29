import {
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
    | 'recordVote'
    | 'goldRecord'
    | 'countCreditedSince'
    | 'creditsEarned'
    | 'markOutcome'
    | 'totals'
    | 'rejectionCounts'
    | 'goldRaters'
    | 'distinctRaterCount'
    | 'votesByRaters'
    | 'delete'
  >;
  loadUser: (userId: string) => Promise<ArenaUser | null>;
  loadSettings: () => Promise<PreferenceArenaSettings>;
  addCredits: AddCredits;
  creditAdapters: Parameters<AddCredits>[1];
  logger: Pick<Logger, 'error'>;
  now?: () => Date;
  random?: () => number;
};

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
    if (pair) return { status: 'ready', pair: toView(pair, outstanding.swapped) };
    // The pair was deleted out from under a served row; drop it so the user is not stuck.
    await votes.delete(outstanding.id);
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
    if (!winner) throw new Error('Arena serve lost a race but no outstanding pair exists');
    return winner;
  }

  async function grantCredits(userId: string, voteId: string, pairId: string, credits: number): Promise<boolean> {
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
      return true;
    } catch (err) {
      logger.error('[preference-arena] reward grant failed', err, { userId, voteId });
      return false;
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
    if (!pair) throw new NotFoundError('Pair not found');

    const votedAt = now();
    const choice = row.swapped ? opposite(request.choice) : request.choice;
    const goldCorrect = pair.goldChoice ? choice === pair.goldChoice : null;
    const recorded = await votes.recordVote(userId, pairId, {
      choice,
      votedAt,
      responseMs: Math.max(0, votedAt.getTime() - row.servedAt.getTime()),
      goldCorrect,
    });
    if (!recorded) {
      const settled = await votes.findForPair(userId, pairId);
      return { creditsAwarded: settled?.creditsAwarded ?? 0 };
    }

    const [gold, creditedVotesToday, creditsEarnedLifetime] = await Promise.all([
      votes.goldRecord(userId),
      votes.countCreditedSince(userId, startOfUtcDay(votedAt), recorded.id),
      votes.creditsEarned(userId, recorded.id),
    ]);
    const judgement = judgeArenaVote({
      settings,
      responseMs: recorded.responseMs ?? 0,
      goldCorrect,
      goldAnswered: gold.answered,
      goldCorrectTotal: gold.correct,
      creditedVotesToday,
      creditsEarnedLifetime,
    });

    if (!judgement.accepted) {
      await votes.markOutcome(recorded.id, { credited: false, rejectReason: judgement.reason });
      return { creditsAwarded: 0 };
    }
    if (!(await grantCredits(userId, recorded.id, pairId, judgement.credits))) return { creditsAwarded: 0 };
    await votes.markOutcome(recorded.id, { credited: true, creditsAwarded: judgement.credits });
    return { creditsAwarded: judgement.credits };
  }

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
      (await pairs.findByIds([...new Set(ratedVotes.map(vote => vote.pairId))])).map(pair => [pair.id, pair])
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
    return [...tallies.values()].sort((x, y) => x.taskType.localeCompare(y.taskType) || y.wins - x.wins);
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
    const enoughGold = goldRaters.filter(rater => rater.answered > 0 && rater.answered >= settings.minGoldVotes);
    const accurate = (rater: { answered: number; correct: number }) =>
      (rater.correct / rater.answered) * 100 >= settings.minGoldAccuracyPercent;
    const qualified = enoughGold.filter(accurate);
    return {
      pairs: pairCounts,
      votes: { total: totals.votes, credited: totals.credited, creditsAwarded: totals.creditsAwarded },
      raters: { total: raterTotal, qualified: qualified.length, flagged: enoughGold.length - qualified.length },
      rejections,
      winRates: await computeWinRates(qualified.map(rater => rater.userId)),
    };
  }

  return { serveNextPair, submitVote, importPairs, listPairs, setPairActive, getArenaStats };
}

export type ArenaService = ReturnType<typeof createArenaService>;
