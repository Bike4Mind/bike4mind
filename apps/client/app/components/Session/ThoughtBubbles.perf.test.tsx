import React, { Profiler, useEffect, useState } from 'react';
import { describe, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { animate, useMotionValue } from 'framer-motion';

const FRAMES = 20;
const FRAME_MS = 100;

const delimiter = '';
function useAnimatedText(text: string, done: boolean) {
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

const ProbeA = ({ text }: { text: string }) => <div data-testid="probe">{useAnimatedText(text, false)}</div>;
const ProbeB = ({ text }: { text: string }) => <div data-testid="probe">{text}</div>;

const frameText = (n: number) =>
  Array.from({ length: n }, (_, i) => `Considering option ${i + 1} and its tradeoffs.`).join(' ');

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function run(Probe: typeof ProbeA) {
  let commits = 0;
  const ui = (text: string) => (
    <Profiler id="probe" onRender={() => commits++}>
      <Probe text={text} />
    </Profiler>
  );
  const start = performance.now();
  const { rerender, unmount } = render(ui(frameText(1)));
  const finalText = frameText(FRAMES);
  for (let n = 2; n <= FRAMES; n++) {
    await act(() => sleep(FRAME_MS));
    rerender(ui(frameText(n)));
  }
  let msToFull = -1;
  while (performance.now() - start < 10_000) {
    if (screen.getByTestId('probe').textContent === finalText) {
      msToFull = performance.now() - start;
      break;
    }
    await act(() => sleep(5));
  }
  unmount();
  return { commits, msToFull };
}

describe.skipIf(!process.env.B4M_PERF)('ThoughtBubbles reasoning render perf', () => {
  it('compares animated vs direct reasoning text', async () => {
    const a = await run(ProbeA);
    const b = await run(ProbeB);
    console.info(`commits A/B: ${a.commits} / ${b.commits}`);
    console.info(`ms until last frame full text A/B: ${a.msToFull.toFixed(1)} / ${b.msToFull.toFixed(1)}`);
  }, 30_000);
});
