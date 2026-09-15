import { AgentOrchestration, ExportableAgentData, FormState } from '../types/agentForm';

/**
 * Whether the agent form has any orchestration field set beyond just
 * maxIterations. Shared by OrchestrationSection (UI gating) and AgentForm
 * (submit-time stripping) so the two can never diverge.
 *
 * The server-side `hasOrchestrationFields` in `agentOrchestration.ts` operates
 * on IAgent and intentionally includes maxIterations as a promoter. This
 * client-side predicate is deliberately narrower - it excludes maxIterations so
 * setting only iteration caps doesn't promote a chat agent into ReAct mode.
 */
export const isOrchestrationConfigured = (o: AgentOrchestration): boolean =>
  o.allowedTools.length > 0 ||
  o.deniedTools.length > 0 ||
  o.defaultThoroughness !== '' ||
  o.exclusiveMcpServers.length > 0 ||
  o.fallbackModels.length > 0 ||
  o.defaultVariables.some(v => v.key.trim().length > 0);

// Safely apply imported data to form state
export const applyImportedDataToNewAgent = (
  currentFormState: FormState,
  importedData: Partial<ExportableAgentData>
): FormState => {
  // Apply value only if it's not empty/null
  const applyIfNotEmpty = (current: any, imported: any) => {
    if (imported === undefined || imported === null || imported === '') {
      return current;
    }
    return imported;
  };

  // Helper for objects - only apply if object has non-empty values
  const applyObjectIfNotEmpty = (current: any, imported: any) => {
    if (!imported || typeof imported !== 'object') {
      return current;
    }

    const result = { ...current };
    Object.keys(imported).forEach(key => {
      if (imported[key] !== undefined && imported[key] !== null && imported[key] !== '') {
        result[key] = imported[key];
      }
    });
    return result;
  };

  return {
    ...currentFormState,
    name: applyIfNotEmpty(currentFormState.name, importedData.name),
    description: applyIfNotEmpty(currentFormState.description, importedData.description),
    triggerWords:
      importedData.triggerWords && importedData.triggerWords.length > 0
        ? importedData.triggerWords
        : currentFormState.triggerWords,
    isPublic: importedData.isPublic !== undefined ? importedData.isPublic : currentFormState.isPublic,
    useOwnCredits:
      importedData.useOwnCredits !== undefined ? importedData.useOwnCredits : currentFormState.useOwnCredits,
    preferredModel: applyIfNotEmpty(currentFormState.preferredModel, importedData.preferredModel),
    preferredImageModel: applyIfNotEmpty(currentFormState.preferredImageModel, importedData.preferredImageModel),
    temperature: importedData.temperature !== undefined ? importedData.temperature : currentFormState.temperature,
    maxTokens: importedData.maxTokens !== undefined ? importedData.maxTokens : currentFormState.maxTokens,
    personality: {
      ...currentFormState.personality,
      ...applyObjectIfNotEmpty(currentFormState.personality, importedData.personality),
    },
    visual: {
      ...currentFormState.visual,
      style: applyIfNotEmpty(currentFormState.visual.style, importedData.visual?.style),
      generationPrompt: applyIfNotEmpty(
        currentFormState.visual.generationPrompt,
        importedData.visual?.generationPrompt
      ),
      // Keep current portraitUrl since it's not exported
    },
    capabilities: {
      ...currentFormState.capabilities,
      responseStyle: applyIfNotEmpty(
        currentFormState.capabilities.responseStyle,
        importedData.capabilities?.responseStyle
      ),
      specialBehaviors:
        importedData.capabilities?.specialBehaviors && importedData.capabilities.specialBehaviors.length > 0
          ? importedData.capabilities.specialBehaviors
          : currentFormState.capabilities.specialBehaviors,
    },
  };
};

