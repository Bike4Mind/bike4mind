import { z } from 'zod';
import { ForbiddenError, type TutorialStep } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import type { TutorialContent, ModuleOverrideReport } from '../effectiveModules';
import { TUTORIAL_MODULE_ID, type TutorialModels } from '../models';
import {
  editableOf,
  OverrideUnitSchema,
  unitKey,
  unitState,
  type OverridePolicy,
  type OverrideUnit,
} from '../overrides';
import type { RepoTutorial } from '../types';
import type { KnownSelectors } from '../validate';
import type { AdminCheck, ApiBuilder } from './types';

const PutSchema = z
  .object({
    moduleId: z.string().regex(TUTORIAL_MODULE_ID),
    enabled: z.boolean().optional(),
    fields: z.array(OverrideUnitSchema).max(400).optional(),
    reason: z.string().trim().min(1).max(500),
    /** The row's `contentSeq` the edits were drafted against; null when the module had no row. */
    expectedContentSeq: z.number().int().min(0).nullable().optional(),
  })
  .refine(body => body.enabled !== undefined || body.fields !== undefined);

export interface TutorialModuleOverrideRow {
  moduleId: string;
  title: string;
  version: number;
  revision: number;
  /** Moves on content writes and system revision bumps, not switch-only writes; the editor sends back the value its draft started from. */
  contentSeq: number | null;
  repoEnabled: boolean;
  enabled: boolean;
  overridden: boolean;
  lastChange: { field: string; actorId: string; reason: string; at: string } | null;
  /** The latest change to the edits themselves, so a later switch toggle does not claim their authorship. */
  lastFieldsChange: { actorId: string; reason: string; at: string } | null;
  /** The repo content edits are written against: the steps as shipped, and the recorded turns. */
  repo: {
    steps: TutorialStep[];
    turns: { turn: number; prompt: string; reply: string }[];
  };
  /** Per step id, the copy fields an edit may change; prompts appear under the step that sends them. */
  editable: Record<string, string[]>;
  fields: OverrideUnit[];
  report: ModuleOverrideReport;
}

export interface TutorialAnchorChoices {
  anchors: string[];
  anchorScopes: string[];
  avoids: string[];
}

export interface TutorialModulesResponse {
  modules: TutorialModuleOverrideRow[];
  choices: TutorialAnchorChoices;
}

export const anchorChoicesOf = (known: KnownSelectors): TutorialAnchorChoices => ({
  anchors: [...known.anchors].sort(),
  anchorScopes: [...known.anchorScopes].sort(),
  avoids: [...known.avoids].sort(),
});

/**
 * Refuses an edit set before the validator sees it: two units on one place, or a new unit not written against
 * today's repo value. A unit stored earlier may come back unchanged while stale or retired, so a save elsewhere
 * never forces it to be resolved first. One a deploy has since locked still fails the validator's lock check.
 */
export function refuseFields(
  tutorial: RepoTutorial,
  fields: readonly OverrideUnit[],
  stored: unknown
): { error: string; rules: { stepId?: string; rule: string; message: string }[] } | null {
  const keys = fields.map(unitKey);
  const duplicate = keys.find((key, i) => keys.indexOf(key) !== i);
  if (duplicate) {
    return { error: 'Two edits change the same place', rules: [{ rule: 'override-duplicate', message: duplicate }] };
  }
  const storedJson = new Set(
    (OverrideUnitSchema.array().safeParse(stored ?? []).data ?? []).map(unit => JSON.stringify(unit))
  );
  const rules = fields.flatMap(unit => {
    if (storedJson.has(JSON.stringify(unit))) return [];
    const at = 'stepId' in unit ? { stepId: unit.stepId } : {};
    if (unitState(unit, tutorial.steps, tutorial.transcript) !== 'live') {
      return [
        {
          ...at,
          rule: 'override-not-current',
          message: `${unitKey(unit)} is not written over today's repo value, or changes nothing`,
        },
      ];
    }
    return [];
  });
  return rules.length > 0 ? { error: 'An edit is not written against the current repo', rules } : null;
}

