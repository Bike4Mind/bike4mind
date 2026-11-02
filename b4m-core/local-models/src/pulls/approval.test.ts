import type { HubBuild, HubEntry } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { curatedLibrary } from '../curated';
import type { HubModelDetail } from '../huggingface';
import type { RuntimeHealth } from '../types';
import { curatedHubDetail, curatedPick, hubBuild, hubDetail, servedLayers } from '../__test__/pullFixtures';
import {
  checkApproval,
  curatedLicensesMatch,
  pullBlock,
  type ApprovalDeps,
  type HubPullApproval,
  type LibraryPullApproval,
  type PullCheckHub,
} from './approval';

const PERMISSIVE = new Set(['apache-2.0', 'mit']);
const UP: RuntimeHealth = { ok: true, version: '9.0.0', error: null };

function fakeHub(detail: HubModelDetail, overrides: Partial<PullCheckHub> = {}): PullCheckHub {
  return {
    getModel: vi.fn(async (repo: string) => (repo === detail.id ? detail : hubDetail({ id: repo }))),
    verifyOllamaRef: vi.fn(async (d: HubModelDetail, b) => `hf.co/${d.id}:${b.quant}`),
    ollamaLayers: vi.fn(async () => null),
    ...overrides,
  };
}

function deps(hub: PullCheckHub, overrides: Partial<ApprovalDeps> = {}): ApprovalDeps {
  return {
    hub: () => hub,
    libraryLayers: vi.fn(async () => null),
    health: vi.fn(async () => UP),
    isPermissive: licenses => licenses.length > 0 && licenses.every(id => PERMISSIVE.has(id)),
    signal: new AbortController().signal,
    ...overrides,
  };
}

const hfApproval = (overrides: Partial<HubPullApproval> = {}): HubPullApproval => ({
  source: 'hf',
  repo: 'org/repo',
  buildId: 'model-Q4_K_M',
  revision: 'rev1',
  sizeBytes: 1024,
  licenseAccepted: false,
  accessConfirmed: false,
  curated: null,
  ...overrides,
});

describe('pullBlock', () => {
  it('names why Ollama cannot pull a build, split first', () => {
    const detail = { ollamaNeedsSshKey: false };
    expect(pullBlock(detail, hubBuild())).toBeNull();
    expect(pullBlock(detail, hubBuild({ split: true, complete: false }))).toBe('split');
    expect(pullBlock(detail, hubBuild({ complete: false }))).toBe('incomplete');
    expect(pullBlock(detail, hubBuild({ ollamaRefIssue: 'no-quant-label' }))).toBe('no-quant-label');
    expect(pullBlock(detail, hubBuild({ ollamaRefIssue: 'unsupported-name' }))).toBe('unsupported-name');
    expect(pullBlock(detail, hubBuild({ ollamaRefIssue: 'unsupported-quant' }))).toBe('unsupported-quant');
    expect(pullBlock(detail, hubBuild({ ollamaRefIssue: 'ambiguous' }))).toBeNull();
  });

  it('tells a file with no checksum from one hidden until access is granted', () => {
    const masked = hubBuild({ files: [{ path: 'm.gguf', sizeBytes: 1, sha256: null, url: 'u' }] });
    expect(pullBlock({ ollamaNeedsSshKey: false }, masked)).toBe('no-checksum');
    expect(pullBlock({ ollamaNeedsSshKey: true }, masked)).toBe('needs-access');
  });
});

describe('curatedLicensesMatch', () => {
  it('compares the card and the base card with the reviewed licenses, ignoring case and order', async () => {
    const { entry, build } = curatedPick('hf');
    const detail = curatedHubDetail(entry, build);
    const hub = fakeHub(detail);
    const signal = new AbortController().signal;
    expect(await curatedLicensesMatch(entry, { licenses: [entry.license.id.toUpperCase()] }, () => hub, signal)).toBe(
      true
    );
    expect(hub.getModel).toHaveBeenCalledWith(entry.lineage.base, { signal });
  });

  it('refuses a card or a base card that declares another license, reading the base only when needed', async () => {
    const { entry, build } = curatedPick('hf');
    const hub = fakeHub(curatedHubDetail(entry, build));
    expect(await curatedLicensesMatch(entry, { licenses: ['mit', entry.license.id] }, () => hub)).toBe(false);
    expect(hub.getModel).not.toHaveBeenCalled();
    const base = fakeHub(hubDetail({ id: entry.lineage.base, licenses: ['other'] }));
    expect(await curatedLicensesMatch(entry, { licenses: [entry.license.id] }, () => base)).toBe(false);
  });
});

