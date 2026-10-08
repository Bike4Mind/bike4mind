// Shared HTTP plumbing for the lake-RAG live driver. Internal: not re-exported from index.ts.
import type { LakeRagApi } from './provision';

/** A non-2xx response. The message carries method, path, status and a body excerpt, never the auth header. */
export class LakeRagHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'LakeRagHttpError';
  }
}

export type Json = Record<string, unknown>;

export function resolved(api: LakeRagApi) {
  return {
    fetch: api.fetch ?? fetch,
    pollIntervalMs: api.pollIntervalMs ?? 2_000,
    pollTimeoutMs: api.pollTimeoutMs ?? 600_000,
    notIngestedGraceMs: api.notIngestedGraceMs ?? 120_000,
    sleep: api.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))),
    now: api.now ?? Date.now,
  };
}

export async function call(api: LakeRagApi, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await resolved(api).fetch(new URL(path, api.baseUrl), {
    method,
    headers: {
      Authorization: api.authorization,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new LakeRagHttpError(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status);
  return text ? (JSON.parse(text) as Json) : {};
}

export type PollStep = { done: true } | { done: false; status: string };

export async function pollUntil(api: LakeRagApi, label: string, step: () => Promise<PollStep>): Promise<void> {
  const { pollIntervalMs, pollTimeoutMs, sleep, now } = resolved(api);
  const deadline = now() + pollTimeoutMs;
  for (;;) {
    const result = await step();
    if (result.done) return;
    if (now() >= deadline) throw new Error(`${label}: still ${result.status} after ${pollTimeoutMs}ms`);
    await sleep(pollIntervalMs);
  }
}

export function stringField(json: Json, key: string, what: string): string {
  const value = json[key];
  if (typeof value !== 'string' || !value) throw new Error(`${what}: response has no ${key}`);
  return value;
}
