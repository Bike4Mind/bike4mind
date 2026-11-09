import { describe, expect, it } from 'vitest';
import { CappedOutput, MAX_STREAM_BYTES } from './cappedOutput';

const PR_URL = 'https://github.com/example-org/widgets/pull/611';

function collect(chunks: (string | Buffer)[], maxBytes?: number): string {
  const output = new CappedOutput(maxBytes);
  for (const chunk of chunks) output.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return output.toString();
}

describe('CappedOutput', () => {
  it('returns output under the cap unchanged', () => {
    expect(collect(['hello ', 'world\n'])).toBe('hello world\n');
  });

  it('keeps the start and the end of output over the cap, so a closing PR URL survives', () => {
    const line = 'pre-push hook: checking a workspace package\n';
    const chunks = Array.from({ length: 5_000 }, () => line);
    chunks.push(`${PR_URL}\n`);

    const text = collect(chunks);

    expect(text.startsWith(line)).toBe(true);
    expect(text.endsWith(`${PR_URL}\n`)).toBe(true);
    const total = line.length * 5_000 + PR_URL.length + 1;
    const omitted = Number(/\[\.\.\. (\d+) bytes omitted from the middle \.\.\.\]/.exec(text)?.[1]);
    expect(omitted).toBe(total - MAX_STREAM_BYTES);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_STREAM_BYTES + 100);
  });

  it('keeps the end when one chunk is larger than the whole cap', () => {
    const text = collect([`${'x'.repeat(200)}${PR_URL}`], 100);
    expect(text.endsWith(PR_URL.slice(-75))).toBe(true);
    expect(text).toContain('omitted from the middle');
  });

  it('stays bounded across many tiny chunks', () => {
    const output = new CappedOutput(1_000);
    for (let i = 0; i < 100_000; i += 1) output.push(Buffer.from('y'));
    output.push(Buffer.from('end'));
    const text = output.toString();
    expect(text.endsWith('end')).toBe(true);
    expect(text).toContain(`[... ${100_003 - 1_000} bytes omitted from the middle ...]`);
  });

  it('never splits a multi-byte character at either cut or across chunks', () => {
    const encoded = Buffer.from('é中😀'.repeat(50));
    const chunks: Buffer[] = [];
    for (let at = 0; at < encoded.length; at += 7) chunks.push(encoded.subarray(at, at + 7));

    const text = collect(chunks, 101);

    expect(text).not.toContain('�');
    const [head, tail] = text.split(/\n\[\.\.\. \d+ bytes omitted from the middle \.\.\.\]\n/);
    expect('é中😀'.repeat(50).startsWith(head)).toBe(true);
    expect('é中😀'.repeat(50).endsWith(tail)).toBe(true);
    const omitted = Number(/(\d+) bytes omitted/.exec(text)?.[1]);
    expect(Buffer.byteLength(head) + Buffer.byteLength(tail) + omitted).toBe(encoded.length);
  });

  it('decodes a character split across chunks when nothing is cut', () => {
    const encoded = Buffer.from('café');
    expect(collect([encoded.subarray(0, 4), encoded.subarray(4)])).toBe('café');
  });
});
