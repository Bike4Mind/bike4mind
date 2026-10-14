import { usdToCredits } from '@bike4mind/utils';
import type { CostEstimate, CreateSessionInput, CreateSessionResult, EndSessionResult, IVoiceTransport } from './types';

export interface ElevenLabsTransportConfig {
  apiKey: string;
  agentId: string;
  /** Pessimistic per-minute USD cost upper bound for voice + LLM. Default ELEVENLABS_CONVERSATIONAL_USD_PER_MINUTE. */
  usdPerMinuteUpperBound?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Default pessimistic per-minute USD cost of a call (voice + LLM). */
export const ELEVENLABS_CONVERSATIONAL_USD_PER_MINUTE = 0.2;

/**
 * Credit cost of a call of `maxDurationSeconds`. The transport's estimateCost (which sizes the
 * up-front hold) and the per-minute rate shown on the voice start control both derive from this,
 * so the displayed price cannot drift from what is billed.
 */
export function estimateElevenLabsConversationalCost(
  maxDurationSeconds: number,
  usdPerMinute: number = ELEVENLABS_CONVERSATIONAL_USD_PER_MINUTE
): CostEstimate {
  const minutes = maxDurationSeconds / 60;
  return {
    voiceMinutesUpperBound: minutes,
    creditsToReserve: usdToCredits(minutes * usdPerMinute),
  };
}

const SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';

export interface ElevenLabsClientBootstrap {
  transport: 'elevenlabs-conversational';
  signedUrl: string;
  agentId: string;
  /**
   * Per-user overrides the browser applies via the SDK `overrides` option at
   * session start. Each requires the matching override permission on the
   * ElevenLabs agent (set at create time): `tts.voice_id` and
   * `agent.prompt.prompt`. Omitted when the user has no override set.
   */
  voiceOverrideId?: string;
  systemPromptOverride?: string;
  /**
   * Signed, session-bound JWT the browser forwards to ElevenLabs via
   * `custom_llm_extra_body.b4m_session`. ElevenLabs echoes it on every Custom-LLM
   * request and the proxy verifies it, trusting only its claims - never raw body
   * fields - so the proxy URL alone can't be used to impersonate a user.
   */
  sessionToken: string;
}

export function createElevenLabsConversationalTransport(config: ElevenLabsTransportConfig): IVoiceTransport {
  const usdPerMinute = config.usdPerMinuteUpperBound ?? ELEVENLABS_CONVERSATIONAL_USD_PER_MINUTE;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    id: 'elevenlabs-conversational',

    async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
      const url = `${SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(config.agentId)}`;
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { 'xi-api-key': config.apiKey },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`ElevenLabs signed-url fetch failed: ${res.status} ${body}`);
      }

      const json = (await res.json()) as { signed_url?: string };
      if (!json.signed_url) {
        throw new Error('ElevenLabs signed-url response missing signed_url');
      }

      const clientBootstrap: ElevenLabsClientBootstrap = {
        transport: 'elevenlabs-conversational',
        signedUrl: json.signed_url,
        agentId: config.agentId,
        ...(input.voiceOverrideId ? { voiceOverrideId: input.voiceOverrideId } : {}),
        ...(input.systemPromptOverride ? { systemPromptOverride: input.systemPromptOverride } : {}),
        sessionToken: input.sessionToken,
      };

      return { clientBootstrap, llmProxyToken: input.sessionToken };
    },

    async endSession(_sessionId: string): Promise<EndSessionResult> {
      return { voiceMinutes: 0 };
    },

    estimateCost(maxDurationSeconds: number): CostEstimate {
      return estimateElevenLabsConversationalCost(maxDurationSeconds, usdPerMinute);
    },
  };
}
