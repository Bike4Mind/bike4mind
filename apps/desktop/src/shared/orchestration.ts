import { z } from 'zod';
import { isLocalModel, modelSupportsTools, type ChatModelOption } from './chat';

const text = z.string().trim().min(1).max(2000);
const entries = z.array(text).max(32);
export const workerRoleSchema = z.enum(['implementation', 'exploration', 'review']);
export type WorkerRole = z.infer<typeof workerRoleSchema>;
export const WORKER_ROLES = workerRoleSchema.options;
const modelId = z.string().trim().min(1).max(300);
export const rolePolicySchema = z.strictObject({
  version: z.literal(1),
  roles: z.strictObject({ implementation: modelId, exploration: modelId, review: modelId }),
  allowedOverrides: z.array(modelId).max(32),
  escalation: z.strictObject({
    mode: z.enum(['ask', 'automatic']),
    allowedModels: z.array(modelId).max(32),
    allowedRoles: z.array(workerRoleSchema).max(3),
    maxAutomaticUpgrades: z.union([z.literal(0), z.literal(1)]),
  }),
});
export type RolePolicy = z.infer<typeof rolePolicySchema>;
export const inheritancePolicy = (): RolePolicy => ({
  version: 1,
  roles: { implementation: 'inherit', exploration: 'inherit', review: 'inherit' },
  allowedOverrides: [],
  escalation: { mode: 'ask', allowedModels: [], allowedRoles: [], maxAutomaticUpgrades: 0 },
});
export const rootPolicySchema = z.strictObject({
  rootSessionId: z.string().min(1),
  rootRunId: z.string().min(1),
  /**
   * The run id `POST /api/v1/completion-runs` issued for this root, sent with each agent turn so
   * the server can group the run's spend. Absent until that request succeeds, and on sessions
   * stored before it existed. `rootRunId` stays the local identity; this one is the server's.
   */
  serverRunId: z.string().min(1).optional(),
  policy: rolePolicySchema,
});
export type RootPolicy = z.infer<typeof rootPolicySchema>;

export const taskContractSchema = z
  .strictObject({
    version: z.literal(1),
    outcome: text,
    rationale: text,
    role: workerRoleSchema,
    paths: entries,
    contextReferences: entries,
    ownedChanges: entries,
    coordinationConstraints: entries,
    nonGoals: entries,
    acceptanceCriteria: entries.min(1),
    verification: entries,
    assumptions: entries,
    escalationConditions: entries,
  })
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 24000, 'Task contract exceeds 24 KB');
export type TaskContract = z.infer<typeof taskContractSchema>;
export const workerRequirementsSchema = z.strictObject({
  vision: z.boolean().optional(),
  contextTokens: z.number().int().positive().max(10000000).optional(),
});
export const spawnOptionsSchema = z
  .strictObject({
    role: workerRoleSchema.optional(),
    requestedModelId: modelId.optional(),
    contract: taskContractSchema.optional(),
    requirements: workerRequirementsSchema.optional(),
  })
  .refine(
    value => !value.role || !value.contract || value.role === value.contract.role,
    'Role must match the contract'
  );
