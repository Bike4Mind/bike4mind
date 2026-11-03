import { describe, it, expect } from 'vitest';
import { parseHubManifest, type HubBuild, type HubManifestInput, type HubRole } from '../schemas/modelHub';
import { fixtureManifest, machine, OLD_PINS, ownEval, PINS, sha } from './__fixtures__/hubManifest';
import { DECODE_CONSTANTS } from './decode';
import { computeBufferBytes, type HardwareProfile } from './fit';
import {
  ollamaBuildBytes,
  pickForMachine,
  SLOW_DECODE_TOKENS_PER_SEC,
  TIER_C_TOOL_REGRESSION_TOLERANCE,
  type HubCandidate,
  type MachineRuntimes,
  type PickOptions,
} from './select';

const BOTH: MachineRuntimes = { ollama: { version: '0.40.11' }, 'llama-server': { build: 11889 } };

const MACHINES: Record<string, HardwareProfile> = {
  'mac-16': machine('unified', 16),
  'mac-24': machine('unified', 24),
  'mac-32': machine('unified', 32),
  'mac-64': machine('unified', 64),
  'nv-8+32': machine('discrete', 32, 8),
  'nv-12+32': machine('discrete', 32, 12),
  'nv-24+64': machine('discrete', 64, 24),
  'cpu-16': machine('cpu', 16),
  'cpu-32': machine('cpu', 32),
};

function pick(
  machineName: string,
  role: HubRole,
  over: Partial<Omit<PickOptions, 'manifest'>> & { manifest?: HubManifestInput } = {}
) {
  const { manifest, ...rest } = over;
  return pickForMachine({
    manifest: parseHubManifest(manifest ?? fixtureManifest()).manifest,
    hardware: MACHINES[machineName],
    role,
    runtimes: BOTH,
    pins: PINS,
    ...rest,
  });
}

const label = (c: HubCandidate | null) =>
  c ? `${c.entry.id}/${c.build.id}@${c.runtime} ${c.fit.verdict}:${c.fit.reason} ${c.fit.context} ${c.fit.kv.k}` : null;

function withManifest(edit: (m: HubManifestInput) => void): HubManifestInput {
  const m = fixtureManifest();
  edit(m);
  return m;
}

