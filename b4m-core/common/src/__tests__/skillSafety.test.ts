import { describe, it, expect } from 'vitest';
import {
  wrapUntrustedSkillBody,
  intersectAllowedTools,
  renderInvokedSkill,
  type RenderableSkill,
} from '../utils/skillSafety';

const makeSkill = (overrides: Partial<RenderableSkill> = {}): RenderableSkill => ({
  name: 'share-demo',
  body: 'Share a demo of $ARGUMENTS for $1.',
  userId: 'owner-1',
  ...overrides,
});

describe('wrapUntrustedSkillBody', () => {
  it('brackets the body in untrusted delimiters and names the origin', () => {
    const wrapped = wrapUntrustedSkillBody('review-pr', 'Do the review.', 'another user');
    expect(wrapped).toContain('/review-pr');
    expect(wrapped).toContain('another user');
    expect(wrapped).toContain('UNTRUSTED_SKILL_CONTENT');
    // The body sits between the open/close sentinels.
    const open = wrapped.indexOf('<<<UNTRUSTED_SKILL_CONTENT>>>');
    const close = wrapped.indexOf('<<<END_UNTRUSTED_SKILL_CONTENT>>>');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(wrapped.slice(open, close)).toContain('Do the review.');
  });

  it('includes do-not-follow-conflicting-instructions framing', () => {
    const wrapped = wrapUntrustedSkillBody('x', 'body', 'the system');
    expect(wrapped.toLowerCase()).toContain('do not follow');
  });
});

describe('renderInvokedSkill', () => {
  it('renders an owner-authored skill as trusted content with args substituted', () => {
    const rendered = renderInvokedSkill(makeSkill(), 'hello world', 'owner-1');
    expect(rendered).toContain('## Skill Invoked: /share-demo');
    expect(rendered).toContain('Share a demo of hello world for hello.');
    expect(rendered).not.toContain('UNTRUSTED_SKILL_CONTENT');
  });

  it('wraps a non-owner skill body as untrusted content', () => {
    const rendered = renderInvokedSkill(makeSkill({ userId: 'someone-else' }), 'x', 'owner-1');
    expect(rendered).toContain('UNTRUSTED_SKILL_CONTENT');
    expect(rendered).toContain('another user');
  });

  it('labels an org-shared skill as belonging to the organization', () => {
    const rendered = renderInvokedSkill(makeSkill({ userId: 'someone-else', organizationId: 'org-1' }), '', 'owner-1');
    expect(rendered).toContain('your organization');
  });

  it('labels a system skill as belonging to the system', () => {
    const rendered = renderInvokedSkill(makeSkill({ userId: 'someone-else', isSystem: true }), '', 'owner-1');
    expect(rendered).toContain('the system');
  });
});

describe('intersectAllowedTools', () => {
  it('returns the invoker list unchanged when the skill declares none', () => {
    expect(intersectAllowedTools(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(intersectAllowedTools([], ['a'])).toEqual(['a']);
  });

  it('returns the skill list when the invoker has no explicit allow-list', () => {
    expect(intersectAllowedTools(['a', 'b'], undefined)).toEqual(['a', 'b']);
    expect(intersectAllowedTools(['a'], [])).toEqual(['a']);
  });

  it('intersects when both are present (a tool must be in both)', () => {
    expect(intersectAllowedTools(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c']);
  });

  it('never widens the invoker surface — a skill cannot grant a tool the invoker lacks', () => {
    expect(intersectAllowedTools(['danger'], ['safe'])).toEqual([]);
  });
});