export type SpawnOptions = z.infer<typeof spawnOptionsSchema>;
export const modelSelectionSchema = z.strictObject({
  role: workerRoleSchema.optional(),
  requestedModelId: modelId.optional(),
  effectiveModel: modelId,
  source: z.enum(['override', 'role-policy', 'parent', 'escalation']),
  rootRunId: z.string().min(1),
  requirements: workerRequirementsSchema.optional(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** Opens the error of a spawn refused only for its model request, which the thread draws muted. */
export const MODEL_REQUEST_REFUSED = 'Model request refused:';

const modelTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const containsRun = (haystack: readonly string[], needle: readonly string[]): boolean =>
  haystack.some((_, start) => needle.every((token, offset) => haystack[start + offset] === token));

const inCatalog = (id: string, models: readonly ChatModelOption[]): boolean =>
  models.some(model => model.id === id || model.aliasIds?.includes(id));

/**
 * The newest of `candidates` that a family name such as `sonnet` or `gpt-6.1` names, by whole
 * tokens of its id, name or alias ids. Only ever one of `candidates`, so an alias can never reach
 * a model the user did not allow; an exact catalog id is never treated as an alias, or
 * `claude-sonnet-5` could resolve to a `claude-sonnet-5-mini` variant.
 */
export function resolveModelAlias(
  requested: string,
  candidates: readonly string[],
  models: readonly ChatModelOption[]
): string | null {
  const needle = modelTokens(requested);
  if (!needle.length || inCatalog(requested, models)) return null;
  const matches = [...new Set(candidates)]
    .map(id => ({ id, option: models.find(model => model.id === id) }))
    .filter(({ id, option }) =>
      [id, option?.name ?? '', ...(option?.aliasIds ?? [])].some(source => containsRun(modelTokens(source), needle))
    );
  const usable = ({ option }: (typeof matches)[number]) => (option && !option.unavailable && !option.disabled ? 0 : 1);
  matches.sort(
    (left, right) =>
      usable(left) - usable(right) ||
      (right.option?.releaseDate ?? '').localeCompare(left.option?.releaseDate ?? '') ||
      left.id.length - right.id.length ||
      left.id.localeCompare(right.id)
  );
  return matches[0]?.id ?? null;
}

const effectiveDefaultFor = (parentModel: string, policy: RolePolicy, role: WorkerRole | undefined): string => {
  const selected = role ? policy.roles[role] : 'inherit';
  return selected === 'inherit' ? parentModel : selected;
};

/**
 * What `requested_model_id` tells the agent it may ask for, or null to leave the field out of the
 * schema: with no allowed override, the only model it could name is the default it gets anyway.
 */
export function modelRequestHint(parentModel: string, policy: RolePolicy): string | null {
  if (!policy.allowedOverrides.length) return null;
  const defaults = WORKER_ROLES.map(role => `${role}=${effectiveDefaultFor(parentModel, policy, role)}`);
  return (
    `Optional; omit for the role default (${defaults.join(', ')}). ` +
    `Allowed: ${policy.allowedOverrides.join(', ')}. A family name like sonnet picks the newest allowed match.`
  );
}

export function resolveWorkerModel(
  parentModel: string,
  policy: RolePolicy,
  options: SpawnOptions,
  models: readonly ChatModelOption[] = []
): Omit<ModelSelection, 'rootRunId'> {
  const role = options.role ?? options.contract?.role;
  const requested = options.requestedModelId;
  const selected = role ? policy.roles[role] : 'inherit';
  const effectiveDefault = effectiveDefaultFor(parentModel, policy, role);
  const resolved =
    !requested || requested === effectiveDefault || policy.allowedOverrides.includes(requested)
      ? requested
      : resolveModelAlias(requested, [effectiveDefault, ...policy.allowedOverrides], models);
  if (requested && !resolved) {
    const allowed = policy.allowedOverrides.length ? policy.allowedOverrides.join(', ') : 'none';
    throw new Error(
      `${MODEL_REQUEST_REFUSED} '${requested}' is not an allowed override (allowed: ${allowed}). Nothing was started. ` +
        `Omit requested_model_id to use the role default (${effectiveDefault}), or ask the user to allow it in orchestration settings.`
    );
  }
  return {
    ...(role ? { role } : {}),
    ...(requested ? { requestedModelId: requested } : {}),
    ...(options.requirements ? { requirements: options.requirements } : {}),
    effectiveModel: resolved ?? effectiveDefault,
    source: requested ? 'override' : selected !== 'inherit' ? 'role-policy' : 'parent',
  };
}

export function validateWorkerModel(
  model: string,
  models: readonly ChatModelOption[],
  requirements: { localOnly: boolean; vision?: boolean; contextTokens?: number }
): void {
  const option = models.find(entry => entry.id === model);
  const problem = !option
    ? 'not in the connected catalog'
    : (option.unavailable ??
      (option.disabled
        ? 'access is disabled'
        : !modelSupportsTools(model, option)
          ? 'does not support tools'
          : requirements.vision && option.supportsVision !== true
            ? 'cannot read required images'
            : requirements.contextTokens && (!option.contextWindow || option.contextWindow < requirements.contextTokens)
              ? 'context window is too small'
              : null));
  if (problem || (requirements.localOnly && !isLocalModel(model))) {
    throw new Error(
      `Worker model ${model} is blocked: ${problem ?? 'device-local work cannot use a hosted model'}. Choose a replacement explicitly; no fallback was started.`
    );
  }
}

export function renderTaskBrief(contract: TaskContract): string {
  const sections: [string, string | string[]][] = [
    ['Outcome', contract.outcome],
    ['Rationale', contract.rationale],
    ['Role', contract.role],
    ['Relevant paths', contract.paths],
    ['Context references', contract.contextReferences],
    ['Owned changes', contract.ownedChanges],
    ['Coordination constraints', contract.coordinationConstraints],
    ['Non-goals', contract.nonGoals],
    ['Acceptance criteria', contract.acceptanceCriteria],
    ['Verification', contract.verification],
    ['Assumptions to check', contract.assumptions],
    ['Escalation conditions', contract.escalationConditions],
  ];
  return (
    sections
      .map(
        ([name, value]) =>
          `${name}:\n${Array.isArray(value) ? value.map(item => `- ${item}`).join('\n') || '(none)' : value}`
      )
      .join('\n\n') +
    '\n\nDecide locally within scope. Filesystem permissions remain authoritative. Report disproven assumptions with evidence using task_report; ask for the smallest missing decision. Do not widen scope or start more agents to bypass a block. A stopped turn is not accepted completion. Report changed paths, verification and unmet criteria. In task_report, give each acceptance criterion a verification entry whose criterion is its exact text above; extra checks such as lint or typecheck count toward no criterion. Skills cannot authorize model, permission or spending changes.'
  );
}

const verificationSchema = z.strictObject({
  criterion: text.describe(
    'The exact text of the acceptance criterion this check evidences. A check labelled any other way, such as lint or typecheck, counts toward no criterion.'
  ),
  command: text,
  outcome: z.enum(['passed', 'failed', 'not-run']),
  evidence: text,
});
const evidenceFields = {
  changedPaths: entries,
  verification: z
    .array(verificationSchema)
    .max(32)
    .describe(
      "One entry per acceptance criterion, quoting that criterion's exact text, plus any extra checks under their own labels."
    ),
  unmetCriteria: entries.describe('Acceptance criteria, quoted exactly, that this attempt did not meet.'),
  handoff: text,
};
export const taskReportSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), ...evidenceFields }),
  z.strictObject({ status: z.literal('blocked'), reason: text, evidence: entries.min(1) }),
  z.strictObject({
    status: z.literal('escalation-requested'),
    reason: text,
    evidence: entries.min(1),
    requestedModelId: modelId.optional(),
    decisionId: z.string().min(1).max(100),
  }),
]);
export type TaskReport = z.infer<typeof taskReportSchema>;
const taskStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('queued') }),
  z.strictObject({ status: z.literal('running') }),
  z.strictObject({
    status: z.literal('completed'),
    ...evidenceFields,
    accepted: z.boolean(),
    assessment: text.optional(),
  }),
  z.strictObject({ status: z.literal('blocked'), reason: text, evidence: entries.min(1) }),
  z.strictObject({
    status: z.literal('escalation-requested'),
    reason: text,
    evidence: entries.min(1),
    requestedModelId: modelId.optional(),
    decisionId: z.string().min(1).max(100),
  }),
  z.strictObject({ status: z.literal('canceled'), reason: text }),
  z.strictObject({ status: z.literal('budget-paused'), reason: text }),
]);
export const MAX_TASK_ATTEMPTS = 32;
export const MAX_RESOLVED_DECISIONS = 32;
export const workerTaskSchema = z.strictObject({
  version: z.literal(1),
  contract: taskContractSchema,
  attempts: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        model: modelId,
        startedAt: z.string(),
        trigger: z.enum(['initial', 'revision', 'user-upgrade', 'automatic-upgrade']),
      })
    )
    .min(1)
    .max(MAX_TASK_ATTEMPTS),
  automaticUpgrades: z.number().int().min(0).max(1),
  resolvedDecisions: z.array(z.string().min(1).max(100)).max(MAX_RESOLVED_DECISIONS),
  state: taskStateSchema,
});
export type WorkerTask = z.infer<typeof workerTaskSchema>;
export const taskActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('report'), report: taskReportSchema }),
  z.strictObject({ kind: z.literal('accept'), assessment: text }),
  z.strictObject({ kind: z.literal('revise'), contract: taskContractSchema, instruction: text }),
  z.strictObject({ kind: z.literal('upgrade'), modelId, decisionId: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('deny'), reason: text, decisionId: z.string().min(1).max(100) }),
  z.strictObject({ kind: z.literal('cancel'), reason: text }),
]);
export type TaskAction = z.infer<typeof taskActionSchema>;

