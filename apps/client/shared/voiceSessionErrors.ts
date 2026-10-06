/**
 * Error code the voice-session route (pages/api/ai/voice-sessions) returns with a 502 when the
 * OpenAI Realtime key is missing or OpenAI rejects the request. A coded response keeps ApiContext
 * from reading an upstream auth failure as a dead login session.
 */
export const VOICE_SESSION_ERROR = {
  unavailable: 'VOICE_SESSION_UNAVAILABLE',
} as const;

export const VOICE_SESSION_UNAVAILABLE_MESSAGE = 'Voice sessions are unavailable right now. Please try again later.';
