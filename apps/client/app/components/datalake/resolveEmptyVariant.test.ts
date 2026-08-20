import { describe, it, expect } from 'vitest';
import { resolveEmptyVariant, type EmptyVariantInputs } from './resolveEmptyVariant';

/** Page mode, lakes read fine, one lake present, something to browse. Cases override one axis. */
const base: EmptyVariantInputs = {
  chatMode: false,
  lakesError: false,
  lakesLoading: false,
  lakeCount: 1,
  manageableLakeCount: 1,
  hasSelectedLake: false,
  isScopeEmpty: false,
};

describe('resolveEmptyVariant', () => {
  it('only claims zero lakes when the read SUCCEEDED and the count really is zero', () => {
    expect(resolveEmptyVariant({ ...base, lakeCount: 0, manageableLakeCount: 0 })).toBe('no-lakes');
  });

  it('still offers first-run create when the only reachable lake is one the caller cannot manage', () => {
    // A built-in fallback lake is listed for everyone, so keying first-run on lakeCount alone would
    // mean the prompt never appears for anyone.
    expect(resolveEmptyVariant({ ...base, lakeCount: 1, manageableLakeCount: 0, isScopeEmpty: true })).toBe('no-lakes');
  });

  it('does not offer first-run create beside a populated tree, even with no lakes of your own', () => {
    expect(resolveEmptyVariant({ ...base, lakeCount: 1, manageableLakeCount: 0, isScopeEmpty: false })).toBe(
      'no-selection'
    );
  });

  it('does not claim zero lakes just because the current scope is empty (#1645)', () => {
    // The regression itself: lakes exist, this view has no files. Before the fix an empty scope
    // rendered the first-run "create your first data lake" prompt.
    expect(resolveEmptyVariant({ ...base, lakeCount: 3, isScopeEmpty: true })).not.toBe('no-lakes');
  });

  it('reports a failed lake-list read as an error, never as zero lakes', () => {
    // The dangerous collapse: a transient error must not read as "you have none", even when the
    // count is 0 (which it always is on a failed read) and the scope is empty.
    expect(
      resolveEmptyVariant({ ...base, lakesError: true, lakeCount: 0, manageableLakeCount: 0, isScopeEmpty: true })
    ).toBe('lakes-error');
  });

  it('keeps the error state even with a lake selected and an empty scope', () => {
    expect(
      resolveEmptyVariant({
        ...base,
        lakesError: true,
        lakeCount: 0,
        manageableLakeCount: 0,
        hasSelectedLake: true,
        isScopeEmpty: true,
      })
    ).toBe('lakes-error');
  });

  it('never flashes the first-run prompt while the lake list is still loading', () => {
    // In flight, so the count is 0 but unknown - the neutral state asserts nothing.
    expect(
      resolveEmptyVariant({ ...base, lakesLoading: true, lakeCount: 0, manageableLakeCount: 0, isScopeEmpty: true })
    ).toBe('no-selection');
  });

  it('prefers the error over the loading state when both are somehow set', () => {
    expect(
      resolveEmptyVariant({ ...base, lakesError: true, lakesLoading: true, lakeCount: 0, manageableLakeCount: 0 })
    ).toBe('lakes-error');
  });

  it('reports an empty SELECTED lake as lake-empty, so the offer is add-files not create-lake', () => {
    expect(resolveEmptyVariant({ ...base, lakeCount: 2, hasSelectedLake: true, isScopeEmpty: true })).toBe(
      'lake-empty'
    );
  });

  it('stays neutral for a selected lake that does have content', () => {
    expect(resolveEmptyVariant({ ...base, hasSelectedLake: true, isScopeEmpty: false })).toBe('no-selection');
  });

  it('says the lakes are empty rather than pointing at a tree branch that does not exist', () => {
    // no-selection reads "pick a branch from the tree", so it may only be used when the tree HAS
    // branches. With lakes present but no files anywhere, there is nothing to point at.
    expect(resolveEmptyVariant({ ...base, lakeCount: 2, hasSelectedLake: false, isScopeEmpty: true })).toBe(
      'all-lakes-empty'
    );
  });

  it('never consults the lake list in chat mode, whatever it says', () => {
    // Chat mode has no rail and no create-first affordance, so every lake signal is irrelevant.
    for (const override of [
      { lakesError: true },
      { lakesLoading: true },
      { lakeCount: 0, manageableLakeCount: 0 },
      { hasSelectedLake: true, isScopeEmpty: true },
    ]) {
      expect(resolveEmptyVariant({ ...base, chatMode: true, ...override })).toBe('no-selection');
    }
  });
});
