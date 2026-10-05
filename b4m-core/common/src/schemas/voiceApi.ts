import { z } from 'zod';

/**
 * Wire schemas for the public `/api/v1/voice/*` contracts (api-contract/contracts/voice.contract.ts).
 * The legacy `/api/voice/v2/*` paths serve the same handlers, so these shapes are also what the SPA
 * consumes (ConversationalVoice/useConversationalVoice.ts, hooks/data/elevenLabsVoices.ts) - keep
 * them compatible with it. Imported directly (never through the schemas barrel) by the contract and
 * OpenAPI layers, so keep this file free of `@bike4mind/*` imports.
 */

export const VoiceSchema = z.object({
  id: z.string().describe('ElevenLabs voice id.'),
  name: z.string(),
  labels: z
    .record(z.string(), z.string())
    .describe('Provider-supplied labels (accent, gender, age, descriptive). May be empty.'),
  previewUrl: z.string().optional().describe('Short preview MP3 hosted by ElevenLabs, when the provider has one.'),
});

export const ListVoicesResponseSchema = z.object({
  voices: z.array(VoiceSchema),
});
export type ListVoicesResponse = z.infer<typeof ListVoicesResponseSchema>;

export const CreateVoiceSessionRequestSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Attach the call to this existing session (notebook). Omit to create a new one.'),
  reasoningModelId: z
    .string()
    .optional()
    .describe('Chat model that answers each spoken turn. Defaults to the platform voice default.'),
  isReconnect: z
    .boolean()
    .optional()
    .describe(
      'Set when re-establishing a dropped transport for the same `sessionId`: the live credit hold from ' +
        'the original connect is reused instead of reserving (and charging) a second time.'
    ),
});
export type CreateVoiceSessionRequest = z.infer<typeof CreateVoiceSessionRequestSchema>;

/**
 * Must stay assignable from `ElevenLabsClientBootstrap` (b4m-core/voice/src/transports/
 * elevenlabsConversational.ts); the v1 sessions handler pins that at compile time.
 */
export const VoiceClientBootstrapSchema = z.object({
  transport: z.literal('elevenlabs-conversational'),
  signedUrl: z.string().describe('Short-lived ElevenLabs signed WebSocket URL for this conversation.'),
  agentId: z.string().describe('ElevenLabs agent the conversation runs on.'),
  voiceOverrideId: z
    .string()
    .optional()
    .describe("Caller's TTS voice override, applied via the SDK `overrides.tts.voiceId`."),
  systemPromptOverride: z
    .string()
    .optional()
    .describe("Caller's system-prompt override, applied via the SDK `overrides.agent.prompt.prompt`."),
  sessionToken: z
    .string()
    .describe(
      'Signed, session-bound token to forward to ElevenLabs as `custom_llm_extra_body.b4m_session`. ' +
        'Treat it as a credential.'
    ),
});
export type VoiceClientBootstrap = z.infer<typeof VoiceClientBootstrapSchema>;

export const CreateVoiceSessionResponseSchema = z.object({
  session: z.object({ id: z.string(), name: z.string() }),
  reasoningModelId: z.string().describe('The model that will answer, after any platform remap.'),
  clientBootstrap: VoiceClientBootstrapSchema,
});
export type CreateVoiceSessionResponse = z.infer<typeof CreateVoiceSessionResponseSchema>;

export const VoiceSessionIdParamSchema = z.object({
  id: z.string().min(1).describe('The session id returned by `POST /api/v1/voice/sessions`.'),
});

export const EndVoiceSessionResponseSchema = z.object({
  refunded: z.number().describe('Credits returned to the caller from the up-front reservation.'),
  elapsedSeconds: z
    .number()
    .int()
    .optional()
    .describe('Billed call duration. Absent when the session had already been reconciled.'),
  alreadyReconciled: z
    .literal(true)
    .optional()
    .describe('Present when there was no live hold left to reconcile; the call is a no-op.'),
});
export type EndVoiceSessionResponse = z.infer<typeof EndVoiceSessionResponseSchema>;
