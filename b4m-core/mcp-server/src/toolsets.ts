export const TOOLSETS = {
  about: { description: 'Keyless product information: what Bike4Mind is, public models, release notes.' },
  jobs: { description: 'Wait on or stop long-running work. Always on.' },
} as const;

export type ToolsetId = keyof typeof TOOLSETS;

export const TOOLSET_IDS = Object.keys(TOOLSETS) as ToolsetId[];

export const DEFAULT_TOOLSETS: readonly ToolsetId[] = ['about', 'jobs'];

/** Enabled regardless of what the caller asks for: a client that started a job must always be able to wait on it. */
export const ALWAYS_ON_TOOLSETS: readonly ToolsetId[] = ['jobs'];

export class UnknownToolsetError extends Error {
  constructor(
    readonly invalid: readonly string[],
    readonly valid: readonly string[] = [...TOOLSET_IDS, 'all', 'default']
  ) {
    super(`Unknown toolset(s): ${invalid.join(', ')}. Valid: ${valid.join(', ')}.`);
    this.name = 'UnknownToolsetError';
  }
}

/**
 * Parses `?toolsets=` and `--toolsets`: comma or space separated, case-insensitive, deduped. `all` enables every
 * toolset and `default` the default set; an empty value means `default`. `defaults` is injectable so tests can tell the two apart. Unknown ids throw UnknownToolsetError.
 */
export function parseToolsets(
  raw: string | readonly string[] | undefined,
  defaults: readonly ToolsetId[] = DEFAULT_TOOLSETS
): ReadonlySet<ToolsetId> {
  const text = typeof raw === 'string' ? raw : (raw ?? []).join(',');
  const tokens = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map(t => t.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  const valid = new Set<string>([...TOOLSET_IDS, 'all', 'default']);
  const invalid = tokens.filter(t => !valid.has(t));
  if (invalid.length) throw new UnknownToolsetError(invalid);

  const out = new Set<ToolsetId>(ALWAYS_ON_TOOLSETS);
  if (tokens.length === 0) tokens.push('default');
  for (const token of tokens) {
    if (token === 'all') TOOLSET_IDS.forEach(id => out.add(id));
    else if (token === 'default') defaults.forEach(id => out.add(id));
    else out.add(token as ToolsetId);
  }
  return out;
}
