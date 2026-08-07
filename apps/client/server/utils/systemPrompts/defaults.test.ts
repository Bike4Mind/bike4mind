import { describe, it, expect, afterEach } from 'vitest';
import { getDefaultSystemPrompts } from './defaults';

describe('getDefaultSystemPrompts - triage_router', () => {
  const origAppName = process.env.APP_NAME;
  afterEach(() => {
    if (origAppName === undefined) delete process.env.APP_NAME;
    else process.env.APP_NAME = origAppName;
  });

  const triage = () => getDefaultSystemPrompts().find(p => p.promptId === 'triage_router');

  it('seeds the triage router with AND without a brand (pure routing logic, unlike the brand identity)', () => {
    delete process.env.APP_NAME; // open-core clone: no brand -> identity is omitted, triage is not
    expect(triage()).toBeDefined();
    expect(getDefaultSystemPrompts().find(p => p.promptId === 'bike4mind_identity')).toBeUndefined();

    process.env.APP_NAME = 'Acme';
    expect(triage()).toBeDefined();
  });

  it('is an enabled system-category prompt whose content carries the three ordered steps', () => {
    const p = triage()!;
    expect(p.enabled).toBe(true);
    expect(p.category).toBe('system');
    expect(p.content).toMatch(/STEP 0/);
    expect(p.content).toMatch(/STEP 1/);
    expect(p.content).toMatch(/STEP 2/);
    // Step 0 (legitimacy) is load-bearing: it must precede the retrieval steps.
    expect(p.content.indexOf('STEP 0')).toBeLessThan(p.content.indexOf('STEP 1'));
    expect(p.content.indexOf('STEP 1')).toBeLessThan(p.content.indexOf('STEP 2'));
  });

  it('carries no brand prose (the router is brand-independent)', () => {
    process.env.APP_NAME = 'UniqueBrandXYZ';
    expect(triage()!.content).not.toContain('UniqueBrandXYZ');
  });
});
