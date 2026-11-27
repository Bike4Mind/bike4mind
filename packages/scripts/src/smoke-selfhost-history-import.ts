/**
 * Self-host check: upload a small Claude chat-history export through the app, wait for the
 * import job the MinIO webhook starts to reach `completed`, and pass only when the imported
 * conversations read back with the same count and content.
 *
 *   BASE_URL=https://b4m.example B4M_API_KEY=b4m_live_... pnpm --filter @bike4mind/scripts smoke:selfhost-history-import
 *
 * The key needs `notebooks:read`. Optional: BROKEN_EXPORT=bad-json|invalid-conversation uploads
 * a deliberately broken export, which must FAIL; RUN_TIMEOUT_MS, POLL_INTERVAL_MS.
 * Exit 0 pass, 1 fail, 2 bad config. Each passing run leaves two small conversations behind.
 */
import { randomUUID } from 'node:crypto';
import { runSelfhostHistoryImportCheck, type BrokenExport } from './selfhostHistoryImportCheck';

const usage = (msg: string): never => {
  console.error(
    `${msg}\nUsage: BASE_URL=<url> B4M_API_KEY=b4m_... [BROKEN_EXPORT=bad-json|invalid-conversation] [RUN_TIMEOUT_MS=] [POLL_INTERVAL_MS=] smoke:selfhost-history-import\nThe API key needs notebooks:read.`
  );
  process.exit(2);
};

const MAX_TIMER_MS = 2_147_483_647; // larger setTimeout delays collapse to 1ms

const positiveInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= MAX_TIMER_MS
    ? n
    : usage(`${name} must be a positive integer no greater than ${MAX_TIMER_MS}`);
};

const BROKEN_EXPORTS: readonly BrokenExport[] = ['bad-json', 'invalid-conversation'];

const baseUrl = process.env.BASE_URL?.replace(/\/+$/, '');
const apiKey = process.env.B4M_API_KEY;
const broken = process.env.BROKEN_EXPORT || undefined;
if (!baseUrl) usage('BASE_URL is required');
if (!URL.canParse(baseUrl!) || !/^https?:$/.test(new URL(baseUrl!).protocol))
  usage('BASE_URL must be an http: or https: URL');
if (!apiKey?.startsWith('b4m_')) usage('B4M_API_KEY is required and must start with b4m_');
if (broken !== undefined && !BROKEN_EXPORTS.includes(broken as BrokenExport))
  usage(`BROKEN_EXPORT must be one of ${BROKEN_EXPORTS.join(', ')}`);

const result = await runSelfhostHistoryImportCheck(
  { fetch, sleep: ms => new Promise(r => setTimeout(r, ms)), now: Date.now },
  {
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    nonce: `nonce-${randomUUID()}`,
    broken: broken as BrokenExport | undefined,
    timeoutMs: positiveInt('RUN_TIMEOUT_MS'),
    pollIntervalMs: positiveInt('POLL_INTERVAL_MS'),
  }
);

if (result.ok) {
  console.log(
    `PASS import job ${result.jobId} completed; ${result.conversations} conversations and ${result.exchanges} exchanges read back intact`
  );
} else {
  console.error(`FAIL ${result.reason}${result.jobId ? ` (import job ${result.jobId})` : ''}`);
  process.exit(1);
}
