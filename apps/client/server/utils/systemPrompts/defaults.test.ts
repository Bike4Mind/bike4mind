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

  // STEP 1 must distinguish facts you ASSERT from reasoning you DERIVE. The earlier blanket ban
  // ("never answer a specific factual question from memory") also stopped arithmetic, and a
  // resource-sizing question is only answerable BY doing the arithmetic - the worst case scored 0.00
  // on trap_detection because the trap was discoverable only by computing. See the WHY STEP 1
  // DISTINGUISHES block in defaults.ts for the measurements.
  //
  // Keyword assertions, so a reworded regression can still pass - a tripwire against drift, not a
  // proof. The pairing is what matters: the ban must survive AND the derivation licence must be there.
  it('bans asserting external facts from memory while still licensing derivation', () => {
    const content = triage()!.content;
    // the ban is still present, now scoped to asserted facts rather than to any specific question
    expect(content).toMatch(/external FACT/);
    expect(content).toMatch(/from memory or assumption/);
    // ...and derivation is explicitly permitted, or sizing questions get refused instead of computed
    expect(content).toMatch(/reasoning you DERIVE/i);
    expect(content).toMatch(/declining to compute is its own failure/i);
    // the old blanket wording must not come back: it is what suppressed the arithmetic
    expect(content).not.toMatch(/Never answer a specific factual question/i);
  });

  // The derivation licence must NOT become a licence to invent a formulation for a request that
  // supplies nothing to derive from - that regression was measured at -57 composite on the
  // "we have a lot of data, formalize it" case when the licence was granted without this clause.
  it('routes a derivation with missing inputs to naming them, not to assuming them', () => {
    const content = triage()!.content;
    expect(content).toMatch(/name the missing inputs/i);
    expect(content).toMatch(/instead of assuming them/i);
  });

  it('carries no brand prose (the router is brand-independent)', () => {
    process.env.APP_NAME = 'UniqueBrandXYZ';
    expect(triage()!.content).not.toContain('UniqueBrandXYZ');
  });
});
