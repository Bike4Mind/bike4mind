import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { VoiceGenerationVendor, VoiceOutputFormat } from '@bike4mind/common';

export type AudioGenMode = 'tts' | 'sound-effects';

/**
 * Transient form state for the in-app audio generator (#1055). Deliberately a
 * small, dedicated store rather than more fields on the useLLM god-store: it is
 * "accessible anytime" so any future generation entry point can read the
 * current selections without prop-drilling.
 *
 * Durable user preferences (preferredVoice, saveGeneratedAudio) are NOT mirrored
 * here - they live on the backend (UserContext / UserSettingsContext). An empty
 * `voice` means "fall back to the user's preferredVoice / provider default",
 * resolved at the call site so this store never clones backend state.
 */
export interface AudioGenSettingsState {
  mode: AudioGenMode;

  // Text-to-speech
  ttsProvider: VoiceGenerationVendor;
  /** '' => resolve from the user's preferredVoice / provider default at send time. */
  voice: string;
  format: VoiceOutputFormat;
  /** '' => let the provider auto-detect the language. */
  languageCode: string;

  // Sound effects (ElevenLabs only)
  /** null => let the provider auto-select the duration. */
  durationSeconds: number | null;
  promptInfluence: number;

  setMode: (mode: AudioGenMode) => void;
  setTtsProvider: (provider: VoiceGenerationVendor) => void;
  setVoice: (voice: string) => void;
  setFormat: (format: VoiceOutputFormat) => void;
  setLanguageCode: (languageCode: string) => void;
  setDurationSeconds: (durationSeconds: number | null) => void;
  setPromptInfluence: (promptInfluence: number) => void;
  reset: () => void;
}

const DEFAULTS = {
  mode: 'tts',
  ttsProvider: 'openai',
  voice: '',
  format: 'mp3',
  languageCode: '',
  durationSeconds: null,
  promptInfluence: 0.3,
} satisfies Omit<
  AudioGenSettingsState,
  | 'setMode'
  | 'setTtsProvider'
  | 'setVoice'
  | 'setFormat'
  | 'setLanguageCode'
  | 'setDurationSeconds'
  | 'setPromptInfluence'
  | 'reset'
>;

export const useAudioGenSettings = create<AudioGenSettingsState>()(
  persist(
    set => ({
      ...DEFAULTS,
      setMode: mode => set({ mode }),
      setTtsProvider: ttsProvider => set({ ttsProvider }),
      setVoice: voice => set({ voice }),
      setFormat: format => set({ format }),
      setLanguageCode: languageCode => set({ languageCode }),
      setDurationSeconds: durationSeconds => set({ durationSeconds }),
      setPromptInfluence: promptInfluence => set({ promptInfluence }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'audio-gen-settings',
      version: 1,
    }
  )
);
