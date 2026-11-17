import { parseArgs } from 'node:util';
import { isMaskedSensitiveSettingValue, maskSensitiveSettingValue } from '@bike4mind/common';

/**
 * Seeds the admin settings a PR preview needs for QA (provider keys plus a few toggles) through the
 * admin `PUT /api/settings/update` route, so every write gets the route's schema validation,
 * at-rest encryption, audit row and cache invalidation. The preview data sync never copies
 * sensitive settings from staging (apps/workers/src/jobs/dataSyncerHandler.ts), which is why a
 * fresh preview has none of these keys.
 *
 * Secret values come only from environment variables and never leave this module except as the
 * request body of that PUT: nothing here prints, logs or persists them.
 */

export const HELP_TEXT = `Seed a PR preview's admin settings (provider API keys and QA toggles) from env vars.

Usage:
  pnpm --filter @bike4mind/scripts preview:seed-settings --pr <N> [options]

Options:
  --pr <N>            Target the pr<N> preview (https://app.pr<N>.preview.bike4mind.com).
  --stage <pr<N>>     Same, by stage name. Only pr<N> stages are accepted; staging and production are refused.
  --only <keys>       Comma-separated setting keys to seed (default: every mapped setting).
  --dry-run           List what would be sent, from the environment alone. No network calls.
  --force             Re-send secrets whose stored last 4 characters already match.
  -h, --help          Show this help.

Auth (env, first one set wins):
  B4M_PREVIEW_ADMIN_TOKEN   A bearer token of an admin on that preview.
  E2E_CLEANUP_SECRET        The preview test-endpoint secret; mints a throwaway emailless
                            settings:manage delegate (username qa-settings-seed-*-e2e) for this run.

Settings (env var -> admin setting; an unset env var is skipped):
${'{MAPPING}'}

Values are never printed. Other Lambda instances cache settings for up to 5 minutes, so a change can
take that long to reach every request.`;

export type SecretSetting = {
  kind: 'secret';
  settingKey: string;
  /** Checked in order; the first non-blank one is used. */
  envVars: readonly string[];
};

export type ToggleSetting = {
  kind: 'toggle';
  settingKey: string;
  value: boolean | string;
};

export type PreviewSetting = SecretSetting | ToggleSetting;

