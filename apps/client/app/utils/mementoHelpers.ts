import { IMemento, MementoTier } from '@bike4mind/common';

/**
 * Returns the total number of characters across summary, fullContent and tags array.
 */
export const calculateMemoryUsage = (mementos: IMemento[]): number => {
  return mementos.reduce((total, memento) => {
    const tagChars = memento.tags ? memento.tags.join('').length : 0;
    return total + memento.summary.length + memento.fullContent.length + tagChars;
  }, 0);
};

/**
 * Returns the character usage for a single tier.
 */
export const calculateTierMemoryUsage = (mementos: IMemento[], tier: MementoTier): number => {
  return mementos
    .filter(m => m.tier === tier)
    .reduce((total, m) => {
      const tagChars = m.tags ? m.tags.join('').length : 0;
      return total + m.summary.length + m.fullContent.length + tagChars;
    }, 0);
};

/**
 * Converts a list of mementos to CSV string (including header row).
 */
export const buildMementosCSV = (mementos: IMemento[]): string => {
  const headers = ['Type', 'Tier', 'Weight', 'Summary', 'Full Content', 'Last Accessed', 'Tags', 'Embedding'];

  const lines = mementos.map(m =>
    [
      m.type,
      m.tier,
      m.weight,
      `"${m.summary.replace(/"/g, '""')}"`,
      `"${m.fullContent.replace(/"/g, '""')}"`,
      new Date(m.lastAccessedAt).toISOString(),
      `"${(m.tags ?? []).join(';')}"`,
      `"${(m.embedding ?? []).join(';')}"`,
    ].join(',')
  );

  return [headers.join(','), ...lines].join('\n');
};

/**
 * Returns a new tag array with `tagToRemove` omitted (case-sensitive).
 */
export const removeTag = (tags: string[], tagToRemove: string): string[] => {
  return tags.filter(t => t !== tagToRemove);
};
