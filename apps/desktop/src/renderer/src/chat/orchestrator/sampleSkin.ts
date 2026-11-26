import { mapSceneSkinAssets, skinAssetUrl, type SkinSummary, type SkinTokens } from '@shared/mods';
import sampleManifest from '@shared/__fixtures__/skins/nightglass/mod.json';
import sampleTokens from '@shared/__fixtures__/skins/nightglass/tokens.json';

/**
 * The sample skin as main hands it over (main/mods/index.ts): its sprite and sound paths already asset
 * URLs. `toUrl` lets a story point the paths at images it can actually load.
 */
export function sampleSkinSummary(
  toUrl: (path: string) => string = path => skinAssetUrl(sampleManifest.id, path)
): Extract<SkinSummary, { status: 'ok' }> {
  const tokens = sampleTokens as SkinTokens;
  return {
    status: 'ok',
    id: sampleManifest.id,
    name: sampleManifest.name,
    version: sampleManifest.version,
    description: sampleManifest.description,
    tokens: {
      ...tokens,
      scenes: Object.fromEntries(
        Object.entries(tokens.scenes ?? {}).map(([scene, block]) => [scene, mapSceneSkinAssets(block, toUrl)])
      ),
      // `needs-you` is kept, though main drops it, so the palette merge's lock is what tests exercise.
      sounds: Object.fromEntries(
        Object.entries(tokens.sounds ?? {}).map(([event, path]) => [event, path && toUrl(path)])
      ),
    },
  };
}
