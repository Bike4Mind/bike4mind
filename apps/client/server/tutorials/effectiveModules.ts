// The modules as learners get them: the repo's, with the admin's overrides applied. Read fresh on every
// request, so every instance serves the same set the moment a write commits.
import {
  OverrideUnitsSchema,
  type OverrideUnit,
  type TutorialStep,
  type UnitState,
  type ValidationIssue,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import type { ITutorialOverride, TutorialModels } from './models';
import { applyOverrides, lockedReason, type OverridePolicy } from './overrides';
import type { RepoTutorial, TutorialModule, TutorialTurn } from './types';
import { validateTutorialModule, type ValidatorOptions } from './validate';

export type TutorialOverrideState = Pick<ITutorialOverride, 'moduleId' | 'enabled' | 'revision'> &
  Partial<Pick<ITutorialOverride, 'contentSeq' | 'fields' | 'structuralDigest' | 'digestRepoVersion'>>;

export interface ModuleOverrideReport {
  states: { key: string; state: UnitState }[];
  /** Why the module's overrides were refused, so it serves the repo content; empty when they apply. */
  rejected: ValidationIssue[];
  /** Digest of the structure actually served; the resolver moves the revision when it changes. */
  structuralDigest: string;
}

export interface EffectiveTutorials {
  modules: TutorialModule[];
  overrides: Record<string, ModuleOverrideReport>;
}

/** The units a row holds, or the issue that makes it unusable: unparsable, or editing a locked field. */
export function parseUnits(
  moduleId: string,
  fields: unknown,
  steps: readonly TutorialStep[],
  policy: OverridePolicy
): { units: OverrideUnit[]; issues: ValidationIssue[] } {
  if (fields === undefined || fields === null) return { units: [], issues: [] };
  const parsed = OverrideUnitsSchema.safeParse(fields);
  if (!parsed.success) {
    return { units: [], issues: [{ rule: 'override-unparsable', message: parsed.error.issues[0]?.message ?? '' }] };
  }
  const issues = parsed.data.flatMap(unit => {
    const reason = lockedReason(moduleId, unit, steps, policy);
    return reason
      ? [{ ...('stepId' in unit && { stepId: unit.stepId }), rule: 'override-locked', message: reason }]
      : [];
  });
  return { units: parsed.data, issues };
}

type DigestMove = 'none' | 'adopt' | 'bump';

/**
 * Whether a row's stored digest must follow the one this instance serves. A row with none adopts it without
 * a bump. An instance older than the repo version that wrote the digest leaves it. Two builds at the same
 * version that serve different structure do bump each other while both serve, which ends running walks until
 * the old instances drain.
 */
export function digestMove(row: TutorialOverrideState, digest: string, repoVersion: number): DigestMove {
  if (row.structuralDigest === undefined) return 'adopt';
  if (row.structuralDigest === digest) return 'none';
  return repoVersion >= (row.digestRepoVersion ?? 0) ? 'bump' : 'none';
}

const OVERRIDE_PROJECTION = {
  moduleId: 1,
  enabled: 1,
  revision: 1,
  contentSeq: 1,
  fields: 1,
  structuralDigest: 1,
  digestRepoVersion: 1,
  _id: 0,
} as const;

export interface TutorialContentOptions {
  models: Pick<TutorialModels, 'Override' | 'OverrideChange'>;
  repo: readonly RepoTutorial[];
  policy: OverridePolicy;
  validator: ValidatorOptions;
  /**
   * Steps an owner appends after the edited ones. `offers` tells whether a module is enabled in this same set,
   * so a closing step never points at one that is off.
   */
  closingSteps?: (
    steps: TutorialStep[],
    tutorial: RepoTutorial,
    offers: (moduleId: string) => boolean
  ) => TutorialStep[];
}

export function tutorialContent(options: TutorialContentOptions) {
  const { models, repo, policy, validator, closingSteps } = options;
  const repoTranscripts: Record<string, readonly TutorialTurn[]> = Object.fromEntries(
    repo.map(t => [t.intro.id, t.transcript])
  );

  /**
   * Pure: applies each module's overrides and checks every overridden module against the validator. A module
   * whose overrides fail anything falls back to its repo content and keeps its switch. `hold` switches modules
   * off for this result only.
   */
  function effectiveTutorials(
    overrides: readonly TutorialOverrideState[],
    hold: ReadonlySet<string> = new Set()
  ): EffectiveTutorials {
    const byId = new Map(overrides.map(o => [o.moduleId, o]));
    const parsed = new Map(
      repo.map(t => [t.intro.id, parseUnits(t.intro.id, byId.get(t.intro.id)?.fields, t.steps, policy)])
    );
    const build = (refused: ReadonlySet<string>) => {
      const applied = new Map<string, ReturnType<typeof applyOverrides>>();
      const edited = repo.map(t => {
        const id = t.intro.id;
        const units = refused.has(id) ? [] : parsed.get(id)!.units;
        const result = applyOverrides(units, t.steps, t.transcript);
        applied.set(id, result);
        return {
          tutorial: t,
          result,
          enabled: t.enabled && byId.get(id)?.enabled !== false && !hold.has(id),
          revision: byId.get(id)?.revision ?? 0,
        };
      });
      const offers = (moduleId: string) => edited.some(e => e.tutorial.intro.id === moduleId && e.enabled);
      const modules: TutorialModule[] = edited.map(({ tutorial, result, enabled, revision }) => ({
        ...tutorial.intro,
        version: tutorial.version,
        revision,
        enabled,
        steps: closingSteps ? closingSteps(result.steps, tutorial, offers) : result.steps,
        transcript: result.transcript,
        ...(tutorial.canvas && { canvas: tutorial.canvas }),
        ...(tutorial.canvasSolve && { canvasSolve: tutorial.canvasSolve }),
      }));
      return { modules, applied };
    };

    const first = build(new Set());
    const rejected = new Map<string, ValidationIssue[]>();
    for (const t of repo) {
      const id = t.intro.id;
      const { units, issues } = parsed.get(id)!;
      if (issues.length > 0) {
        rejected.set(id, issues);
        continue;
      }
      if (units.length === 0) continue;
      const found = validateTutorialModule(
        first.modules.find(m => m.id === id)!,
        validator
      );
      if (found.length > 0) rejected.set(id, found);
    }
    const final = rejected.size > 0 ? build(new Set(rejected.keys())) : first;

    const report = Object.fromEntries(
      repo.map(t => {
        const id = t.intro.id;
        const applied = final.applied.get(id)!;
        const states = rejected.has(id)
          ? applyOverrides(parsed.get(id)!.units, t.steps, t.transcript).states
          : applied.states;
        return [id, { states, rejected: rejected.get(id) ?? [], structuralDigest: applied.structuralDigest }];
      })
    );
    return { modules: final.modules, overrides: report };
  }

  async function readOverrides(): Promise<TutorialOverrideState[]> {
    return models.Override.find({}, OVERRIDE_PROJECTION).lean<TutorialOverrideState[]>();
  }

  let memo: { key: string; value: EffectiveTutorials } | undefined;
  const memoKey = (rows: readonly TutorialOverrideState[]) =>
    JSON.stringify(
      [...rows]
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId))
        .map(r => [r.moduleId, r.enabled ?? null, r.revision, r.contentSeq ?? 0, r.structuralDigest ?? null])
    );

  function computeOnce(rows: readonly TutorialOverrideState[], hold: ReadonlySet<string>): EffectiveTutorials {
    if (hold.size > 0) return effectiveTutorials(rows, hold);
    const key = memoKey(rows);
    if (memo?.key !== key) memo = { key, value: effectiveTutorials(rows) };
    return memo.value;
  }

  /**
   * Moves each row's revision when the structure it serves changed without a save: a structural override that
   * went stale or retired under a deploy, or one the validator now refuses. Best-effort: a module whose bump
   * did not land is held off for this request rather than served at a revision that no longer describes it.
   */
  async function followDigests(rows: readonly TutorialOverrideState[], result: EffectiveTutorials) {
    const moved: { row: TutorialOverrideState; move: DigestMove; digest: string; version: number }[] = [];
    for (const row of rows) {
      const tutorial = repo.find(t => t.intro.id === row.moduleId);
      const digest = result.overrides[row.moduleId]?.structuralDigest;
      if (!tutorial || digest === undefined) continue;
      const move = digestMove(row, digest, tutorial.version);
      if (move !== 'none') moved.push({ row, move, digest, version: tutorial.version });
    }
    await Promise.all(
      moved.map(async ({ row, move, digest, version }) => {
        if (move === 'adopt') {
          // Adopting moves no revision, so a failed write only means the next request adopts instead.
          try {
            await models.Override.updateOne(
              { moduleId: row.moduleId, structuralDigest: { $exists: false } },
              { $set: { structuralDigest: digest, digestRepoVersion: version } }
            );
          } catch {
            // left for the next request
          }
          return;
        }
        try {
          await withTransaction(async session => {
            const bumped = await models.Override.findOneAndUpdate(
              { moduleId: row.moduleId, structuralDigest: row.structuralDigest, revision: row.revision },
              {
                $set: { structuralDigest: digest, digestRepoVersion: version },
                $inc: { revision: 1, contentSeq: 1 },
              },
              { returnDocument: 'after', session }
            );
            if (!bumped) return;
            await models.OverrideChange.create(
              [
                {
                  moduleId: row.moduleId,
                  field: 'revision',
                  before: JSON.stringify(row.revision),
                  after: JSON.stringify(bumped.revision),
                  actorId: 'system',
                  reason: 'The structure this module serves changed without a save',
                },
              ],
              { session }
            );
          });
        } catch {
          // the re-read decides: a row still disagreeing is held off
        }
      })
    );
    return moved.some(m => m.move === 'bump');
  }

  async function resolve(): Promise<EffectiveTutorials> {
    const rows = await readOverrides();
    const first = computeOnce(rows, new Set());
    if (!(await followDigests(rows, first))) return first;
    // Whoever won the CAS, the row now names the digest it serves; a module still disagreeing is held off.
    const fresh = await readOverrides();
    const settled = computeOnce(fresh, new Set());
    const hold = new Set<string>();
    for (const row of fresh) {
      const tutorial = repo.find(t => t.intro.id === row.moduleId);
      const digest = settled.overrides[row.moduleId]?.structuralDigest;
      if (tutorial && digest !== undefined && digestMove(row, digest, tutorial.version) === 'bump') {
        hold.add(row.moduleId);
      }
    }
    return hold.size > 0 ? computeOnce(fresh, hold) : settled;
  }

  return { effectiveTutorials, readOverrides, resolve, repoTranscripts };
}

export type TutorialContent = ReturnType<typeof tutorialContent>;
