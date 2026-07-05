import { ResponseStyle } from '@bike4mind/common';
import { ResponseStyleOption, ThoroughnessLevel } from '../types/agentForm';

// Shared id linking the out-of-form Save/Create button to the `<form>` via the
// HTML `form="..."` attribute. Lives in this leaf module so `AgentForm.tsx` and
// `useAgentPageActions.tsx` can both import it without a module cycle.
export const AGENT_FORM_ID = 'agent-form';

export const RESPONSE_STYLES: ResponseStyleOption[] = [
  { value: 'formal', label: 'Formal - Professional and structured' },
  { value: 'casual', label: 'Casual - Relaxed and conversational' },
  { value: 'technical', label: 'Technical - Precise and detailed' },
  { value: 'friendly', label: 'Friendly - Warm and approachable' },
  { value: 'playful', label: 'Playful - Fun and energetic' },
  { value: 'concise', label: 'Concise - Brief and to the point' },
  { value: 'detailed', label: 'Detailed - Comprehensive and thorough' },
];

export const VISUAL_STYLES = [
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
  { value: 'futuristic', label: 'Futuristic' },
  { value: 'minimalist', label: 'Minimalist' },
  { value: 'playful', label: 'Playful' },
] as const;

export const PERSONALITY_COMPLEXITY_LEVELS = ['simple', 'moderate', 'complex', 'maximum'] as const;

export const CREDIT_SOURCE = {
  USER: 'user',
  AGENT: 'agent',
} as const;

export type CreditSource = (typeof CREDIT_SOURCE)[keyof typeof CREDIT_SOURCE];

export const LOW_CREDITS_THRESHOLD = 1000;

export const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'non-binary', label: 'Non-binary' },
  { value: 'agender', label: 'Agender' },
  { value: 'genderfluid', label: 'Genderfluid' },
  { value: 'other', label: 'Other' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
] as const;

/**
 * Default iteration caps per thoroughness. Mirrors the executor's runtime
 * defaults in `apps/client/server/queueHandlers/agentExecutor.ts`, kept in sync
 * manually until both paths can import from `b4m-core/common`. Server is the
 * source of truth; this is the form's pre-fill copy.
 */
export const DEFAULT_MAX_ITERATIONS = { quick: 5, medium: 15, very_thorough: 30 } as const;

export const DEFAULT_FORM_STATE = {
  name: '',
  description: '',
  triggerWords: [] as string[],
  newTriggerWord: '',
  isPublic: false,
  useOwnCredits: false,
  creditSource: CREDIT_SOURCE.USER,
  currentCredits: 0,
  projectId: '',
  systemPrompt: '',
  preferredModel: '',
  preferredImageModel: '',
  temperature: 0.9,
  maxTokens: 4000,
  personality: {
    majorMotivation: '',
    minorMotivation: '',
    flaw: '',
    quirk: '',
    description: '',
    emotionalIntelligence: '',
    communicationPattern: '',
    memoryStyle: '',
    culturalFlavor: '',
    energyLevel: '',
    humorStyle: '',
    backstoryElement: '',
    problemSolvingApproach: '',
    personalMission: '',
    activeProject: '',
    secretAmbition: '',
    coreValues: '',
    legacyAspiration: '',
    growthChallenge: '',
    personalityComplexity: 'simple' as const,
    generationTimestamp: '',
    uniqueId: '',
  },
  visual: {
    portraitUrl: '',
    style: 'modern',
    generationPrompt: 'A friendly AI assistant with a professional appearance',
  },
  capabilities: {
    responseStyle: 'friendly' as ResponseStyle,
    specialBehaviors: [],
    newBehavior: '',
  },
  identity: {
    gender: 'prefer-not-to-say' as const,
    pronouns: {
      subject: '',
      object: '',
      possessive: '',
      possessiveAdjective: '',
      reflexive: '',
    },
    customPronouns: '',
  },
  orchestration: {
    allowedTools: [] as string[],
    deniedTools: [] as string[],
    // Pre-populated with the executor's runtime defaults so the inputs are never
    // blank. Payload only goes to the server if the user otherwise opts into
    // orchestration (see `isOrchestrationConfigured` in `AgentForm.tsx`).
    maxIterations: { ...DEFAULT_MAX_ITERATIONS },
    defaultThoroughness: '' as ThoroughnessLevel | '',
    defaultVariables: [] as Array<{ id: string; key: string; value: string }>,
    exclusiveMcpServers: [] as string[],
    fallbackModels: [] as string[],
  },
};

/**
 * Display labels for thoroughness levels. Order matters, used directly to render
 * the selector. Values must match `ThoroughnessLevel` exactly so server validators
 * accept them.
 */
export const THOROUGHNESS_OPTIONS: ReadonlyArray<{ value: ThoroughnessLevel; label: string }> = [
  { value: 'quick', label: 'Quick — fewer iterations, faster answers' },
  { value: 'medium', label: 'Medium — balanced (default)' },
  { value: 'very_thorough', label: 'Very thorough — most iterations, deepest reasoning' },
] as const;

/**
 * Tools that always require a permission card the first time an agent invokes them.
 * Mirrors `REQUIRES_APPROVAL_TOOLS` in `apps/client/server/queueHandlers/agentExecutorUtils/toolPermissions.ts`.
 * Presentational hint on the tool picker only; the server is the source of truth
 * for the actual permission classification at runtime.
 */
export const TOOLS_REQUIRING_APPROVAL: ReadonlySet<string> = new Set([
  'send_slack_message',
  'delegate_to_agent',
  'image_generation',
  'edit_image',
  'video_generation',
]);
