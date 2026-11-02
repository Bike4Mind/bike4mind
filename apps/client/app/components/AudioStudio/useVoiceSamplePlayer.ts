import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/**
 * Plays one pre-recorded voice sample at a time. `toggle` starts a voice's sample (stopping any
 * other), or stops it when that voice is already sounding.
 */
export const useVoiceSamplePlayer = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setActiveId(null);
  }, []);

  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    async (id: string, url: string) => {
      const wasActive = activeId === id;
      stop();
      if (wasActive) return;

      const audio = new Audio(url);
      audioRef.current = audio;
      setActiveId(id);

      // A stale element's events must not clear the voice that replaced it.
      const fail = (message: string) => {
        if (audioRef.current !== audio) return;
        audioRef.current = null;
        setActiveId(null);
        toast.error(message);
      };
      audio.onended = () => {
        if (audioRef.current === audio) setActiveId(null);
      };
      audio.onerror = () => fail('Could not play the voice sample');
      try {
        await audio.play();
      } catch (error) {
        const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
        fail(blocked ? 'Your browser blocked audio playback' : 'Could not play the voice sample');
      }
    },
    [activeId, stop]
  );

  return { activeId, toggle, stop };
};