describe('pickForMachine golden picks on the fixture catalog', () => {
  it.each([
    ['mac-16', 'code', 'dense-9b-tuned/q4@llama-server slow:below-floor 32768 q8_0'],
    ['mac-16', 'chat', 'dense-9b-tuned/q4@llama-server tight:reduced-context 32768 q8_0'],
    ['mac-16', 'vision', 'gemma-12b/q4@ollama slow:below-floor 16384 f16'],
    ['mac-24', 'code', 'dense-9b-tuned/q4@llama-server tight:reduced-context 65536 q8_0'],
    ['mac-24', 'chat', 'gemma-12b/q4@ollama fast:fits 65536 f16'],
    ['mac-24', 'vision', 'gemma-12b/q4@ollama fast:fits 65536 f16'],
    ['mac-32', 'code', 'dense-9b-tuned/q4@llama-server fast:kv-quantized 131072 q8_0'],
    ['mac-32', 'chat', 'gemma-12b/q4@ollama fast:fits 65536 f16'],
    ['mac-64', 'code', 'hybrid-27b/q6@llama-server fast:fits 262144 f16'],
    ['mac-64', 'chat', 'moe-35b/q4@llama-server fast:fits 65536 f16'],
    ['nv-8+32', 'code', 'moe-35b/q4@llama-server tight:expert-offload 262144 q8_0'],
    ['nv-8+32', 'chat', 'moe-35b/q4@llama-server tight:expert-offload 65536 q8_0'],
    ['nv-8+32', 'vision', 'gemma-12b/q4@ollama slow:layer-offload 65536 f16'],
    ['nv-12+32', 'code', 'moe-35b/q4@llama-server tight:expert-offload 262144 q8_0'],
    ['nv-12+32', 'chat', 'moe-35b/q4@llama-server tight:expert-offload 65536 q8_0'],
    ['nv-24+64', 'code', 'dense-9b-tuned/q4@llama-server fast:kv-quantized 131072 q8_0'],
    ['nv-24+64', 'chat', 'moe-35b/q4@llama-server fast:fits 65536 f16'],
    ['cpu-16', 'code', 'dense-9b-tuned/q4@llama-server slow:cpu-only 65536 q8_0'],
    ['cpu-16', 'chat', 'gemma-12b/q4@ollama slow:cpu-only 32768 f16'],
    ['cpu-32', 'code', 'hybrid-27b/q6@llama-server slow:cpu-only 65536 q8_0'],
    ['cpu-32', 'chat', 'moe-35b/q4@llama-server slow:cpu-only 65536 f16'],
    ['mac-16', 'embeddings', 'embed-small/q8@ollama fast:fits 8192 f16'],
    ['cpu-16', 'embeddings', 'embed-small/q8@ollama slow:cpu-only 8192 f16'],
  ] as const)('%s %s', (machineName, role, expected) => {
    expect(label(pick(machineName, role).best)).toBe(expected);
  });

  it('moves the fewest expert layers that fit an 8 GB GPU at the largest context', () => {
    const { best } = pick('nv-8+32', 'chat');
    const { memory } = best!.fit;
    expect(best?.fit).toMatchObject({ placement: 'expert-offload', nCpuMoe: 35 });
    expect(memory.totalBytes - memory.offloadedBytes + memory.marginBytes).toBeLessThanOrEqual(8 * 1024 ** 3);
    // The CUDA compute buffer also holds a copy of at least one offloaded expert tensor.
    const expertBytesPerLayer = best!.build.tensorStats!.expertBytesPerLayer;
    const weightsBytes = best!.build.weights.reduce((sum, w) => sum + w.sizeBytes, 0);
    const model = { arch: best!.entry.arch, weightsBytes, expertBytesPerLayer };
    const graph = computeBufferBytes(model, best!.fit.context, best!.fit.ubatch, { memoryKind: 'discrete' });
    expect(memory.computeBytes).toBeGreaterThanOrEqual(graph + expertBytesPerLayer / 3);
  });

  it('takes a later build that is eligible over an earlier one that only fits better', () => {
    // iq3 is tight at 64k on a 24 GB Mac, but its own eval is on an old pin, so the A-grade iq4 represents the entry.
    const { alternates } = pick('mac-24', 'code');
    expect(alternates.map(label)).toContain('hybrid-27b/iq3@llama-server tight:reduced-context 65536 q8_0');
    const { best } = pick('mac-24', 'code', {
      manifest: withManifest(m => {
        m.rankings = { code: ['hybrid-27b'] };
        m.entries = m.entries.filter(e => e.id === 'hybrid-27b');
      }),
    });
    expect(label(best)).toBe('hybrid-27b/iq4@llama-server slow:below-floor 32768 q8_0');
    expect(best?.grade).toBe('A');
  });

  it('admits a build that loads on a 16 GB Mac only with layers in system RAM, ranked as slow', () => {
    // Shrunk so it misses the GPU part of unified memory but fits the RAM past it.
    const manifest = withManifest(m => {
      const iq3 = m.entries.find(e => e.id === 'hybrid-27b')!.builds.find(b => b.id === 'iq3')!;
      iq3.weights[0].sizeBytes = 9.6e9;
    });
    const { best, alternates } = pick('mac-16', 'chat', { manifest });
    expect(label(best)).toBe('dense-9b-tuned/q4@llama-server tight:reduced-context 32768 q8_0');
    const spilled = alternates.find(c => c.entry.id === 'hybrid-27b');
    expect(spilled?.fit).toMatchObject({ verdict: 'slow', reason: 'layer-offload', placement: 'layer-offload' });
    // Ahead of a slow all-GPU load below the mode floor.
    const ordered = [best, ...alternates].map(c => c?.entry.id);
    expect(ordered.indexOf('hybrid-27b')).toBeLessThan(ordered.indexOf('gemma-12b'));
  });

  it('lists one alternate per other entry and labels a stale eval as pending', () => {
    const { best, alternates } = pick('mac-24', 'chat');
    expect(alternates.map(c => c.entry.id)).toEqual(['hybrid-27b', 'restricted-moe', 'dense-9b-tuned']);
    expect(alternates.some(c => c.entry === best?.entry)).toBe(false);
    expect(alternates[0].labels).toEqual(['eval-pending']);
  });
});

