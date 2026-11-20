// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveServerConsent } from './serverConsent';

const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });

const APP = 'b4m_consent';
const SHARED = 'b4m-consent-decision';

describe('resolveServerConsent', () => {
  // The app cookie is the whole point of the gate: this origin's banner records its decision in
  // localStorage, which no request handler can read, so the banner publishes the resolution it
  // reached into this cookie. Without it an in-app Accept is invisible here and every
  // app-direct signup is suppressed - which is what the first round of this gate did.
  it("grants on this origin's own published decision, with no marketing cookie present", () => {
    expect(resolveServerConsent(req(`${APP}=granted`))).toBe('granted');
  });

  it('grants on the marketing decision when this origin has published none', () => {
    expect(resolveServerConsent(req(`${SHARED}=granted`))).toBe('granted');
    expect(resolveServerConsent(req(`a=1; ${SHARED}=granted; b=2`))).toBe('granted');
  });

  // Precedence, both directions. It mirrors resolveConsent (readStoredConsent ?? readSharedConsent)
  // so signup and checkout cannot disagree about the same visitor.
  it('prefers this origin when the two disagree', () => {
    expect(resolveServerConsent(req(`${APP}=denied; ${SHARED}=granted`))).toBe('suppressed');
    expect(resolveServerConsent(req(`${APP}=granted; ${SHARED}=denied`))).toBe('granted');
  });

  // Not a decision, so it is not read as a denial either: it falls through, exactly as
  // readStoredConsent returning null does in the browser.
  it.each([
    ['empty', `${APP}=; ${SHARED}=granted`],
    ['unrecognised', `${APP}=yes; ${SHARED}=granted`],
    ['case-mismatched', `${APP}=GRANTED; ${SHARED}=granted`],
  ])('falls through to the marketing decision when this origin published something %s', (_l, c) => {
    expect(resolveServerConsent(req(c))).toBe('granted');
  });

  // Fail closed. `absent` is not a corner case: a visitor who has loaded neither the app nor the
  // marketing site's banner carries no decision at all, and is not attributed.
  it.each([
    ['denied on both', `${APP}=denied; ${SHARED}=denied`],
    ['denied here, nothing shared', `${APP}=denied`],
    ['absent', 'b4m_utm=%7B%22source%22%3A%22widgets%22%7D'],
    ['empty at both levels', `${APP}=; ${SHARED}=`],
    ['unrecognised at both levels', `${APP}=yes; ${SHARED}=maybe`],
    ['case-mismatched at both levels', `${APP}=GRANTED; ${SHARED}=GRANTED`],
    ['no cookie header at all', undefined],
  ])('suppresses when the decision is %s', (_label, cookie) => {
    expect(resolveServerConsent(req(cookie))).toBe('suppressed');
  });

  it('does not infer a grant from the region cookie', () => {
    // The region is a default the BROWSER applies and then publishes the result of. The server
    // never applies it itself: a bare region cookie is not a decision anyone made.
    expect(resolveServerConsent(req('b4m-region=row'))).toBe('suppressed');
  });

  it.each([
    ['the app cookie', `x-${APP}=granted`],
    ['the marketing cookie', `x-${SHARED}=granted`],
  ])('is not fooled by a cookie whose name merely ends with %s', (_label, cookie) => {
    expect(resolveServerConsent(req(cookie))).toBe('suppressed');
  });
});
