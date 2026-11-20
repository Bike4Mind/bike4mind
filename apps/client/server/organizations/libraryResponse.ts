import { z } from 'zod';
import { BriefcasePromptInput, ImageGenerationTemplateInput } from '@bike4mind/common';

export const librarySummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['agent', 'skill', 'prompt', 'template']),
  pinned: z.boolean(),
});

const text = z.string().optional();
const strings = z.array(z.string()).optional();
const fields = z.record(z.string(), z.unknown()).optional();
const agentDefinition = z.object({
  name: z.string(),
  description: text,
  systemPrompt: text,
  triggerWords: strings,
  capabilities: strings,
  personality: fields,
  identity: fields,
  preferredModel: text,
  preferredImageModel: text,
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  allowedTools: strings,
  deniedTools: strings,
  maxIterations: fields,
  defaultThoroughness: text,
  confidenceGateThreshold: z.number().optional(),
  confidenceGateMode: text,
  confidenceGateSelfReport: z.boolean().optional(),
  useOwnCredits: z.literal(false),
  isPublic: z.literal(false),
});
const skillDefinition = z.object({
  name: z.string(),
  description: text,
  body: z.string(),
  argumentHint: text,
  allowedTools: strings,
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  claudeCodeAllowedTools: strings,
  claudeCodeModel: text,
  disableModelInvocation: z.boolean().optional(),
});
const promptDefinition = BriefcasePromptInput;
const templateDefinition = ImageGenerationTemplateInput;

export const libraryListResponse = z.object({ items: z.array(librarySummarySchema) });
export const librarySourcesResponse = z.object({ sources: z.array(z.object({ id: z.string(), name: z.string() })) });
export const librarySummaryResponse = z.object({ item: librarySummarySchema });
export const libraryItemResponse = z.object({
  item: z.discriminatedUnion('kind', [
    librarySummarySchema.extend({ kind: z.literal('agent'), definition: agentDefinition }),
    librarySummarySchema.extend({ kind: z.literal('skill'), definition: skillDefinition }),
    librarySummarySchema.extend({ kind: z.literal('prompt'), definition: promptDefinition }),
    librarySummarySchema.extend({ kind: z.literal('template'), definition: templateDefinition }),
  ]),
});
