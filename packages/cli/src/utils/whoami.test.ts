import { describe, expect, it } from 'vitest';
import { SIGN_IN_HINT } from '../bootstrap/signedOutLocal.js';
import { whoamiReport } from './whoami.js';

const now = new Date('2026-11-05T12:00:00.000Z');
const tokens = (expiresAt: string) => ({ userId: 'u1', expiresAt });

describe('whoamiReport', () => {
  it('says a signed-out local session is signed out even when a sign-in has since been saved', () => {
    const report = whoamiReport(tokens('2026-11-06T00:00:00.000Z'), { signedOutLocal: true }, now);

    expect(report).toBe(`This session is local and signed out. ${SIGN_IN_HINT}`);
  });

  it('reports the signed-in user as authenticated', () => {
    const report = whoamiReport(tokens('2026-11-06T00:00:00.000Z'), { signedOutLocal: false }, now);

    expect(report).toContain('User ID: u1');
    expect(report).toContain('Authenticated');
  });

  it('reports an expired token', () => {
    expect(whoamiReport(tokens('2026-11-05T11:00:00.000Z'), { signedOutLocal: false }, now)).toContain('Token expired');
  });

  it('says how to log in when there is no sign-in', () => {
    expect(whoamiReport(null, { signedOutLocal: false }, now)).toBe('Not authenticated. Run /login to authenticate.');
  });
});
