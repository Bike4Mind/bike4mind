import { describe, expect, it } from 'vitest';
import { resolveServerConsent } from './serverConsent';

const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });

describe('resolveServerConsent', () => {
  it('grants only on an explicit granted decision', () => {
    expect(resolveServerConsent(req('b4m-consent-decision=granted'))).toBe('granted');
    expect(resolveServerConsent(req('a=1; b4m-consent-decision=granted; b=2'))).toBe('granted');
  });

  // Fail closed. `absent` is not a corner case: the marketing site publishes the decision cookie
  // only when a visitor actually decides, so a visitor who never opened the banner has none -
  // including every `row` visitor the browser auto-granted. Those signups go unattributed here,
  // which is the direction a consent gate should be wrong in.
  it.each([
    ['denied', 'b4m-consent-decision=denied'],
    ['absent', 'b4m_utm=%7B%22source%22%3A%22widgets%22%7D'],
    ['empty', 'b4m-consent-decision='],
    ['unrecognised', 'b4m-consent-decision=yes'],
    ['case-mismatched', 'b4m-consent-decision=GRANTED'],
    ['no cookie header at all', undefined],
  ])('suppresses when the decision is %s', (_label, cookie) => {
    expect(resolveServerConsent(req(cookie))).toBe('suppressed');
  });

  it('does not infer a grant from the region cookie', () => {
    // The browser treats `row` as an implicit grant; the server deliberately does not, because it
    // cannot see this origin's localStorage decision and would be inferring consent from a cookie
    // the visitor never answered.
    expect(resolveServerConsent(req('b4m-region=row'))).toBe('suppressed');
  });

  it('is not fooled by a cookie whose name merely ends with the decision cookie name', () => {
    expect(resolveServerConsent(req('x-b4m-consent-decision=granted'))).toBe('suppressed');
  });
});
