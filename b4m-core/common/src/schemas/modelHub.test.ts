import { describe, it, expect } from 'vitest';
import { build, fixtureManifest, ownEval, sha } from '../modelHub/__fixtures__/hubManifest';
import { HubManifestSchema, ModelArchSchema, parseHubManifest, type HubManifestInput } from './modelHub';

type EntryInput = HubManifestInput['entries'][number];

function issues(input: unknown): string[] {
  const result = HubManifestSchema.safeParse(input);
  return (result.error?.issues ?? []).map(i => `${i.path.join('.')}: ${i.message}`);
}

/** The fixture manifest with one entry edited; returns its issues. */
function issuesAfter(id: string, edit: (e: EntryInput) => void): string[] {
  const m = fixtureManifest();
  edit(m.entries.find(e => e.id === id)!);
  return issues(m);
}

const index = (id: string) => fixtureManifest().entries.findIndex(e => e.id === id);

const pinned = () => ({ template: sha(5), params: sha(6), license: sha(7), numCtx: 40960 });

const kvProbe = (runtime: string) => ({
  bytesPerToken: 1,
  fixedBytes: 0,
  source: 'llama-fit-params' as const,
  runtime,
});

describe('HubManifestSchema', () => {
  it('accepts the fixture catalog and fills defaults', () => {
    const parsed = HubManifestSchema.parse(fixtureManifest());
    const hybrid = parsed.entries[0];
    expect(hybrid.arch.mtpLayers).toBe(0);
    expect(hybrid.builds[0].preset).toMatchObject({ kv: 'auto', flashAttn: 'auto', ubatch: 512, slots: 1 });
    expect(hybrid.builds[0].preset.speculative).toEqual({ type: 'none', draftMax: 3 });
    expect(hybrid.lineage.steps).toEqual([]);
    expect(hybrid.license.requiresAck).toBe(false);
  });

  it('rejects schemaVersion 1', () => {
    expect(issues({ ...fixtureManifest(), schemaVersion: 1 })).not.toEqual([]);
  });

  it('drops capabilities it does not model, such as audio', () => {
    const m = fixtureManifest();
    Object.assign(m.entries[0].capabilities, { audio: true });
    expect(HubManifestSchema.parse(m).entries[0].capabilities).not.toHaveProperty('audio');
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://example.com/LICENSE',
    'https://user:pass@example.com/LICENSE',
    'https://localhost/LICENSE',
    'https://127.0.0.1/LICENSE',
    'https://[::1]/LICENSE',
    'https://models.internal/LICENSE',
    `https://example.com/${'a'.repeat(2048)}`,
  ])('rejects license source %s', source => {
    const found = issuesAfter('hybrid-27b', e => (e.license.source = source));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(i => i.startsWith('entries.0.license.source: '))).toBe(true);
  });

  it.each([
    '../model.gguf',
    '.hidden.gguf',
    'a/b/model.gguf',
    'dir/.model.gguf',
    'model.bin',
    'mo del.gguf',
    '-model.gguf',
    'dir/-model.gguf',
    `${'a'.repeat(200)}.gguf`,
  ])('rejects weight path %s', path => {
    expect(issuesAfter('hybrid-27b', e => (e.builds[0].weights[0].path = path))).not.toEqual([]);
  });

  it.each(['model.gguf', 'UD-Q4_K_XL/model-00001-of-00003.gguf'])('accepts weight path %s', path => {
    expect(issuesAfter('hybrid-27b', e => (e.builds[0].weights[0].path = path))).toEqual([]);
  });

  it.each(['org/..', '../repo', 'org/repo/extra', 'org/.repo'])('rejects hf repo %s', repo => {
    expect(issuesAfter('hybrid-27b', e => (e.builds[0].hf.repo = repo))).not.toEqual([]);
  });

  it('requires a full commit sha for the pinned revision', () => {
    expect(issuesAfter('hybrid-27b', e => (e.builds[0].hf.revision = 'main'))).not.toEqual([]);
  });

  it('strips preset keys it does not know, so no free-form flag reaches the client', () => {
    const m = fixtureManifest();
    Object.assign(m.entries[0].builds[0], { preset: { extraArgs: '--rpc evil' } });
    expect(HubManifestSchema.parse(m).entries[0].builds[0].preset).not.toHaveProperty('extraArgs');
  });

  it.each<[string, (e: EntryInput) => void]>([
    ['arch.moe.moeLayers', e => (e.arch = { ...e.arch, moe: { experts: 8, used: 2, moeLayers: 5e7 } })],
    ['arch.mtpLayers', e => (e.arch = { ...e.arch, mtpLayers: 1025 })],
    ['arch.blockCount', e => (e.arch = { ...e.arch, blockCount: 2000 })],
    ['arch.contextMax', e => (e.arch = { ...e.arch, contextMax: 2 ** 25 })],
    ['arch.headCount', e => (e.arch = { ...e.arch, headCount: 4097 })],
    ['arch.embeddingLength', e => (e.arch = { ...e.arch, embeddingLength: 65537 })],
    ['arch.activeFeedForwardLength', e => (e.arch = { ...e.arch, activeFeedForwardLength: 1048577 })],
    [
      'arch.recurrent.kind',
      e => (e.arch = { ...e.arch, recurrent: { layers: 1, stateBytesPerSeq: 1, kind: 'x'.repeat(33) } }),
    ],
    ['arch.full.kvHeads', e => (e.arch = { ...e.arch, full: { ...e.arch.full, kvHeads: 1e6 } })],
    ['arch.kvProbe.runtime', e => (e.arch = { ...e.arch, kvProbe: kvProbe('b'.repeat(33)) })],
    ['params.activeB', e => (e.params = { totalB: 100000, activeB: 200000 })],
    [
      'builds.0.weights',
      e => {
        e.builds[0].routing.reasons = ['sharded'];
        e.builds[0].weights = Array.from({ length: 65 }, (_, i) => ({
          ...e.builds[0].weights[0],
          path: `m-${i}.gguf`,
        }));
      },
    ],
    ['builds.0.smoke', e => (e.builds[0].smoke = Array.from({ length: 33 }, () => e.builds[0].smoke[0]))],
    ['builds.0.hf.repo', e => (e.builds[0].hf.repo = `org/${'r'.repeat(200)}`)],
    ['builds.0.runtimeMin.llamaCppBuild', e => (e.builds[0].runtimeMin = { llamaCppBuild: 1e7 })],
    ['builds.1.evidence.1.value', e => (e.builds[1].evidence[1].value = 1e13)],
    ['builds.1.evidence.0.ownEval.decodeTokS', e => (e.builds[1].evidence[0].ownEval!.decodeTokS = 1e7)],
    ['builds.1.evidence.0.ownEval.recall.of', e => (e.builds[1].evidence[0].ownEval!.recall.of = 2e6)],
    [
      'builds.1.evidence.0.ownEval.thinkingTokensMedian',
      e => (e.builds[1].evidence[0].ownEval!.thinkingTokensMedian = 2e6),
    ],
  ])('bounds %s', (path, edit) => {
    const found = issuesAfter('hybrid-27b', edit);
    expect(found.some(i => i.startsWith(`entries.0.${path}: Too big`))).toBe(true);
  });

  it('rejects a zero feed-forward width and an empty recurrent kind', () => {
    const base = {
      contextMax: 4096,
      blockCount: 4,
      full: { layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1 },
    };
    expect(ModelArchSchema.safeParse({ ...base, activeFeedForwardLength: 0 }).success).toBe(false);
    const recurrent = { layers: 1, stateBytesPerSeq: 1 };
    expect(ModelArchSchema.safeParse({ ...base, recurrent: { ...recurrent, kind: '' } }).success).toBe(false);
    expect(ModelArchSchema.safeParse({ ...base, recurrent: { ...recurrent, kind: 'x' } }).success).toBe(true);
  });

  it('bounds moeLayers on the arch alone, where no cross-field rule applies', () => {
    const result = ModelArchSchema.safeParse({
      contextMax: 4096,
      blockCount: 1024,
      full: { layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1 },
      moe: { experts: 8, used: 2, moeLayers: 1025 },
    });
    expect(result.error?.issues.map(i => i.path.join('.'))).toEqual(['moe.moeLayers']);
  });

  it.each(['nemotron-3-nano', 'nemotron-3.5-nano', 'qwen3-vl-thinking', 'glm-4.7', 'olmo3-32b-think'])(
    'accepts the Ollama renderer id %s',
    renderer => {
      expect(
        issuesAfter(
          'hybrid-27b',
          e => (e.builds[2].ollama = { kind: 'create', modelfile: { renderer, parser: renderer } })
        )
      ).toEqual([]);
    }
  );

  it.each(['-qwen3', 'Qwen3', 'qwen 3', 'qwen_3'])('rejects the Ollama renderer id %s', renderer => {
    expect(
      issuesAfter('hybrid-27b', e => (e.builds[2].ollama = { kind: 'create', modelfile: { renderer } }))
    ).not.toEqual([]);
  });

  it('accepts every renderer and parser id Ollama 0.40.11 registers', () => {
    // From the switch statements in model/renderers/renderer.go and model/parsers/parsers.go at v0.40.11.
    const ids = [
      'cogito',
      'cohere',
      'd3',
      'deepseek3',
      'deepseek3.1',
      'flint',
      'functiongemma',
      'gemma4',
      'gemma4-large',
      'gemma4-nemotron',
      'gemma4-no-thinking',
      'gemma4-small',
      'glimmer',
      'glm-4.7',
      'glm-ocr',
      'harmony',
      'laguna',
      'lfm2',
      'lfm2-thinking',
      'ministral',
      'nemotron-3.5-nano',
      'nemotron-3.5-super',
      'nemotron-3-nano',
      'olmo3',
      'olmo3.1',
      'olmo3-32b-think',
      'olmo3-think',
      'ornith',
      'passthrough',
      'poolside-v1',
      'qwen3',
      'qwen3.5',
      'qwen3.8',
      'qwen3-coder',
      'qwen3-thinking',
      'qwen3-vl-instruct',
      'qwen3-vl-thinking',
      'tev1',
    ];
    const m = fixtureManifest();
    const failing = ids.filter(id => {
      m.families.hybrid.ollama = { renderer: id, parser: id };
      return issues(m).length > 0;
    });
    expect(failing).toEqual([]);
  });

  it('rejects duplicate entry ids, unknown families and bad rankings', () => {
    const m = fixtureManifest();
    m.entries.push({ ...m.entries[0] });
    m.entries[1].family = 'nope';
    m.rankings.vision = ['gemma-12b', 'hybrid-27b', 'missing', 'gemma-12b'];
    const last = m.entries.length - 1;
    expect(issues(m)).toEqual([
      'entries.1.family: unknown family nope',
      `entries.${last}.id: duplicate entry id hybrid-27b`,
      'rankings.vision: ranking lists an id twice',
      'rankings.vision.1: no vision entry hybrid-27b',
      'rankings.vision.2: no vision entry missing',
    ]);
  });
});

