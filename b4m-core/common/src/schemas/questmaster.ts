import { z } from 'zod';
import { BaseArtifactSchema } from './artifacts';
import { QUEST_COMPLEXITY_VALUES, SUBQUEST_STATUS_VALUES } from '../types/entities/QuestTypes';

// Quest schemas - status and complexity use the canonical QuestMaster
// vocabulary from QuestTypes (shared with QuestMasterPlan and the client)
export const QuestStatusSchema = z.enum(SUBQUEST_STATUS_VALUES);

export const QuestSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(255),
  description: z.string().max(1000),
  status: QuestStatusSchema.prefault('not_started'),
  order: z.int().nonnegative(),
  dependencies: z.array(z.uuid()).optional(),
  estimatedMinutes: z.int().positive().optional(),
  completedAt: z.date().optional(),
  completedBy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const QuestResourceSchema = z.object({
  type: z.enum(['documentation', 'tutorial', 'example', 'tool']),
  title: z.string().min(1).max(255),
  url: z.url(),
  description: z.string().max(500).optional(),
});

export const QuestMasterContentSchema = z.object({
  goal: z.string().min(1).max(500),
  quests: z.array(QuestSchema).min(1),
  totalSteps: z.int().positive(),
  estimatedDuration: z.int().positive().optional(),
  complexity: z.enum(QUEST_COMPLEXITY_VALUES),
  category: z.string().max(100).optional(),
  prerequisites: z.array(z.string().max(255)).optional(),
  completionCriteria: z.array(z.string().max(500)).optional(),
  resources: z.array(QuestResourceSchema).optional(),
});

export const QuestMasterArtifactV2Schema = BaseArtifactSchema.extend({
  type: z.literal('questmaster'),
  content: QuestMasterContentSchema,
});

// Type exports
export type QuestStatus = z.infer<typeof QuestStatusSchema>;
export type Quest = z.infer<typeof QuestSchema>;
export type QuestResource = z.infer<typeof QuestResourceSchema>;
export type QuestMasterContent = z.infer<typeof QuestMasterContentSchema>;
export type QuestMasterArtifactV2 = z.infer<typeof QuestMasterArtifactV2Schema>;

// Validation helpers
export const validateQuest = (data: unknown): Quest => {
  return QuestSchema.parse(data);
};

export const validateQuestMasterArtifactV2 = (data: unknown): QuestMasterArtifactV2 => {
  return QuestMasterArtifactV2Schema.parse(data);
};

// Safe parse helpers (return result object instead of throwing)
export const safeParseQuest = (data: unknown) => {
  return QuestSchema.safeParse(data);
};

export const safeParseQuestMasterArtifactV2 = (data: unknown) => {
  return QuestMasterArtifactV2Schema.safeParse(data);
};
