// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('migrated admin page frames', () => {
  it.each(['Organizations', 'CreditAnalytics', 'AdminSettings', 'SecurityDashboard', 'AuditLog'])(
    'lets the shell frame %s',
    tab => {
      expect(source('./AdminPage.tsx')).toContain(`<TabPanel value={AdminTab.${tab}}>`);
    }
  );

  it('does not apply the page frame or full-height scrolling to nested tab panels', () => {
    const shell = source('./AdminPage.tsx');
    expect(shell).toContain("'& > [role=\"tabpanel\"]': { height: '100%', overflow: 'auto' }");
    expect(shell).toContain('[`& > [role="tabpanel"]:not([${SELF_FRAMED_ATTR}])`]: adminPageFrame');
  });

  it.each(['AdminSettingsTab.tsx', 'CreditAnalysis/index.tsx'])(
    '%s keeps its tabs scrollable without viewport-height inner scrollers',
    path => {
      const page = source(`./${path}`);
      expect(page).toContain('sx={adminTabStrip}');
      expect(page).not.toContain('100vh');
    }
  );
});
