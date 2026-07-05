import { animate, useMotionValue } from 'framer-motion';
import { useEffect, useState } from 'react';

const delimiter = '';
export function useAnimatedText(text: string, done: boolean) {
  const animatedCursor = useMotionValue(0);
  const [cursor, setCursor] = useState(0);
  const [prevText, setPrevText] = useState(text);
  const [isSameText, setIsSameText] = useState(true);

  if (prevText.length !== text.length) {
    setPrevText(text);
    setIsSameText(text.startsWith(prevText));

    if (!text.startsWith(prevText)) {
      setCursor(0);
    }
  }

  useEffect(() => {
    if (done) return;
    if (!isSameText) {
      animatedCursor.jump(0);
    }

    const controls = animate(animatedCursor, text.split(delimiter).length, {
      duration: 2,
      ease: 'linear',
      onUpdate(latest) {
        setCursor(Math.floor(latest));
      },
    });

    return () => controls.stop();
  }, [animatedCursor, isSameText, text, done]);

  return done ? text : text.split(delimiter).slice(0, cursor).join(delimiter);
}
