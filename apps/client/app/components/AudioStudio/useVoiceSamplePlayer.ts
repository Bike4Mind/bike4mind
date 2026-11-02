import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getServerErrorField } from '@client/app/utils/error';
import { VoiceSampleUnavailableError } from './openAiVoiceSample';

export type VoiceSampleSource = string | (() => Promise<string>);

/**
 * Plays one voice sample at a time. `toggle` starts a voice's sample (stopping any other), or
 * stops it when that voice is already loading or sounding. A source is either a hosted clip URL
 * or a resolver that fetches one, so OpenAI's generated samples and ElevenLabs' hosted
 * `previewUrl`s share one player.
 */
export const useVoiceSamplePlayer = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped on every toggle so a slow resolver for an abandoned voice cannot start playing.
  const requestRef = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const stop = useCallback(() => {
    requestRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    setActiveId(null);
    setIsLoading(false);
  }, []);

  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    async (id: string, source: VoiceSampleSource) => {
      const wasActive = activeId === id;
      stop();
      if (wasActive) return;

      const request = requestRef.current;
      setActiveId(id);
      setIsLoading(typeof source !== 'string');

      const fail = (message: string) => {
        if (request !== requestRef.current) return;
        setActiveId(null);
        setIsLoading(false);
        toast.error(message);
      };

      let url: string;
      try {
        url = typeof source === 'string' ? source : await source();
      } catch (error) {
        // The server's reason (e.g. the credit shortfall for a generated sample) is the actionable part.
        const reason = error instanceof VoiceSampleUnavailableError ? error.message : getServerErrorField(error);
        fail(reason ?? 'Could not load the voice sample');
        return;
      }
      if (request !== requestRef.current) return;

      const audio = new Audio(url);
      audioRef.current = audio;
      setIsLoading(false);
      audio.onended = () => {
        if (request === requestRef.current) setActiveId(null);
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

  return { activeId, isLoading, toggle, stop };
};