describe('parseHubManifest', () => {
  it('returns the whole fixture deep-frozen with nothing dropped', () => {
    const { manifest, dropped } = parseHubManifest(fixtureManifest());
    expect(dropped).toEqual([]);
    expect(manifest).toEqual(HubManifestSchema.parse(fixtureManifest()));
    expect(Object.isFrozen(manifest.entries[0].builds[0].weights[0])).toBe(true);
    expect(() => {
      (manifest.entries as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('drops a build it cannot read and keeps the others, ignoring an unknown route reason', () => {
    const m = fixtureManifest();
    const [q6, iq4] = m.entries[0].builds;
    Object.assign(q6.routing, { reasons: ['per-model-kv', 'new-reason'] });
    Object.assign(iq4.quant, { family: 'FP3' });
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.entries[0].builds.map(b => b.id)).toEqual(['q6', 'iq3']);
    expect(manifest.entries[0].builds[0].routing.reasons).toEqual(['per-model-kv']);
    expect(dropped).toEqual([{ path: 'entries.0.builds.1', reason: expect.stringMatching(/^quant\.family:/) }]);
  });

  it('ignores unknown roles, ranking keys, smoke checks and preset keys', () => {
    const m = fixtureManifest();
    Object.assign(m.entries[0], { roles: ['code', 'chat', 'audio'] });
    Object.assign(m.rankings, { audio: ['hybrid-27b'] });
    Object.assign(m.entries[0].builds[0], { preset: { newKnob: true } });
    Object.assign(m.entries[0].builds[0].smoke[0], { checks: ['load', 'audio'] });
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.entries[0].roles).toEqual(['code', 'chat']);
    expect(manifest.rankings).not.toHaveProperty('audio');
    expect(manifest.entries[0].builds[0].smoke[0].checks).toEqual(['load']);
    expect(dropped).toEqual([{ path: 'rankings.audio', reason: 'unknown role' }]);
  });

  it('keeps an entry whose recurrent kind this client has not calibrated', () => {
    const m = fixtureManifest();
    const recurrent = m.entries[0].arch.recurrent!;
    Object.assign(recurrent, { kind: 'future-kind' });
    const { manifest, dropped } = parseHubManifest(m);
    expect(dropped).toEqual([]);
    expect(manifest.entries[0].arch.recurrent?.kind).toBe('future-kind');
  });

  it('drops an unreadable evidence item without dropping its build', () => {
    const m = fixtureManifest();
    const iq4 = m.entries[0].builds[1];
    Object.assign(iq4.evidence[1], { kind: 'arena-elo' });
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.entries[0].builds[1].evidence).toHaveLength(1);
    expect(dropped.map(d => d.path)).toEqual(['entries.0.builds.1.evidence.1']);
  });

  it('drops an invalid entry and the ranking ids that pointed at it', () => {
    const m = fixtureManifest();
    m.entries[1].license.class = 'research';
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.entries.map(e => e.id)).not.toContain('moe-35b');
    expect(manifest.rankings.chat).toEqual(['gemma-12b', 'hybrid-27b', 'restricted-moe', 'dense-9b-tuned']);
    expect(dropped.map(d => d.path)).toEqual(['entries.1', 'rankings.code.3', 'rankings.chat.0']);
  });

  it('describes a non-string ranking id by its type and never stringifies it', () => {
    const hostile: unknown = JSON.parse('{"toString":0}');
    const deep: unknown = JSON.parse(`${'['.repeat(200000)}${']'.repeat(200000)}`);
    const m = { ...fixtureManifest(), rankings: { chat: [hostile, deep, null, 'moe-35b'] } };
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.rankings.chat).toEqual(['moe-35b']);
    expect(dropped).toEqual([
      { path: 'rankings.chat.0', reason: 'ranking id is not a string (object)' },
      { path: 'rankings.chat.1', reason: 'ranking id is not a string (object)' },
      { path: 'rankings.chat.2', reason: 'ranking id is not a string (null)' },
    ]);
  });

  it('falls back to the most restrictive value for a policy it does not understand', () => {
    const m = fixtureManifest();
    Object.assign(m, { policy: { abliterated: 'curated-default', bestPickPermissiveOnly: false } });
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.policy).toMatchObject({ abliterated: 'hidden', bestPickPermissiveOnly: false });
    expect(dropped.map(d => d.path)).toEqual(['policy.abliterated']);
  });

  it('reads a null policy as an absent one', () => {
    const { manifest, dropped } = parseHubManifest({ ...fixtureManifest(), policy: null });
    expect(manifest.policy).toEqual(parseHubManifest(fixtureManifest()).manifest.policy);
    expect(dropped).toEqual([]);
  });

  it('rejects a manifest whose envelope it cannot read', () => {
    expect(() => parseHubManifest({ ...fixtureManifest(), schemaVersion: 3 })).toThrow();
    expect(() =>
      parseHubManifest({ ...fixtureManifest(), entries: Array.from({ length: 501 }, () => ({})) })
    ).toThrow();
  });
});

