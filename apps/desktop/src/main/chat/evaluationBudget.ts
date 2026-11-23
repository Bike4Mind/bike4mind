import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAxiosError, type AxiosInstance } from 'axios';
import { z } from 'zod';
import {
  CompletionEvaluationReceiptSchema,
  CompletionEvaluationStateSchema,
  CompletionRunSchema,
  ModelBackend,
  oneHourCacheWriteRate,
  resolveAppliedRates,
} from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import type { CompletionRequest } from './completions';
import { foldUsage, type CompletionStreamEvent } from './streamEvents';

export const EVALUATION_LIMITS = Object.freeze({
  usd: 150,
  inputTokens: 131_072,
  outputTokens: 2048,
  requests: 200,
  totalTokens: 2_000_000,
  rounds: 24,
  workers: 1,
});

export const evaluationContext = new AsyncLocalStorage<EvaluationBudget>();

export function assertEvaluationTool(name: string): void {
  const budget = evaluationContext.getStore();
  if (!budget) return;
  if (name === 'session_spawn') {
    if (!budget.allowWorker || budget.workersStarted >= EVALUATION_LIMITS.workers)
      throw new Error('Evaluation worker limit reached.');
    budget.workersStarted++;
    return;
  }
  if (!['file_read', 'glob_files', 'grep_search', 'task_report'].includes(name))
    throw new Error('Evaluation tool is not permitted.');
}

const receiptSchema = CompletionEvaluationReceiptSchema;

