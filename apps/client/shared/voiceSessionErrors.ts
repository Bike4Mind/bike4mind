/**
 * Error code the voice-session route (pages/api/ai/voice-sessions) returns with a 502 when the
 * OpenAI Realtime key is missing or OpenAI rejects the request. The 502 status, not this code, is
 * what keeps ApiContext from tearing the login session down (that path only runs for a 401); the
 * code lets the client and tests recognize this failure.
 */
export const VOICE_SESSION_ERROR = {
  unavailable: 'VOICE_SESSION_UNAVAILABLE',
} as const;

export const VOICE_SESSION_UNAVAILABLE_MESSAGE = 'Voice sessions are unavailable right now. Please try again later.';
