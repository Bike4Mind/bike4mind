import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_HISTORY_STEPS } from './steps';
import transcript from './transcript.json';

// The draft validator treats any anchor a shipped module uses as known, so only this ties the walk to the
// client: a renamed testid or label would otherwise drop the ring or the dock clearance with every test green.
const repoRoot = path.resolve(__dirname, '../../../../../..');
const CLIENT_APP = 'apps/client/app';

function clientHas(pattern: string): boolean {
  try {
    execFileSync('git', ['grep', '-q', '-E', pattern, '--', CLIENT_APP, ':!*.test.*'], { cwd: repoRoot });
    return true;
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const testIdsOf = (selector: string) => [...selector.matchAll(/\[data-testid="([^"]+)"\]/g)].map(match => match[1]);

const usedTestIds = [
  ...new Set(
    IMPORT_HISTORY_STEPS.flatMap(step => [
      ...(step.anchor ? [step.anchor] : []),
      ...testIdsOf(step.anchorScope ?? ''),
      ...testIdsOf(step.avoid ?? ''),
    ])
  ),
];

describe('the import-history tutorial selectors', () => {
  it('reads every avoid selector as data-testid matches', () => {
    for (const step of IMPORT_HISTORY_STEPS.filter(s => s.avoid)) {
      expect(testIdsOf(step.avoid!), step.id).not.toEqual([]);
    }
  });

  it.each(usedTestIds)('finds testid "%s" in the client', id => {
    expect(clientHas(`data-testid=["']${escape(id)}["']`)).toBe(true);
  });

  // The cards name the importer button by its English label, so a relabel must update them too.
  it('names the importer button by its English label', () => {
    const en = JSON.parse(readFileSync(path.join(repoRoot, CLIENT_APP, 'locales/en.json'), 'utf8')) as {
      importLLMHistory: string;
    };
    const opener = IMPORT_HISTORY_STEPS.find(step => step.anchor === 'settings-import-history-btn')!;
    expect(opener.body).toContain(en.importLLMHistory);
    expect(transcript[0].reply).toContain(en.importLLMHistory);
  });
});
