// A leaf module so both the completions wire schema (schemas/cliCompletions.ts) and the stored
// UsageEvent shape (types/entities/UsageEventTypes.ts) can share the tuples without an import cycle.

/** Who made a run-attributed request: the session that started the run, or a worker it spawned. */
export const COMPLETION_RUN_ROLES = ['root', 'worker'] as const;
export type CompletionRunRole = (typeof COMPLETION_RUN_ROLES)[number];

/** What a run-attributed request was for, so spend can be split by category. */
export const COMPLETION_RUN_PURPOSES = ['turn', 'title', 'compaction', 'suggestion', 'explore', 'review'] as const;
export type CompletionRunPurpose = (typeof COMPLETION_RUN_PURPOSES)[number];