// Tolerates only case, whitespace and trailing punctuation drift; anything looser could let an
// unrelated check stand in for a criterion. Scans backwards because an anchored `[...]+$` regex is
// quadratic on a long run of spaces.
const criterionKey = (value: string): string => {
  let end = value.length;
  while (end > 0 && /[\s.!?;:,]/.test(value[end - 1])) end--;
  return value.slice(0, end).trim().replace(/\s+/g, ' ').toLowerCase();
};

const quoteList = (items: readonly string[]): string => items.map(item => `\n- "${item}"`).join('');

type CompletedReport = Extract<TaskReport, { status: 'completed' }>;

/** Rejects a completed report that leaves an acceptance criterion with neither a matching check nor an unmet entry. */
export function assertReportCoversCriteria(contract: TaskContract, report: CompletedReport): void {
  const covered = new Set(
    [...report.verification.map(check => check.criterion), ...report.unmetCriteria].map(criterionKey)
  );
  const missing = contract.acceptanceCriteria.filter(criterion => !covered.has(criterionKey(criterion)));
  if (missing.length)
    throw new Error(
      `A completed report must give each acceptance criterion a verification entry whose criterion is that criterion's exact text, or list it in unmetCriteria. Checks under other labels count toward no criterion. Not covered:${quoteList(missing)}`
    );
}

