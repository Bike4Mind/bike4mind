import {
  GENERATION_JOB_ID_PATTERN,
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type GenerationJobCommitGuard,
  type GenerationJobCreateInput,
  type IGenerationJob,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
  type StalledJobLimits,
} from '@bike4mind/common';

/**
 * Map-backed IGenerationJobRepository for engine tests: lets them run without Mongo and simulate crashes
 * by poking `jobs` directly. Lease / claim / stalled semantics must stay in sync with
 * packages/database/src/models/ai/GenerationJobModel.ts (pinned there by its Mongo tests).
 * Only the methods the engine and sweeper call are implemented; the rest of IBaseRepository is absent.
 */
export const createInMemoryGenerationJobRepository = (options: { now?: () => Date } = {}) => {
  const now = options.now ?? (() => new Date());
  const jobs = new Map<string, IGenerationJobDocument>();
  let sequence = 0;
  const isTerminal = (job: IGenerationJob) => TERMINAL_GENERATION_JOB_STATES.includes(job.state);
  const isUnleased = (job: IGenerationJob, at: Date) => !job.leaseUntil || job.leaseUntil < at;
  const guardHolds = (job: IGenerationJob, guard: GenerationJobCommitGuard) =>
    guard.kind === 'lease'
      ? job.leaseUntil?.getTime() === guard.leaseToken.getTime()
      : job.state === 'pending' && !job.submitAttemptedAt && isUnleased(job, guard.now);
  // Every write bumps updatedAt, like Mongoose timestamps:true on updateOne / findOneAndUpdate.
  const touch = (job: IGenerationJobDocument) => {
    job.updatedAt = now();
  };
  const clone = (job: IGenerationJobDocument | undefined) => (job ? structuredClone(job) : null);

  const repository = {
    jobs,

    async createJob({ id: suppliedId, ...input }: GenerationJobCreateInput) {
      if (suppliedId !== undefined && !GENERATION_JOB_ID_PATTERN.test(suppliedId)) {
        throw new Error(`generation job id must be a lowercase 24-hex ObjectId string, got '${suppliedId}'`);
      }
      const id = suppliedId ?? `job${++sequence}`;
      const createdAt = now();
      // Mirrors the Mongoose schema defaults.
      const doc: IGenerationJobDocument = {
        submitAttemptedAt: null,
        leaseUntil: null,
        nextPollAt: null,
        terminalHandlingClaimedAt: null,
        terminalHandledAt: null,
        ...input,
        id,
        createdAt,
        updatedAt: createdAt,
      };
      jobs.set(id, doc);
      return structuredClone(doc);
    },

    async findById(id: string) {
      return clone(jobs.get(id));
    },

    async findByIdempotencyKey(ownerType: IGenerationJob['ownerType'], ownerId: string, key: string) {
      return clone(
        [...jobs.values()].find(
          job => job.ownerType === ownerType && job.ownerId === ownerId && job.idempotencyKey === key
        )
      );
    },

    async acquireLease(id: string, at: Date, leaseUntil: Date) {
      const job = jobs.get(id);
      if (!job) return null;
      const leasable = !isTerminal(job) || !job.terminalHandledAt;
      if (!isUnleased(job, at) || !leasable) return null;
      job.leaseUntil = leaseUntil;
      touch(job);
      return structuredClone(job);
    },

    async markSubmitAttempted(id: string, at: Date) {
      const job = jobs.get(id);
      if (!job) return;
      job.submitAttemptedAt = at;
      touch(job);
    },

    async commit(id: string, update: GenerationJobCommit, guard: GenerationJobCommitGuard) {
      const job = jobs.get(id);
      if (!job || !guardHolds(job, guard)) return null;
      // Mongo's $set drops undefined values rather than clearing the field.
      const defined = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
      Object.assign(job, defined, { leaseUntil: null, updatedAt: now() });
      return structuredClone(job);
    },

    async requestCancel(id: string) {
      const job = jobs.get(id);
      if (!job || (job.state !== 'pending' && job.state !== 'running')) return null;
      job.cancelRequested = true;
      touch(job);
      return structuredClone(job);
    },

    async claimTerminalHandling(id: string, at: Date) {
      const job = jobs.get(id);
      if (!job || !isTerminal(job) || job.terminalHandlingClaimedAt) return false;
      job.terminalHandlingClaimedAt = at;
      touch(job);
      return true;
    },

    async markTerminalHandled(id: string, at: Date) {
      const job = jobs.get(id);
      if (!job) return;
      job.terminalHandledAt = at;
      touch(job);
    },

    async recordSettlement(id: string, settledCredits: number) {
      const job = jobs.get(id);
      if (!job) return;
      job.settledCredits = settledCredits;
      touch(job);
    },

    async findStalled(overdueBefore: Date, limits: StalledJobLimits) {
      const time = (date: Date | null | undefined) => date?.getTime() ?? 0;
      const inFlight = [...jobs.values()]
        .filter(job => !isTerminal(job) && !!job.nextPollAt && job.nextPollAt < overdueBefore)
        .sort((a, b) => time(a.nextPollAt) - time(b.nextPollAt));
      const terminal = [...jobs.values()]
        .filter(
          job =>
            isTerminal(job) &&
            !job.terminalHandledAt &&
            (job.terminalHandlingClaimedAt
              ? job.terminalHandlingClaimedAt < overdueBefore
              : time(job.updatedAt) < overdueBefore.getTime())
        )
        .sort((a, b) => time(a.updatedAt) - time(b.updatedAt));
      return [...inFlight.slice(0, limits.inFlight), ...terminal.slice(0, limits.terminal)].map(job =>
        structuredClone(job)
      );
    },
  };

  return repository as typeof repository & IGenerationJobRepository;
};
