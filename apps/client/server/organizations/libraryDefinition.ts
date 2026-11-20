import type {
  IAgent,
  ISkill,
  IBriefcasePrompt,
  IImageGenerationTemplate,
  OrganizationLibraryDefinition,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { BriefcasePromptInput, ImageGenerationTemplateInput } from '@bike4mind/common';

export function agentLibraryDefinition(agent: IAgent): OrganizationLibraryDefinition {
  if (agent.type === 'voice') throw new BadRequestError('Voice agents cannot be published to the library');
  return {
    kind: 'agent',
    definition: {
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      triggerWords: agent.triggerWords,
      capabilities: agent.capabilities,
      personality: agent.personality,
      identity: agent.identity,
      preferredModel: agent.preferredModel,
      preferredImageModel: agent.preferredImageModel,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      allowedTools: agent.allowedTools,
      deniedTools: agent.deniedTools,
      maxIterations: agent.maxIterations,
      defaultThoroughness: agent.defaultThoroughness,
      confidenceGateThreshold: agent.confidenceGateThreshold,
      confidenceGateMode: agent.confidenceGateMode,
      confidenceGateSelfReport: agent.confidenceGateSelfReport,
      useOwnCredits: false,
      isPublic: false,
    },
  };
}

export function skillLibraryDefinition(skill: ISkill): OrganizationLibraryDefinition {
  return {
    kind: 'skill',
    definition: {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      argumentHint: skill.argumentHint,
      allowedTools: skill.allowedTools,
      files: skill.files,
      claudeCodeAllowedTools: skill.claudeCodeAllowedTools,
      claudeCodeModel: skill.claudeCodeModel,
      disableModelInvocation: skill.disableModelInvocation,
    },
  };
}

export function promptLibraryDefinition(prompt: IBriefcasePrompt): OrganizationLibraryDefinition {
  return {
    kind: 'prompt',
    definition: BriefcasePromptInput.parse({
      name: prompt.name,
      description: prompt.description,
      type: prompt.type,
      promptText: prompt.promptText,
      tags: prompt.tags ?? [],
      executionMode: prompt.executionMode === 'hidden' ? 'auto-fire' : prompt.executionMode,
      requiredTools: prompt.requiredTools ?? [],
    }),
  };
}

export function templateLibraryDefinition(template: IImageGenerationTemplate): OrganizationLibraryDefinition {
  return {
    kind: 'template',
    definition: ImageGenerationTemplateInput.parse({
      name: template.name,
      description: template.description,
      category: template.category,
      model: template.model,
      settings: template.settings,
    }),
  };
}