export function acceptTask(task: WorkerTask, assessment: string): WorkerTask {
  const state = task.state;
  if (state.status !== 'completed')
    throw new Error(`Acceptance requires a completed task report; this task is ${state.status}.`);
  const passed = new Set(
    state.verification.filter(check => check.outcome === 'passed').map(check => criterionKey(check.criterion))
  );
  const missing = task.contract.acceptanceCriteria.filter(criterion => !passed.has(criterionKey(criterion)));
  const failing = state.verification.filter(check => check.outcome !== 'passed');
  if (missing.length || failing.length || state.unmetCriteria.length) {
    const problems = [
      missing.length &&
        `No passed verification entry quotes these acceptance criteria:${quoteList(missing)}\nChecks under other labels count toward no criterion.`,
      failing.length &&
        `Checks that did not pass:${failing.map(check => `\n- "${check.criterion}" (${check.outcome})`).join('')}`,
      state.unmetCriteria.length && `Unmet criteria reported:${quoteList(state.unmetCriteria)}`,
    ].filter(Boolean);
    throw new Error(
      `Acceptance requires passing evidence for every criterion and no failed checks or unmet criteria.\n${problems.join('\n')}`
    );
  }
  return { ...task, state: { ...state, accepted: true, assessment } };
}

/** Admission belongs to the future root budget service, never a skill or model assertion. */
export function automaticUpgradeAllowed(
  task: WorkerTask,
  policy: RolePolicy,
  model: string,
  budgetAdmitted: boolean
): boolean {
  return (
    budgetAdmitted &&
    task.state.status === 'escalation-requested' &&
    policy.escalation.mode === 'automatic' &&
    policy.escalation.allowedRoles.includes(task.contract.role) &&
    policy.escalation.allowedModels.includes(model) &&
    task.automaticUpgrades < policy.escalation.maxAutomaticUpgrades
  );
}
