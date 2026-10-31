import {
  localModelId,
  parseLocalModelId,
  readSpecs,
  serverManagement,
  serverRuntimeId,
} from '@bike4mind/local-models/servers';
import * as chat from '@shared/chat';
import * as shared from '@shared/modelServers';
import { describe, expect, it } from 'vitest';

// @bike4mind/local-models/servers copies these from shared/chat.ts and shared/modelServers.ts, which the
// renderer imports and so cannot come from a Node package. The CLI reads Desktop's file through that copy,
// so a drift here would make its model ids and server rules disagree with Desktop's.
describe('the local-models copies of the shared server helpers', () => {
  it('build and parse the same model ids', () => {
    for (const [runtime, model] of [
      ['ollama', 'qwen3:8b'],
      [serverRuntimeId('a1b2'), 'org/model:q4'],
      ['with:colon', 'm'],
    ]) {
      expect(serverRuntimeId(runtime)).toBe(shared.serverRuntimeId(runtime));
      const id = localModelId(runtime, model);
      expect(id).toBe(chat.localModelId(runtime, model));
      expect(parseLocalModelId(id)).toEqual(chat.parseLocalModelId(id));
    }
    for (const id of ['local:%E0%A4%A:x', 'local:x', 'hosted-model']) {
      expect(parseLocalModelId(id)).toEqual(chat.parseLocalModelId(id));
    }
  });

  it('allow the same management on every kind of server', () => {
    for (const local of [true, false]) {
      for (const kind of ['ollama', 'openai-compatible'] as const) {
        for (const access of ['chat', 'manage'] as const) {
          expect(serverManagement({ local, kind, access })).toBe(shared.serverManagement({ local, kind, access }));
        }
      }
    }
  });

  it('accept the same saved specs', () => {
    // Desktop's own readSpecs before the move: range-checked, and RAM not required.
    const desktopSpecs = (value: unknown) => {
      const specs = shared.readSpecsShape(value);
      if (!specs || (specs.ramGiB === null && specs.gpuMemoryGiB === null && specs.bandwidthGBps === null)) return null;
      return shared.specsProblem(specs, true) ? null : specs;
    };
    const base = { ramGiB: 32, gpuMemoryGiB: null, bandwidthGBps: null, unified: true };
    for (const specs of [
      base,
      { ...base, ramGiB: shared.MAX_SPEC_MEMORY_GIB },
      { ...base, ramGiB: shared.MAX_SPEC_MEMORY_GIB + 1 },
      { ...base, gpuMemoryGiB: shared.MAX_SPEC_MEMORY_GIB + 1 },
      { ...base, bandwidthGBps: shared.MAX_SPEC_BANDWIDTH_GBPS },
      { ...base, bandwidthGBps: shared.MAX_SPEC_BANDWIDTH_GBPS + 1 },
      { ...base, ramGiB: 0 },
      { ...base, ramGiB: Number.NaN },
      { ...base, ramGiB: '32' },
      { ramGiB: null, gpuMemoryGiB: 24, bandwidthGBps: null },
      { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null },
      null,
      'specs',
    ]) {
      expect(readSpecs(specs)).toEqual(desktopSpecs(specs));
    }
  });
});
