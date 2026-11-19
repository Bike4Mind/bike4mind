import { describe, it, expect } from 'vitest';
import { ARTIFACT_EMISSION_PROMPT } from '@bike4mind/common';
import { buildArtifactEmissionMessages, resolveArtifactsEnabled, withArtifactDataOrigins } from './artifactGating';
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
  const APP_URL = 'https://app.example.com';

  it.each([
    ['unset', undefined],
    ['empty', []],
    ['invalid', ['https://data.example.org', 'http://plain.example.org']],
    ["naming the app's own site", ['https://api.example.com']],
  ])('returns the default prompt byte for byte when the list is %s', (_label, stored) => {
    expect(withArtifactDataOrigins(ARTIFACT_EMISSION_PROMPT, stored, APP_URL)).toBe(ARTIFACT_EMISSION_PROMPT);
  });

  it('names each listed origin and how to fetch it after the Python section', () => {
    const content = withArtifactDataOrigins(
      ARTIFACT_EMISSION_PROMPT,
      ['https://Data.example.org/', 'https://stats.example.net'],
      APP_URL
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