describe('pickForMachine decode speed', () => {
  const hybridThenMoe = withManifest(m => {
    m.rankings.code = ['hybrid-27b', 'moe-35b'];
    m.entries = m.entries.filter(e => e.id === 'hybrid-27b' || e.id === 'moe-35b');
  });
  const withBandwidth = (gbps: number): HardwareProfile => ({
    ...MACHINES['mac-64'],
    memoryBandwidthBytesPerSec: gbps * 1e9,
  });
  const atBandwidth = (gbps?: number) =>
    pick('mac-64', 'code', { manifest: hybridThenMoe, ...(gbps && { hardware: withBandwidth(gbps) }) });

  it('keeps the ranking when no bandwidth is known', () => {
    const { best, alternates } = atBandwidth();
    expect(label(best)).toBe('hybrid-27b/q6@llama-server fast:fits 262144 f16');
    expect(best?.fit.decode).toBeNull();
    expect(alternates.map(c => c.entry.id)).toEqual(['moe-35b']);
  });

  it('ranks a fitting MoE ahead of a higher-ranked dense model estimated under the slow bar', () => {
    // At 100 GB/s every hybrid build decodes under the bar; the MoE reads about 5.2 GB per token.
    const { best, alternates } = atBandwidth(100);
    expect(best?.entry.id).toBe('moe-35b');
    expect(best?.fit.verdict).toBe('fast');
    expect(best?.fit.decode?.tokensPerSec).toBeGreaterThan(SLOW_DECODE_TOKENS_PER_SEC);
    expect(alternates.map(label)).toEqual(['hybrid-27b/q6@llama-server fast:fits 262144 f16']);
    expect(alternates[0].fit.decode?.tokensPerSec).toBeLessThan(SLOW_DECODE_TOKENS_PER_SEC);
  });

  it('keeps the ranking once the dense entry has a build over the bar, preferring that build', () => {
    const { best } = atBandwidth(200);
    expect(best?.entry.id).toBe('hybrid-27b');
    expect(best?.build.id).toBe('iq4');
    expect(best?.fit.decode?.tokensPerSec).toBeGreaterThanOrEqual(SLOW_DECODE_TOKENS_PER_SEC);
  });

  it('counts speculative decoding only on a preset that turns it on', () => {
    const speculative = withManifest(m => {
      const q6 = m.entries.find(e => e.id === 'hybrid-27b')!.builds[0];
      q6.draft = { kind: 'mtp-embedded', layers: 1 };
      q6.preset = { speculative: { type: 'draft-mtp', draftMax: 3 } };
    });
    const rate = (manifest: HubManifestInput) => {
      const { best } = pick('mac-64', 'code', { manifest, hardware: withBandwidth(400) });
      expect(best?.build.id).toBe('q6');
      return best?.fit.decode?.tokensPerSec ?? 0;
    };
    expect(rate(speculative) / rate(fixtureManifest())).toBeCloseTo(DECODE_CONSTANTS.speculativeGain);
  });

  it('counts speculative decoding on an Ollama build that ships a draft', () => {
    const gemmaOnly = (draft: boolean) =>
      withManifest(m => {
        m.entries = m.entries.filter(e => e.id === 'gemma-12b');
        if (draft) m.entries[0].builds[0].draft = { kind: 'mtp-embedded', layers: 1 };
      });
    const rate = (manifest: HubManifestInput) => {
      const { best } = pick('mac-64', 'chat', { manifest, hardware: withBandwidth(400) });
      expect(best?.runtime).toBe('ollama');
      return best?.fit.decode?.tokensPerSec ?? 0;
    };
    expect(rate(gemmaOnly(true)) / rate(gemmaOnly(false))).toBeCloseTo(DECODE_CONSTANTS.speculativeGain);
  });

  it('keeps an embedding model in its ranked place however slowly its weights would decode', () => {
    const bigEmbedder = withManifest(m => {
      const large = structuredClone(m.entries.find(e => e.id === 'embed-small')!);
      large.id = 'embed-large';
      large.name = 'embed-large';
      large.params = { totalB: 8, activeB: null };
      const [first] = large.builds;
      first.weights = [{ ...first.weights[0], sizeBytes: 16e9 }];
      first.ollama = { kind: 'library', ref: 'embed-large:8b', sizeBytes: 16e9, digest: sha(901) };
      first.evidence = [ownEval(sha(901), { runtime: 'ollama' })];
      m.entries.push(large);
      m.rankings.embeddings = ['embed-large', 'embed-small'];
    });
    const { best, alternates } = pick('mac-64', 'embeddings', { manifest: bigEmbedder, hardware: withBandwidth(120) });
    expect(best?.entry.id).toBe('embed-large');
    expect(best?.fit.decode?.tokensPerSec).toBeLessThan(SLOW_DECODE_TOKENS_PER_SEC);
    expect(alternates.map(c => c.entry.id)).toEqual(['embed-small']);
  });

  it('compares a candidate without an estimate to none that has one, by ranking alone', () => {
    const unsized = (ids: string[]) =>
      withManifest(m => {
        const moe = structuredClone(m.entries.find(e => e.id === 'moe-35b')!);
        moe.id = 'unsized-moe';
        moe.name = 'unsized-moe';
        moe.params = { totalB: 35, activeB: null };
        delete moe.builds[0].tensorStats;
        m.entries.push(moe);
        m.rankings.chat = ids;
        m.entries = m.entries.filter(e => ids.includes(e.id));
      });
    const { best, alternates } = pick('mac-64', 'chat', {
      manifest: unsized(['dense-9b-tuned', 'unsized-moe']),
      hardware: withBandwidth(60),
    });
    expect(best?.entry.id).toBe('dense-9b-tuned');
    expect(best?.fit.decode?.tokensPerSec).toBeLessThan(SLOW_DECODE_TOKENS_PER_SEC);
    expect(alternates.map(c => [c.entry.id, c.fit.decode])).toEqual([['unsized-moe', null]]);
  });

  describe('on a GPU that holds the dense model but not the MoE experts', () => {
    const nvidia = (gbps?: number): HardwareProfile => ({
      ...MACHINES['nv-12+32'],
      ...(gbps && { memoryBandwidthBytesPerSec: gbps * 1e9 }),
    });
    const ranked = (...ids: string[]) =>
      withManifest(m => {
        m.rankings.chat = ids;
        m.entries = m.entries.filter(e => ids.includes(e.id));
      });
    const chat = (ids: string[], gbps?: number) =>
      pick('nv-12+32', 'chat', { manifest: ranked(...ids), hardware: nvidia(gbps) });

    it('ranks an offloaded MoE as slow, so a resident dense model over the bar passes it', () => {
      const { best, alternates } = chat(['moe-35b', 'dense-9b-tuned'], 100);
      expect(best?.entry.id).toBe('dense-9b-tuned');
      expect(best?.fit).toMatchObject({ verdict: 'tight', placement: 'gpu' });
      expect(best?.fit.decode?.tokensPerSec).toBeGreaterThanOrEqual(SLOW_DECODE_TOKENS_PER_SEC);
      expect(alternates.map(c => [c.entry.id, c.fit.placement])).toEqual([['moe-35b', 'expert-offload']]);
    });

    it('keeps the ranking between an offloaded MoE and a resident model under the bar', () => {
      const { best, alternates } = chat(['dense-9b-tuned', 'moe-35b'], 60);
      expect(best?.entry.id).toBe('dense-9b-tuned');
      expect(best?.fit.decode?.tokensPerSec).toBeLessThan(SLOW_DECODE_TOKENS_PER_SEC);
      expect(alternates.map(c => c.fit.placement)).toEqual(['expert-offload']);
    });

    it('leaves the ranking alone when the machine has no known bandwidth', () => {
      const { best } = chat(['moe-35b', 'dense-9b-tuned']);
      expect(best?.entry.id).toBe('moe-35b');
      expect(best?.fit.placement).toBe('expert-offload');
    });
  });
});

