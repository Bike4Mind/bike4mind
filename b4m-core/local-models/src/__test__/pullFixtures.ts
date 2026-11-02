import { createHash } from 'node:crypto';
import type { HubBuild, HubEntry, HubManifest } from '@bike4mind/common';
import { curatedLibrary, curatedPins, loadCuratedManifest } from '../curated';
import type { HubGgufBuild, HubModelDetail } from '../huggingface';
import type { ModelInspection, OllamaRegistryLayers } from '../types';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const manifest = (): HubManifest => structuredClone(loadCuratedManifest(() => {}));

/** The first bundled entry with a build of the given source, as a fresh copy that tests may change. */
export function curatedPick(kind: 'library' | 'hf'): { entry: HubEntry; build: HubBuild } {
  for (const entry of manifest().entries) {
    const build = entry.builds.find(candidate => (kind === 'library' ? curatedLibrary(candidate) : candidate.hf));
    if (build) return { entry, build };
  }
  throw new Error(`the bundled list has no ${kind} build`);
}

const weightsOf = (build: HubBuild) => curatedLibrary(build)?.digest ?? build.weights[0].sha256;

export function servedLayers(build: HubBuild): OllamaRegistryLayers {
  const pins = curatedPins(build);
  return {
    model: weightsOf(build),
    others: (['template', 'params', 'license', 'projector', 'draft'] as const).flatMap(kind => {
      const digest = pins?.[kind];
      return digest ? [{ mediaType: `application/vnd.ollama.image.${kind}`, digest }] : [];
    }),
  };
}

/** Pins the build's template and license to known texts, then reports an install whose contents match them. */
export function installedAs(build: HubBuild): ModelInspection {
  const pins = curatedPins(build);
  if (!pins) throw new Error('expected a pinned build');
  const template = '{{ .Prompt }}';
  const license = 'A license text';
  if (pins.installedTemplate) pins.installedTemplate = sha256(template);
  else if (pins.template) pins.template = sha256(template);
  if (pins.license) pins.license = sha256(license);
  return {
    model: {
      name: 'fixture',
      sizeBytes: null,
      quantization: null,
      family: null,
      parameterSize: null,
      modifiedAt: null,
      capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
    },
    arch: null,
    tensorStats: null,
    parameters: pins.numCtx ? `num_ctx ${pins.numCtx}` : null,
    contents: {
      template: pins.installedTemplate || pins.template ? template : null,
      license: pins.license ? license : null,
      modelBlob: weightsOf(build),
      projectorBlobs: pins.projector ? [pins.projector] : [],
      draftBlobs: pins.draft ? [pins.draft] : [],
    },
  };
}

export function hubBuild(overrides: Partial<HubGgufBuild> = {}): HubGgufBuild {
  return {
    id: 'model-Q4_K_M',
    quant: 'Q4_K_M',
    label: 'Q4_K_M',
    files: [{ path: 'model-Q4_K_M.gguf', sizeBytes: 1024, sha256: 'a'.repeat(64), url: 'https://example.test/f' }],
    sizeBytes: 1024,
    split: false,
    complete: true,
    ollamaRef: 'hf.co/org/repo:Q4_K_M',
    ollamaRefIssue: null,
    ...overrides,
  };
}

export function hubDetail(overrides: Partial<HubModelDetail> = {}): HubModelDetail {
  return {
    id: 'org/repo',
    author: 'org',
    downloads: null,
    likes: null,
    updatedAt: null,
    pipelineTag: null,
    gated: false,
    private: false,
    licenses: ['apache-2.0'],
    baseModels: [],
    tags: [],
    revision: 'rev1',
    licenseName: null,
    licenseLink: null,
    gguf: null,
    builds: [hubBuild()],
    projectors: [],
    canDownload: true,
    ollamaNeedsSshKey: false,
    ...overrides,
  };
}

/** The Hub's view of a curated Hugging Face build, matching its pins. */
export function curatedHubDetail(entry: HubEntry, build: HubBuild): HubModelDetail {
  const file = build.weights[0];
  const id = file.path.replace(/\.gguf$/i, '');
  return hubDetail({
    id: build.hf?.repo ?? '',
    licenses: [entry.license.cardTag ?? entry.license.id],
    builds: [
      hubBuild({
        id,
        quant: build.quant.label,
        label: build.quant.label,
        files: [{ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256, url: 'https://example.test/f' }],
        sizeBytes: file.sizeBytes,
      }),
    ],
  });
}
