// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { OVERRIDE_BUNDLE_FORMAT } from '@bike4mind/common';
import { applyBundle, parseBundle } from '../applyOverride';
import { applyModuleBundle } from '../applyModule';
import { coreLayout } from '../coreLayout';
import { checkBundleOwner } from '../owner';
import { fixtureLayout } from './fixtureLayout';

const core = coreLayout('/repo');

describe('checkBundleOwner', () => {
  it('accepts a bundle that names this repo as its owner', () => {
    expect(checkBundleOwner({ owner: 'core', moduleId: 'm' }, core)).toEqual({ ok: true });
  });

  it('refuses another owner and names it, and the repo to use when the layout knows one', () => {
    const verdict = checkBundleOwner({ owner: 'other-pkg', moduleId: 'm' }, core);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.message).toContain('other-pkg');
    expect(!verdict.ok && verdict.message).toContain('the repo that owns other-pkg');
    const known = checkBundleOwner({ owner: 'core', moduleId: 'm' }, fixtureLayout());
    expect(!known.ok && known.message).toContain('apply it in the core repo');
  });

  it('refuses a missing owner in core, and reads it as the legacy owner where a layout names one', () => {
    expect(checkBundleOwner({ moduleId: 'm' }, core).ok).toBe(false);
    expect(checkBundleOwner({ moduleId: 'm' }, fixtureLayout({ legacyOwner: 'x', owner: 'x' }))).toEqual({ ok: true });
    expect(checkBundleOwner({ moduleId: 'm' }, fixtureLayout({ legacyOwner: 'x' })).ok).toBe(false);
  });
});

describe('the override format', () => {
  const bundleOf = (owner?: string) =>
    parseBundle({
      format: OVERRIDE_BUNDLE_FORMAT,
      ...(owner && { owner }),
      moduleId: 'fixture-mod',
      version: 1,
      revision: 0,
      exportedAt: '2026-11-09T00:00:00.000Z',
      units: [{ kind: 'reply', turn: 0, value: 'b', repoValue: 'a' }],
      changes: [],
    });
  const repo = {
    version: 1,
    index: 0,
    steps: [],
    transcript: [{ prompt: 'p', reply: 'a' }],
    stepsSource: '',
    versionSource: '',
  };

  it('applies for the owner and refuses another owner or none, before reading any source', () => {
    const layout = fixtureLayout();
    expect(applyBundle(bundleOf(layout.owner), repo, layout).applied).toEqual(['turn:0']);
    expect(() => applyBundle(bundleOf('other-pkg'), repo, layout)).toThrow(/other-pkg/);
    expect(() => applyBundle(bundleOf(), repo, layout)).toThrow(/names no owner/);
    expect(applyBundle(bundleOf(), repo, fixtureLayout({ legacyOwner: layout.owner })).applied).toEqual(['turn:0']);
  });
});

describe('the module writer', () => {
  it('refuses a foreign or missing owner before building any file', () => {
    const content = { moduleId: 'm' } as never;
    for (const owner of ['other-pkg', undefined]) {
      const result = applyModuleBundle({ ...(owner && { owner }), moduleId: 'm', content }, core, { dryRun: false });
      expect(result).toMatchObject({ ok: false, reason: 'owner' });
    }
  });
});
