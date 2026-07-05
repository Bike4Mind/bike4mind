import type { ChatModelName } from '@bike4mind/common';

export type VoiceTransportId = 'elevenlabs-conversational';

export interface B4MTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface CreateSessionInput {
  userId: string;
  organizationId: string;
  sessionId: string;
  reasoningModelId: ChatModelName;
  tools: B4MTool[];
  systemPrompt: string;
  /** Per-user TTS voice override (ElevenLabs voice ID) applied at session start. */
  voiceOverrideId?: string;
  /** Per-user system prompt override applied at session start. */
  systemPromptOverride?: string;
  /**
   * Signed, session-bound token the proxy verifies to authenticate each turn.
   * Minted by the caller (the API route owns the signing secret); the transport
   * treats it as opaque and only forwards it to the browser.
   */
  sessionToken: string;
}

export interface CreateSessionResult {
  clientBootstrap: unknown;
  /**
   * The signed session token the proxy verifies (mirrors what the browser
   * forwards inside `clientBootstrap`). Same value as `CreateSessionInput.sessionToken`.
   */
  llmProxyToken: string;
}

export interface EndSessionResult {
  voiceMinutes: number;
}

export interface CostEstimate {
  voiceMinutesUpperBound: number;
  creditsToReserve: number;
}

export interface IVoiceTransport {
  readonly id: VoiceTransportId;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  endSession(sessionId: string): Promise<EndSessionResult>;
  estimateCost(maxDurationSeconds: number): CostEstimate;
}
