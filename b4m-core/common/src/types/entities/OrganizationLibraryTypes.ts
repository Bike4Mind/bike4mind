import type { IAgent } from './AgentTypes';
import type { ISkill } from './SkillTypes';
import type { IBriefcasePrompt } from './BriefcasePromptTypes';
import type { IImageGenerationTemplate } from './ImageGenerationTemplateTypes';

export type OrganizationLibraryDefinition =
  | { kind: 'agent'; definition: Partial<IAgent> }
  | { kind: 'skill'; definition: Partial<ISkill> }
  | { kind: 'prompt'; definition: Partial<IBriefcasePrompt> }
  | { kind: 'template'; definition: Partial<IImageGenerationTemplate> };

export type OrganizationLibraryKind = OrganizationLibraryDefinition['kind'];

export interface OrganizationLibraryItemSummary {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  kind: OrganizationLibraryKind;
  pinned: boolean;
}

export type OrganizationLibraryItem = OrganizationLibraryItemSummary & OrganizationLibraryDefinition;
