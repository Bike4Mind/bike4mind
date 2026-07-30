import { describe, it, expect, afterEach } from 'vitest';
import { useDataLakeWizardStore } from './useDataLakeWizardStore';
import type { WizardFile } from '../utils/folderTreeParser';

/**
 * Opening the wizard must start a genuinely clean create session - no config, tag prefix,
 * file, or opt-in choice from a prior session leaks into the next one.
 */

const staleFile = (): WizardFile => ({
  file: new File(['x'], 'a.txt', { type: 'text/plain' }),
  relativePath: 'old/a.txt',
  size: 1,
  type: 'text/plain',
  excluded: false,
  isDuplicate: false,
});

const seedStaleSession = () =>
  useDataLakeWizardStore.setState({
    allFiles: [staleFile()],
    optionalSteps: { preview: true, taxonomy: true },
    config: {
      name: 'Old Lake',
      description: 'old',
      tagPrefix: 'old:',
      requiredUserTag: 'x',
      requiredEntitlement: 'y',
      conflictResolution: 'skip',
    },
  });

describe('useDataLakeWizardStore - open starts a clean session', () => {
  afterEach(() => useDataLakeWizardStore.getState().resetWizard());

  it('openWizard clears a prior session (no config/prefix/files leak)', () => {
    seedStaleSession();

    useDataLakeWizardStore.getState().openWizard();

    const s = useDataLakeWizardStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.step).toBe('source');
    expect(s.targetLake).toBeNull();
    expect(s.allFiles).toEqual([]);
    expect(s.config.name).toBe('');
    expect(s.config.tagPrefix).toBe('');
    // Opt-ins are per-session: a prior session's choices must not silently re-expand the flow.
    expect(s.optionalSteps).toEqual({ preview: false, taxonomy: false });
  });

  it('openWizardForLake clears a prior session and preseeds config from the lake only', () => {
    seedStaleSession();

    useDataLakeWizardStore.getState().openWizardForLake({
      id: 'l1',
      slug: 'niche',
      name: 'Niche',
      fileTagPrefix: 'niche:',
    });

    const s = useDataLakeWizardStore.getState();
    expect(s.targetLake?.id).toBe('l1');
    expect(s.allFiles).toEqual([]);
    expect(s.config.name).toBe('Niche');
    expect(s.config.tagPrefix).toBe('niche:');
    // Stale fields from the prior session don't survive.
    expect(s.config.description).toBe('');
    expect(s.config.requiredUserTag).toBe('');
    expect(s.optionalSteps).toEqual({ preview: false, taxonomy: false });
  });
});

describe('useDataLakeWizardStore - deriveTagPrefixFromName', () => {
  afterEach(() => useDataLakeWizardStore.getState().resetWizard());

  const setName = (name: string) => useDataLakeWizardStore.getState().setConfig({ name });

  it('re-derives after a rename', () => {
    setName('Legal Contracts');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    setName('Medical Records');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('medical-records:');
  });

  it('never clobbers a prefix the user edited by hand', () => {
    setName('Legal Contracts');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();
    useDataLakeWizardStore.getState().setTagPrefix('custom:');

    setName('Medical Records');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('custom:');
  });

  it('never clobbers a hand-typed prefix that happens to match the derived value', () => {
    setName('Legal Contracts');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();
    // Retyping the exact same value the auto-derive produced must still count as "typed by
    // hand" - it must not leave the auto-derive provenance marker set.
    useDataLakeWizardStore.getState().setTagPrefix('legal-contracts:');

    setName('Medical Records');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('legal-contracts:');
  });

  it('refuses to derive into the reserved datalake: namespace', () => {
    // The server rejects it and Start Upload gates on it, so seeding it would block the user
    // over a value they never typed. Leaving it empty keeps the field theirs to fill.
    setName('Datalake');

    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('');
  });

  it('still derives for a name that merely starts with the reserved word', () => {
    setName('Datalake Archive');

    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('datalake-archive:');
  });
});

describe('useDataLakeWizardStore - optional step opt-ins', () => {
  afterEach(() => useDataLakeWizardStore.getState().resetWizard());

  it('toggles one step without disturbing the other', () => {
    useDataLakeWizardStore.getState().setOptionalStep('taxonomy', true);
    expect(useDataLakeWizardStore.getState().optionalSteps).toEqual({ preview: false, taxonomy: true });

    useDataLakeWizardStore.getState().setOptionalStep('preview', true);
    expect(useDataLakeWizardStore.getState().optionalSteps).toEqual({ preview: true, taxonomy: true });

    useDataLakeWizardStore.getState().setOptionalStep('taxonomy', false);
    expect(useDataLakeWizardStore.getState().optionalSteps).toEqual({ preview: true, taxonomy: false });
  });
});
