// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODULE_BUNDLE_FORMAT, OVERRIDE_BUNDLE_FORMAT } from '@bike4mind/common';
import { CORE_DRAFT_PROFILE, coreDraftCore } from '@bike4mind/server-utils/tutorials/coreDraftProfile';
import { runApplyCli } from '../cli';
import { coreLayout } from '../coreLayout';
import { fixtureLayout } from './fixtureLayout';

const root = mkdtempSync(join(tmpdir(), 'apply-cli-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const out = { log: vi.spyOn(console, 'log'), error: vi.spyOn(console, 'error') };
beforeEach(() => {
  out.log.mockImplementation(() => undefined);
  out.error.mockImplementation(() => undefined);
});
afterEach(() => vi.clearAllMocks());

const write = (name: string, value: unknown) => {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : []);

const transcript = [{ prompt: 'Plan my week', reply: 'Here is a plan.' }];
const content = {
  moduleId: 'cli-week',
  title: 'Plan the week',
  pitch: 'Plan a week.',
  transcript,
  steps: coreDraftCore.normalizeDraftSteps({
    steps: CORE_DRAFT_PROFILE.starterSteps(transcript),
    transcript,
    sheet: undefined,
    canvasNodeId: undefined,
  }),
  finale: CORE_DRAFT_PROFILE.defaultFinale,
  visibility: { public: true },
};
const moduleBundle = (owner?: string) => ({
  format: MODULE_BUNDLE_FORMAT,
  ...(owner && { owner }),
  moduleId: 'cli-week',
  exportedAt: '2026-11-12T00:00:00.000Z',
  content,
});

describe('runApplyCli in the core layout', () => {
  const layout = coreLayout(root);
  const modules = join(root, layout.modulesDir);

  it('returns 1 and writes nothing for a bundle another owner exported', async () => {
    expect(await runApplyCli(layout, [write('foreign.json', moduleBundle('other-pkg'))])).toBe(1);
    expect(out.error.mock.calls.flat().join('\n')).toContain('belongs to other-pkg');
    expect(filesIn(modules)).toEqual([]);
    out.error.mockClear();
    const override = {
      format: OVERRIDE_BUNDLE_FORMAT,
      owner: 'other-pkg',
      moduleId: 'cli-week',
      version: 1,
      revision: 0,
      exportedAt: '2026-11-12T00:00:00.000Z',
      units: [{ kind: 'reply', turn: 0, value: 'b', repoValue: 'a' }],
      changes: [],
    };
    expect(await runApplyCli(layout, [write('foreign-override.json', override)])).toBe(1);
    expect(out.error.mock.calls.flat().join('\n')).toContain('belongs to other-pkg');
    expect(filesIn(modules)).toEqual([]);
  });

  it('returns 1 for a bundle with no owner and names no repo it cannot know', async () => {
    expect(await runApplyCli(layout, [write('legacy.json', moduleBundle())])).toBe(1);
    expect(out.error.mock.calls.flat().join('\n')).toContain('names no owner');
    expect(filesIn(modules)).toEqual([]);
  });

  it('writes a core-made module and returns 0, and nothing on a dry run', async () => {
    const path = write('mine.json', moduleBundle('core'));
    expect(await runApplyCli(layout, [path, '--dry-run'])).toBe(0);
    expect(filesIn(modules)).toEqual([]);
    expect(await runApplyCli(layout, [path])).toBe(0);
    expect(readFileSync(join(modules, 'cli-week', 'transcript.json'), 'utf8')).toContain('Plan my week');
  });

  it('returns 2 without an input file or with one that is not JSON', async () => {
    expect(await runApplyCli(layout, [])).toBe(2);
    const bad = join(root, 'bad.json');
    writeFileSync(bad, '{');
    expect(await runApplyCli(layout, [bad])).toBe(2);
  });
});

describe('runApplyCli in another layout', () => {
  it('refuses a core bundle and names the repo the layout knows', async () => {
    const dir = join(root, 'other');
    mkdirSync(dir);
    const layout = fixtureLayout({ root: dir });
    expect(await runApplyCli(layout, [write('core-bundle.json', moduleBundle('core'))])).toBe(1);
    expect(out.error.mock.calls.flat().join('\n')).toContain('the core repo');
  });
});
