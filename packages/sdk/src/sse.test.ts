import { describe, expect, it } from 'vitest';
import { parseSse } from './sse';

const encoder = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('parseSse', () => {
  it('reassembles an event split across reads, including a split multi-byte character', async () => {
    const bytes = encoder.encode('data: {"text":"caf\u00e9"}\n\ndata: two\n\n');
    // Split inside the two-byte e-acute so the decoder must carry state between reads.
    const cut = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    expect(await collect(parseSse(stream))).toEqual(['{"text":"caf\u00e9"}', 'two']);
  });

  it('stops at [DONE]', async () => {
    expect(await collect(parseSse(streamOf(['data: a\n\n', 'data: [DONE]\n\n', 'data: b\n\n'])))).toEqual(['a']);
  });

  it('flushes a final event at end of stream', async () => {
    expect(await collect(parseSse(streamOf(['data: a\n', '\n'])))).toEqual(['a']);
  });

  it('throws the abort reason and cancels the body when the signal aborts mid-stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const data of parseSse(stream, controller.signal)) {
        seen.push(data);
        controller.abort(new Error('stop'));
      }
    })();
    await expect(run).rejects.toThrow('stop');
    expect(seen).toEqual(['first']);
    expect(cancelled).toBe(true);
  });
});
