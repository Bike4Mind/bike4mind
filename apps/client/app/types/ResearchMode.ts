import { ChatModelName } from '@bike4mind/common';

export interface ResearchModeConfiguration {
  id: string;
  enabled: boolean;
  model: ChatModelName;
  parameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
  };
  label?: string; // User-friendly label for this config
}

export interface ResearchModeState {
  enabled: boolean;
  configurations: ResearchModeConfiguration[];
  syncScrolling: boolean;
  comparisonView: 'grid' | 'tabs' | 'accordion';
}

export interface ResearchModeResponse {
  configId: string;
  questId: string;
  response: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  error?: string;
  metrics?: {
    firstTokenMs: number;
    totalTimeMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
}
