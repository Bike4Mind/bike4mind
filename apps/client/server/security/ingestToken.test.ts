import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const sst = vi.hoisted(() => ({ simulationToken: undefined as string | undefined }));
vi.mock('sst', () => ({
  Resource: {
    get SECOPS_ATTACK_SIMULATION_INGEST_TOKEN() {
      return sst.simulationToken === undefined ? undefined : { value: sst.simulationToken };
    },
  },
}));

import { ATTACK_SIMULATION_HEADER, INGEST_TOKEN_REFUSED_MESSAGE, verifyIngestToken } from './ingestToken';

const HEADER = 'x-security-ingest-token';
const EXPECTED = 'expected-ingest-token';

const SIMULATION_TOKEN = 'simulation-ingest-token';

const request = (headers: Record<string, string | string[] | undefined>) => {
  const warn = vi.fn();
  const info = vi.fn();
  return { req: { headers, logger: { warn, info } } as unknown as Request, warn, info };
};

afterEach(() => {
  sst.simulationToken = undefined;
});

describe('verifyIngestToken', () => {
  it('accepts the expected token without logging', () => {
    const { req, warn } = request({ [HEADER]: EXPECTED });
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the first value of a repeated header', () => {
    const { req } = request({ [HEADER]: [EXPECTED, 'other'] });
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(true);
  });

  it('refuses a wrong token and logs the refusal without the token', () => {
    const { req, warn } = request({ [HEADER]: 'guessed-token' });
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(false);
    expect(warn).toHaveBeenCalledWith(INGEST_TOKEN_REFUSED_MESSAGE, { header: HEADER, tokenPresent: true });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('guessed-token');
  });

  it('refuses and logs a missing token', () => {
    const { req, warn } = request({});
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(false);
    expect(warn).toHaveBeenCalledWith(INGEST_TOKEN_REFUSED_MESSAGE, { header: HEADER, tokenPresent: false });
  });

  it("does not count the attack simulation's deliberate refusals, and still refuses them", () => {
    sst.simulationToken = SIMULATION_TOKEN;
    const { req, warn, info } = request({ [HEADER]: 'wrong', [ATTACK_SIMULATION_HEADER]: SIMULATION_TOKEN });
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls)).not.toContain(INGEST_TOKEN_REFUSED_MESSAGE);
  });

  it('counts a refusal whose simulation marker does not carry the simulation secret', () => {
    sst.simulationToken = SIMULATION_TOKEN;
    const { req, warn } = request({ [HEADER]: 'wrong', [ATTACK_SIMULATION_HEADER]: 'forged' });
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(false);
    expect(warn).toHaveBeenCalledWith(INGEST_TOKEN_REFUSED_MESSAGE, { header: HEADER, tokenPresent: true });
  });

  it('counts a refusal carrying the marker when no simulation secret is configured', () => {
    sst.simulationToken = 'not-configured';
    const { req, warn } = request({ [ATTACK_SIMULATION_HEADER]: 'not-configured' });
    expect(verifyIngestToken(req, HEADER, EXPECTED)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the message the API probe detector counts', () => {
    expect(INGEST_TOKEN_REFUSED_MESSAGE).toBe('[ingest-token-refused]');
  });
});
