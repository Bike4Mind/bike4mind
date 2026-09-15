import { describe, expect, it } from 'vitest';
import { settingsMap } from './settings';
import { SettingScopeLevel } from '../types/entities/ScopedSettingTypes';

/**
 * Lockstep guard for the scoped-settings foundation (#1660). The resolver relies on invariants that
 * live in the setting DEFINITION, so drift there would silently break scoping rather than fail a
 * type. Pinning them here means a malformed `scope` registration fails the build.
 *
 * SCOPE OF THIS GUARD, deliberately narrow (#2709): every assertion below is STRUCTURAL - it reads
 * `settingsMap` and nothing else, so it can only judge whether a declaration is well-formed, never
 * whether a consumer honors it. It does NOT catch "a lever with no consumer / a lever that lies",
 * which this docblock used to claim and #2624 walked straight past. That class is a property of
 * CALL SITES, not of this file, and the defence against it lives where it is caused, in two parts:
 *
 *  - `scope` is a REQUIRED parameter on `resolveScopedSetting`, `resolveScopedSettingValues` and
 *    `resolveSearchBudgets`, so a consumer has to name the scope it wants rather than inherit
 *    platform-only by omission. One that deliberately passes `{}` still reads platform-only, which
 *    is the point - some genuinely should.
 *  - `computeCandidateRefs` warns when a scope cannot key a rung the setting declares and the scope
 *    builders always populate (owner, lake - see its `STRUCTURAL_RUNGS`). That is the half a
 *    required parameter cannot reach: #2624 passed a perfectly real scope, just one built by
 *    `scopeForCaller`, which never carries a lakeId, so the declared Lake rung resolved nothing and
 *    nothing said so.
 *
 * Both bind any consumer that calls the resolver, including one in a private overlay, which is why
 * neither is a second list here. A rung declared on a setting that NOTHING resolves is still not
 * detected, deliberately: #1683 found a repo-wide "every declared setting has a consumer" check
 * false-positives on keys read only by an overlay, and scoped its own guard to one family for that
 * reason.
 */
const VALID_LEVELS = new Set([SettingScopeLevel.Organization, SettingScopeLevel.Owner, SettingScopeLevel.Lake]);

const scopedEntries = Object.entries(settingsMap).filter(
  ([, def]) => (def as { scope?: unknown }).scope !== undefined
) as Array<[string, { scope: { settableAt: readonly SettingScopeLevel[]; clamp?: unknown }; isSensitive?: boolean }]>;

describe('scoped setting metadata invariants', () => {
  it('has at least one scoped setting (the reference budgets), else this guard is vacuous', () => {
    expect(scopedEntries.length).toBeGreaterThan(0);
  });

  it.each(scopedEntries)('%s declares a non-empty settableAt of valid override rungs only', (_key, def) => {
    expect(Array.isArray(def.scope.settableAt)).toBe(true);
    expect(def.scope.settableAt.length).toBeGreaterThan(0);
    for (const level of def.scope.settableAt) {
      // Platform is the base, never an override rung; only org/owner/lake are settable.
      expect(VALID_LEVELS.has(level)).toBe(true);
    }
  });

  it.each(scopedEntries)('%s is not sensitive (scoped overrides are stored plaintext)', (_key, def) => {
    expect(def.isSensitive).not.toBe(true);
  });

  it.each(scopedEntries)('%s clamp, if present, is a function', (_key, def) => {
    if (def.scope.clamp !== undefined) expect(typeof def.scope.clamp).toBe('function');
  });

  it('a lake-settable setting is also owner-settable (owner is the mandatory rung below org)', () => {
    // The epic makes owner a first-class rung; a setting that can be pinned at a lake but not at its
    // owner would be an odd altitude gap. Not a hard requirement of the resolver, but a smell worth
    // catching early while the only scoped settings are the ones we control.
    for (const [key, def] of scopedEntries) {
      if (def.scope.settableAt.includes(SettingScopeLevel.Lake)) {
        expect(def.scope.settableAt, `${key} is lake-settable but not owner-settable`).toContain(
          SettingScopeLevel.Owner
        );
      }
    }
  });
});