export class EvaluationBudget {
  private readonly db: DatabaseSync;
  private active = false;
  private closing = false;
  private remote?: { axios: AxiosInstance; runId: string };
  private modelIds: string[] = [];
  private modelBackends = new Map<string, string>();
  private dispatchModelIds?: string[];
  private requestTail: Promise<void> = Promise.resolve();
  private transportPaused = false;
  allowWorker = false;
  workersStarted = 0;
  stage = 'initializing';
  withdrawnTools = new Set<string>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, model TEXT NOT NULL, reservation REAL NOT NULL CHECK(reservation>0),
        status TEXT NOT NULL, usage TEXT, provider_usd REAL, platform_usd REAL, platform_credits REAL
      );
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), root_id TEXT NOT NULL, run_id TEXT);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS measurements (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO identity(id,root_id) VALUES (1,?)').run(randomUUID());
    this.db.prepare('INSERT OR IGNORE INTO policy VALUES (1, ?)').run(JSON.stringify(EVALUATION_LIMITS));
    const policy = this.db.prepare('SELECT value FROM policy WHERE id=1').get();
    if (policy?.value !== JSON.stringify(EVALUATION_LIMITS)) {
      this.db.close();
      throw new Error('Evaluation ledger policy mismatch.');
    }
  }

  async connect(axios: AxiosInstance, modelIds: string[], recoverRunId?: string): Promise<void> {
    this.modelIds = modelIds;
    const identity = this.db.prepare('SELECT root_id,run_id FROM identity WHERE id=1').get()!;
    let runId = identity.run_id;
    if (recoverRunId) {
      z.uuid().parse(recoverRunId);
      if (runId && runId !== 'mint-pending' && runId !== recoverRunId)
        throw new Error('Cannot replace an existing evaluation run.');
      const response = await axios.get(`/api/v1/completion-runs/${recoverRunId}/evaluation`, { timeout: 10_000 });
      const recovered = CompletionEvaluationStateSchema.parse(response.data);
      if (
        recovered.limits.maxProviderUsd > EVALUATION_LIMITS.usd ||
        recovered.limits.maxTokens > EVALUATION_LIMITS.totalTokens ||
        recovered.limits.maxRequests > EVALUATION_LIMITS.requests ||
        recovered.limits.modelIds.some(id => !modelIds.includes(id))
      )
        throw new Error('Recovered run exceeds authorized policy.');
      this.db.prepare('UPDATE identity SET run_id=? WHERE id=1').run(recoverRunId);
      runId = recoverRunId;
    }
    if (!runId || runId === 'mint-pending') {
      // The server mints idempotently for this persisted root identity, including timeout recovery.
      this.db.prepare("UPDATE identity SET run_id='mint-pending' WHERE id=1").run();
      const response = await axios
        .post(
          '/api/v1/completion-runs',
          {
            rootSessionId: identity.root_id,
            evaluation: {
              version: 1,
              maxProviderUsd: EVALUATION_LIMITS.usd,
              maxTokens: EVALUATION_LIMITS.totalTokens,
              maxRequests: EVALUATION_LIMITS.requests,
              modelIds,
            },
          },
          { timeout: 10_000 }
        )
        .catch((error: unknown) => {
          if (isAxiosError(error) && [400, 401, 403, 404, 422].includes(error.response?.status ?? 0))
            this.db.prepare('UPDATE identity SET run_id=NULL WHERE id=1').run();
          throw error;
        });
      const created = CompletionRunSchema.parse(response.data);
      if (!created.evaluation) throw new Error('Server did not authorize an evaluation budget.');
      runId = created.runId;
      this.db.prepare('UPDATE identity SET run_id=? WHERE id=1').run(runId);
    }
    if (typeof runId !== 'string' || !z.uuid().safeParse(runId).success)
      throw new Error('Evaluation run mint is unresolved; recover its server identity before continuing.');
    this.remote = { axios, runId };
    await this.reconcile();
  }

  wire(requestId: string) {
    if (!this.remote) throw new Error('Evaluation requires server budget admission.');
    return { evaluation: { version: 1, requestId }, run: { runId: this.remote.runId, role: 'root' as const } };
  }

  pinModels(models: ChatModelOption[]): void {
    this.modelBackends = new Map(models.map(model => [model.id, model.backend ?? '']));
  }

  permitDispatch(modelIds: string[]): void {
    this.dispatchModelIds = modelIds;
    this.transportPaused = false;
  }

  pauseDispatch(): void {
    this.transportPaused = true;
  }

  assertTransportOpen(): void {
    if (this.closing || this.transportPaused) throw new Error('Evaluation transport is stopped.');
  }

  async serialize<T>(request: () => Promise<T>): Promise<T> {
    const previous = this.requestTail;
    let release!: () => void;
    this.requestTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await request();
    } finally {
      release();
    }
  }

  async reconcile(): Promise<void> {
    if (!this.remote) return;
    const response = await this.remote.axios.get(
      `/api/v1/completion-runs/${encodeURIComponent(this.remote.runId)}/evaluation`,
      { timeout: 10_000 }
    );
    const snapshot = CompletionEvaluationStateSchema.parse(response.data);
    if (
      snapshot.limits.maxProviderUsd > EVALUATION_LIMITS.usd ||
      snapshot.limits.maxTokens > EVALUATION_LIMITS.totalTokens ||
      snapshot.limits.maxRequests > EVALUATION_LIMITS.requests ||
      snapshot.limits.modelIds.some(id => !this.modelIds.includes(id))
    )
      throw new Error('Evaluation server policy exceeds local authorization.');
    for (const receipt of snapshot.receipts) {
      const attempt = this.db.prepare('SELECT model,reservation FROM attempts WHERE id=?').get(receipt.requestId);
      if (!attempt) continue;
      const rejected =
        receipt.status === 'rejected-before-dispatch' &&
        receipt.backend === 'not-dispatched' &&
        receipt.pricingRevision === 'not-dispatched' &&
        receipt.maxProviderUsd === 0 &&
        receipt.maxTokens === 0 &&
        receipt.maxInputTokens === 0 &&
        receipt.maxOutputTokens === 0 &&
        receipt.rates.length === 0 &&
        (receipt.providerUsd === undefined || receipt.providerUsd === 0);
      if (receipt.status === 'rejected-before-dispatch' && !rejected)
        throw new Error('Invalid evaluation rejection receipt.');
      if (
        attempt.model !== receipt.modelId ||
        (!rejected && receipt.backend !== (this.modelBackends.get(receipt.modelId) ?? 'openai'))
      )
        throw new Error('Evaluation receipt model mismatch.');
      const previous = this.db.prepare('SELECT revision,value FROM receipts WHERE id=?').get(receipt.requestId);
      if (previous && Number(previous.revision) >= receipt.revision) {
        if (Number(previous.revision) === receipt.revision && previous.value !== JSON.stringify(receipt))
          throw new Error('Evaluation receipt revision conflict.');
        continue;
      }
      const complete =
        receipt.status === 'complete' &&
        receipt.providerUsd !== undefined &&
        receipt.inputTokens !== undefined &&
        receipt.outputTokens !== undefined &&
        receipt.rates.length > 0 &&
        receipt.provenance === 'provider-reported-usage/catalog-rates';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .prepare('INSERT OR REPLACE INTO receipts VALUES (?,?,?)')
          .run(receipt.requestId, receipt.revision, JSON.stringify(receipt));
        this.db
          .prepare(
            `UPDATE attempts SET status=?,provider_usd=?,
          platform_usd=COALESCE(?,platform_usd),platform_credits=COALESCE(?,platform_credits) WHERE id=?`
          )
          .run(
            complete || receipt.status === 'rejected-before-dispatch'
              ? 'complete'
              : receipt.status === 'complete'
                ? 'unknown'
                : receipt.status,
            complete ? receipt.providerUsd! : receipt.status === 'rejected-before-dispatch' ? 0 : null,
            receipt.platformUsd ?? null,
            receipt.platformCredits ?? null,
            receipt.requestId
          );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  measure(id: string, request: CompletionRequest): void {
    const blocks = [
      ...request.messages.map(message => ({
        source:
          message.role === 'system'
            ? 'system'
            : message.role === 'user'
              ? 'user-and-tool-results'
              : 'assistant-history',
        value: message.content,
      })),
      { source: 'tool-definitions', value: request.tools ?? [] },
    ].map(({ source, value }) => {
      const text = JSON.stringify(value);
      return { source, bytes: Buffer.byteLength(text) };
    });
    this.db
      .prepare('INSERT INTO measurements VALUES (?,?)')
      .run(id, JSON.stringify({ stage: this.stage, ttl: request.cacheTtl ?? '5m', blocks }));
  }

  reserve(id: string, request: CompletionRequest, model: ChatModelOption): () => void {
    if (this.closing) throw new Error('Evaluation is closing.');
    if (this.active) throw new Error('Evaluation concurrency is limited to one.');
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) {
      throw new Error('Evaluation requires a finite positive output bound.');
    }
    if (
      !(this.modelIds.length ? this.modelIds : ['gpt-6.1-sol']).includes(request.model) ||
      (this.dispatchModelIds && !this.dispatchModelIds.includes(request.model)) ||
      model.id !== request.model ||
      !['openai', 'anthropic'].includes(model.backend ?? '') ||
      model.disabled ||
      model.unavailable
    ) {
      throw new Error('Evaluation requires the exact available pinned model.');
    }
    const tiers = Object.entries(model.pricing ?? {});
    if (
      !tiers.length ||
      tiers.some(
        ([key, rates]) =>
          !Number.isFinite(Number(key)) ||
          Number(key) <= 0 ||
          Object.values(rates).some(rate => !Number.isFinite(rate) || rate <= 0)
      )
    ) {
      throw new Error('Evaluation requires complete positive pricing.');
    }
    // Reserve the entire input ceiling at the highest published rate, including a 1h cache write.
    const rates = tiers.map(([threshold]) =>
      resolveAppliedRates(
        {
          pricing: model.pricing!,
          backend: model.backend === 'anthropic' ? ModelBackend.Anthropic : ModelBackend.OpenAI,
        },
        Number(threshold)
      )
    );
    if (rates.some(rate => !rate)) throw new Error('Evaluation pricing tier is unresolved.');
    const inputRate = Math.max(
      ...rates.flatMap(rate => [rate!.input, rate!.cacheRead, rate!.cacheWrite, oneHourCacheWriteRate(rate!)])
    );
    const outputRate = Math.max(...rates.map(rate => rate!.output));
    const reserved =
      Math.ceil(
        ((model.contextWindow ?? EVALUATION_LIMITS.inputTokens) * inputRate +
          EVALUATION_LIMITS.outputTokens * outputRate) *
          1_000_000
      ) / 1_000_000;
    if (!Number.isFinite(reserved) || reserved <= 0) throw new Error('Invalid evaluation reservation.');
    if (Buffer.byteLength(JSON.stringify(request)) > EVALUATION_LIMITS.inputTokens) {
      throw new Error('Evaluation input envelope exceeded.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const totals = this.db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'complete' THEN provider_usd ELSE reservation END),0) AS usd, SUM(CASE WHEN status != 'complete' THEN 1 ELSE 0 END) AS unresolved FROM attempts"
        )
        .get();
      if (
        !totals ||
        Number(totals.n) >= EVALUATION_LIMITS.requests ||
        Number(totals.usd) + reserved > EVALUATION_LIMITS.usd ||
        Number(totals.unresolved) > 0
      ) {
        throw new Error('Evaluation budget exhausted or a previous charge is unresolved.');
      }
      this.db
        .prepare("INSERT INTO attempts(id,model,reservation,status) VALUES (?,?,?,'unknown')")
        .run(id, model.id, reserved);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.active = true;
    request.maxTokens = Math.min(request.maxTokens ?? EVALUATION_LIMITS.outputTokens, EVALUATION_LIMITS.outputTokens);
    return () => {
      this.active = false;
      if (this.closing) this.db.close();
    };
  }

  record(id: string, events: readonly CompletionStreamEvent[], failed: boolean): void {
    let usage: ReturnType<typeof foldUsage>;
    let settlement: Extract<CompletionStreamEvent, { type: 'settled' }> | undefined;
    let matching = true;
    for (const event of events) {
      usage = foldUsage(usage, event);
      if (event.type === 'meta' && event.requestId !== id) matching = false;
      if (event.type === 'settled') {
        if (settlement || event.requestId !== id) matching = false;
        settlement = event;
      }
    }
    const valid = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0;
    const complete =
      !failed &&
      matching &&
      !!settlement &&
      valid(settlement.creditsCharged) &&
      valid(usage?.inputTokens) &&
      valid(usage?.outputTokens) &&
      usage!.inputTokens! <= EVALUATION_LIMITS.inputTokens &&
      usage!.outputTokens! <= EVALUATION_LIMITS.outputTokens;
    // Stream settlement is platform accounting, never authority to release a provider hold.
    this.db.prepare('UPDATE attempts SET status=?, usage=?, platform_usd=?, platform_credits=? WHERE id=?').run(
      complete ? 'usage-reported-charge-unverified' : failed ? 'failed-unknown-charge' : 'unknown',
      usage
        ? JSON.stringify({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            reasoningTokens: usage.reasoningTokens,
          })
        : null,
      matching && valid(settlement?.usdCost) ? settlement!.usdCost! : null,
      matching && valid(settlement?.creditsCharged) ? settlement!.creditsCharged : null,
      id
    );
  }

  report(): unknown[] {
    return this.db
      .prepare(
        'SELECT a.model, a.reservation AS reservedUsd, a.status, a.usage, a.provider_usd AS providerPricedUsd, a.platform_usd AS platformUsd, a.platform_credits AS platformCredits, r.value AS receipt, m.value AS measurement FROM attempts a LEFT JOIN receipts r ON r.id=a.id LEFT JOIN measurements m ON m.id=a.id ORDER BY a.rowid'
      )
      .all()
      .map(({ receipt, measurement, ...attempt }) => {
        const parsed = typeof receipt === 'string' ? receiptSchema.parse(JSON.parse(receipt)) : undefined;
        const { requestId: _requestId, attemptId: _attemptId, ...safeReceipt } = parsed ?? {};
        return {
          ...attempt,
          receipt: parsed ? safeReceipt : null,
          measurement: typeof measurement === 'string' ? (JSON.parse(measurement) as unknown) : null,
        };
      });
  }

  totals() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS attempts,
      SUM(CASE WHEN status!='complete' THEN 1 ELSE 0 END) AS unknowns,
      SUM(provider_usd) AS providerUsd, SUM(platform_usd) AS platformUsd FROM attempts`
      )
      .get()!;
    return {
      attemptCount: Number(row.attempts),
      unresolvedAttempts: Number(row.unknowns ?? 0),
      providerPricedUsd: Number(row.attempts) && !Number(row.unknowns) ? Number(row.providerUsd) : null,
      platformUsd: row.platformUsd === null ? null : Number(row.platformUsd),
    };
  }

  armTotals(arm: string) {
    const attempts = this.db
      .prepare(
        `SELECT a.provider_usd,a.status FROM attempts a
      JOIN measurements m ON m.id=a.id WHERE json_extract(m.value,'$.stage') LIKE ?`
      )
      .all(`${arm}/%`);
    return {
      attemptCount: attempts.length,
      providerPricedUsd:
        attempts.length && attempts.every(attempt => attempt.status === 'complete')
          ? attempts.reduce((sum, attempt) => sum + Number(attempt.provider_usd), 0)
          : null,
    };
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    if (!this.active) this.db.close();
  }
}

export function filterEvaluationTools<T extends { toolSchema: { name: string } }>(tools: T[]): T[] {
  const withdrawn = evaluationContext.getStore()?.withdrawnTools;
  return withdrawn?.size ? tools.filter(tool => !withdrawn.has(tool.toolSchema.name)) : tools;
}