describe('curated sequence, changelog and tiers', () => {
  const curated = () => ({
    ...fixtureManifest(),
    sequence: 3,
    changelog: [
      { sequence: 3, date: '2026-10-27', added: ['gemma-12b'], removed: [], changed: [], notes: 'Adds Gemma.' },
      {
        sequence: 2,
        date: '2026-10-20',
        added: [],
        removed: [{ id: 'old-pick', name: 'Old' }],
        changed: [],
        notes: '',
      },
    ],
    tiers: [
      {
        memoryKind: 'cpu',
        minGiB: 0,
        picks: [
          { slot: 'best', entry: 'hybrid-27b', build: 'q6' },
          { slot: 'light', entry: 'gemma-12b', build: 'q4' },
        ],
      },
      { memoryKind: 'discrete', minGiB: 16, picks: [{ slot: 'fast', entry: 'gemma-12b', build: 'q4' }] },
    ],
  });

  it('accepts them and defaults both lists to empty', () => {
    expect(issues(curated())).toEqual([]);
    const parsed = HubManifestSchema.parse(fixtureManifest());
    expect(parsed).toMatchObject({ changelog: [], tiers: [] });
    expect(parsed).not.toHaveProperty('sequence');
    const { manifest, dropped } = parseHubManifest(curated());
    expect(dropped).toEqual([]);
    expect(manifest).toEqual(HubManifestSchema.parse(curated()));
  });

  it('rejects a pick of a missing build, a taken slot and a repeated tier', () => {
    const m = curated();
    m.tiers[0].picks.push({ slot: 'best', entry: 'gemma-12b', build: 'q4' });
    m.tiers[1].picks[0].build = 'q9';
    m.tiers.push({ memoryKind: 'cpu', minGiB: 0, picks: [] });
    expect(issues(m)).toEqual([
      'tiers.0.picks.2.slot: slot taken',
      'tiers.1.picks.0: no build q9 in gemma-12b',
      'tiers.2: duplicate tier',
    ]);
  });

  it('allows best, fast and long-context on GPU tiers and best, fast and light on the CPU tier', () => {
    const m = curated();
    m.tiers[0].picks.push({ slot: 'long-context', entry: 'gemma-12b', build: 'q4' });
    m.tiers[1].picks.push({ slot: 'light', entry: 'gemma-12b', build: 'q4' });
    m.tiers.push({ memoryKind: 'unified', minGiB: 32, picks: [{ slot: 'light', entry: 'gemma-12b', build: 'q4' }] });
    expect(issues(m)).toEqual([
      'tiers.0.picks.2: no long-context slot in a cpu tier',
      'tiers.1.picks.1: no light slot in a discrete tier',
      'tiers.2.picks.0: no light slot in a unified tier',
    ]);

    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.tiers.map(tier => tier.picks.map(pick => pick.slot))).toEqual([['best', 'light'], ['fast'], []]);
    expect(dropped.map(d => d.path)).toEqual(['tiers.0.picks.2', 'tiers.1.picks.1', 'tiers.2.picks.0']);
  });

  it('caps a tier at three picks: the strict schema rejects a fourth and the reader drops the tier', () => {
    const m = curated();
    m.tiers[1].picks = [
      { slot: 'best', entry: 'gemma-12b', build: 'q4' },
      { slot: 'fast', entry: 'gemma-12b', build: 'q4' },
      { slot: 'long-context', entry: 'gemma-12b', build: 'q4' },
    ];
    expect(issues(m)).toEqual([]);
    m.tiers[1].picks.push({ slot: 'best', entry: 'hybrid-27b', build: 'q6' });
    expect(issues(m)).toEqual(['tiers.1.picks: Too big: expected array to have <=3 items']);

    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.tiers.map(tier => tier.memoryKind)).toEqual(['cpu']);
    expect(dropped).toEqual([{ path: 'tiers.1', reason: 'picks: Too big: expected array to have <=3 items' }]);
  });

  it('holds chat entries, and only chat entries, to a 16K trained context', () => {
    const m = curated();
    const short = (id: string) => {
      const entry = m.entries.find(e => e.id === id)!;
      entry.arch = { ...entry.arch, contextMax: 8192 };
    };
    short('gemma-12b');
    short('embed-small');
    expect(issues(m)).toEqual([
      `entries.${index('gemma-12b')}.arch.contextMax: a chat model needs a context of at least 16384 tokens`,
    ]);

    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.entries.map(e => e.id)).not.toContain('gemma-12b');
    expect(manifest.entries.map(e => e.id)).toContain('embed-small');
    expect(manifest.tiers[0].picks.map(pick => pick.entry)).toEqual(['hybrid-27b']);
    expect(dropped.map(d => d.path)).toContain(`entries.${index('gemma-12b')}`);
  });

  it('leaves a slot empty when its entry was dropped, and drops unreadable picks and changelog items', () => {
    const m = curated();
    m.entries.find(e => e.id === 'hybrid-27b')!.license.class = 'research';
    Object.assign(m.tiers[1].picks[0], { slot: 'tiny' });
    Object.assign(m.changelog[1], { date: 'yesterday' });
    const { manifest, dropped } = parseHubManifest(m);
    expect(manifest.tiers).toEqual([
      { memoryKind: 'cpu', minGiB: 0, picks: [{ slot: 'light', entry: 'gemma-12b', build: 'q4' }] },
      { memoryKind: 'discrete', minGiB: 16, picks: [] },
    ]);
    expect(manifest.changelog.map(item => item.sequence)).toEqual([3]);
    expect(dropped.map(d => d.path)).toEqual(
      expect.arrayContaining(['tiers.0.picks.0', 'tiers.1.picks.0', 'changelog.1'])
    );
  });

  it('rejects an envelope whose sequence is not a positive integer', () => {
    expect(() => parseHubManifest({ ...curated(), sequence: 0 })).toThrow();
    expect(() => parseHubManifest({ ...curated(), sequence: 1.5 })).toThrow();
  });
});