describe('pickForMachine policy', () => {
  const restrictedFirst = (edit: (m: HubManifestInput) => void = () => {}) =>
    withManifest(m => {
      m.rankings.chat = ['moe-35b', 'restricted-moe', 'gemma-12b', 'hybrid-27b', 'dense-9b-tuned'];
      edit(m);
    });

  it('hides abliterated builds until the user turns the toggle on, and never makes them the best pick', () => {
    const ids = (p: ReturnType<typeof pick>) => [p.best, ...p.alternates].map(c => c?.entry.id);
    expect(ids(pick('mac-64', 'code'))).not.toContain('hybrid-27b-abliterated');
    const shown = pick('mac-64', 'code', { showAbliterated: true });
    const abl = shown.alternates.find(c => c.entry.id === 'hybrid-27b-abliterated');
    expect(abl?.labels).toContain('abliterated');
    expect(shown.best?.entry.id).toBe('hybrid-27b');
  });

  it('ignores the toggle when policy keeps abliterated builds out of Curated', () => {
    const manifest = withManifest(m => {
      m.policy = { abliterated: 'explore-only' };
    });
    const p = pick('mac-64', 'code', { manifest, showAbliterated: true });
    expect([p.best, ...p.alternates].map(c => c?.entry.id)).not.toContain('hybrid-27b-abliterated');
  });

  it('lets a restricted license be the best pick, carrying the acknowledgement the download must show', () => {
    const { best } = pick('mac-24', 'chat', { manifest: restrictedFirst() });
    expect(best?.entry.id).toBe('restricted-moe');
    expect(best?.labels).toEqual(['restricted-license']);
    expect(best?.licenseAck).toEqual({
      summary: 'Free for local use; offering it as a hosted service needs a separate license.',
      source: 'https://example.com/LICENSE',
    });
    const permissive = pick('mac-24', 'chat').alternates.find(c => c.entry.id === 'dense-9b-tuned');
    expect(permissive?.licenseAck).toBeNull();
  });

  it('demotes restricted licenses to alternates under permissive-only, and hides them under explore-only', () => {
    const permissiveOnly = restrictedFirst(m => {
      m.policy = { bestPickPermissiveOnly: true };
    });
    const p = pick('mac-24', 'chat', { manifest: permissiveOnly });
    expect(p.best?.entry.id).toBe('gemma-12b');
    expect(p.alternates.map(c => c.entry.id)).toContain('restricted-moe');

    const exploreOnly = withManifest(m => {
      m.policy = { restrictedLicense: 'explore-only' };
    });
    const hidden = pick('mac-24', 'chat', { manifest: exploreOnly });
    expect([hidden.best, ...hidden.alternates].map(c => c?.entry.id)).not.toContain('restricted-moe');
  });

  it('never lists an entry whose license is blocked', () => {
    const manifest = withManifest(m => {
      m.entries.find(e => e.id === 'restricted-moe')!.license.legal = 'blocked';
    });
    const p = pick('mac-24', 'chat', { manifest });
    expect([p.best, ...p.alternates].map(c => c?.entry.id)).not.toContain('restricted-moe');
  });

  it('never picks an experimental entry, even when ranked first', () => {
    const manifest = withManifest(m => {
      m.rankings.code = ['experimental-agent', 'hybrid-27b'];
    });
    const p = pick('mac-64', 'code', { manifest });
    expect(p.best?.entry.id).toBe('hybrid-27b');
    expect(p.alternates.find(c => c.entry.id === 'experimental-agent')?.labels).toContain('experimental');
  });

  it('lets a Tier B fine-tune win only when it beats the Tier A pick on tool calls without a coding regression', () => {
    const bFirst = (exact: number, coding: number) =>
      withManifest(m => {
        m.rankings.code = ['dense-9b-tuned', 'hybrid-27b'];
        const own = m.entries.find(e => e.id === 'dense-9b-tuned')!.builds[0].evidence[0].ownEval!;
        own.toolCall.exact = exact;
        own.coding.passed = coding;
      });
    expect(pick('mac-64', 'code', { manifest: bFirst(19, 9) }).best?.entry.id).toBe('dense-9b-tuned');
    expect(pick('mac-64', 'code', { manifest: bFirst(18, 9) }).best?.entry.id).toBe('hybrid-27b');
    expect(pick('mac-64', 'code', { manifest: bFirst(20, 7) }).best?.entry.id).toBe('hybrid-27b');
  });

  it('lets a Tier B variant win on fit when no Tier A pick is in the same verdict class', () => {
    const manifest = withManifest(m => {
      m.entries.find(e => e.id === 'dense-9b-tuned')!.builds[0].evidence[0].ownEval!.toolCall.exact = 10;
    });
    // The eligible hybrid builds (q6, iq4) are only slow on 24 GB; its tight iq3 has a stale eval.
    expect(label(pick('mac-24', 'code', { manifest }).best)).toBe(
      'dense-9b-tuned/q4@llama-server tight:reduced-context 65536 q8_0'
    );
    expect(pick('mac-64', 'code', { manifest }).best?.entry.id).toBe('hybrid-27b');
  });

  it('lists a Tier B variant only with a current own eval, and a Tier C one only with its parent regression run', () => {
    const ids = (p: ReturnType<typeof pick>) => [p.best, ...p.alternates].map(c => c?.entry.id);
    const staleB = withManifest(m => {
      m.entries.find(e => e.id === 'dense-9b-tuned')!.builds[0].evidence[0].ownEval!.runtimeVersion = 'b10430';
    });
    expect(ids(pick('mac-24', 'code', { manifest: staleB }))).not.toContain('dense-9b-tuned');
    const noParent = withManifest(m => {
      delete m.entries.find(e => e.id === 'hybrid-27b-abliterated')!.builds[0].evidence[0].ownEval!.parentToolCall;
    });
    expect(ids(pick('mac-64', 'code', { manifest: noParent, showAbliterated: true }))).not.toContain(
      'hybrid-27b-abliterated'
    );
  });

  it('lists a Tier C variant only when its tool calls stay within the regression tolerance of its parent', () => {
    const tierC = (exact: number, parentExact: number) =>
      withManifest(m => {
        const own = m.entries.find(e => e.id === 'hybrid-27b-abliterated')!.builds[0].evidence[0].ownEval!;
        own.toolCall.exact = exact;
        own.parentToolCall = { exact: parentExact, nearMiss: 0, malformed: 0, of: 20 };
      });
    const listed = (manifest: HubManifestInput) =>
      pick('mac-64', 'code', { manifest, showAbliterated: true }).alternates.some(
        c => c.entry.id === 'hybrid-27b-abliterated'
      );
    expect(TIER_C_TOOL_REGRESSION_TOLERANCE).toBe(0.05);
    expect(listed(tierC(2, 18))).toBe(false);
    expect(listed(tierC(17, 18))).toBe(true);
    // Exactly the tolerance below: 0.4 - 0.05 is 0.35000000000000003 in floating point.
    expect(listed(tierC(7, 8))).toBe(true);
    expect(listed(tierC(6, 8))).toBe(false);
  });

  it('never lists a Tier C variant whose tool-call counts have no runs, even past the schema', () => {
    type Counts = { exact: number; of: number };
    const listedWith = (edit: (own: { toolCall: Counts; parentToolCall?: Counts }) => void) => {
      // The parsed manifest is frozen; a clone lets the counts go where the schema would refuse them.
      const manifest = structuredClone(parseHubManifest(fixtureManifest()).manifest);
      edit(manifest.entries.find(e => e.id === 'hybrid-27b-abliterated')!.builds[0].evidence[0].ownEval!);
      return pickForMachine({
        manifest,
        hardware: MACHINES['mac-64'],
        role: 'code',
        runtimes: BOTH,
        pins: PINS,
        showAbliterated: true,
      }).alternates.some(c => c.entry.id === 'hybrid-27b-abliterated');
    };
    expect(listedWith(() => {})).toBe(true);
    expect(listedWith(own => Object.assign(own.parentToolCall!, { exact: 0, of: 0 }))).toBe(false);
    expect(listedWith(own => (own.toolCall.of = 0))).toBe(false);
  });

  it('lists a Tier B build on the runtime that carries its eval when an earlier runtime is also installed', () => {
    const manifest = withManifest(m => {
      const b = m.entries.find(e => e.id === 'dense-9b-tuned')!.builds[0];
      b.ollama = { kind: 'create', modelfile: {} };
      b.routing = { preferred: 'ollama', reasons: ['renderer-known'], ollamaFallback: true };
      b.smoke = [...b.smoke, { ...b.smoke[0], runtime: 'ollama', runtimeVersion: PINS.ollama, kv: undefined }];
    });
    const dense = (runtimes: MachineRuntimes) => {
      const p = pick('mac-24', 'code', { manifest, runtimes });
      return [p.best, ...p.alternates].find(c => c?.entry.id === 'dense-9b-tuned');
    };
    expect(dense({ 'llama-server': { build: 11889 } })?.runtime).toBe('llama-server');
    expect(dense(BOTH)?.runtime).toBe('llama-server');
    expect(dense({ ollama: { version: '0.40.11' } })).toBeUndefined();
  });

  it('prices flash attention off from the manifest head count', () => {
    // Llama-3.1-8B-like: 32 query heads over 8 KV heads.
    const manifest = (headCount?: number) =>
      withManifest(m => {
        const dense = m.entries.find(e => e.id === 'dense-9b-tuned')!;
        dense.arch = {
          contextMax: 131072,
          blockCount: 32,
          headCount,
          full: { layers: 32, kvHeads: 8, keyLength: 128, valueLength: 128 },
        };
        dense.builds[0].weights[0].sizeBytes = 4.9e9;
        dense.builds[0].preset = { flashAttn: 'off' };
      });
    const dense = (m: HubManifestInput) => {
      const p = pick('mac-24', 'chat', { manifest: m });
      return label([p.best, ...p.alternates].find(c => c?.entry.id === 'dense-9b-tuned') ?? null);
    };
    expect(dense(manifest(32))).toBe('dense-9b-tuned/q4@llama-server tight:reduced-context 32768 f16');
    expect(dense(manifest())).toBe('dense-9b-tuned/q4@llama-server slow:below-floor 16384 f16');
  });

  it('only counts an own eval run on the runtime the candidate would use', () => {
    const ollamaEvalOnly = withManifest(m => {
      m.entries.find(e => e.id === 'gemma-12b')!.builds[0].evidence.pop();
    });
    const server = { 'llama-server': { build: 11889 } };
    expect(pick('mac-64', 'vision', { manifest: ollamaEvalOnly, runtimes: server }).best).toBeNull();
    expect(label(pick('mac-64', 'vision', { manifest: ollamaEvalOnly }).best)).toBe(
      'gemma-12b/q4@ollama fast:fits 65536 f16'
    );
  });

  it('raises the bar with minGradeForBestPick', () => {
    const manifest = withManifest(m => {
      m.policy = { minGradeForBestPick: 'A' };
    });
    expect(label(pick('mac-64', 'code', { manifest }).best)).toBe('hybrid-27b/iq4@llama-server fast:fits 262144 f16');
  });

  it('does not let a speed run lift a build to the grade A a best pick needs', () => {
    const manifest = withManifest(m => {
      m.policy = { minGradeForBestPick: 'A' };
      const evidence = m.entries.find(e => e.id === 'hybrid-27b')!.builds[1].evidence;
      evidence[1] = { ...evidence[1], kind: 'speed', metric: 'decode tok/s', value: 30 };
    });
    const p = pick('mac-64', 'code', { manifest });
    expect(p.best).toBeNull();
    expect(p.alternates.find(c => c.entry.id === 'hybrid-27b')?.grade).toBe('B');
  });

  describe('falls back to the most restrictive choice for a policy value this client does not know', () => {
    const unknown = (field: string, edit: (m: HubManifestInput) => void = () => {}) =>
      withManifest(m => {
        edit(m);
        Object.assign(m, { policy: { [field]: 'from-a-newer-catalog' } });
      });
    const ids = (p: ReturnType<typeof pick>) => [p.best, ...p.alternates].map(c => c?.entry.id);

    it('abliterated: hidden even with the toggle on', () => {
      const p = pick('mac-64', 'code', { manifest: unknown('abliterated'), showAbliterated: true });
      expect(ids(p)).not.toContain('hybrid-27b-abliterated');
    });

    it('restrictedLicense: hidden', () => {
      expect(ids(pick('mac-24', 'chat', { manifest: unknown('restrictedLicense') }))).not.toContain('restricted-moe');
    });

    it('bestPickPermissiveOnly: a restricted license is never the best pick', () => {
      const manifest = unknown('bestPickPermissiveOnly', m => {
        m.rankings.chat = ['moe-35b', 'restricted-moe', 'gemma-12b', 'hybrid-27b', 'dense-9b-tuned'];
      });
      const p = pick('mac-24', 'chat', { manifest });
      expect(p.best?.entry.id).toBe('gemma-12b');
      expect(p.alternates.map(c => c.entry.id)).toContain('restricted-moe');
    });

    it('minGradeForBestPick: only a grade A build is the best pick', () => {
      const p = pick('mac-64', 'code', { manifest: unknown('minGradeForBestPick') });
      expect(label(p.best)).toBe('hybrid-27b/iq4@llama-server fast:fits 262144 f16');
      expect(p.best?.grade).toBe('A');
    });
  });

  it('defaults the policy block when the manifest omits it', () => {
    expect(parseHubManifest(fixtureManifest()).manifest.policy).toEqual({
      abliterated: 'curated-opt-in',
      restrictedLicense: 'curated-labelled',
      bestPickPermissiveOnly: false,
      minGradeForBestPick: 'B',
    });
  });
});

