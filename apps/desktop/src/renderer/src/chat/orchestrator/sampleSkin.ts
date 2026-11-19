import { skinAssetUrl, type SkinSummary, type SkinTokens } from '@shared/mods';
import sampleManifest from '@shared/__fixtures__/skins/nightglass/mod.json';
import sampleTokens from '@shared/__fixtures__/skins/nightglass/tokens.json';

/** The sample skin as main hands it over: its sprite and sound paths already asset URLs (main/mods/index.ts). */
export function sampleSkinSummary(): Extract<SkinSummary, { status: 'ok' }> {
  const tokens = sampleTokens as SkinTokens;
  const urls = (paths: Record<string, string | undefined> = {}) =>
    Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, path && skinAssetUrl(sampleManifest.id, path)])
    );
  return {
    status: 'ok',
    id: sampleManifest.id,
    name: sampleManifest.name,
    version: sampleManifest.version,
    description: sampleManifest.description,
    tokens: { ...tokens, sprites: urls(tokens.sprites), sounds: urls(tokens.sounds) },
  };
}
