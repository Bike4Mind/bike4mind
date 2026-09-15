import * as auth from '.';

describe('@bike4mind/auth public exports', () => {
  it.each(['AuthTokenGeneratorService', 'apiKeyService', 'mfaService', 'safeCompareTokens'])('exports %s', sym => {
    expect((auth as Record<string, unknown>)[sym]).toBeDefined();
  });
});
