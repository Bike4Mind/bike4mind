import {
  QUEST_COMPLEXITY_VALUES,
  SUBQUEST_STATUS_VALUES,
  normalizeQuestComplexity,
  normalizeSubQuestStatus,
} from '@bike4mind/common';
import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: rewrite any retired QuestMaster status or complexity token in `questmasterplans` to
 * the canonical vocabulary.
 *
 * WHY THIS CAN EXIST AT ALL. The mongoose `enum` on the sub-quest status path only ran on the
 * create path: no call site passed `runValidators`, and every status write is `findOneAndUpdate`
 * + `$set`, so the enum was dead on updates (pinned in
 * packages/database/src/__test__/questMasterPlanLegacyStatus.test.ts). `complexity` has never had
 * an enum at all, on any path. The same PR that adds this migration turns `runValidators` on for
 * the status writes, which closes the hole going forward - this pass closes it backwards. Order
 * matters conceptually but not operationally: enabling validators cannot strand an existing
 * legacy row, because update validators only check the paths named in the update, and a repair
 * write names a canonical value.
 *
 * EXPECTED TO BE A NO-OP. On the evidence, the retired vocabularies never reached this
 * collection: `pending`/`in-progress` lived in the V2 artifact zod schema, which has no
 * producers, and `blocked` in the deleted V1 artifact repository, which operated on the separate
 * `questmaster_artifacts` collection. But the update path was unguarded for the collection's
 * whole life and this repo's history is squashed at the open-core cut, so "no legacy data" was an
 * assumption nobody could check. The counts logged below turn it into a fact.
 *
 * UNRECOGNIZED TOKENS ARE SKIPPED AND LOGGED, NEVER GUESSED. normalizeSubQuestStatus returns null
 * rather than a default for a token with no documented meaning, and this script honours that: a
 * row whose meaning nobody knows is reported for a human, not silently rewritten into something
 * that merely validates.
 *
 * `reviewStatus` IS DELIBERATELY UNTOUCHED. Its vocabulary (pending/approved/rejected) never
 * diverged. Note the trap: `pending` is CANONICAL for a review gate but a RETIRED ALIAS for a
 * sub-quest status meaning `not_started`. Running the status normalizer over a review gate would
 * silently destroy it, so the two must never share a pass.
 *
 * Raw driver throughout, never the QuestMasterPlan schema class - a migration is a point-in-time
 * record and must not reshape itself as the live schema evolves. The collection name below was
 * confirmed empirically against a real mongod, not assumed from the model name (see the
 * `confirms the collection name` case in the characterization test).
 */

const BATCH_SIZE = 200;
const MAX_SKIPPED_SAMPLES = 20;

interface RawSubQuest {
  id?: string;
  status?: unknown;
}

interface RawQuest {
  id?: string;
  complexity?: unknown;
  subQuests?: RawSubQuest[];
}

interface RawPlan {
  _id: mongoose.Types.ObjectId;
  quests?: RawQuest[];
}

