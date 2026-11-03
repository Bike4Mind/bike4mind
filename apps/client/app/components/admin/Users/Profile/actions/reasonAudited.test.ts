import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// Every profile ActionDialog collects a reason; `reasonAudited` tells the admin whether it is stored.
// A dialog may only mark it unstored (or compute it) while its endpoint has no reason field, and must
// be listed here with why. Wiring the reason through means deleting the prop and its entry.
const UNAUDITED_REASON_EXEMPTIONS: Record<string, string> = {
  'change-role-dialog': 'Only the Super Admin axis has roleChangeReason; a developer-tag-only change has none.',
  'manage-tags-dialog': 'The tags update has no reason field.',
  'product-access-dialog': 'Product access is written as tags, and the tags update has no reason field.',
};

const PROFILE_DIR = resolve(__dirname, '..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });

type DialogUse = { file: string; testId: string | null; reasonAudited: string | null };

// Prettier puts each multi-line JSX attribute list on its own lines and closes it with a bare `>` or `/>`.
const actionDialogUses = (): DialogUse[] =>
  sourceFiles(PROFILE_DIR).flatMap(file =>
    readFileSync(file, 'utf8')
      .split('<ActionDialog')
      .slice(1)
      .map(rest => {
        const attributes = rest.split(/\n\s*\/?>\s*\n/)[0];
        return {
          file: file.slice(PROFILE_DIR.length + 1),
          testId: attributes.match(/data-testid="([^"]+)"/)?.[1] ?? null,
          reasonAudited: attributes.match(/reasonAudited=\{([^}]*)\}/)?.[1] ?? null,
        };
      })
  );

describe('profile ActionDialog reasonAudited', () => {
  const uses = actionDialogUses();

  it('finds the profile dialogs', () => {
    expect(uses.length).toBeGreaterThan(10);
    expect(uses.every(use => use.testId)).toBe(true);
  });

  it('only exempt dialogs mark the reason unstored', () => {
    const offenders = uses
      .filter(use => use.reasonAudited !== null && use.reasonAudited !== 'true')
      .filter(use => !(use.testId! in UNAUDITED_REASON_EXEMPTIONS))
      .map(use => `${use.file}: ${use.testId} sets reasonAudited={${use.reasonAudited}}`);
    expect(offenders).toEqual([]);
  });

  it('has no stale exemptions', () => {
    const unaudited = new Set(uses.filter(use => use.reasonAudited !== null).map(use => use.testId));
    expect(Object.keys(UNAUDITED_REASON_EXEMPTIONS).filter(testId => !unaudited.has(testId))).toEqual([]);
  });
});
