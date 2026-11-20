import diagnostics_channel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import { providerDispatcher } from './providerDispatcher';

const URL = 'https://api.anthropic.com/v1/models';
const CALLS = 4;
const GAP_MS = 5_000;

async function run(dispatcher?: object) {
  let connects = 0;
  const onConnected = () => {
    connects++;
  };
  diagnostics_channel.channel('undici:client:connected').subscribe(onConnected);
  const perCall: number[] = [];
  try {
    for (let i = 0; i < CALLS; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, GAP_MS));
      const start = performance.now();
      const res = await fetch(URL, {
        headers: { 'anthropic-version': '2023-06-01' },
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      await res.arrayBuffer();
      perCall.push(Math.round((performance.now() - start) * 10) / 10);
    }
  } finally {
    diagnostics_channel.channel('undici:client:connected').unsubscribe(onConnected);
  }
  return { connects, perCall };
}

describe.skipIf(!process.env.B4M_PERF)('provider keep-alive (network)', () => {
  it('reuses one connection across idle gaps', { timeout: 120_000 }, async () => {
    const a = await run();
    const b = await run(providerDispatcher());
    console.info(`connects A/B: ${a.connects} / ${b.connects}`);
    console.info(`per-call ms A: ${a.perCall.join(', ')}`);
    console.info(`per-call ms B: ${b.perCall.join(', ')}`);
    expect(b.connects).toBeLessThan(a.connects);
  });
});
