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
  });
});
