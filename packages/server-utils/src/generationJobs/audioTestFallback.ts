import type { ProviderContext, SyncGenerationProvider } from '@bike4mind/utils/generationProviders';

/** The key a keyless stage hands an audio vendor; it routes that vendor's calls to the test provider. */
export const TEST_AUDIO_KEY = 'test-key';

/**
 * Wraps a real audio provider for a stage with the test providers on (ENABLE_TEST_AUDIO_PROVIDER): a call carrying
 * TEST_AUDIO_KEY goes to the test provider, any other key to the real one, so a keyed stage still calls the vendor.
 */
export const withTestAudioFallback = <TRequest>(
  real: SyncGenerationProvider<string, string, TRequest>,
  test: SyncGenerationProvider<string, string, TRequest>
): SyncGenerationProvider<string, string, TRequest> => {
  const pick = (ctx: ProviderContext) => (ctx.apiKey === TEST_AUDIO_KEY ? test : real);
  return {
    ...real,
    generate: (request, inputs, ctx) => pick(ctx).generate(request, inputs, ctx),
    fetchOutput: (output, ctx) => pick(ctx).fetchOutput(output, ctx),
  };
};

/**
 * The key resolver for a stage with the test providers on. A vendor with a usable key gets it. A keyless vendor gets
 * null while another of `vendors` has a key, so the real fallback (e.g. TTS to ElevenLabs) still runs; only when
 * none has one does it get TEST_AUDIO_KEY.
 */
export const resolveApiKeyOrTest =
  <TVendor extends string>(
    vendors: readonly TVendor[],
    resolveApiKey: (vendor: TVendor, userId: string) => Promise<string | null>
  ) =>
  async (vendor: TVendor, userId: string): Promise<string | null> => {
    const key = await resolveApiKey(vendor, userId);
    if (key) return key;
    const others = await Promise.all(
      vendors.filter(other => other !== vendor).map(other => resolveApiKey(other, userId))
    );
    return others.some(Boolean) ? null : TEST_AUDIO_KEY;
  };
