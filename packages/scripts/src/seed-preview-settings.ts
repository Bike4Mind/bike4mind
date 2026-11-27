#!/usr/bin/env tsx

/**
 * Seed a PR preview's admin settings (provider keys, QA toggles) from env vars. Options and the env
 * var -> setting table: ./seedPreviewSettings.ts (or pass --help).
 *
 * Usage (no sst shell or AWS session needed; it talks to the preview's HTTP API):
 *   pnpm --filter @bike4mind/scripts preview:seed-settings --pr 1234 [--only openaiDemoKey,FirecrawlApiKey] [--dry-run]
 */

import { randomBytes } from 'node:crypto';
import {
  formatHelp,
  formatOutcomes,
  parseSeedArgs,
  previewBaseUrl,
  runSeed,
  type SettingsClient,
} from './seedPreviewSettings';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// Preview Mongo has intermittent TLS blips that surface as a 5xx; retry those, not client errors.
async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}: ${errorMessage(text)}`);
      return text ? (JSON.parse(text) as unknown) : null;
    } catch (error) {
      const retryable = !(error instanceof HttpError) || error.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function errorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const message = record.message ?? record.error;
      if (typeof message === 'string') return message.slice(0, 300);
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.slice(0, 300);
}

async function resolveAdminToken(baseUrl: string): Promise<string> {
  const token = process.env.B4M_PREVIEW_ADMIN_TOKEN?.trim();
  if (token) return token;

  const e2eSecret = process.env.E2E_CLEANUP_SECRET?.trim();
  if (!e2eSecret) {
    throw new Error('Set B4M_PREVIEW_ADMIN_TOKEN or E2E_CLEANUP_SECRET in the environment to authenticate.');
  }
  // Emailless and passwordless, holding only settings:manage: nothing to sign in with afterwards,
  // and the -e2e suffix keeps it inside the test cleanup sweep.
  const created = await requestJson(`${baseUrl}/api/test/create-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-e2e-cleanup-secret': e2eSecret },
    body: JSON.stringify({
      username: `qa-settings-seed-${randomBytes(4).toString('hex')}-e2e`,
      name: 'QA settings seed',
      adminPermissions: ['settings:manage'],
      initialCredits: 0,
    }),
  });
  const accessToken = (created as { accessToken?: unknown } | null)?.accessToken;
  if (typeof accessToken !== 'string') throw new Error('/api/test/create-user returned no accessToken.');
  return accessToken;
}

function httpSettingsClient(baseUrl: string, token: string): SettingsClient {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async readStoredValues() {
      const rows = await requestJson(`${baseUrl}/api/settings`, { headers });
      if (!Array.isArray(rows)) throw new Error('GET /api/settings did not return a list.');
      const stored = new Map<string, unknown>();
      for (const row of rows as Array<{ settingName?: unknown; settingValue?: unknown }>) {
        if (typeof row.settingName === 'string') stored.set(row.settingName, row.settingValue);
      }
      return stored;
    },
    async write(settingKey, value) {
      const written = await requestJson(`${baseUrl}/api/settings/update`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ key: settingKey, value }),
      });
      return (written as { settingValue?: unknown } | null)?.settingValue;
    },
  };
}

async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help || !args.stage) {
    console.log(formatHelp());
    return 0;
  }
  const baseUrl = previewBaseUrl(args.stage);
  const client = args.dryRun ? undefined : httpSettingsClient(baseUrl, await resolveAdminToken(baseUrl));
  const outcomes = await runSeed({ env: process.env, only: args.only, dryRun: args.dryRun, force: args.force, client });

  console.log(formatOutcomes(args.stage, outcomes));
  if (args.dryRun) console.log('Dry run: nothing was sent.');
  return outcomes.some(outcome => outcome.status === 'failed') ? 1 : 0;
}

main().then(
  code => process.exit(code),
  (error: unknown) => {
    // Our own messages never carry a secret; a server-side message is redacted inside runSeed.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
