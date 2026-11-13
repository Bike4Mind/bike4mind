// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { ApiKeyScope, CONTRACTS } from '@bike4mind/common';
import { DERIVED_API_KEY_SCOPE_ENDPOINTS } from '@bike4mind/server-utils/app/constants/apiKeyScopeEndpoints.generated';
import { FILES_READ_OR_WRITE_OR_GENERATE_SCOPES } from '@bike4mind/server-utils/files/fileScopes';
import {
  admitsNoApiKey,
  doorSitesIn,
  pageRouteFiles,
  routePathOf,
  stripComments,
} from '../../scripts/apiKeyScopeRoutes';

/**
 * Invariant: a key minted for a connected app (the federated AI-token exchange) reaches only the
 * routes that declare its scopes, and of those only the ones listed here.
 *
 * Every baseApi door that resolves to ai:generate or me:read must be in the pinned registry list or
 * DOOR_ONLY_ROUTES. The unresolvable-door check covers only inline-literal `baseApi({...})` doors;
 * options passed as a variable or with type arguments are covered by the registry only.
 * Adding a door for either scope fails this test until it is listed.
 * verifyApiKey stack: it refuses exchange keys unless the caller passes `allowExchangeKeys`, and
 * only the completion routes do.
 */

const EXCHANGE_SCOPES: string[] = [ApiKeyScope.AI_GENERATE, ApiKeyScope.ME_READ];

// Scanned from outside pages/ (see sessionGrantRoutesRejectApiKeys.test.ts for why).
const API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');
const CLIENT_SERVER_DIR = path.join(__dirname, '..');
const WORKERS_SRC_DIR = path.join(__dirname, '..', '..', '..', 'workers', 'src');
const SERVER_UTILS_SRC_DIR = path.join(__dirname, '..', '..', '..', '..', 'packages', 'server-utils', 'src');

const ALLOWED_CONTRACTS = new Set([
  'sendChatMessage',
  'startAgentExecution',
  'getAgentExecution',
  'createCompletion',
  'createCompletionRun',
  'synthesizeSpeech',
  'generateMusic',
  'generateSoundEffect',
  'getMe',
  'getClientConfig',
  'getCreditBalance',
  'listModels',
  'generateImage',
  'editImage',
  'createEmbeddings',
  'listEmbeddingModels',
  'createTextRefinement',
  'createDecision',
  'listDecisionModels',
  'getQuest',
  'listQuestFiles',
  'createSession',
  'listCreditTransactions',
  'cancelVideoGeneration',
  'createVideoGeneration',
  'getVideoGeneration',
  'listVideoGenerations',
  'listVideoModels',
  'cancelMusicGeneration',
  'createMusicGeneration',
  'getMusicGeneration',
  'listMusicGenerations',
  'listMusicModels',
  'listVoices',
  'createVoiceSession',
  'endVoiceSession',
  'createTranscriptionUpload',
  'createTranscription',
]);

