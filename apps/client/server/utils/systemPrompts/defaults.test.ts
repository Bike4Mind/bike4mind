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

  it('is an enabled system-category prompt whose content carries the two ordered steps', () => {
    const p = triage()!;
    expect(p.enabled).toBe(true);
    expect(p.category).toBe('system');
    expect(p.content).toMatch(/STEP 0/);
    expect(p.content).toMatch(/STEP 1/);
    // Step 0 (legitimacy) is load-bearing: it must precede the retrieval step.
    expect(p.content.indexOf('STEP 0')).toBeLessThan(p.content.indexOf('STEP 1'));
  });

  // Guards a deliberate removal, not an oversight - see the WHY THERE IS NO UNDERSPECIFIED STEP block
  // in defaults.ts for the measurements. Re-adding it silently would restore an instruction measured
  // not to fire, which reads as a capability in the admin editor while changing nothing at runtime.
  //
  // A TRIPWIRE AGAINST DRIFT, NOT A PROOF OF ABSENCE. These are keyword assertions, so a sufficiently
  // reworded re-add still passes - "if the request could mean several materially different things,
  // hold off until the user narrows it" trips none of them. It is strictly better than the `/STEP 2/`
  // assertion it replaced, which pinned the step COUNT (failing an unrelated future second step) and
  // caught only a literal revert, but do not read a green run here as proof the step is gone.
  //
  // The patterns are deliberately broad, so legitimate future prompt text can trip them - any sentence
  // using "vague", or "underspecified", which is ABSTENTION_PROMPT's own word for the case this router
  // now leaves to it. If that happens, narrow the offending pattern; do not delete the assertion.
  it('carries no underspecified/withhold-retrieval step under any of its known spellings', () => {
    const content = triage()!.content;
    expect(content).not.toMatch(/UNDERSPECIFIED/i);
    expect(content).not.toMatch(/vague/i);
    expect(content).not.toMatch(/clarifying question/i);
    expect(content).not.toMatch(/withhold/i);
    expect(content).not.toMatch(/hold off on retrieval/i);
    expect(content).not.toMatch(/do NOT search/i);
  });

  it('carries no brand prose (the router is brand-independent)', () => {
    process.env.APP_NAME = 'UniqueBrandXYZ';
    expect(triage()!.content).not.toContain('UniqueBrandXYZ');
  });
});