// Every settingKey must be a registered admin setting; secrets must be isSensitive.
// seedPreviewSettings.test.ts checks both against settingsMap.
export const PREVIEW_SETTINGS: readonly PreviewSetting[] = [
  { kind: 'secret', settingKey: 'openaiDemoKey', envVars: ['OPENAI_API_KEY'] },
  { kind: 'secret', settingKey: 'anthropicDemoKey', envVars: ['ANTHROPIC_API_KEY'] },
  { kind: 'secret', settingKey: 'geminiDemoKey', envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  { kind: 'secret', settingKey: 'xaiApiKey', envVars: ['XAI_API_KEY'] },
  { kind: 'secret', settingKey: 'deepseekApiKey', envVars: ['DEEPSEEK_API_KEY'] },
  { kind: 'secret', settingKey: 'moonshotApiKey', envVars: ['MOONSHOT_API_KEY'] },
  { kind: 'secret', settingKey: 'voyageApiKey', envVars: ['VOYAGE_API_KEY'] },
  { kind: 'secret', settingKey: 'bflApiKey', envVars: ['BFL_API_KEY'] },
  { kind: 'secret', settingKey: 'elevenLabsServerApiKey', envVars: ['ELEVENLABS_API_KEY'] },
  { kind: 'secret', settingKey: 'FirecrawlApiKey', envVars: ['FIRECRAWL_API_KEY'] },
  { kind: 'secret', settingKey: 'PerplexityApiKey', envVars: ['PERPLEXITY_API_KEY'] },
  { kind: 'secret', settingKey: 'SerperKey', envVars: ['SERPAPI_API_KEY', 'SERPER_API_KEY'] },
  { kind: 'secret', settingKey: 'OpenWeatherKey', envVars: ['OPENWEATHER_API_KEY'] },
  { kind: 'secret', settingKey: 'WolframAlphaKey', envVars: ['WOLFRAM_ALPHA_APP_ID'] },
  { kind: 'secret', settingKey: 'FmpApiKey', envVars: ['FMP_API_KEY'] },
  { kind: 'toggle', settingKey: 'EnableWeatherService', value: true },
];

// Allowlist, not a denylist: anything that is not exactly pr<N> is refused, so staging (`dev`),
// production and any typo can never be written to.
const PREVIEW_STAGE_PATTERN = /^pr[1-9][0-9]{0,6}$/;

export function resolvePreviewStage(input: { pr?: string; stage?: string }): string {
  if (input.pr !== undefined && input.stage !== undefined) {
    throw new Error('Pass --pr or --stage, not both.');
  }
  const stage = input.pr !== undefined ? `pr${input.pr.trim()}` : input.stage?.trim();
  if (!stage) throw new Error('A target is required: --pr <N> or --stage pr<N>.');
  if (!PREVIEW_STAGE_PATTERN.test(stage)) {
    throw new Error(`Refusing stage "${stage}": only PR preview stages (pr<N>) can be seeded.`);
  }
  return stage;
}

export function previewBaseUrl(stage: string): string {
  return `https://app.${resolvePreviewStage({ stage })}.preview.bike4mind.com`;
}

export type SeedArgs = {
  help: boolean;
  stage?: string;
  only?: readonly string[];
  dryRun: boolean;
  force: boolean;
};

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      pr: { type: 'string' },
      stage: { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { help: true, dryRun: false, force: false };
  return {
    help: false,
    stage: resolvePreviewStage({ pr: values.pr, stage: values.stage }),
    only: values.only === undefined ? undefined : parseOnly(values.only),
    dryRun: values['dry-run'],
    force: values.force,
  };
}

function parseOnly(raw: string): readonly string[] {
  const keys = raw
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);
  const known = new Set(PREVIEW_SETTINGS.map(setting => setting.settingKey));
  const unknown = keys.filter(key => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown --only key(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
  }
  if (keys.length === 0) throw new Error('--only needs at least one setting key.');
  return keys;
}

export function formatHelp(): string {
  const rows = PREVIEW_SETTINGS.map(setting =>
    setting.kind === 'secret'
      ? `  ${setting.envVars.join(' | ').padEnd(40)} -> ${setting.settingKey}`
      : `  ${'(toggle)'.padEnd(40)} -> ${setting.settingKey} = ${String(setting.value)}`
  );
  return HELP_TEXT.replace('{MAPPING}', rows.join('\n'));
}

type Env = Readonly<Record<string, string | undefined>>;

export type PlannedWrite = {
  settingKey: string;
  value: boolean | string;
  /** Where the value came from, for the report: an env var name, or 'toggle'. Never the value. */
  source: string;
  isSecret: boolean;
};

export type PlannedSkip = { settingKey: string; reason: string };

export function planSeed(
  env: Env,
  only?: readonly string[]
): { writes: readonly PlannedWrite[]; skips: readonly PlannedSkip[] } {
  const selected = only ? PREVIEW_SETTINGS.filter(setting => only.includes(setting.settingKey)) : PREVIEW_SETTINGS;
  const writes: PlannedWrite[] = [];
  const skips: PlannedSkip[] = [];
  for (const setting of selected) {
    if (setting.kind === 'toggle') {
      writes.push({ settingKey: setting.settingKey, value: setting.value, source: 'toggle', isSecret: false });
      continue;
    }
    const envVar = setting.envVars.find(name => (env[name] ?? '').trim() !== '');
    if (!envVar) {
      skips.push({ settingKey: setting.settingKey, reason: `not set (${setting.envVars.join(' / ')})` });
      continue;
    }
    // The update route reads a leading run of asterisks as "keep the stored value" and ignores it.
    if (isMaskedSensitiveSettingValue(env[envVar]!.trim())) {
      skips.push({ settingKey: setting.settingKey, reason: `${envVar} holds a masked value, not a key` });
      continue;
    }
    writes.push({ settingKey: setting.settingKey, value: env[envVar]!.trim(), source: envVar, isSecret: true });
  }
  return { writes, skips };
}

/**
 * True when the stored value already matches. A secret reads back only as its mask (last 4 chars, or
 * no characters at all for values of 8 or fewer), so a match there is "same last 4", and a short
 * secret always counts as changed.
 */
export function isUnchanged(write: PlannedWrite, storedValue: unknown): boolean {
  if (write.isSecret && String(write.value).length <= 8) return false;
  return readsBackAs(write, storedValue);
}

/** Whether a value the server returned (masked, for a secret) is what this write sends. */
function readsBackAs(write: PlannedWrite, returnedValue: unknown): boolean {
  if (returnedValue === undefined || returnedValue === null) return false;
  if (!write.isSecret) return String(returnedValue) === String(write.value);
  return returnedValue === maskSensitiveSettingValue(String(write.value));
}

/** Strips every planned secret out of a server message before it reaches the terminal. */
export function redactSecrets(message: string, writes: readonly PlannedWrite[]): string {
  return writes
    .filter(write => write.isSecret)
    .reduce((text, write) => text.split(String(write.value)).join('[redacted]'), message);
}

export type SettingsClient = {
  readStoredValues(): Promise<ReadonlyMap<string, unknown>>;
  write(settingKey: string, value: boolean | string): Promise<unknown>;
};

export type SeedOutcome =
  | { settingKey: string; status: 'set'; source: string }
  | { settingKey: string; status: 'unchanged'; source: string }
  | { settingKey: string; status: 'would-set'; source: string }
  | { settingKey: string; status: 'skipped'; reason: string }
  | { settingKey: string; status: 'failed'; source: string; reason: string };

export async function runSeed(options: {
  env: Env;
  only?: readonly string[];
  dryRun: boolean;
  force: boolean;
  client?: SettingsClient;
}): Promise<readonly SeedOutcome[]> {
  const { writes, skips } = planSeed(options.env, options.only);
  const skipped: SeedOutcome[] = skips.map(skip => ({ ...skip, status: 'skipped' }));
  if (options.dryRun) {
    return [
      ...writes.map(write => ({ settingKey: write.settingKey, status: 'would-set' as const, source: write.source })),
      ...skipped,
    ];
  }
  if (!options.client) throw new Error('A settings client is required outside --dry-run.');
  const client = options.client;
  const stored = writes.length > 0 ? await client.readStoredValues() : new Map<string, unknown>();

  const outcomes: SeedOutcome[] = [];
  for (const write of writes) {
    const { settingKey, source } = write;
    const forced = options.force && write.isSecret;
    if (!forced && isUnchanged(write, stored.get(settingKey))) {
      outcomes.push({ settingKey, status: 'unchanged', source });
      continue;
    }
    try {
      const echoed = await client.write(settingKey, write.value);
      if (!readsBackAs(write, echoed)) {
        outcomes.push({ settingKey, status: 'failed', source, reason: 'the server did not echo the new value back' });
        continue;
      }
      outcomes.push({ settingKey, status: 'set', source });
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error), writes);
      outcomes.push({ settingKey, status: 'failed', source, reason });
    }
  }
  return [...outcomes, ...skipped];
}

export function formatOutcomes(stage: string, outcomes: readonly SeedOutcome[]): string {
  const lines = outcomes.map(outcome => {
    const label = outcome.status.padEnd(9);
    switch (outcome.status) {
      case 'skipped':
        return `  ${label} ${outcome.settingKey}: ${outcome.reason}`;
      case 'failed':
        return `  ${label} ${outcome.settingKey} (from ${outcome.source}): ${outcome.reason}`;
      default:
        return `  ${label} ${outcome.settingKey} (from ${outcome.source})`;
    }
  });
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
  return [`Admin settings on ${stage}:`, ...lines, `Summary: ${summary || 'nothing to do'}`].join('\n');
}
