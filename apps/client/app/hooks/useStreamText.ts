import { useEffect, useState } from 'react';

const STREAM_SPEED_MS = 20;

export const useStreamText = (text: string, completed: boolean) => {
  const [streamedText, setStreamedText] = useState<string[]>([]);

  // Animate streamed text word by word
  useEffect(() => {
    const words = text.split(/(\s+)/).filter(word => word.length > 0);

    if (completed) {
      setStreamedText(words);
      return;
    }

    const timeoutId = setInterval(() => {
      setStreamedText(prev => {
        if (prev.length >= words.length) return prev;
        return [...prev, words[prev.length]];
      });
    }, STREAM_SPEED_MS);

    return () => timeoutId && clearInterval(timeoutId);
  }, [text, completed]);

  return streamedText.join('');
};
