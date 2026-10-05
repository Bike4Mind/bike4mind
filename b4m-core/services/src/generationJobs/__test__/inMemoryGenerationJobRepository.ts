import {
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type IGenerationJob,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
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
  // Every write bumps updatedAt, like Mongoose timestamps:true on updateOne / findOneAndUpdate.
  const touch = (job: IGenerationJobDocument) => {
    job.updatedAt = now();
  };
  const clone = (job: IGenerationJobDocument | undefined) => (job ? structuredClone(job) : null);

  const repository = {
    jobs,

    async createJob(input: Omit<IGenerationJob, 'createdAt' | 'updatedAt'>) {
      const id = `job${++sequence}`;
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
      const free = !job.leaseUntil || job.leaseUntil < at;
      const leasable = !isTerminal(job) || !job.terminalHandledAt;
      if (!free || !leasable) return null;
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

    async commit(id: string, update: GenerationJobCommit) {
      const job = jobs.get(id);
      if (!job) return null;
      // Mongo's $set drops undefined values rather than clearing the field.
      const defined = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
      Object.assign(job, defined, { leaseUntil: null, updatedAt: now() });
      return structuredClone(job);
    },

    async requestCancel(id: string) {
      const job = jobs.get(id);
      if (!job || isTerminal(job)) return null;
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

    async findStalled(overdueBefore: Date, limit: number) {
      return [...jobs.values()]
        .filter(job =>
          isTerminal(job)
            ? !job.terminalHandledAt &&
              (job.terminalHandlingClaimedAt
                ? job.terminalHandlingClaimedAt < overdueBefore
                : job.updatedAt < overdueBefore)
            : !!job.nextPollAt && job.nextPollAt < overdueBefore
        )
        .slice(0, limit)
        .map(job => structuredClone(job));
    },
  };

  return repository as typeof repository & IGenerationJobRepository;
};
