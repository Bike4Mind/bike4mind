import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Regression guard: SessionMiddle is the only caller of useSessionReconnectProbe, and dropping
// the call silently stops re-hydrating an in-flight run after a reload. A full SessionMiddle
// render needs a large web of providers, so this is source-level (mirrors
// SessionBottom/SessionBottom.dedup.test.ts). The two-space indent pins the call to the
// component's top level, outside any render branch.
describe('SessionMiddle - mount-time reconnect probe', () => {
  const source = readFileSync(resolve(__dirname, 'SessionMiddle.tsx'), 'utf8');

  it('calls useSessionReconnectProbe(sessionId) unconditionally at the top level', () => {
    expect(source).toMatch(/^ {2}useSessionReconnectProbe\(sessionId\);$/m);
  });
});
