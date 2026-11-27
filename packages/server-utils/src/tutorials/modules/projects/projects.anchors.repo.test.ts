import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECTS_STEPS } from './steps';

// The draft validator treats any anchor a shipped module uses as known, so only this ties the walk to the
// client: a renamed testid would otherwise drop the ring and the dock clearance with every test still green.
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
  ...new Set(PROJECTS_STEPS.flatMap(step => [...(step.anchor ? [step.anchor] : []), ...testIdsOf(step.avoid ?? '')])),
];

describe('the projects tutorial selectors', () => {
  it('reads every avoid selector as data-testid matches', () => {
    for (const step of PROJECTS_STEPS.filter(s => s.avoid)) expect(testIdsOf(step.avoid!), step.id).not.toEqual([]);
  });

  // A quoted literal outside tests: some components take the id as a prop default (testId = 'new-project-btn').
  it.each(usedTestIds.filter(id => id !== 'sidenav-nav-projects'))('finds testid "%s" in the client', id => {
    expect(clientHas(`["']${escape(id)}["']`)).toBe(true);
  });

  // Built from a template in SidenavNav.tsx, so it never appears as a literal. Bracket classes, not backslash
  // escapes: GNU grep reads a backslash-backtick as an anchor, so that pattern never matches on Linux CI.
  it('finds the side menu Projects row the open step points at', () => {
    expect(clientHas('data-testid=[{][`]sidenav-nav-[$][{]item[.]key[}][`][}]')).toBe(true);
    expect(clientHas(`key: ['"]projects['"]`)).toBe(true);
  });
});
