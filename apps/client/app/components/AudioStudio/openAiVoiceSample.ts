import type { TtsBase64Response } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { toPlayableAudio } from '@client/app/utils/generatedAudio';

export const VOICE_SAMPLE_TEXT = "Hello! This is how my voice sounds. I'm ready to help you with anything you need.";

export class VoiceSampleUnavailableError extends Error {}

// OpenAI hosts no sample clips, so each voice's sample is synthesized once (a billed preview call)
// and its playable URL kept for the rest of the page session. The promise is cached so a
// double-click shares one request; a failed one is evicted so the next click retries.
const samples = new Map<string, Promise<string>>();

const synthesizeSample = async (voice: string): Promise<string> => {
  const response = await api.post<TtsBase64Response>(
    '/api/ai/tts',
    // preview keeps the throwaway audition out of the user's Files.
    { text: VOICE_SAMPLE_TEXT, provider: 'openai', voice, preview: true, encoding: 'base64' },
    { timeout: 30000, validateStatus: status => status === 200, skipAuthRefresh: true }
  );

  // /api/ai/tts stands in another provider when OpenAI is unavailable, but a different
  // vendor's voice is no sample of the selected OpenAI one.
  if (response.data.fallbackFrom) {
    throw new VoiceSampleUnavailableError('OpenAI is unavailable, so this voice cannot be previewed.');
  }
  return toPlayableAudio(response.data).url;
};

/** Resolves a playable URL for an OpenAI voice's sample, synthesizing it on first use. */
export const getOpenAiVoiceSample = (voice: string): Promise<string> => {
  const cached = samples.get(voice);
  if (cached) return cached;

  const pending = synthesizeSample(voice);
  samples.set(voice, pending);
  pending.catch(() => samples.delete(voice));
  return pending;
};

/** Test-only: forget every cached sample. */
export const clearOpenAiVoiceSamples = () => samples.clear();
