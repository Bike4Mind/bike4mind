/**
 * External skills command (b4m skills push <path> [--publish]).
 * Imports a Claude Code SKILL.md (or commands/*.md) as the user's own
 * Bike4Mind skill, and with --publish lists it on the Skill Market. Runs
 * outside the interactive CLI session. Validation is left to the server
 * (apps/client/server/utils/skillValidation.ts).
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';
import { parseSkillMd, type SkillMdFields } from '@bike4mind/common/utils/skillMd';
import type { PublicSkillListing, PublicSkillListingVersion, SkillMarketSubmitResponse } from '@bike4mind/common';
import { ConfigStore } from '../storage/ConfigStore.js';
import { RemoteSkillSource } from '../storage/RemoteSkillSource.js';
import { ApiClient } from '../auth/ApiClient.js';
import { requireApiUrl } from '../utils/apiUrl.js';
import { isReservedCommandName } from '../config/commands.js';

interface SkillsCommandArgs {
  _: (string | number)[];
  path?: string;
  update?: boolean;
  yes?: boolean;
  publish?: boolean;
  visibility?: MarketVisibility;
  org?: string;
  tags?: string;
  'api-key'?: string;
  [key: string]: unknown;
}

export interface SkillPayload {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  claudeCodeAllowedTools: string[];
  disableModelInvocation: boolean;
}

export interface SkillFile {
  payload: SkillPayload;
  dropped: string[];
  source?: { url: string; thirdParty: boolean };
  /** Other entries in a SKILL.md's folder; empty for a plain .md file. */
  extraFiles: string[];
}

interface SkillRow {
  id: string;
  name: string;
  userId?: string;
  importedFrom?: { listingId: string };
}

export interface PushDeps {
  api: Pick<ApiClient, 'get' | 'post' | 'put' | 'getCurrentUser'>;
  /** Who the skill belongs to. Defaults to the stored login; an API key resolves it via /api/v1/me. */
  whoAmI?: () => Promise<{ id: string } | null>;
  confirm: (question: string) => Promise<boolean>;
  isTTY: boolean;
  update: boolean;
  yes: boolean;
  /** Base URL of the API, used to tell a same-origin source stamp from a foreign one. */
  apiOrigin?: string;
  log: (line: string) => void;
}

export type MarketVisibility = 'organization' | 'public' | 'unlisted';

export type PushResult = { outcome: 'created' | 'updated'; skillId: string } | { outcome: 'aborted' };

const MAX_LISTED_FILES = 10;
// Must stay in sync with SKILL_DESCRIPTION_MAX in apps/client/server/utils/skillValidation.ts.
const DESCRIPTION_MAX = 500;

/** The server requires a description, but many Claude Code commands/*.md files have none. */
function descriptionFor(fields: SkillMdFields): string {
  if (fields.description?.trim()) return fields.description;
  const firstLine = (fields.body ?? '')
    .split('\n')
    .map(line => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return (firstLine ?? '').slice(0, DESCRIPTION_MAX);
}

/**
 * Built from an explicit field list (never a spread of parsed data). The file's
 * allowed-tools goes to claudeCodeAllowedTools, never allowedTools: Claude Code
 * tool names don't map to B4M. claudeCodeAllowedTools and disableModelInvocation
 * are always sent so an update mirrors the file.
 */
export function buildSkillPayload(fields: SkillMdFields, fallbackName: string): SkillPayload {
  return {
    name: (fields.name?.trim() || fallbackName).trim().toLowerCase(),
    description: descriptionFor(fields),
    body: fields.body ?? '',
    ...(fields.argumentHint !== undefined && { argumentHint: fields.argumentHint }),
    claudeCodeAllowedTools: fields.claudeCodeAllowedTools ?? [],
    disableModelInvocation: fields.disableModelInvocation ?? false,
  };
}

/** Resolves <dir>, <dir>/SKILL.md or any .md file and parses it. */
export async function readSkillFile(input: string): Promise<SkillFile> {
  const expanded = input === '~' || input.startsWith('~/') ? path.join(os.homedir(), input.slice(1)) : input;
  const resolved = path.resolve(expanded);

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`No such file or folder: ${input}`);
  }

  let filePath: string;
  let fallbackName: string;
  if (stat.isDirectory()) {
    filePath = path.join(resolved, 'SKILL.md');
    fallbackName = path.basename(resolved);
  } else if (stat.isFile() && resolved.toLowerCase().endsWith('.md')) {
    filePath = resolved;
    fallbackName =
      path.basename(resolved).toLowerCase() === 'skill.md'
        ? path.basename(path.dirname(resolved))
        : path.basename(resolved, path.extname(resolved));
  } else {
    throw new Error(`Not a skill: ${input} - pass a skill folder, its SKILL.md, or a .md file.`);
  }

  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(stat.isDirectory() ? 'No SKILL.md in that folder.' : `Cannot read ${input}`);
  }

  const parsed = parseSkillMd(text);
  if (!parsed.ok) throw new Error(parsed.error);

  const name = path.basename(filePath);
  const extraFiles =
    name.toLowerCase() === 'skill.md'
      ? (await fs.readdir(path.dirname(filePath))).filter(f => f !== name && !f.startsWith('.')).sort()
      : [];

  return {
    payload: buildSkillPayload(parsed.fields, fallbackName),
    dropped: parsed.dropped,
    ...(parsed.source && { source: parsed.source }),
    extraFiles,
  };
}