export interface OverridesRouteOptions {
  api: ApiBuilder;
  isAdmin: AdminCheck;
  models: Pick<TutorialModels, 'Override' | 'OverrideChange'>;
  content: TutorialContent;
  repo: readonly RepoTutorial[];
  policy: OverridePolicy;
  known: KnownSelectors;
}

type LatestChange = { _id: string; field: string; actorId: string; reason: string; createdAt: Date };

/**
 * GET/PUT: the tutorial switch and live edits behind the admin editor. GET lists every repo module with its
 * switch, version, revision, last change, the repo content an edit is written against, and each stored edit
 * with its state. PUT `{ moduleId, reason, enabled?, fields?, expectedContentSeq? }` switches a module,
 * replaces its edits, or both; `fields: []` resets it. An `expectedContentSeq` the row no longer holds is a
 * 409. An edit set the validator refuses is a 422 with the rules, and nothing is written.
 */
export function overridesRoute({ api, isAdmin, models, content, repo, policy, known }: OverridesRouteOptions) {
  const choices = anchorChoicesOf(known);
  const requireAdmin = async (req: Parameters<AdminCheck>[0]) => {
    if (!(await isAdmin(req))) throw new ForbiddenError('Only full administrators can edit tutorials.');
  };

  const latestChangePerModule = (field?: string) =>
    models.OverrideChange.aggregate<LatestChange>([
      ...(field ? [{ $match: { field } }] : []),
      { $sort: { moduleId: 1, createdAt: -1 } },
      {
        $group: {
          _id: '$moduleId',
          field: { $first: '$field' },
          actorId: { $first: '$actorId' },
          reason: { $first: '$reason' },
          createdAt: { $first: '$createdAt' },
        },
      },
    ]);

  async function listModules(): Promise<TutorialModuleOverrideRow[]> {
    const [overrides, changes, fieldsChanges] = await Promise.all([
      content.readOverrides(),
      latestChangePerModule(),
      latestChangePerModule('fields'),
    ]);
    const overrideOf = new Map(overrides.map(o => [o.moduleId, o]));
    const changeOf = new Map(changes.map(c => [c._id, c]));
    const fieldsChangeOf = new Map(fieldsChanges.map(c => [c._id, c]));
    const effective = content.effectiveTutorials(overrides);
    return repo.map(tutorial => {
      const id = tutorial.intro.id;
      const override = overrideOf.get(id);
      const change = changeOf.get(id);
      const fieldsChange = fieldsChangeOf.get(id);
      const parsed = OverrideUnitSchema.array().safeParse(override?.fields ?? []);
      return {
        moduleId: id,
        title: tutorial.intro.title,
        version: tutorial.version,
        revision: override?.revision ?? 0,
        contentSeq: override ? (override.contentSeq ?? 0) : null,
        repoEnabled: tutorial.enabled,
        enabled: tutorial.enabled && override?.enabled !== false,
        overridden: override?.enabled !== undefined || (override?.fields?.length ?? 0) > 0,
        lastChange: change
          ? { field: change.field, actorId: change.actorId, reason: change.reason, at: change.createdAt.toISOString() }
          : null,
        lastFieldsChange: fieldsChange
          ? { actorId: fieldsChange.actorId, reason: fieldsChange.reason, at: fieldsChange.createdAt.toISOString() }
          : null,
        repo: {
          steps: tutorial.steps.map(step => ({ ...step })),
          turns: tutorial.transcript.map((t, turn) => ({ turn, prompt: t.prompt, reply: t.reply })),
        },
        editable: editableOf(id, policy),
        fields: parsed.success ? parsed.data : [],
        report: effective.overrides[id],
      };
    });
  }

  return api()
    .get(async (req, res) => {
      await requireAdmin(req);
      return res.json({ modules: await listModules(), choices } satisfies TutorialModulesResponse);
    })
    .put(async (req, res) => {
      await requireAdmin(req);
      const parsed = PutSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'moduleId, a reason of up to 500 characters, and enabled or fields are required' });
      }
      const { moduleId, enabled, fields, reason, expectedContentSeq } = parsed.data;
      const tutorial = repo.find(candidate => candidate.intro.id === moduleId);
      if (!tutorial) return res.status(404).json({ error: 'No such tutorial module' });
      const actorId = req.user!.id;
      const rows = await content.readOverrides();
      const prior = rows.find(row => row.moduleId === moduleId);
      // Every content write bumps contentSeq, so a stored 0 (switch-only row) holds no content a null basis could miss.
      if (expectedContentSeq !== undefined && (expectedContentSeq ?? 0) !== (prior?.contentSeq ?? 0)) {
        return res.status(409).json({ error: 'The module changed while you edited it; reload and try again' });
      }

      let revisionStep = 0;
      let structuralDigest: string | undefined;
      if (fields !== undefined) {
        const refused = refuseFields(tutorial, fields, prior?.fields);
        if (refused) return res.status(422).json(refused);
        const served = content.effectiveTutorials(rows).overrides[moduleId];
        const candidate = content.effectiveTutorials([
          ...rows.filter(row => row.moduleId !== moduleId),
          { moduleId, enabled: prior?.enabled, revision: prior?.revision ?? 0, fields },
        ]).overrides[moduleId];
        if (candidate.rejected.length > 0) {
          return res.status(422).json({ error: 'The edited module breaks a tutorial rule', rules: candidate.rejected });
        }
        structuralDigest = candidate.structuralDigest;
        // Copy and reply edits leave a walk where it stands; a change to the structure restarts it. Measured
        // against the stored digest, so a save cannot absorb a structural change a deploy made and nothing has
        // bumped yet; a digest a newer repo version wrote is not this instance's to judge.
        const stored =
          prior?.structuralDigest !== undefined && (prior.digestRepoVersion ?? 0) <= tutorial.version
            ? prior.structuralDigest
            : served.structuralDigest;
        revisionStep = candidate.structuralDigest === stored ? 0 : 1;
      }

      const changed: { field: string; before: unknown; after: unknown }[] = [];
      if (enabled !== undefined) changed.push({ field: 'enabled', before: prior?.enabled, after: enabled });
      if (fields !== undefined) changed.push({ field: 'fields', before: prior?.fields, after: fields });

      // The change and its audit rows commit together, so a failed audit rolls the change back. The content
      // sequence guards content edits and the enabled value read guards switch writes; the loser gets a 409.
      const written = await withTransaction(async session => {
        // A first save matches no stored row, so one committed since the read makes it insert, hit the unique
        // moduleId and read as a conflict below rather than overwrite it.
        const update = await models.Override.findOneAndUpdate(
          prior
            ? {
                moduleId,
                contentSeq: prior.contentSeq ?? 0,
                ...(enabled !== undefined && { enabled: prior.enabled ?? null }),
              }
            : { moduleId, contentSeq: { $exists: false } },
          {
            $set: {
              ...(enabled !== undefined && { enabled }),
              ...(fields !== undefined && { fields }),
              ...(structuralDigest !== undefined && { structuralDigest }),
              updatedBy: actorId,
              reason,
            },
            // An older instance saving mid-deploy never lowers the version a newer one recorded.
            ...(structuralDigest !== undefined && { $max: { digestRepoVersion: tutorial.version } }),
            $inc: { contentSeq: fields !== undefined ? 1 : 0, revision: revisionStep },
          },
          { upsert: !prior, returnDocument: 'after', session }
        );
        if (!update) return false;
        await models.OverrideChange.create(
          changed.map(change => ({
            moduleId,
            field: change.field,
            before: change.before === undefined ? null : JSON.stringify(change.before),
            after: JSON.stringify(change.after),
            actorId,
            reason,
          })),
          { session, ordered: true }
        );
        return true;
      }).catch((error: { code?: number }) => {
        if (error?.code === 11000) return false;
        throw error;
      });
      if (!written) {
        return res.status(409).json({ error: 'The module changed while you edited it; reload and try again' });
      }
      req.logger?.info(
        { actorId, moduleId, enabled, fieldCount: fields?.length, revisionStep },
        'Tutorial module changed by admin'
      );
      return res.json({ modules: await listModules(), choices } satisfies TutorialModulesResponse);
    });
}
