import { createHash } from 'crypto';
import type { HubBuild, HubManifest } from '@bike4mind/common';
import {
  curatedLibrary,
  curatedPins,
  curatedSource,
  type ModelInspection,
  type OllamaRegistryLayers,
} from '@bike4mind/local-models';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const templateOf = (build: HubBuild) => `{{ .Prompt }} for ${curatedSource(build).ollamaRef}`;
const licenseOf = (build: HubBuild) => `License of ${curatedSource(build).ollamaRef}`;
const weightsOf = (build: HubBuild) => curatedLibrary(build)?.digest ?? build.weights[0].sha256;

export const curatedBuilds = (manifest: HubManifest) => manifest.entries.flatMap(entry => entry.builds);

/** Re-pins every build's template and license to known texts, so a fake Ollama can report matching contents. */
export function reviewable(manifest: HubManifest): HubManifest {
  for (const build of curatedBuilds(manifest)) {
    const pins = curatedPins(build);
    if (!pins) continue;
    if (pins.installedTemplate) pins.installedTemplate = sha256(templateOf(build));
    else if (pins.template) pins.template = sha256(templateOf(build));
    if (pins.license) pins.license = sha256(licenseOf(build));
  }
  return manifest;
}

/** The registry layers a curated build serves as reviewed. */
export function reviewedLayers(build: HubBuild): OllamaRegistryLayers {
  const pins = curatedPins(build);
  return {
    model: weightsOf(build),
    others: (['template', 'params', 'license', 'projector', 'draft'] as const).flatMap(kind => {
      const digest = pins?.[kind];
      return digest ? [{ mediaType: `application/vnd.ollama.image.${kind}`, digest }] : [];
    }),
  };
}

/** What Ollama's /api/show reports for a curated build installed as reviewed, from a `reviewable` list. */
export function reviewedInspection(build: HubBuild, name: string): ModelInspection {
  const pins = curatedPins(build);
  return {
    model: {
      name,
      sizeBytes: null,
      quantization: null,
      family: null,
      parameterSize: null,
      modifiedAt: null,
      capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
    },
    arch: null,
    tensorStats: null,
    parameters: pins?.numCtx ? `num_ctx ${pins.numCtx}` : null,
    contents: {
      template: templateOf(build),
      license: pins?.license ? licenseOf(build) : null,
      modelBlob: weightsOf(build),
      projectorBlobs: pins?.projector ? [pins.projector] : [],
      draftBlobs: pins?.draft ? [pins.draft] : [],
    },
  };
}