const migration: MigrationFile = {
  id: 20260826000000,
  name: 'normalize questmaster status and complexity vocabularies',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const plans = db.collection<RawPlan>('questmasterplans');

    // Any plan carrying at least one non-canonical status OR complexity. $elemMatch at both
    // levels is required: a bare `{'quests.subQuests.status': {$nin: [...]}}` would test the
    // whole array at once and match only plans where NO element is canonical, which is the
    // opposite of what is wanted.
    const filter = {
      $or: [
        {
          quests: {
            $elemMatch: { subQuests: { $elemMatch: { status: { $nin: [...SUBQUEST_STATUS_VALUES] } } } },
          },
        },
        { quests: { $elemMatch: { complexity: { $nin: [...QUEST_COMPLEXITY_VALUES] } } } },
      ],
    };

    // Cursor pagination on _id rather than a self-consuming filter. A plan holding an
    // UNRECOGNIZED token is skipped, so it still matches the filter after this pass - a
    // re-selecting loop would spin on it forever.
    let lastId: mongoose.Types.ObjectId | null = null;
    let plansScanned = 0;
    let plansRewritten = 0;
    let statusesRewritten = 0;
    let complexitiesRewritten = 0;
    let skipped = 0;
    const skippedSamples: string[] = [];
    const rewriteTally = new Map<string, number>();

    for (;;) {
      const page: RawPlan[] = await plans
        .find(lastId ? { $and: [filter, { _id: { $gt: lastId } }] } : filter, {
          projection: { quests: 1 },
        })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();
      if (page.length === 0) break;

      const ops = [];
      for (const plan of page) {
        const $set: Record<string, string> = {};

        (plan.quests ?? []).forEach((quest, questIndex) => {
          const canonicalComplexity = normalizeQuestComplexity(quest.complexity);
          if (canonicalComplexity !== null && canonicalComplexity !== quest.complexity) {
            $set[`quests.${questIndex}.complexity`] = canonicalComplexity;
            complexitiesRewritten++;
            rewriteTally.set(
              `complexity:${String(quest.complexity)}`,
              (rewriteTally.get(`complexity:${String(quest.complexity)}`) ?? 0) + 1
            );
          } else if (canonicalComplexity === null) {
            skipped++;
            if (skippedSamples.length < MAX_SKIPPED_SAMPLES) {
              skippedSamples.push(
                `${plan._id.toString()} quest[${questIndex}] complexity=${JSON.stringify(quest.complexity)}`
              );
            }
          }

          (quest.subQuests ?? []).forEach((subQuest, subQuestIndex) => {
            const canonicalStatus = normalizeSubQuestStatus(subQuest.status);
            if (canonicalStatus !== null && canonicalStatus !== subQuest.status) {
              $set[`quests.${questIndex}.subQuests.${subQuestIndex}.status`] = canonicalStatus;
              statusesRewritten++;
              rewriteTally.set(
                `status:${String(subQuest.status)}`,
                (rewriteTally.get(`status:${String(subQuest.status)}`) ?? 0) + 1
              );
            } else if (canonicalStatus === null) {
              skipped++;
              if (skippedSamples.length < MAX_SKIPPED_SAMPLES) {
                skippedSamples.push(
                  `${plan._id.toString()} quest[${questIndex}].subQuests[${subQuestIndex}] ` +
                    `status=${JSON.stringify(subQuest.status)}`
                );
              }
            }
          });
        });

        if (Object.keys($set).length > 0) {
          ops.push({ updateOne: { filter: { _id: plan._id }, update: { $set } } });
          plansRewritten++;
        }
      }

      if (ops.length > 0) {
        await plans.bulkWrite(ops, { ordered: false });
      }

      plansScanned += page.length;
      lastId = page[page.length - 1]._id;
      console.log(`[normalize-questmaster-vocabularies] scanned ${plansScanned} plan(s) with a non-canonical token`);
    }

    if (plansScanned === 0) {
      console.log(
        '[normalize-questmaster-vocabularies] no plan carries a non-canonical status or complexity - ' +
          'the collection was already clean, which confirms the retired vocabularies never reached it'
      );
      return;
    }

    const tally = [...rewriteTally.entries()].map(([token, count]) => `${token} x${count}`).join(', ');
    console.log(
      `[normalize-questmaster-vocabularies] rewrote ${statusesRewritten} status(es) and ` +
        `${complexitiesRewritten} complexity value(s) across ${plansRewritten} plan(s)` +
        (tally ? ` - ${tally}` : '')
    );

    if (skipped > 0) {
      // Not a failure: an undocumented token is a question for a human, not a value to invent.
      // Loud so it cannot be mistaken for "nothing to do".
      console.warn(
        `[normalize-questmaster-vocabularies] SKIPPED ${skipped} value(s) with no documented ` +
          `meaning - these remain non-canonical and need a decision: ${skippedSamples.join('; ')}`
      );
    }
  },

  down: async () => {
    // No rollback. The retired token a value came from is not recoverable once rewritten, and
    // restoring it would reintroduce exactly the data the canonical vocabulary exists to remove.
    console.log('[normalize-questmaster-vocabularies] rollback: no-op; the retired tokens are not recoverable.');
  },
};

export default migration;
