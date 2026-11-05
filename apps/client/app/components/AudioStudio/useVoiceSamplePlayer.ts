import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Plays one pre-recorded voice sample at a time. `toggle` starts a voice's sample (stopping any
 * other), or stops it when that voice is already sounding.
 */
export const useVoiceSamplePlayer = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // toggle reads this, not activeId, so two clicks before a re-render still see the latest voice.
  const activeIdRef = useRef<string | null>(null);
  const setActive = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setActive(null);
  }, [setActive]);

  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    async (id: string, url: string) => {
      const wasActive = activeIdRef.current === id;
      stop();
      if (wasActive) return;

      const audio = new Audio(url);
      audioRef.current = audio;
      setActive(id);

      // A stale element's events must not clear the voice that replaced it.
      const fail = (message: string) => {
        if (audioRef.current !== audio) return;
        audioRef.current = null;
        setActive(null);
        toast.error(message);
      };
      audio.onended = () => {
        if (audioRef.current === audio) setActive(null);
      };
      audio.onerror = () => fail('Could not play the voice sample');
      try {
        await audio.play();
      } catch (error) {
        const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
        fail(blocked ? 'Your browser blocked audio playback' : 'Could not play the voice sample');
      }
    },
    [setActive, stop]
  );

  return { activeId, toggle, stop };
};