describe('HubEntrySchema cross-field rules', () => {
  it.each<[string, string, (e: EntryInput) => void, string]>([
    ['hybrid-27b', 'duplicate roles', e => (e.roles = ['code', 'code', 'chat']), 'roles: roles must be unique'],
    [
      'hybrid-27b',
      'vision role without capability',
      e => e.roles.push('vision'),
      'roles: vision role and capabilities.vision must agree',
    ],
    [
      'gemma-12b',
      'vision build without projector',
      e => delete e.builds[0].mmproj,
      `builds.0.mmproj: a vision build needs an mmproj, a pinned projector layer or an Ollama library source`,
    ],
    [
      'gemma-12b',
      'a vision hf-pull build whose layers pin no projector',
      e => {
        delete e.builds[0].mmproj;
        e.builds[0].ollama = { kind: 'hf-pull', modelfile: {}, layers: pinned() };
      },
      `builds.0.mmproj: a vision build needs an mmproj, a pinned projector layer or an Ollama library source`,
    ],
    [
      'hybrid-27b',
      'embeddings capability without role',
      e => (e.capabilities = { ...e.capabilities, embeddings: true }),
      'roles: embeddings role and capabilities.embeddings must agree',
    ],
    [
      'gemma-12b',
      'a tool-use rating without tool support',
      e => {
        e.capabilities = { ...e.capabilities, tools: false };
        e.toolUse = { rating: 'ok' };
      },
      'toolUse.rating: a tool-use rating needs capabilities.tools',
    ],
    [
      'gemma-12b',
      'a chat model trained on less than 16K',
      e => (e.arch = { ...e.arch, contextMax: 16383 }),
      'arch.contextMax: a chat model needs a context of at least 16384 tokens',
    ],
    [
      'hybrid-27b',
      'a pinned num_ctx without a params layer',
      e => {
        e.builds[2].ollama = { kind: 'hf-pull', modelfile: {}, layers: { ...pinned(), params: null } };
      },
      'builds.2.ollama.layers: numCtx needs a params layer',
    ],
    [
      'hybrid-27b',
      'a projector size without a projector layer',
      e => {
        e.builds[2].ollama = { kind: 'hf-pull', modelfile: {}, layers: { ...pinned(), projectorBytes: 1000 } };
      },
      'builds.2.ollama.layers: projectorBytes needs a projector layer',
    ],
    [
      'hybrid-27b',
      'a Hugging Face build with no weights',
      e => (e.builds[2].weights = []),
      'builds.2.weights: a build needs Hugging Face weights unless it is an Ollama library build',
    ],
    [
      'hybrid-27b',
      'a Hugging Face build with no repo',
      e => delete e.builds[2].hf,
      'builds.2.weights: a build needs Hugging Face weights unless it is an Ollama library build',
    ],
    [
      'hybrid-27b',
      'shards without the sharded reason',
      e => e.builds[0].weights.push({ path: 'model-2.gguf', sizeBytes: 1, sha256: sha(77) }),
      'builds.0.routing.reasons: sharded weights need sharded',
    ],
    [
      'hybrid-27b',
      'hf-pull of a split file',
      e => {
        const b = e.builds[2];
        b.routing.reasons = ['sharded'];
        b.weights.push({ path: 'model-2.gguf', sizeBytes: 1, sha256: sha(77) });
        b.ollama = { kind: 'hf-pull', modelfile: {} };
      },
      'builds.2.ollama.kind: Ollama cannot pull shards; use create',
    ],
    [
      'gemma-12b',
      'hf-pull with a separate projector',
      e => (e.builds[0].ollama = { kind: 'hf-pull', modelfile: {} }),
      'builds.0.ollama.kind: hf-pull needs a single file and no separate mmproj; use create',
    ],
    [
      'hybrid-27b',
      'Ollama routing without an Ollama source',
      e => (e.builds[0].routing.ollamaFallback = true),
      'builds.0.ollama: routing to Ollama needs an Ollama source',
    ],
    [
      'hybrid-27b',
      'MTP speculation without a draft',
      e => (e.builds[0].preset = { speculative: { type: 'draft-mtp', draftMax: 3 } }),
      'builds.0.preset.speculative.type: speculative draft-mtp needs a matching draft',
    ],
    [
      'hybrid-27b',
      'quantized V cache with flash attention off',
      e => (e.builds[0].preset = { kv: { k: 'q8_0', v: 'q8_0' }, flashAttn: 'off' }),
      "builds.0.preset.kv: a quantized V cache requires flashAttn 'on'",
    ],
    [
      'hybrid-27b',
      'quantized V cache with flash attention auto',
      e => (e.builds[0].preset = { kv: { k: 'q8_0', v: 'q8_0' } }),
      "builds.0.preset.kv: a quantized V cache requires flashAttn 'on'",
    ],
    [
      'hybrid-27b',
      'exact evidence naming another file',
      e => (e.builds[0].evidence = [ownEval(sha(12345))]),
      'builds.0.evidence.0.measured.sha256: exact evidence must name a weight or Ollama digest of this build',
    ],
    [
      'hybrid-27b',
      'own eval that is not independent',
      e => (e.builds[1].evidence[0].independent = false),
      'builds.1.evidence.0.measured: an own eval is independent, reproducible and on the exact build',
    ],
    [
      'hybrid-27b',
      'own-eval kind without results',
      e => delete e.builds[1].evidence[0].ownEval,
      'builds.1.evidence.0.ownEval: ownEval is required for, and only for, kind own-eval',
    ],
    [
      'hybrid-27b',
      'tool-call counts over the total',
      e => (e.builds[1].evidence[0].ownEval!.toolCall.nearMiss = 5),
      'builds.1.evidence.0.ownEval.toolCall: tool-call counts exceed of',
    ],
    [
      'hybrid-27b',
      'abliterated lineage without the flag',
      e => (e.lineage.steps = ['abliterate']),
      'flags.abliterated: abliterated lineage requires flags.abliterated',
    ],
    [
      'hybrid-27b',
      'license looser than its base',
      e => (e.license.base.class = 'non-commercial'),
      'license.class: license class cannot be less restrictive than the base license',
    ],
    [
      'hybrid-27b',
      'card tag that disagrees with the LICENSE file',
      e => (e.license.cardTag = 'MIT'),
      'flags.licenseMismatch: card tag differs from the LICENSE file',
    ],
    [
      'restricted-moe',
      'restricted license without an acknowledgement',
      e => (e.license.requiresAck = false),
      'license.requiresAck: a non-permissive license needs an acknowledgement',
    ],
    [
      'restricted-moe',
      'acknowledgement without a summary',
      e => delete e.license.summary,
      'license.summary: an acknowledged license needs a plain summary',
    ],
    [
      'restricted-moe',
      'cleared restricted license without a note',
      e => delete e.license.legalNote,
      'license.legalNote: a cleared non-permissive license needs a legalNote',
    ],
    [
      'hybrid-27b',
      'custom quant without the flag',
      e => (e.builds[0].quant.family = 'custom'),
      'flags.customQuant: custom quant requires flags.customQuant',
    ],
    [
      'hybrid-27b',
      'tensorStats on a dense model',
      e => (e.builds[0].tensorStats = { expertBytesPerLayer: 1, nonExpertBytes: 1 }),
      'builds.0.tensorStats: tensorStats needs arch.moe',
    ],
    [
      'moe-35b',
      'tensorStats larger than the weight files',
      e => (e.builds[0].tensorStats = { expertBytesPerLayer: 1e9, nonExpertBytes: 2e9 }),
      'builds.0.tensorStats: tensorStats exceed the weight files',
    ],
    [
      'hybrid-27b',
      'a fixed quantized KV preset on a kvProbe arch',
      e => {
        e.arch = { ...e.arch, kvProbe: kvProbe('b11889') };
        e.builds[0].preset = { kv: { k: 'q8_0', v: 'f16' } };
      },
      'builds.0.preset.kv: a kvProbe arch is sized at f16 KV only',
    ],
    [
      'hybrid-27b',
      'layer groups beyond blockCount',
      e => (e.arch = { ...e.arch, blockCount: 32 }),
      'arch: layer groups exceed blockCount',
    ],
    ['hybrid-27b', 'duplicate build ids', e => (e.builds[1].id = 'q6'), 'builds.1.id: duplicate build id q6'],
    [
      'hybrid-27b',
      'parent tool-call counts over the total',
      e => (e.builds[1].evidence[0].ownEval!.parentToolCall = { exact: 30, nearMiss: 0, malformed: 0, of: 20 }),
      'builds.1.evidence.0.ownEval.parentToolCall: tool-call counts exceed of',
    ],
    [
      'moe-35b',
      'a fixed nCpuMoe without tensorStats',
      e => {
        delete e.builds[0].tensorStats;
        e.builds[0].preset = { nCpuMoe: 10 };
      },
      'builds.0.preset.nCpuMoe: a fixed nCpuMoe needs tensorStats',
    ],
  ])('%s: %s', (id, _label, edit, expected) => {
    expect(issuesAfter(id, edit)).toContain(`entries.${index(id)}.${expected}`);
  });

  it('reports each rule on its own: an unedited entry has no issues', () => {
    expect(issues(fixtureManifest())).toEqual([]);
  });

  it('lists tool support without any eval, and defaults the tool-use rating to unrated', () => {
    const m = fixtureManifest();
    for (const entry of m.entries) for (const b of entry.builds) b.evidence = [];
    expect(issues(m)).toEqual([]);
    const { manifest, dropped } = parseHubManifest(m);
    expect(dropped).toEqual([]);
    const hybrid = manifest.entries.find(e => e.id === 'hybrid-27b');
    expect(hybrid).toMatchObject({ capabilities: { tools: true }, toolUse: { rating: 'unrated' } });
  });

  it('keeps a rating and note beside tool support, and pinned hf-pull layers', () => {
    expect(
      issuesAfter('hybrid-27b', e => {
        e.toolUse = { rating: 'weak', note: 'Often answers in prose instead of calling the tool.' };
        e.builds[2].ollama = { kind: 'hf-pull', modelfile: {}, layers: pinned() };
      })
    ).toEqual([]);
  });

  it('accepts a vision hf-pull build whose registry serves a pinned projector', () => {
    const layers = { ...pinned(), template: null, installedTemplate: sha(8), projector: sha(9), projectorBytes: 9 };
    expect(
      issuesAfter('gemma-12b', e => {
        delete e.builds[0].mmproj;
        e.builds[0].ollama = { kind: 'hf-pull', modelfile: {}, layers };
      })
    ).toEqual([]);
  });

  it('accepts an Ollama library build with pinned layers and no Hugging Face files', () => {
    const m = fixtureManifest();
    const embed = m.entries.find(e => e.id === 'embed-small')!;
    delete embed.builds[0].hf;
    embed.builds[0].weights = [];
    embed.builds[0].ollama = {
      kind: 'library',
      ref: 'embed-small:0.6b',
      sizeBytes: 639_150_000,
      digest: sha(900),
      layers: { ...pinned(), numCtx: null, draft: sha(10) },
    };
    expect(issues(m)).toEqual([]);
    const { manifest, dropped } = parseHubManifest(m);
    expect(dropped).toEqual([]);
    const parsed = manifest.entries.find(e => e.id === 'embed-small')!.builds[0];
    expect(parsed.weights).toEqual([]);
    expect(parsed.ollama).toMatchObject({ layers: { projector: null, draft: sha(10) } });
  });

  it('reads a tool-use rating it does not know as unrated instead of dropping the entry', () => {
    const m = fixtureManifest();
    const hybrid = m.entries.find(e => e.id === 'hybrid-27b');
    if (!hybrid) throw new Error('no hybrid-27b');
    (hybrid as { toolUse: unknown }).toolUse = { rating: 'excellent', note: 'From a newer rating scale.' };
    const { manifest, dropped } = parseHubManifest(m);
    expect(dropped).toEqual([]);
    expect(manifest.entries.find(e => e.id === 'hybrid-27b')?.toolUse).toEqual({ rating: 'unrated' });
  });

  it.each([
    ['a rating on a model without tools', { rating: 'strong', note: 'Rated.' }, false, { rating: 'unrated' }],
    ['a note past 200 characters', { rating: 'ok', note: 'x'.repeat(240) }, true, { rating: 'ok' }],
    ['an empty note', { rating: 'weak', note: '' }, true, { rating: 'weak' }],
    ['a tool-use value that is not an object', 'strong', true, { rating: 'unrated' }],
  ])('keeps the entry when the tool-use label has %s', (_label, toolUse, tools, expected) => {
    const m = fixtureManifest();
    const hybrid = m.entries.find(e => e.id === 'hybrid-27b');
    if (!hybrid) throw new Error('no hybrid-27b');
    (hybrid as { toolUse: unknown }).toolUse = toolUse;
    hybrid.capabilities.tools = tools;
    const { manifest, dropped } = parseHubManifest(m);
    expect(dropped).toEqual([]);
    expect(manifest.entries.find(e => e.id === 'hybrid-27b')?.toolUse).toEqual(expected);
  });

  it('accepts evidence on an Ollama library digest', () => {
    expect(
      issuesAfter('embed-small', e => (e.builds[0].evidence = [ownEval(sha(900), { runtime: 'ollama' })]))
    ).toEqual([]);
  });

  it('accepts a speculative MTP preset with an embedded draft', () => {
    expect(
      issuesAfter('hybrid-27b', e => {
        e.builds[0].draft = { kind: 'mtp-embedded', layers: 1 };
        e.builds[0].preset = { speculative: { type: 'draft-mtp', draftMax: 3 } };
      })
    ).toEqual([]);
  });

  it('builds fixture builds that parse on their own', () => {
    const m = fixtureManifest();
    m.entries[0].builds.push(build('extra', 1e9));
    expect(issues(m)).toEqual([]);
  });
});

describe('ModelArchSchema', () => {
  it.each([
    [0, true],
    [4096, true],
    [-1, false],
    [0.5, false],
  ])('sliding window %s accepted: %s', (window, ok) => {
    const result = ModelArchSchema.safeParse({
      contextMax: 8192,
      blockCount: 2,
      full: { layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1 },
      swa: { layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1, window },
    });
    expect(result.success).toBe(ok);
  });

  it('accepts the shapes local-models extracts', () => {
    expect(
      ModelArchSchema.parse({
        contextMax: 1048576,
        blockCount: 32,
        full: { layers: 4, kvHeads: 4, keyLength: 64, valueLength: 64 },
        recurrent: { layers: 28, stateBytesPerSeq: 22622208 },
      }).mtpLayers
    ).toBe(0);
  });

  it('only accepts llama-fit-params as a kvProbe source', () => {
    const probe = { bytesPerToken: 1, fixedBytes: 0, source: 'guess', runtime: 'b11889' };
    expect(
      ModelArchSchema.safeParse({
        contextMax: 1,
        blockCount: 1,
        full: { layers: 1, kvHeads: 1, keyLength: 1, valueLength: 1 },
        kvProbe: probe,
      }).success
    ).toBe(false);
  });
});