function serverMessage(error: unknown): string {
  const err = error as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message ?? String(error);
}

/** The stamp is plain comment text, so only a same-origin URL is presented as provenance. */
function isSameOrigin(url: string, apiOrigin: string | undefined): boolean {
  try {
    return apiOrigin !== undefined && new URL(url).origin === new URL(apiOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Prints the notices, applies the third-party and name-conflict gates, then
 * creates or updates the skill. Nothing is sent to the server before the
 * third-party gate passes. Throws on any exit-1 condition.
 */
export async function pushSkill(file: SkillFile, deps: PushDeps): Promise<PushResult> {
  const { payload, dropped, source, extraFiles } = file;
  const { api, log } = deps;

  if (dropped.length > 0) log(`Ignored (not supported in Bike4Mind skills): ${dropped.join(', ')}`);
  if (extraFiles.length > 0) {
    const listed = extraFiles.slice(0, MAX_LISTED_FILES).join(', ');
    const more = extraFiles.length > MAX_LISTED_FILES ? ` and ${extraFiles.length - MAX_LISTED_FILES} more` : '';
    log(`Not uploaded: supporting files (${listed}${more}) - only SKILL.md is pushed.`);
  }
  if (isReservedCommandName(payload.name)) {
    log(`Note: /${payload.name} is a built-in B4M CLI command, so the CLI won't list this skill (the web still will).`);
  }

  if (source) {
    log(
      isSameOrigin(source.url, deps.apiOrigin)
        ? `This skill came from Bike4Mind: ${source.url}`
        : `This file has a Bike4Mind source stamp from another site: ${source.url}`
    );
    // A pushed copy is an own skill and runs trusted; a market import runs as untrusted.
    if (source.thirdParty) {
      log(
        "This is another author's Skill Market skill - import it from the market instead to keep updates and attribution."
      );
      if (!deps.yes) {
        if (!deps.isTTY) throw new Error("Re-run with --yes to push another author's skill as your own.");
        if (!(await deps.confirm('Push it as your own skill anyway? [y/N] '))) return { outcome: 'aborted' };
      }
    }
  }

  try {
    const me = await (deps.whoAmI ?? (() => api.getCurrentUser()))();
    if (!me) throw new Error('Not authenticated. Run `b4m /login` to authenticate.');

    // ?query is a fuzzy name/description match over every visible skill, so page until the own exact match.
    let existing: SkillRow | undefined;
    for (let page = 1; !existing; page++) {
      const { data, hasMore } = await api.get<{ data: SkillRow[]; hasMore?: boolean }>('/api/skills', {
        params: { query: payload.name, limit: 100, page },
      });
      existing = data.find(s => s.name === payload.name && s.userId === me.id);
      if (!hasMore) break;
    }

    if (!existing) {
      const created = await api.post<{ id: string }>('/api/skills', payload);
      return { outcome: 'created', skillId: created.id };
    }
    if (existing.importedFrom) {
      throw new Error(
        `"${payload.name}" is the name of a Skill Market skill you imported - rename the local skill or delete the import first.`
      );
    }
    if (!deps.update) {
      if (!deps.isTTY) {
        throw new Error(`A skill named "${payload.name}" already exists - re-run with --update to overwrite it.`);
      }
      if (!(await deps.confirm(`A skill named "${payload.name}" already exists. Update it? [y/N] `)))
        return { outcome: 'aborted' };
    }
    // PUT preserves omitted fields, so explicitly clear a hint removed from the local file.
    await api.put(`/api/skills/${existing.id}`, { ...payload, argumentHint: payload.argumentHint ?? '' });
    return { outcome: 'updated', skillId: existing.id };
  } catch (error) {
    throw new Error(serverMessage(error));
  }
}

function describeVersion(version: PublicSkillListingVersion): string {
  const verdict = `scan ${version.scan_status}, review ${version.review_status}, risk ${version.risk_tier ?? 'n/a'}`;
  return version.review_status === 'pending' ? `${verdict} - it goes live once a reviewer approves it` : verdict;
}

/**
 * Lists a pushed skill on the Skill Market: a new version of its live listing when there is one,
 * else a new listing. Uses the /api/v1 routes, so an API key needs `skills:write`.
 */
export async function publishToMarket(
  skillId: string,
  opts: { visibility: MarketVisibility; org?: string; tags?: string[] },
  api: Pick<ApiClient, 'get' | 'post'>,
  log: (line: string) => void
): Promise<void> {
  try {
    const { data } = await api.get<{ data: PublicSkillListing[] }>('/api/v1/skills/market/listings/mine', {
      params: { source_skill_id: skillId },
    });
    const live = data.find(l => l.status !== 'withdrawn' && l.status !== 'delisted');
    const tags = opts.tags ? { tags: opts.tags } : {};
    if (live) {
      let version: SkillMarketSubmitResponse['version'];
      try {
        ({ version } = await api.post<SkillMarketSubmitResponse>(
          `/api/v1/skills/market/listings/${live.id}/versions`,
          tags
        ));
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status === 400 && serverMessage(error).includes('already live or waiting for review')) {
          log(`Listing "${live.name}" is already up to date`);
          return;
        }
        throw error;
      }
      log(`Submitted version ${version.version} of listing "${live.name}": ${describeVersion(version)}`);
      return;
    }
    const { listing, version } = await api.post<SkillMarketSubmitResponse>('/api/v1/skills/market/listings', {
      skill_id: skillId,
      visibility: opts.visibility,
      ...(opts.org && { organization_id: opts.org }),
      ...tags,
    });
    log(`Published listing "${listing.name}" (${listing.visibility}): ${describeVersion(version)}`);
  } catch (error) {
    const required = (error as { response?: { data?: { required_scopes?: string[] } } }).response?.data
      ?.required_scopes;
    const hint = required?.length ? ` (the API key needs ${required.join(' or ')})` : '';
    throw new Error(`Publishing to the Skill Market failed: ${serverMessage(error)}${hint}`);
  }
}

/** The key's owner, for a push made with an API key (the stored-login lookup does not apply). */
async function whoAmIWithKey(api: Pick<ApiClient, 'get'>): Promise<{ id: string }> {
  try {
    return await api.get<{ id: string }>('/api/v1/me');
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status === 403) {
      throw new Error('This API key needs the me:read and skills:write scopes.');
    }
    throw error;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>(resolve => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function handleSkillsCommand(subcommand: string | undefined, argv: SkillsCommandArgs): Promise<void> {
  if (subcommand !== 'push') throw new Error(`Unknown skills subcommand: ${subcommand ?? '(none)'}`);
  if (!argv.path) throw new Error('Usage: b4m skills push <path> [--publish]');

  const file = await readSkillFile(argv.path);

  const configStore = new ConfigStore();
  const config = await configStore.load();
  // Same precedence as `b4m mcp serve`: --api-key, then B4M_API_KEY, then the stored login.
  const apiKey = argv['api-key'] ?? process.env.B4M_API_KEY;
  // A stale access token is fine: ApiClient refreshes it on the first 401.
  if (!apiKey && !(await configStore.getAuthTokens())) {
    throw new Error('Not authenticated. Run `b4m /login` to authenticate, or set B4M_API_KEY.');
  }
  const apiUrl = requireApiUrl(config.apiConfig);
  const apiClient = new ApiClient(apiUrl, configStore, apiKey);

  const result = await pushSkill(file, {
    api: apiClient,
    confirm,
    isTTY: Boolean(process.stdin.isTTY),
    update: Boolean(argv.update),
    yes: Boolean(argv.yes),
    apiOrigin: apiUrl,
    log: line => console.log(line),
    ...(apiKey && { whoAmI: () => whoAmIWithKey(apiClient) }),
  });

  if (result.outcome === 'aborted') {
    console.log('Aborted');
    return;
  }
  try {
    await new RemoteSkillSource(apiClient).clearCache();
  } catch (error) {
    console.warn(`Skill saved, but the local skills cache could not be cleared: ${serverMessage(error)}`);
  }
  console.log(`${result.outcome === 'created' ? 'Created' : 'Updated'} skill /${file.payload.name}`);

  if (argv.publish) {
    const tags = argv.tags
      ?.split(',')
      .map(t => t.trim())
      .filter(Boolean);
    await publishToMarket(
      result.skillId,
      { visibility: argv.visibility ?? 'organization', org: argv.org, tags },
      apiClient,
      line => console.log(line)
    );
  }
}
