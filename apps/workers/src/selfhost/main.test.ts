import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('the scheduled task isolates the two passes', () => {
  // Source-shape guard: main.ts registers the task inside an unexported boot closure, so the
  // chaining is unreachable from a behavioural test. The regression is silent - dropping either
  // catch type-checks and only shows up as a stranded backlog that stops draining whenever the
  // un-chunked pass's FabFile.find throws.
  it('wraps both sweep calls in their own catch', async () => {
    const src = await readFile(resolve(__dirname, 'main.ts'), 'utf8');
    // runChunkRescueSweep now takes the options object (limit + logger), not a bare logger - only
    // its own call site's shape differs from runStrandedVectorizeRescue's.
    const calls: [string, RegExp][] = [
      ['runChunkRescueSweep', /await runChunkRescueSweep\(\{[^}]*logger: bootLogger[^}]*\}\)(\.catch)?/],
      ['runStrandedVectorizeRescue', /await runStrandedVectorizeRescue\(bootLogger\)(\.catch)?/],
    ];
    for (const [fn, pattern] of calls) {
      const call = src.match(pattern);
      expect(call, `${fn} call site vanished - move or delete this guard with it`).not.toBeNull();
      expect(call![1], `${fn} must not reject out of the tick and skip the other pass`).toBe('.catch');
    }
  });
});