describe('pickForMachine runtimes', () => {
  it('lists nothing whose smoke ran on another runtime pin', () => {
    const p = pick('mac-64', 'code', { pins: OLD_PINS });
    expect(p.best).toBeNull();
    expect(p.alternates).toEqual([]);
  });

  it('goes by the newest smoke run on the pin, so a later failure is not hidden by an earlier pass', () => {
    const withSmoke = (runs: Array<{ date: string; pass: boolean }>) =>
      withManifest(m => {
        const b = m.entries.find(e => e.id === 'embed-small')!.builds[0];
        b.smoke = runs.map(run => ({ ...b.smoke[0], ...run }));
      });
    const best = (manifest: HubManifestInput) => pick('mac-16', 'embeddings', { manifest }).best?.entry.id;
    const older = { date: '2026-10-21', pass: true };
    const newerFail = { date: '2026-10-24', pass: false };
    expect(best(withSmoke([older, newerFail]))).toBeUndefined();
    expect(best(withSmoke([newerFail, older]))).toBeUndefined();
    const olderFail = { date: '2026-10-21', pass: false };
    const newerPass = { date: '2026-10-24', pass: true };
    expect(best(withSmoke([olderFail, newerPass]))).toBe('embed-small');
    expect(best(withSmoke([newerPass, { ...newerPass, pass: false }]))).toBeUndefined();
  });

  it('falls back to Ollama only for builds that allow it when llama-server is missing', () => {
    const p = pick('nv-24+64', 'code', { runtimes: { ollama: { version: '0.40.11' } } });
    expect(p.best).toBeNull();
    // Ollama cannot quantize KV per model and runs -ub 2048 at long context, so it reaches half the context ls does.
    expect(p.alternates.map(label)).toEqual(['hybrid-27b/iq3@ollama tight:reduced-context 131072 f16']);
  });

  it('honours runtimeMin against the installed Ollama', () => {
    const manifest = withManifest(m => {
      m.entries.find(e => e.id === 'embed-small')!.builds[0].runtimeMin = { ollama: '0.41.0' };
    });
    expect(pick('mac-16', 'embeddings', { manifest }).best).toBeNull();
    const newer = { ollama: { version: '0.41.2' }, 'llama-server': { build: 11889 } };
    expect(pick('mac-16', 'embeddings', { manifest, runtimes: newer }).best?.entry.id).toBe('embed-small');
  });

  it('applies the Ollama daemon KV type and parallel slots, except for single-slot architectures', () => {
    const runtimes = { ollama: { version: '0.40.11', kvType: 'q8_0' as const, numParallel: 2 } };
    const gemma = pick('mac-64', 'vision', { runtimes }).best!;
    const gemmaOneSlot = pick('mac-64', 'vision', { runtimes: { ollama: { version: '0.40.11' } } }).best!;
    expect(gemma.fit.kv).toEqual({ k: 'q8_0', v: 'q8_0' });
    expect(gemma.fit.memory.kvBytes).toBeGreaterThan(gemmaOneSlot.fit.memory.kvBytes);

    const hybrid = pick('nv-24+64', 'code', { runtimes }).alternates[0];
    expect(hybrid.runtime).toBe('ollama');
    expect(hybrid.fit.memory.recurrentBytes).toBe(150 * 1024 ** 2);
  });

  it('keeps one Ollama slot for every architecture current Ollama restricts to one', () => {
    const twoSlots = { ollama: { version: '0.40.11', numParallel: 2 } };
    const oneSlot = { ollama: { version: '0.40.11' } };
    for (const arch of ['mllama', 'qwen3vl', 'qwen3vlmoe', 'lfm2moe', 'nemotron_h_moe', 'nemotron_h_omni']) {
      const manifest = withManifest(m => {
        m.families.gemma.ggufArch = arch;
      });
      const kvBytes = (runtimes: PickOptions['runtimes']) =>
        pick('mac-64', 'vision', { manifest, runtimes }).best!.fit.memory.kvBytes;
      expect(kvBytes(twoSlots)).toBe(kvBytes(oneSlot));
    }
  });

  it('keeps an f16 cache on Ollama when its flash attention is off', () => {
    const runtimes = { ollama: { version: '0.40.11', kvType: 'q8_0' as const, flashAttention: false } };
    expect(pick('mac-64', 'vision', { runtimes }).best!.fit.kv).toEqual({ k: 'f16', v: 'f16' });
  });

  it("prices Ollama's draft snapshots of recurrent state, from the Modelfile or Ollama's default", () => {
    const withDraft = (draftNumPredict?: number) =>
      withManifest(m => {
        const iq3 = m.entries.find(e => e.id === 'hybrid-27b')!.builds[2];
        iq3.draft = { kind: 'mtp-embedded', layers: 1 };
        iq3.ollama = { kind: 'create', modelfile: { draftNumPredict } };
      });
    const ollamaOnly = { ollama: { version: '0.40.11' } };
    const recurrent = (manifest: HubManifestInput) =>
      pick('nv-24+64', 'code', { manifest, runtimes: ollamaOnly }).alternates[0].fit.memory.recurrentBytes;
    expect(recurrent(withDraft())).toBe(150 * 1024 ** 2 * 3);
    expect(recurrent(withDraft(4))).toBe(150 * 1024 ** 2 * 5);
  });

  it('offers a quantized cache under flash attention auto only for KV types a smoke loaded', () => {
    const manifest = withManifest(m => {
      for (const e of m.entries) for (const b of e.builds) for (const s of b.smoke) delete s.kv;
    });
    expect(pick('nv-24+64', 'code', { manifest }).best?.fit.kv).toEqual({ k: 'f16', v: 'f16' });
  });

  it('loads the projector on llama-server only for the vision role', () => {
    const server = { 'llama-server': { build: 11889 } };
    const vision = pick('mac-64', 'vision', { runtimes: server }).best!;
    const chat = pick('mac-64', 'chat', { runtimes: server }).alternates.find(c => c.entry.id === 'gemma-12b')!;
    expect(vision.runtime).toBe('llama-server');
    expect(vision.fit.memory.mmprojBytes).toBe(0.21e9);
    expect(chat.fit.memory.mmprojBytes).toBe(0);
  });
});