// Validate imported JSON
export const validateImportedJSON = (
  jsonString: string
): { isValid: boolean; data?: ExportableAgentData; error?: string } => {
  try {
    const parsed = JSON.parse(jsonString);

    // Basic validation - check if it looks like an agent export
    if (typeof parsed !== 'object' || parsed === null) {
      return { isValid: false, error: 'Invalid JSON format: Expected an object' };
    }

    // Check for required fields (be forgiving)
    const hasBasicStructure =
      typeof parsed.name === 'string' ||
      typeof parsed.description === 'string' ||
      Array.isArray(parsed.triggerWords) ||
      typeof parsed.personality === 'object' ||
      typeof parsed.capabilities === 'object';

    if (!hasBasicStructure) {
      return { isValid: false, error: 'JSON does not appear to be an agent export' };
    }

    return { isValid: true, data: parsed as ExportableAgentData };
  } catch (error) {
    return { isValid: false, error: `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
};

// Curated word lists for a fun, submittable default agent name (Auto Fill).
const AGENT_NAME_ADJECTIVES = [
  'Cosmic',
  'Solar',
  'Stellar',
  'Nimble',
  'Radiant',
  'Verdant',
  'Lucid',
  'Astral',
  'Vivid',
  'Keen',
  'Bright',
  'Swift',
  'Curious',
  'Bold',
];
const AGENT_NAME_NOUNS = [
  'Sage',
  'Scout',
  'Architect',
  'Navigator',
  'Companion',
  'Strategist',
  'Muse',
  'Sentinel',
  'Pathfinder',
  'Maven',
  'Guide',
  'Catalyst',
  'Oracle',
  'Beacon',
];

/** Generate a fun, human-readable default agent name (e.g. "Cosmic Navigator"). */
export const generateAgentName = (): string => {
  const adj = AGENT_NAME_ADJECTIVES[Math.floor(Math.random() * AGENT_NAME_ADJECTIVES.length)];
  const noun = AGENT_NAME_NOUNS[Math.floor(Math.random() * AGENT_NAME_NOUNS.length)];
  return `${adj} ${noun}`;
};

/**
 * Derive a couple of trigger words from an agent name so Auto Fill yields a submittable form.
 * Trigger words are stored @-prefixed and validated (see useTagManagement.addTriggerWord /
 * validateTriggerWord), so emit the same normalized form rather than bare words.
 */
export const deriveTriggerWords = (name: string): string[] => {
  const tokens = name
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  // Prefer words longer than 2 chars, but never return [] for a non-empty name - an empty
  // result leaves Auto Fill's form unsubmittable.
  const preferred = tokens.filter(w => w.length > 2);
  return (preferred.length ? preferred : tokens).slice(0, 3).map(w => `@${w}`);
};

type GeneratorCapabilities = { responseStyle?: string; specialBehaviors?: string[] };

// Input shape for the client-side description / system-prompt generators. `capabilities` flows
// through as either the array form ([{...}]) or the object form ({...}); typing it explicitly
// (instead of `any`) catches the array-vs-object confusion that `readCapabilities` exists to
// absorb.
interface GeneratorAgentData {
  name?: string;
  personality?: {
    majorMotivation?: string;
    minorMotivation?: string;
    flaw?: string;
    quirk?: string;
    description?: string;
    personalMission?: string;
    activeProject?: string;
  };
  capabilities?: GeneratorCapabilities | GeneratorCapabilities[];
}

// Personality trait fields from generateEnhancedPersonality() arrive as "Label: explanation."
// (e.g. "achiever: driven by completing goals."). The sentence templates want the short label,
// so take the part before the colon and drop trailing punctuation - avoids leaked archetype
// prefixes and double periods. Plain values (no colon - manual/test input) pass through.
const cleanTrait = (value: string): string => (value.split(':')[0] ?? '').replace(/[.;,]+\s*$/, '').trim();

// Read responseStyle/specialBehaviors whether `capabilities` is the array form ([{...}]) or the
// object form ({...}) - both shapes flow through these generators.
const readCapabilities = (agentData: GeneratorAgentData): GeneratorCapabilities => {
  const caps = agentData?.capabilities;
  return (Array.isArray(caps) ? caps[0] : caps) ?? {};
};

// Join clauses grammatically: "a", "a and b", or "a, b, and c".
const joinClauses = (clauses: string[]): string => {
  if (clauses.length <= 1) return clauses[0] ?? '';
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
};

// Client-side description generation for new agents. Builds complete sentences so that missing
// fields never leave a dangling fragment like "<name> is, They communicate...".
export const generateDescriptionFromFormData = (agentData: GeneratorAgentData): string => {
  // Auto Fill stores a complete, grammatical blurb in personality.description (built by
  // generateEnhancedPersonality from archetype *labels*). Prefer it verbatim rather than
  // re-deriving from the raw "Label: explanation." trait fields - that re-derivation leaked
  // archetype prefixes, doubled periods, and produced "specializes in offers..." in the Auto
  // Fill description.
  const provided = agentData.personality?.description;
  if (typeof provided === 'string' && provided.trim()) {
    return provided.trim();
  }

  const subject = agentData.name && agentData.name !== 'Unnamed Agent' ? agentData.name : 'This agent';
  const { responseStyle, specialBehaviors } = readCapabilities(agentData);

  // Clauses that complete "<subject> is ..." - only the non-empty ones, joined grammatically.
  const isClauses: string[] = [];
  if (agentData.personality?.majorMotivation) {
    isClauses.push(`driven by ${cleanTrait(agentData.personality.majorMotivation).toLowerCase()}`);
  }
  if (agentData.personality?.quirk) {
    isClauses.push(`known for a ${cleanTrait(agentData.personality.quirk).toLowerCase()}`);
  }

  const sentences: string[] = [
    isClauses.length > 0 ? `${subject} is ${joinClauses(isClauses)}.` : `${subject} is an AI assistant.`,
  ];

  if (agentData.personality?.flaw) {
    sentences.push(`It can sometimes be ${cleanTrait(agentData.personality.flaw).toLowerCase()}.`);
  }
  if (responseStyle) {
    sentences.push(`It communicates in a ${responseStyle.toLowerCase()} manner.`);
  }
  if (specialBehaviors && specialBehaviors.length > 0) {
    sentences.push(`It specializes in ${specialBehaviors.join(', ').toLowerCase()}.`);
  }
  if (agentData.personality?.minorMotivation) {
    sentences.push(`It is also motivated by ${cleanTrait(agentData.personality.minorMotivation).toLowerCase()}.`);
  }

  return sentences.join(' ');
};

// Simple client-side system prompt generation for new agents
export const generateSystemPromptFromFormData = (agentData: GeneratorAgentData): string => {
  const promptParts = [];
  const { responseStyle, specialBehaviors } = readCapabilities(agentData);

  // Basic identity. Guard against the 'Unnamed Agent' placeholder leaking into the prompt.
  if (agentData.name && agentData.name !== 'Unnamed Agent') {
    promptParts.push(`You are ${agentData.name}, an AI assistant.`);
  } else {
    promptParts.push('You are an AI assistant.');
  }

  // Personality traits - cleanTrait strips the "Label: explanation." shape so the prompt reads
  // "...is achiever." not "...is achiever: driven by.....".
  if (agentData.personality?.majorMotivation) {
    promptParts.push(`Your primary motivation is ${cleanTrait(agentData.personality.majorMotivation).toLowerCase()}.`);
  }

  if (agentData.personality?.minorMotivation) {
    promptParts.push(`You are also motivated by ${cleanTrait(agentData.personality.minorMotivation).toLowerCase()}.`);
  }

  // Communication style
  if (responseStyle) {
    promptParts.push(`You communicate in a ${responseStyle} manner.`);
  }

  // Special behaviors
  if (specialBehaviors && specialBehaviors.length > 0) {
    promptParts.push(`Your special abilities include: ${specialBehaviors.join(', ').toLowerCase()}.`);
  }

  // Personality quirks - trailing "quirk" keeps it grammatical for adjective-shaped labels
  // ("...a unique occasionally vain quirk.") as well as noun phrases.
  if (agentData.personality?.quirk) {
    promptParts.push(`You have a unique ${cleanTrait(agentData.personality.quirk).toLowerCase()} quirk.`);
  }

  if (agentData.personality?.flaw) {
    promptParts.push(`You can sometimes be ${cleanTrait(agentData.personality.flaw).toLowerCase()}.`);
  }

  // Mission and purpose
  if (agentData.personality?.personalMission) {
    promptParts.push(`Your personal mission is: ${agentData.personality.personalMission}`);
  }

  if (agentData.personality?.activeProject) {
    promptParts.push(`You are currently working on: ${agentData.personality.activeProject}`);
  }

  // Instructions
  promptParts.push('Always stay in character and provide helpful, accurate responses.');
  promptParts.push('Use your personality traits to make interactions engaging and authentic.');

  return promptParts.join('\n\n');
};
