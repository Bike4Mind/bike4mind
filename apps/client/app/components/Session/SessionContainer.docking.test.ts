// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// These parent components pull in the entire admin/session provider trees. Pin the
// two upstream connections here; the window and controls test the menu behavior.
describe('admin chat docking restriction reaches the floating window', () => {
  it('opts the admin session out of docking', () => {
    const source = readFileSync(resolve(__dirname, '../admin/AdminPage.tsx'), 'utf8');
    const sessionTags = source.match(/<SessionContainer\b[^>]*\/>/g);

    expect(sessionTags).toHaveLength(1);
    expect(sessionTags?.[0]).toMatch(/\bfloatingChatDockable=\{false\}/);
  });

  it('forwards the host restriction to the floating window', () => {
    const source = readFileSync(resolve(__dirname, 'SessionContainer.tsx'), 'utf8');
    const windowTags = source.match(/<FloatingChatWindow\b[^>]*>/g);

    expect(windowTags).toHaveLength(1);
    expect(windowTags?.[0]).toMatch(/\bdockable=\{floatingChatDockable\}/);
  });
});