// Every endpoint the generated registry lists under ai:generate or me:read. The callback-secret route is
// here because it names the scope at the door and refuses an exchange key in its handler.
const ALLOWED_ENDPOINTS = [
  'GET /api/generated-content/:ref',
  'GET /api/models',
  'GET /api/quests/:id/files',
  'GET /api/v1/agent-executions/:id',
  'GET /api/v1/client-config',
  'GET /api/v1/credits',
  'GET /api/v1/credits/transactions',
  'GET /api/v1/decision-models',
  'GET /api/v1/embedding-models',
  'GET /api/v1/me',
  'GET /api/v1/models',
  'GET /api/v1/music-generations/:id',
  'GET /api/v1/music-models',
  'GET /api/v1/quests/:id',
  'GET /api/v1/quests/:id/files',
  'GET /api/v1/video-generations/:id',
  'GET /api/v1/video-models',
  'GET /api/v1/voice/voices',
  'GET /api/voice/v2/agents',
  'GET|POST /api/v1/music-generations',
  'GET|POST /api/v1/video-generations',
  'POST /api/ai/music',
  'POST /api/ai/transcribe',
  'POST /api/ai/transcribe/init',
  'POST /api/ai/sound-effects',
  'POST /api/ai/tts',
  'POST /api/ai/v1/completions',
  'POST /api/chat',
  'POST /api/files/generate-presigned-url',
  'POST /api/tools/weather',
  'POST /api/tools/web-fetch',
  'POST /api/tools/web-search',
  'POST /api/user-api-keys/:id/callback-secret',
  'POST /api/v1/agent-executions',
  'POST /api/v1/completion-runs',
  'POST /api/v1/decisions',
  'POST /api/v1/embeddings',
  'POST /api/v1/image-edits',
  'POST /api/v1/image-generations',
  'POST /api/v1/music-generations/:id/cancel',
  'POST /api/v1/sessions',
  'POST /api/v1/text-refinements',
  'POST /api/v1/transcriptions',
  'POST /api/v1/transcriptions/uploads',
  'POST /api/v1/video-generations/:id/cancel',
  'POST /api/v1/voice/sessions',
  'POST /api/v1/voice/sessions/:id/end',
  'POST /api/voice/v2/sessions/:id/activity',
];

// Routes whose door admits ai:generate but whose per-method check narrows it, so the registry omits them.
const DOOR_ONLY_ROUTES = ['files/[id]/index.ts'];

// Doors whose scope list the generator cannot resolve. Each needs a reason.
const UNRESOLVABLE_DOOR_ALLOWLIST: Record<string, string> = {};

// Scoped routes that manage credentials: each refuses an exchange key in its handler.
const REFUSING_ROUTES = ['user-api-keys/[id]/callback-secret.ts'];

// Scope-less credential and account routes. They stay closed only while they declare no exchange scope.
const SCOPE_LESS_CREDENTIAL_ROUTES = [
  'user-api-keys/index.ts',
  'user-api-keys/[id]/rotate.ts',
  'api-keys/create.ts',
  'cc-bridge/pair.ts',
  'auth/github/authorize.ts',
];

