import { describe, it, expect, afterEach } from 'vitest';
import { useDataLakeWizardStore } from './useDataLakeWizardStore';
import type { WizardFile } from '../utils/folderTreeParser';

/**
 * Opening the wizard must start a genuinely clean create session. taxonomy.prefix and
 * config.tagPrefix are a synced pair now (the taxonomy step drives the applied tags), so a
 * partial reset that blanked taxonomy but kept a prior config.tagPrefix would upload files
 * with a prefix the user never sees on the review step.
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
    taxonomy: {
      prefix: 'old:',
      suggestedName: 'Old',
      tags: [
        {
          suffix: 'type:x',
          originalName: 'old:type:x',
          strength: 0.9,
          source: 'ai',
          matchingFolders: [],
          deleted: false,
        },
      ],
      fileAssignments: [],
      attempted: true,
      analyzing: false,
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
    // The desync guard: taxonomy.prefix and config.tagPrefix both reset together.
    expect(s.config.tagPrefix).toBe('');
    expect(s.taxonomy.prefix).toBe('');
    expect(s.taxonomy.tags).toEqual([]);
    expect(s.taxonomy.attempted).toBe(false);
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
    expect(s.taxonomy.tags).toEqual([]);
    expect(s.optionalSteps).toEqual({ preview: false, taxonomy: false });
  });
});

describe('useDataLakeWizardStore - prefix stays synced across taxonomy inference', () => {
  afterEach(() => useDataLakeWizardStore.getState().resetWizard());

  const inferenceResult = (prefix: string) => ({
    prefix,
    suggestedName: 'Legal',
    tags: [],
    fileAssignments: [],
    attempted: true,
    analyzing: false,
  });

  it('keeps an already-seeded prefix on BOTH fields when inference suggests a different one', () => {
    // Reachable via source -> Next (derives a prefix) -> Back -> enable AI Taxonomy -> Next.
    // taxonomy.prefix renders the tag cards; config.tagPrefix is what upload applies. Adopting
    // the inferred prefix on only one of them would tag files with a namespace never shown.
    useDataLakeWizardStore.getState().setTagPrefix('legal-contracts:');

    useDataLakeWizardStore.getState().setTaxonomy(inferenceResult('legal:'));

    const s = useDataLakeWizardStore.getState();
    expect(s.taxonomy.prefix).toBe('legal-contracts:');
    expect(s.config.tagPrefix).toBe('legal-contracts:');
  });

  it('adopts the inferred prefix on both fields when nothing was seeded', () => {
    useDataLakeWizardStore.getState().setTaxonomy(inferenceResult('legal:'));

    const s = useDataLakeWizardStore.getState();
    expect(s.taxonomy.prefix).toBe('legal:');
    expect(s.config.tagPrefix).toBe('legal:');
  });
});

describe('useDataLakeWizardStore - deriveTagPrefixFromName', () => {
  afterEach(() => useDataLakeWizardStore.getState().resetWizard());

  const setName = (name: string) => useDataLakeWizardStore.getState().setConfig({ name });

  it('re-derives after a rename, keeping both prefix fields together', () => {
    setName('Legal Contracts');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    setName('Medical Records');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    const s = useDataLakeWizardStore.getState();
    expect(s.config.tagPrefix).toBe('medical-records:');
    expect(s.taxonomy.prefix).toBe('medical-records:');
  });

  it('never clobbers a prefix the user edited by hand', () => {
    setName('Legal Contracts');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();
    useDataLakeWizardStore.getState().setTagPrefix('custom:');

    setName('Medical Records');
    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('custom:');
  });

  const inferPrefix = (prefix: string) =>
    useDataLakeWizardStore.getState().setTaxonomy({
      prefix,
      suggestedName: 'Inferred Name',
      tags: [],
      fileAssignments: [],
      attempted: true,
      analyzing: false,
    });

  it('re-derives over a prefix inference supplied, once the taxonomy step is turned back off', () => {
    // Inference shortens the name its own way (e.g. "pr10:"), so leaving it in place after the
    // step is unticked both quotes a step that no longer runs and lets two unrelated lakes
    // collide on one namespace.
    setName('Untick AI Lake');
    inferPrefix('uai:');
    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('uai:');

    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    const s = useDataLakeWizardStore.getState();
    expect(s.config.tagPrefix).toBe('untick-ai-lake:');
    expect(s.taxonomy.prefix).toBe('untick-ai-lake:');
  });

  it('keeps a prefix the user typed on the taxonomy step after unticking it', () => {
    setName('Untick AI Lake');
    inferPrefix('uai:');
    useDataLakeWizardStore.getState().setTagPrefix('mine:');

    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('mine:');
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

  it('does not treat a suggestion it never adopted as inference-owned', () => {
    // An existing value wins in setTaxonomy, so the rejected suggestion must not become the
    // marker that lets a later derive overwrite the value that did win.
    setName('Untick AI Lake');
    useDataLakeWizardStore.getState().setTagPrefix('mine:');
    inferPrefix('uai:');

    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('mine:');
  });

  it('keeps a typed prefix that inference then echoes back verbatim', () => {
    // The case the guard above actually exists for, and not an exotic one: both the auto-run
    // and Re-analyze thread the user's prefix to the model as existingPrefix, so having the
    // suggestion come back identical is the EXPECTED outcome, not a coincidence. Distinct from
    // the case above, where the suggestion differs and the not-ours branch already covers it.
    setName('Untick AI Lake');
    useDataLakeWizardStore.getState().setTagPrefix('uai:');
    inferPrefix('uai:');

    useDataLakeWizardStore.getState().deriveTagPrefixFromName();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('uai:');
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
