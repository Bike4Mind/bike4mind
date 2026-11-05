import { CuratedCatalogSchema, type HubManifestInput } from '../schemas/modelHub';
import { HubManifestV3Schema, type HubManifestV3Input } from '../schemas/modelHubV3';

type EntryV3Input = HubManifestV3Input['entries'][number];
type BuildV3Input = EntryV3Input['builds'][number];
type EntryV2Input = HubManifestInput['entries'][number];
type BuildV2Input = EntryV2Input['builds'][number];

function v2Build({ license, profiles, ...build }: BuildV3Input): BuildV2Input {
  return build;
}

// Spreading keeps the v3 key order, so a v3 list written in v2's order converts to the same bytes.
function v2Entry({ modality, builds: all, ...header }: EntryV3Input, builds: BuildV3Input[]): EntryV2Input {
  const { label, ...license } = header.license;
  return {
    ...header,
    license,
    capabilities: { ...header.capabilities, embeddings: false },
    builds: builds.map(v2Build),
  };
}

// The keys of `input` the v2 schema kept in `parsed`, so stray keys drop and defaults the input left out stay out.
function onlyKnown(input: unknown, parsed: unknown): unknown {
  if (Array.isArray(input) && Array.isArray(parsed)) return input.map((item, i) => onlyKnown(item, parsed[i]));
  if (!isRecord(input) || !isRecord(parsed)) return input;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => Object.hasOwn(parsed, key))
      .map(([key, value]) => [key, onlyKnown(value, parsed[key])])
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function lookup<T>(map: ReadonlyMap<string, T>, id: string, what: string): T {
  const found = map.get(id);
  if (found === undefined) throw new Error(`v2Channel names ${what} ${id}, which the v3 list does not have`);
  return found;
}

/**
 * The curated-v2 list the v3 list's `v2Channel` describes, for clients that read only v2. Works on the authored
 * input so defaults a v2 list leaves out stay out; throws when either list is invalid.
 */
export function curatedV2FromV3(input: HubManifestV3Input): HubManifestInput {
  HubManifestV3Schema.parse(input);
  const channel = input.v2Channel;
  if (!channel) throw new Error('the v3 list has no v2Channel');
  const entriesById = new Map(input.entries.map(entry => [entry.id, entry]));
  const entries = channel.entries.map(({ entry: id, builds }) => {
    const entry = lookup(entriesById, id, 'entry');
    const buildsById = new Map(entry.builds.map(build => [build.id, build]));
    return v2Entry(
      entry,
      builds.map(buildId => lookup(buildsById, buildId, `${id} build`))
    );
  });
  const used = new Set(entries.map(entry => entry.family));
  const manifest: HubManifestInput = {
    schemaVersion: 2,
    sequence: channel.sequence,
    updatedAt: channel.updatedAt,
    ...(input.notesUrl === undefined ? {} : { notesUrl: input.notesUrl }),
    changelog: channel.changelog,
    ...(input.revokedKeyIds === undefined ? {} : { revokedKeyIds: input.revokedKeyIds }),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    families: Object.fromEntries(Object.entries(input.families).filter(([key]) => used.has(key))),
    rankings: channel.rankings,
    tiers: channel.tiers,
    entries,
  };
  // The v2 schema strips unknown keys on parse; the pruned input is valid because pruning only drops those.
  return onlyKnown(manifest, CuratedCatalogSchema.parse(manifest)) as HubManifestInput;
}
