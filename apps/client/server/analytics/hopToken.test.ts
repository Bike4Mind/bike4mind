// @vitest-environment node
import crypto from 'crypto';
import { describe, it, expect, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: {} as Record<string, string | undefined> }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));

import {
  HOP_TOKEN_TTL_SECONDS,
  deriveHopKey,
  hopKey,
  isHopId,
  mintHopId,
  signHopToken,
  verifyHopToken,
} from './hopToken';

const KEY = deriveHopKey('test-salt');
const HOP_ID = 'a'.repeat(32);
const NOW = 1_793_707_200;
const EXP = NOW + HOP_TOKEN_TTL_SECONDS;
const DEST = 'bike4mind';

const token = (over: { hopId?: string; exp?: number; dest?: string; key?: Buffer } = {}) =>
  signHopToken(over.key ?? KEY, { hopId: over.hopId ?? HOP_ID, exp: over.exp ?? EXP, dest: over.dest ?? DEST });

const verify = (t: unknown, over: { dest?: string; nowSeconds?: number; key?: Buffer } = {}) =>
  verifyHopToken(over.key ?? KEY, t, { dest: over.dest ?? DEST, nowSeconds: over.nowSeconds ?? NOW });

describe('hop ids', () => {
  it('mints 32 random hex characters', () => {
    const a = mintHopId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(mintHopId()).not.toBe(a);
    expect(isHopId(a)).toBe(true);
  });

  it('recognises only that shape', () => {
    for (const value of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}g`, 42, undefined]) {
      expect(isHopId(value), String(value)).toBe(false);
    }
  });
});

describe('the hop key', () => {
  it('is derived, never the secret itself, and stable for one secret', () => {
    const key = deriveHopKey('test-salt');
    expect(key.equals(KEY)).toBe(true);
    expect(key.toString('utf8')).not.toContain('test-salt');
    expect(deriveHopKey('other-salt').equals(key)).toBe(false);
  });

  it('is not any pseudonym the same secret produces, even of the label itself', () => {
    // A pseudonym is HMAC(salt, input); the key must not be one for any input.
    for (const input of ['5f1e2d3c4b5a69788796a5b4', 'b4m-hop-token-key/v1']) {
      const pseudonym = crypto.createHmac('sha256', 'test-salt').update(input).digest();
      expect(KEY.equals(pseudonym), input).toBe(false);
    }
  });

  it('is absent when no salt is configured', () => {
    config.OVERWATCH_PSEUDONYM_SALT = undefined;
    expect(hopKey()).toBeUndefined();
    config.OVERWATCH_PSEUDONYM_SALT = 'not-configured';
    expect(hopKey()).toBeUndefined();
    config.OVERWATCH_PSEUDONYM_SALT = 'test-salt';
    expect(hopKey()?.equals(KEY)).toBe(true);
  });
});

describe('hop tokens', () => {
  it('are hopId.exp.mac and verify for the destination they were minted to', () => {
    const t = token();
    expect(t).toMatch(/^[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(t.length).toBe(87);
    expect(verify(t)).toEqual({ ok: true, hopId: HOP_ID, exp: EXP });
  });

  it('stop redeeming at their expiry', () => {
    expect(verify(token(), { nowSeconds: EXP - 1 }).ok).toBe(true);
    expect(verify(token(), { nowSeconds: EXP })).toEqual({ ok: false, reason: 'expired' });
    expect(verify(token(), { nowSeconds: EXP + 3600 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuse a token minted for another destination', () => {
    expect(verify(token({ dest: 'another-product' }))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuse a token signed with another key', () => {
    expect(verify(token({ key: deriveHopKey('other-salt') }))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuse a token whose expiry was pushed out', () => {
    const [hopId, , mac] = token({ exp: NOW - 60 }).split('.');
    expect(verify(`${hopId}.${EXP}.${mac}`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuse a token moved onto another hop id', () => {
    const [, exp, mac] = token().split('.');
    expect(verify(`${'b'.repeat(32)}.${exp}.${mac}`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('check the MAC before the expiry', () => {
    const [hopId, , mac] = token({ exp: NOW - 60 }).split('.');
    expect(verify(`${hopId}.${NOW - 30}.${mac}`).ok).toBe(false);
    expect(verify(`${hopId}.${NOW - 30}.${mac}`)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuse anything not shaped like a token, without throwing', () => {
    const good = token();
    const [hopId, exp, mac] = good.split('.');
    const cases: unknown[] = [
      undefined,
      null,
      42,
      {},
      '',
      `${good}.extra`,
      `${hopId}.${exp}`,
      `${hopId.toUpperCase()}.${exp}.${mac}`,
      `${hopId}.-1.${mac}`,
      `${hopId}.1e9.${mac}`,
      `${hopId}.0${exp}.${mac}`,
      `${hopId}.${exp}.${mac.slice(1)}`,
      `${hopId}.${exp}.${mac}=`,
      `${hopId}.${exp}.${mac.slice(0, 42)}+`,
      'x'.repeat(200),
    ];
    for (const value of cases) {
      expect(verify(value), String(value)).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});
