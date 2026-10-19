import * as z from 'zod';
import type { IQuestMasterPlanDocument } from '../types/entities/QuestTypes';
import { passthroughField, passthroughShape } from './responseShape';

// Held to IQuestMasterPlanDocument: a new plan field fails the build here until it is listed.
const QUEST_MASTER_PLAN_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  notebookId: true,
  goal: true,
  quests: true,
  userId: true,
  visibility: true,
  state: true,
  lastAccessedAt: true,
  sessionHistory: true,
  metrics: true,
  tags: true,
  priority: true,
  parentPlanId: true,
  sharedWith: true,
  handoff: true,
  blockers: true,
  decisions: true,
} as const satisfies Record<keyof IQuestMasterPlanDocument, true>;

export const questMasterPlanResponseSchema = z.object(passthroughShape(QUEST_MASTER_PLAN_RESPONSE_FIELDS));
export const questMasterPlansResponseSchema = z.array(questMasterPlanResponseSchema);

/**
 * `{ success, plan }`, the envelope of the plan write routes: quest-master-plans/[id]/* (except the
 * GET) and quest-plans/[id]/{clone,continue,progress}. The quest-plans/[id] GET and PATCH return the bare plan.
 */
export const questMasterPlanMutationResponseSchema = z.object({
  success: z.literal(true),
  plan: questMasterPlanResponseSchema,
});

/** The progress routes also echo the plan's metrics at the top level. */
export const questMasterPlanProgressResponseSchema = questMasterPlanMutationResponseSchema.extend({
  metrics: passthroughField,
});
