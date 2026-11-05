/**
 * Self-host check: start an agent run and pass only when GET /api/v1/agent-executions/{id}
 * reaches `completed` with an answer echoing a per-run nonce.
 *
 *   BASE_URL=https://b4m.example B4M_API_KEY=b4m_live_... pnpm --filter @bike4mind/scripts smoke:selfhost-agent-run
 *
 * Optional: MODEL, RUN_TIMEOUT_MS, POLL_INTERVAL_MS. Exit 0 pass, 1 fail, 2 bad config.
 */
import { randomUUID } from 'node:crypto';
import { runSelfhostAgentCheck } from './selfhostAgentRunCheck';

const usage = (msg: string): never => {
  console.error(
    `${msg}\nUsage: BASE_URL=<url> B4M_API_KEY=b4m_... [MODEL=] [RUN_TIMEOUT_MS=] [POLL_INTERVAL_MS=] smoke:selfhost-agent-run`
  );
  process.exit(2);
};

const positiveInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : usage(`${name} must be a positive integer`);
};

const baseUrl = process.env.BASE_URL?.replace(/\/+$/, '');
const apiKey = process.env.B4M_API_KEY;
if (!baseUrl) usage('BASE_URL is required');
if (!apiKey?.startsWith('b4m_')) usage('B4M_API_KEY is required and must start with b4m_');

const result = await runSelfhostAgentCheck(
  { fetch, sleep: ms => new Promise(r => setTimeout(r, ms)), now: Date.now },
  {
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    nonce: `nonce-${randomUUID()}`,
    model: process.env.MODEL || undefined,
    timeoutMs: positiveInt('RUN_TIMEOUT_MS'),
    pollIntervalMs: positiveInt('POLL_INTERVAL_MS'),
  }
);

if (result.ok) {
  console.log(
    `PASS run ${result.executionId} completed${result.iterations === null ? '' : ` in ${result.iterations} iterations`}`
  );
} else {
  console.error(`FAIL ${result.reason}`);
  process.exit(1);
}