// Every non-test source occurrence of the opt-in, by file. A spread, variable or renamed pass-through
// still contains the identifier, so it shows up here.
const EXCHANGE_KEY_OPT_IN_OCCURRENCES: Record<string, number> = {
  'client/server/chatCompletion/external/sseRoute.ts': 1,
  'client/server/chatCompletion/external/wsRoute.ts': 1,
  'client/server/cli/auth.ts': 2,
  'client/server/cli/resolveContractAuth.ts': 3,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const posixRel = (base: string, file: string) => path.relative(base, file).split(path.sep).join('/');

const GENERATED_ENDPOINTS: readonly string[] = EXCHANGE_SCOPES.flatMap(
  scope => (DERIVED_API_KEY_SCOPE_ENDPOINTS as Partial<Record<string, readonly string[]>>)[scope] ?? []
);

const routeSource = (route: string) => readFileSync(path.join(API_DIR, route), 'utf8');

describe('keys minted for a connected app reach only their scoped routes', () => {
  it('lists every contract that declares ai:generate or me:read', () => {
    const declared = CONTRACTS.filter(c => c.scopes?.some(s => EXCHANGE_SCOPES.includes(s))).map(c => c.operationId);
    expect(
      declared.filter(id => !ALLOWED_CONTRACTS.has(id)),
      'these contracts are reachable with an exchange key. Add each to ALLOWED_CONTRACTS only if a connected app needs it.'
    ).toEqual([]);
    expect([...ALLOWED_CONTRACTS].filter(id => !declared.includes(id))).toEqual([]);
  });

  it('lists every endpoint the generated registry opens to ai:generate or me:read', () => {
    const generated = [...new Set(GENERATED_ENDPOINTS)].sort();
    expect(
      generated.filter(e => !ALLOWED_ENDPOINTS.includes(e)),
      'these endpoints are reachable with an exchange key. Pin each in ALLOWED_ENDPOINTS, or refuse the key in the handler.'
    ).toEqual([]);
    expect(ALLOWED_ENDPOINTS.filter(e => !generated.includes(e))).toEqual([]);
  });

  it('finds every ai:generate or me:read door in the registry, and no door the generator cannot resolve', () => {
    const registryRoutes = new Set(ALLOWED_ENDPOINTS.map(e => e.slice(e.indexOf(' ') + 1)));
    const unlisted: string[] = [];
    const unresolved: string[] = [];
    for (const file of pageRouteFiles()) {
      const routePath = routePathOf(file);
      if (!routePath) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (admitsNoApiKey(code)) continue;
      const rel = posixRel(API_DIR, file);
      for (const { raw, scopes } of doorSitesIn(code)) {
        if (scopes.size === 0 && !(rel in UNRESOLVABLE_DOOR_ALLOWLIST)) unresolved.push(`${rel}: ${raw}`);
        const opensExchange = EXCHANGE_SCOPES.some(s => (scopes as ReadonlySet<string>).has(s));
        if (opensExchange && !registryRoutes.has(routePath) && !DOOR_ONLY_ROUTES.includes(rel)) unlisted.push(rel);
      }
    }
    expect(
      unlisted,
      'these doors admit an exchange scope but are in neither ALLOWED_ENDPOINTS nor DOOR_ONLY_ROUTES.'
    ).toEqual([]);
    expect(
      unresolved,
      'the generator cannot resolve these doors, so it would omit them. Name the scopes as ApiKeyScope.X.'
    ).toEqual([]);
  });

  it.each(DOOR_ONLY_ROUTES)('%s is pinned for the exchange scope its door admits', route => {
    expect(FILES_READ_OR_WRITE_OR_GENERATE_SCOPES).toContain(ApiKeyScope.AI_GENERATE);
    expect(routeSource(route)).toMatch(/requiredScopes:\s*FILES_READ_OR_WRITE_OR_GENERATE_SCOPES/);
  });

  it.each(REFUSING_ROUTES)('%s refuses an exchange key in its handler', route => {
    expect(routeSource(route)).toMatch(/if \(req\.apiKeyInfo\?\.oauthExchangeClientId\)/);
  });

  it.each(SCOPE_LESS_CREDENTIAL_ROUTES)('%s declares no scope an exchange key holds', route => {
    expect(routeSource(route)).not.toMatch(/\b(AI_GENERATE|ME_READ|FILES_READ_OR_WRITE_OR_GENERATE_SCOPES)\b/);
  });

  it('references allowExchangeKeys only from the pinned files', () => {
    const found: Record<string, number> = {};
    const scan = (dir: string, prefix: string) => {
      for (const file of sourceFiles(dir)) {
        const count = readFileSync(file, 'utf8').split('allowExchangeKeys').length - 1;
        if (count > 0) found[`${prefix}/${posixRel(dir, file)}`] = count;
      }
    };
    scan(CLIENT_SERVER_DIR, 'client/server');
    scan(API_DIR, 'client/pages/api');
    scan(WORKERS_SRC_DIR, 'workers/src');
    scan(SERVER_UTILS_SRC_DIR, 'server-utils/src');
    expect(found).toEqual(EXCHANGE_KEY_OPT_IN_OCCURRENCES);
  });

  it('has no admitExchangeKeys option anywhere in source', () => {
    const found: string[] = [];
    const scan = (dir: string, prefix: string) => {
      for (const file of sourceFiles(dir)) {
        if (readFileSync(file, 'utf8').includes('admitExchangeKeys')) found.push(`${prefix}/${posixRel(dir, file)}`);
      }
    };
    scan(CLIENT_SERVER_DIR, 'client/server');
    scan(API_DIR, 'client/pages/api');
    scan(WORKERS_SRC_DIR, 'workers/src');
    scan(SERVER_UTILS_SRC_DIR, 'server-utils/src');
    expect(found).toEqual([]);
  });
});