describe('checkApproval for a Hugging Face build', () => {
  it('passes an unchanged permissive build and returns the ref the registry proved', async () => {
    const detail = hubDetail();
    const hub = fakeHub(detail);
    const onReviewed = vi.fn();
    const d = deps(hub, { onReviewed });
    expect(await checkApproval(hfApproval(), d)).toEqual({ ok: true, ref: 'hf.co/org/repo:Q4_K_M' });
    expect(hub.getModel).toHaveBeenCalledWith('org/repo', { refresh: true });
    expect(hub.verifyOllamaRef).toHaveBeenCalledWith(detail, detail.builds[0], { signal: d.signal });
    expect(onReviewed).toHaveBeenCalledWith({ label: 'Q4_K_M', sizeBytes: 1024 });
    expect(hub.ollamaLayers).not.toHaveBeenCalled();
  });

  it('refuses a moved revision or size before asking the runtime', async () => {
    const hub = fakeHub(hubDetail({ revision: 'rev2' }));
    const d = deps(hub);
    expect(await checkApproval(hfApproval(), d)).toEqual({ ok: false, reason: 'changed' });
    expect(await checkApproval(hfApproval({ sizeBytes: 1 }), deps(fakeHub(hubDetail())))).toEqual({
      ok: false,
      reason: 'changed',
    });
    expect(d.health).not.toHaveBeenCalled();
  });

  it('refuses a build that left the repo or that Ollama cannot pull', async () => {
    expect(await checkApproval(hfApproval({ buildId: 'gone' }), deps(fakeHub(hubDetail())))).toEqual({
      ok: false,
      reason: 'build-missing',
    });
    const split = hubDetail({ builds: [hubBuild({ split: true })] });
    expect(await checkApproval(hfApproval(), deps(fakeHub(split)))).toEqual({
      ok: false,
      reason: 'blocked',
      block: 'split',
    });
  });

  it('needs the license accepted when any declared license is not permissive, or none is declared', async () => {
    for (const licenses of [['apache-2.0', 'llama3.2'], []]) {
      const hub = fakeHub(hubDetail({ licenses }));
      expect(await checkApproval(hfApproval(), deps(hub))).toEqual({ ok: false, reason: 'license-required' });
      expect(await checkApproval(hfApproval({ licenseAccepted: true }), deps(hub))).toMatchObject({ ok: true });
    }
  });

  it('needs the access steps confirmed for a repo Ollama downloads with its own key', async () => {
    const hub = fakeHub(hubDetail({ gated: true, ollamaNeedsSshKey: true }));
    expect(await checkApproval(hfApproval(), deps(hub))).toEqual({ ok: false, reason: 'access-required' });
    expect(await checkApproval(hfApproval({ accessConfirmed: true }), deps(hub))).toMatchObject({ ok: true });
  });

  it('refuses when the runtime is down, before asking the registry', async () => {
    const hub = fakeHub(hubDetail());
    const health = vi.fn(async () => ({ ok: false, version: null, error: 'refused' }));
    expect(await checkApproval(hfApproval(), deps(hub, { health }))).toEqual({
      ok: false,
      reason: 'runtime-unreachable',
      error: 'refused',
    });
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
  });

  it('refuses when the registry cannot prove which file Ollama would get', async () => {
    const hub = fakeHub(hubDetail(), { verifyOllamaRef: vi.fn(async () => null) });
    expect(await checkApproval(hfApproval(), deps(hub))).toEqual({ ok: false, reason: 'unverified' });
  });

  it('stops as cancelled once the signal aborts', async () => {
    const controller = new AbortController();
    const detail = hubDetail();
    const hub = fakeHub(detail, {
      getModel: vi.fn(async () => {
        controller.abort();
        return detail;
      }),
    });
    const d = deps(hub, { signal: controller.signal });
    expect(await checkApproval(hfApproval(), d)).toEqual({ ok: false, reason: 'cancelled' });
    expect(d.health).not.toHaveBeenCalled();
  });

  it('lets a Hub error through for the caller to word', async () => {
    const hub = fakeHub(hubDetail(), {
      getModel: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(checkApproval(hfApproval(), deps(hub))).rejects.toThrow('offline');
  });
});

describe('checkApproval for a curated Hugging Face build', () => {
  const setup = (change: (pick: { entry: HubEntry; build: HubBuild; detail: HubModelDetail }) => void = () => {}) => {
    const { entry, build } = curatedPick('hf');
    build.runtimeMin = { ollama: '1.0.0' };
    const detail = curatedHubDetail(entry, build);
    change({ entry, build, detail });
    const base = hubDetail({ id: entry.lineage.base, licenses: [entry.license.base.id] });
    const hub = fakeHub(detail, {
      getModel: vi.fn(async (repo: string) => (repo === detail.id ? detail : base)),
      ollamaLayers: vi.fn(async () => servedLayers(build)),
    });
    const approval = hfApproval({
      repo: detail.id,
      buildId: detail.builds[0].id,
      sizeBytes: detail.builds[0].sizeBytes,
      curated: { entry, build },
    });
    return { entry, build, detail, hub, approval };
  };

  it('passes when the source serves the reviewed layers at the proven tag', async () => {
    const { build, detail, hub, approval } = setup();
    const result = await checkApproval(approval, deps(hub));
    expect(result).toEqual({ ok: true, ref: `hf.co/${detail.id}:${build.quant.label}` });
    expect(hub.ollamaLayers).toHaveBeenCalledWith(build.hf?.repo, build.quant.label, expect.anything());
  });

  it('refuses a request that does not name the reviewed repo and file', async () => {
    const { hub, approval } = setup();
    expect(await checkApproval({ ...approval, buildId: 'other' }, deps(hub))).toEqual({
      ok: false,
      reason: 'not-listed',
    });
    expect(hub.getModel).not.toHaveBeenCalled();
  });

  it('refuses a repo now marked abliterated, or whose licenses changed', async () => {
    const abliterated = setup(({ detail }) => {
      detail.tags = ['abliterated'];
    });
    expect(await checkApproval(abliterated.approval, deps(abliterated.hub))).toEqual({
      ok: false,
      reason: 'abliterated',
    });
    const relicensed = setup(({ detail }) => {
      detail.licenses = ['mit'];
    });
    expect(await checkApproval(relicensed.approval, deps(relicensed.hub))).toEqual({
      ok: false,
      reason: 'license-changed',
    });
  });

  it('refuses a runtime older than the build needs', async () => {
    const { hub, approval } = setup();
    const health = vi.fn(async () => ({ ok: true, version: '0.9.0', error: null }));
    expect(await checkApproval(approval, deps(hub, { health }))).toEqual({
      ok: false,
      reason: 'runtime-too-old',
      blocked: 'Needs Ollama 1.0.0 or newer',
      required: '1.0.0',
      actual: '0.9.0',
    });
  });

  it('refuses when the source serves other layers than were reviewed', async () => {
    const { hub, approval } = setup();
    vi.mocked(hub.ollamaLayers).mockResolvedValue({ model: 'f'.repeat(64), others: [] });
    expect(await checkApproval(approval, deps(hub))).toEqual({ ok: false, reason: 'layers-changed' });
  });

  it('needs the license accepted when the entry or its base model is not permissive, though the card is', async () => {
    const { hub, approval } = setup(({ entry }) => {
      entry.license.base.class = 'non-commercial';
    });
    const d = deps(hub, { isPermissive: () => true });
    expect(await checkApproval(approval, d)).toEqual({ ok: false, reason: 'license-required' });
    expect(await checkApproval({ ...approval, licenseAccepted: true }, d)).toMatchObject({ ok: true });
  });

  it('names an abliterated repo before a license change, without reading the base model', async () => {
    const { entry, hub, approval } = setup(({ detail }) => {
      detail.tags = ['abliterated'];
      detail.licenses = ['mit'];
    });
    expect(await checkApproval(approval, deps(hub))).toEqual({ ok: false, reason: 'abliterated' });
    expect(hub.getModel).not.toHaveBeenCalledWith(entry.lineage.base, expect.anything());
  });

  it('stops as cancelled when the signal aborts while the runtime is asked, before the registry', async () => {
    const { hub, approval } = setup();
    const controller = new AbortController();
    const health = vi.fn(async () => {
      controller.abort();
      return UP;
    });
    expect(await checkApproval(approval, deps(hub, { health, signal: controller.signal }))).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
  });

  it('stops as cancelled when the signal aborts while the ref is verified, before the layers', async () => {
    const controller = new AbortController();
    const { hub, approval } = setup();
    vi.mocked(hub.verifyOllamaRef).mockImplementation(async (d, b) => {
      controller.abort();
      return `hf.co/${d.id}:${b.quant}`;
    });
    expect(await checkApproval(approval, deps(hub, { signal: controller.signal }))).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(hub.ollamaLayers).not.toHaveBeenCalled();
  });
});

describe('checkApproval refusal order for a Hugging Face build', () => {
  it('reports a build Ollama cannot pull before a license the user has not accepted', async () => {
    const hub = fakeHub(hubDetail({ builds: [hubBuild({ split: true })], licenses: ['llama3.2'] }));
    expect(await checkApproval(hfApproval(), deps(hub))).toEqual({ ok: false, reason: 'blocked', block: 'split' });
  });

  it('asks for the license before the access steps', async () => {
    const hub = fakeHub(hubDetail({ licenses: ['llama3.2'], gated: true, ollamaNeedsSshKey: true }));
    expect(await checkApproval(hfApproval(), deps(hub))).toEqual({ ok: false, reason: 'license-required' });
  });

  it('reports the approved build before it asks the runtime, and only once it is approved', async () => {
    const onReviewed = vi.fn();
    const d = deps(fakeHub(hubDetail()), { onReviewed });
    await checkApproval(hfApproval(), d);
    expect(onReviewed.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.health).mock.invocationCallOrder[0]);

    for (const detail of [hubDetail({ builds: [hubBuild({ split: true })] }), hubDetail({ licenses: ['llama3.2'] })]) {
      const refused = vi.fn();
      await checkApproval(hfApproval(), deps(fakeHub(detail), { onReviewed: refused }));
      expect(refused).not.toHaveBeenCalled();
    }
  });
});

describe('checkApproval for a curated library build', () => {
  const setup = () => {
    const { entry, build } = curatedPick('library');
    const library = curatedLibrary(build);
    if (!library) throw new Error('expected a library build');
    const approval: LibraryPullApproval = {
      source: 'library',
      ref: library.ref,
      buildId: build.id,
      manifestDigest: library.digest,
      sizeBytes: library.sizeBytes,
      licenseAccepted: false,
      curated: { entry, build },
    };
    const libraryLayers = vi.fn(async () => servedLayers(build));
    return { entry, build, library, approval, libraryLayers, hub: fakeHub(hubDetail()) };
  };

  it('passes when the library still serves the reviewed layers', async () => {
    const { build, library, approval, libraryLayers, hub } = setup();
    const onReviewed = vi.fn();
    const d = deps(hub, { libraryLayers, onReviewed });
    expect(await checkApproval(approval, d)).toEqual({ ok: true, ref: library.ref });
    expect(libraryLayers).toHaveBeenCalledWith(library.ref, { signal: d.signal });
    expect(onReviewed).toHaveBeenCalledWith({ label: build.quant.label, sizeBytes: library.sizeBytes });
    expect(hub.getModel).not.toHaveBeenCalled();
  });

  it('refuses another ref, a changed digest or size, and an unaccepted restricted license', async () => {
    const { entry, approval, libraryLayers, hub } = setup();
    const d = deps(hub, { libraryLayers });
    expect(await checkApproval({ ...approval, ref: 'other:tag' }, d)).toEqual({ ok: false, reason: 'not-listed' });
    expect(await checkApproval({ ...approval, manifestDigest: 'x' }, d)).toEqual({ ok: false, reason: 'changed' });
    expect(await checkApproval({ ...approval, sizeBytes: 1 }, d)).toEqual({ ok: false, reason: 'changed' });
    entry.license.base.class = 'non-commercial';
    expect(await checkApproval(approval, d)).toEqual({ ok: false, reason: 'license-required' });
    expect(await checkApproval({ ...approval, licenseAccepted: true }, d)).toMatchObject({ ok: true });
  });

  it('refuses when the library no longer serves the tag', async () => {
    const { approval, hub } = setup();
    expect(await checkApproval(approval, deps(hub))).toEqual({ ok: false, reason: 'layers-not-served' });
  });

  it('stops as cancelled when the signal aborts while the runtime is asked, before the library layers', async () => {
    const { approval, libraryLayers, hub } = setup();
    const controller = new AbortController();
    const health = vi.fn(async () => {
      controller.abort();
      return UP;
    });
    expect(await checkApproval(approval, deps(hub, { libraryLayers, health, signal: controller.signal }))).toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(libraryLayers).not.toHaveBeenCalled();
  });

  it('reports the approved build before asking the runtime, and not when the license is unaccepted', async () => {
    const { entry, approval, libraryLayers, hub } = setup();
    const onReviewed = vi.fn();
    const d = deps(hub, { libraryLayers, onReviewed });
    await checkApproval(approval, d);
    expect(onReviewed.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.health).mock.invocationCallOrder[0]);
    entry.license.base.class = 'non-commercial';
    onReviewed.mockClear();
    await checkApproval(approval, d);
    expect(onReviewed).not.toHaveBeenCalled();
  });
});
