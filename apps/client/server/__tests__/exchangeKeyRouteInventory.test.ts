// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { ApiKeyScope, CONTRACTS } from '@bike4mind/common';

/**
 * Invariant: a key minted for a connected app (the federated AI-token exchange) reaches only the
 * routes that declare its scopes, and of those only the ones listed here.
 *
 * baseApi stack: apiKeyAuth treats an exchange key as confined, so a route reaches it only by
 * naming ai:generate or me:read. Every such route must be on an allowlist below, or refuse the key
 * in its handler. Adding a route that declares either scope fails this test until it is listed.
 * verifyApiKey stack: it refuses exchange keys unless the caller passes `allowExchangeKeys`, and
 * only the completion routes do.
 */

const EXCHANGE_SCOPES: string[] = [ApiKeyScope.AI_GENERATE, ApiKeyScope.ME_READ];

// Scanned from outside pages/ (see sessionGrantRoutesRejectApiKeys.test.ts for why).
const API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');
const CLIENT_SERVER_DIR = path.join(__dirname, '..');
const WORKERS_SRC_DIR = path.join(__dirname, '..', '..', '..', 'workers', 'src');

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

const ALLOWED_ROUTES = new Set([
  'quests/[id]/files.ts',
  'tools/weather.ts',
  'tools/web-fetch.ts',
  'tools/web-search.ts',
  'voice/v2/agents.ts',
  'voice/v2/sessions/[id]/activity.ts',
]);

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

const ALLOWED_EXCHANGE_KEY_CALLERS = new Set([
  'chatCompletion/external/sseRoute.ts',
  'chatCompletion/external/wsRoute.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const posixRel = (base: string, file: string) => path.relative(base, file).split(path.sep).join('/');

const declaredScopes = (src: string) =>
  [...src.matchAll(/\brequiredScopes:\s*\[([^\]]*)\]/g)].flatMap(m => m[1].split(',').map(s => s.trim()));

const grantsExchangeScope = (src: string) => declaredScopes(src).some(s => /\b(AI_GENERATE|ME_READ)$/.test(s));

describe('keys minted for a connected app reach only their scoped routes', () => {
  it('lists every contract that declares ai:generate or me:read', () => {
    const declared = CONTRACTS.filter(c => c.scopes?.some(s => EXCHANGE_SCOPES.includes(s))).map(c => c.operationId);
    expect(
      declared.filter(id => !ALLOWED_CONTRACTS.has(id)),
      'these contracts are reachable with an exchange key. Add each to ALLOWED_CONTRACTS only if a connected app needs it.'
    ).toEqual([]);
    expect([...ALLOWED_CONTRACTS].filter(id => !declared.includes(id))).toEqual([]);
  });

  it('lists every baseApi route that declares ai:generate or me:read', () => {
    const scoped = sourceFiles(API_DIR)
      .filter(f => grantsExchangeScope(readFileSync(f, 'utf8')))
      .map(f => posixRel(API_DIR, f));
    const unlisted = scoped.filter(r => !ALLOWED_ROUTES.has(r) && !REFUSING_ROUTES.includes(r));
    expect(
      unlisted,
      'these routes are reachable with an exchange key. Add each to ALLOWED_ROUTES, or refuse the key in the handler.'
    ).toEqual([]);
    for (const route of [...ALLOWED_ROUTES, ...REFUSING_ROUTES]) expect(scoped).toContain(route);
  });

  it.each(REFUSING_ROUTES)('%s refuses an exchange key in its handler', route => {
    expect(readFileSync(path.join(API_DIR, route), 'utf8')).toMatch(/if \(req\.apiKeyInfo\?\.oauthExchangeClientId\)/);
  });

  it.each(SCOPE_LESS_CREDENTIAL_ROUTES)('%s declares no scope an exchange key holds', route => {
    expect(grantsExchangeScope(readFileSync(path.join(API_DIR, route), 'utf8'))).toBe(false);
  });

  it('passes allowExchangeKeys only from the completion routes', () => {
    const plumbing = new Set(['cli/auth.ts', 'cli/resolveContractAuth.ts']);
    const callers = [
      ...sourceFiles(CLIENT_SERVER_DIR).map(f => posixRel(CLIENT_SERVER_DIR, f)),
      ...sourceFiles(WORKERS_SRC_DIR).map(f => `workers/${posixRel(WORKERS_SRC_DIR, f)}`),
    ].filter(rel => !plumbing.has(rel));
    const roots = (rel: string) => (rel.startsWith('workers/') ? WORKERS_SRC_DIR : CLIENT_SERVER_DIR);
    const passing = callers.filter(rel =>
      /\ballowExchangeKeys:\s*true\b/.test(readFileSync(path.join(roots(rel), rel.replace(/^workers\//, '')), 'utf8'))
    );
    expect(new Set(passing)).toEqual(ALLOWED_EXCHANGE_KEY_CALLERS);
  });
});
