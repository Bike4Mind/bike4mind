import { afterEach, describe, it, expect, vi } from 'vitest';
import { ARTIFACT_EMISSION_PROMPT } from '@bike4mind/common';
import {
  buildArtifactEmissionMessages,
  dataOriginReservedHosts,
  resolveArtifactsEnabled,
  resolveCallableFunctionsSafely,
  withArtifactDataOrigins,
} from './artifactGating';
import { buildTaggedContextMessages } from './systemPromptSources';

describe('resolveArtifactsEnabled', () => {
  it('requires the admin setting: no request flag can turn artifacts back on', () => {
    expect(resolveArtifactsEnabled(false, true)).toBe(false);
    expect(resolveArtifactsEnabled(false, false)).toBe(false);
    expect(resolveArtifactsEnabled(false, undefined)).toBe(false);
  });

  it('honours an explicit opt-out from the caller', () => {
    expect(resolveArtifactsEnabled(true, false)).toBe(false);
  });

  it('leaves the admin setting as the only gate when the caller says nothing', () => {
    // Regression lock: most internal callers never set the flag. Reading absence as "off" would
    // silently strip artifacts from every one of them.
    expect(resolveArtifactsEnabled(true, undefined)).toBe(true);
  });

  it('is on when both agree', () => {
    expect(resolveArtifactsEnabled(true, true)).toBe(true);
  });
});

describe('artifact-emission wiring into the assembled system messages', () => {
  // The gate resolving `false` is only half the fix - the assembly site has to honour it. These go
  // gate -> assembly -> buildTaggedContextMessages so a refactor that drops the conditional shows up
  // here, which a test of resolveArtifactsEnabled alone cannot catch.
  const EMISSION = 'ARTIFACT OUTPUT: wrap large HTML in <artifact> tags';

  const assemble = (adminEnabled: boolean, requestedByCaller: boolean | undefined) =>
    buildTaggedContextMessages({
      dateContext: [{ role: 'system' as const, content: 'Current date: Monday' }],
      artifactEmission: buildArtifactEmissionMessages(
        resolveArtifactsEnabled(adminEnabled, requestedByCaller),
        EMISSION
      ),
    });

  it.each([
    ['admin off, caller opted in', false, true],
    ['admin off, caller silent', false, undefined],
    ['admin on, caller opted out', true, false],
  ] as const)('omits the emission prompt entirely when the gate resolves false (%s)', (_label, admin, caller) => {
    const tagged = assemble(admin, caller);

    expect(tagged.map(t => t.source)).not.toContain('artifactEmission');
    expect(tagged.map(t => t.message.content)).not.toContain(EMISSION);
  });

  // Paired with the absence assertions above so those cannot pass trivially by assembly returning
  // nothing at all.
  it.each([
    ['both agree', true, true],
    ['caller silent, admin on', true, undefined],
  ] as const)('includes the emission prompt when the gate resolves true (%s)', (_label, admin, caller) => {
    const tagged = assemble(admin, caller);

    expect(tagged.map(t => t.source)).toContain('artifactEmission');
    expect(tagged.find(t => t.source === 'artifactEmission')?.message).toEqual({
      role: 'system',
      content: EMISSION,
    });
  });
});

describe('withArtifactDataOrigins', () => {
  const RESERVED = dataOriginReservedHosts({ APP_URL: 'https://app.example.com' });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['unset', undefined],
    ['empty', []],
    ['invalid', ['https://data.example.org', 'http://plain.example.org']],
    ["naming the app's own site", ['https://api.example.com']],
  ])('returns the default prompt byte for byte when the list is %s', (_label, stored) => {
    expect(withArtifactDataOrigins(ARTIFACT_EMISSION_PROMPT, stored, RESERVED)).toBe(ARTIFACT_EMISSION_PROMPT);
  });

  it('reserves the deployment site from SERVER_DOMAIN where APP_URL is not set', () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('CHAT_COMPLETION_PUBLIC_URL', '');
    vi.stubEnv('NEXT_PUBLIC_CDN_URL', '');
    vi.stubEnv('SERVER_DOMAIN', 'example.com');
    expect(withArtifactDataOrigins(ARTIFACT_EMISSION_PROMPT, ['https://api.example.com'])).toBe(
      ARTIFACT_EMISSION_PROMPT
    );
  });

  it('names each listed origin and how to fetch it after the Python section', () => {
    const content = withArtifactDataOrigins(
      ARTIFACT_EMISSION_PROMPT,
      ['https://Data.example.org/', 'https://stats.example.net'],
      RESERVED
    );

    expect(content.startsWith(ARTIFACT_EMISSION_PROMPT)).toBe(true);
    const note = content.slice(ARTIFACT_EMISSION_PROMPT.length);
    expect(note).toMatch(/^\n\nPYTHON DATA ORIGINS: /);
    expect(note).toContain('https://data.example.org, https://stats.example.net');
    expect(note).toContain('pyodide.http import pyfetch');
    expect(note).toContain('pyodide.http import open_url');
    expect(note).toContain('Every other address is blocked');
  });
});

describe('resolveCallableFunctionsSafely', () => {
  const logger = { warn: vi.fn() };

  afterEach(() => {
    logger.warn.mockReset();
  });

  it('is off when the host gives no resolver', async () => {
    await expect(resolveCallableFunctionsSafely(undefined, logger)).resolves.toBe(false);
  });

  it('answers with the resolver', async () => {
    await expect(resolveCallableFunctionsSafely(async () => true, logger)).resolves.toBe(true);
    await expect(resolveCallableFunctionsSafely(async () => false, logger)).resolves.toBe(false);
  });

  it('is off and logs when the setting cannot be read, so the turn goes on', async () => {
    const error = new Error('settings unavailable');
    await expect(resolveCallableFunctionsSafely(() => Promise.reject(error), logger)).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'), error);
  });
});
