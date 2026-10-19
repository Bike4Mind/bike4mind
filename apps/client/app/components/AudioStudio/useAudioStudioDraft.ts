import { create } from 'zustand';
import type { AudioGenMode } from '@client/app/stores/useAudioGenSettings';

type AudioStudioDraftState = {
  text: Record<AudioGenMode, string>;
  setText: (mode: AudioGenMode, text: string) => void;
};

/**
 * The text being written in Studio's Speech and Sound effects tabs. A store rather than form state so a gallery card's
 * "use these settings again" can fill it, and so switching tabs keeps each draft. Not persisted: the selections in
 * useAudioGenSettings are, the text is not.
 */
export const useAudioStudioDraft = create<AudioStudioDraftState>()(set => ({
  text: { tts: '', 'sound-effects': '' },
  setText: (mode, text) => set(state => ({ text: { ...state.text, [mode]: text } })),
}));