describe('ollamaBuildBytes', () => {
  const layers = (projectorBytes?: number) => ({
    template: null,
    params: null,
    license: null,
    numCtx: null,
    projector: projectorBytes === undefined ? null : sha(1),
    projectorBytes,
    draft: null,
  });
  const build = (over: Partial<HubBuild>) => ({ weights: [], ...over }) as HubBuild;
  const library = (projectorBytes?: number) =>
    build({
      ollama: { kind: 'library', ref: 'vision:12b', sizeBytes: 7e9, digest: sha(2), layers: layers(projectorBytes) },
    });

  it('takes a pinned projector out of a library layer, which includes it', () => {
    expect(ollamaBuildBytes(library(0.175e9))).toEqual({ weightsBytes: 7e9 - 0.175e9, mmprojBytes: 0.175e9 });
    expect(ollamaBuildBytes(library())).toEqual({ weightsBytes: 7e9, mmprojBytes: 0 });
  });

  it("takes Ollama's pinned projector out of a library layer over a Hugging Face mmproj file", () => {
    const both = {
      ...library(0.175e9),
      mmproj: { path: 'mmproj.gguf', sizeBytes: 0.85e9, sha256: sha(4) },
    } as HubBuild;
    expect(ollamaBuildBytes(both)).toEqual({ weightsBytes: 7e9 - 0.175e9, mmprojBytes: 0.175e9 });
  });

  it('adds a pinned projector beside Hugging Face weights, which leave it out', () => {
    const pinned = build({
      weights: [{ path: 'model.gguf', sizeBytes: 8.4e9, sha256: sha(3) }],
      ollama: { kind: 'hf-pull', modelfile: { dropStops: [] }, layers: layers(0.93e9) },
    } as Partial<HubBuild>);
    expect(ollamaBuildBytes(pinned)).toEqual({ weightsBytes: 8.4e9, mmprojBytes: 0.93e9 });
  });
});
