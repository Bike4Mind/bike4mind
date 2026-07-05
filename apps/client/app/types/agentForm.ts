import { ResponseStyle } from '@bike4mind/common';
import { CreditSource } from '../constants/agentForm';

/**
 * Mirrors the inline union on `IAgent.defaultThoroughness`. Kept as a named
 * type here so the form code can refer to it without importing the entire
 * IAgent surface.
 */
export type ThoroughnessLevel = 'quick' | 'medium' | 'very_thorough';

export interface FormState {
  name: string;
  description: string;
  triggerWords: string[];
  newTriggerWord: string;
  isPublic: boolean;
  useOwnCredits: boolean;
  creditSource: CreditSource;
  currentCredits: number;
  projectId: string;
  systemPrompt: string;
  preferredModel: string;
  preferredImageModel: string;
  temperature: number;
  maxTokens: number;
  personality: AgentPersonality;
  visual: AgentVisual;
  capabilities: AgentCapabilities;
  identity: {
    gender: 'male' | 'female' | 'non-binary' | 'agender' | 'genderfluid' | 'other' | 'prefer-not-to-say';
    pronouns: {
      subject: string;
      object: string;
      possessive: string;
      possessiveAdjective: string;
      reflexive: string;
    };
    customPronouns: string;
  };
  orchestration: AgentOrchestration;
}

/**
 * Advanced - Orchestration form state for ReAct-mode agents.
 *
 * Setting any of these fields routes the agent through the ReAct executor with
 * the inline permission card; leaving them unset keeps the agent on the legacy
 * chat-completion path (see `hasOrchestrationFields` in `utils/agentOrchestration.ts`).
 *
 * `defaultVariables` is modeled as an array of pairs on the form so React can
 * key by stable id while the user types - serialized to a `Record<string, string>`
 * on submit.
 */
export interface AgentOrchestration {
  allowedTools: string[];
  deniedTools: string[];
  maxIterations: { quick: number; medium: number; very_thorough: number };
  defaultThoroughness: ThoroughnessLevel | '';
  defaultVariables: DefaultVariableEntry[];
  exclusiveMcpServers: string[];
  fallbackModels: string[];
}

export interface DefaultVariableEntry {
  /** Stable client-side identity so the user can reorder/remove rows without
   *  React unmount-remount churn. Never sent to the server. */
  id: string;
  key: string;
  value: string;
}

export interface AgentPersonality {
  // Core personality dimensions
  majorMotivation: string;
  minorMotivation: string;
  flaw: string;
  quirk: string;
  description: string;

  // Enhanced personality dimensions
  emotionalIntelligence: string;
  communicationPattern: string;
  memoryStyle: string;
  culturalFlavor: string;
  energyLevel: string;
  humorStyle: string;
  backstoryElement: string;
  problemSolvingApproach: string;

  // Agency and purpose dimensions
  personalMission: string; // Their burning life purpose
  activeProject: string; // What they're currently working on
  secretAmbition: string; // Hidden dream they're pursuing
  coreValues: string; // Unshakeable beliefs that guide them
  legacyAspiration: string; // How they want to be remembered
  growthChallenge: string; // Current personal struggle they're working through

  // Meta information
  personalityComplexity: 'simple' | 'moderate' | 'complex' | 'maximum';
  generationTimestamp: string;
  uniqueId: string;
}

export interface AgentVisual {
  portraitUrl: string;
  style: string;
  generationPrompt: string;
}

export interface AgentCapabilities {
  responseStyle: ResponseStyle;
  specialBehaviors: string[];
  newBehavior: string;
}

export interface UserWithCredits {
  currentCredits?: number;
}

export interface ExportableAgentData {
  name: string;
  description: string;
  triggerWords: string[];
  isPublic: boolean;
  useOwnCredits: boolean;
  preferredModel?: string;
  preferredImageModel?: string;
  temperature?: number;
  maxTokens?: number;
  personality: AgentPersonality;
  visual: {
    style: string;
    generationPrompt: string;
  };
  identity?: {
    gender: 'male' | 'female' | 'non-binary' | 'agender' | 'genderfluid' | 'other' | 'prefer-not-to-say';
    pronouns: {
      subject: string;
      object: string;
      possessive: string;
      possessiveAdjective: string;
      reflexive: string;
    };
    customPronouns: string;
  };
  capabilities: {
    responseStyle: ResponseStyle;
    specialBehaviors: string[];
  };
  exportMetadata: {
    version: string;
    exportedAt: string;
    exportedBy: string;
  };
}

export interface ResponseStyleOption {
  value: ResponseStyle;
  label: string;
}

export interface AgencyPurposeFieldProps {
  fieldName: keyof AgentPersonality;
  label: string;
  placeholder: string;
  shimmeringField: string | null;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onRandomize: (fieldName: string, currentValue?: string) => void;
  readOnly?: boolean;
}

export interface AutoAwesomeIconButtonProps {
  onClick?: () => void;
  sx?: any;
  loading?: boolean;
  disabled?: boolean;
  tooltip?: string;
  [key: string]: any;
}
