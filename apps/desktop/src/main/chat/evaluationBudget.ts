import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { ModelBackend, oneHourCacheWriteRate, resolveAppliedRates } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import type { CompletionRequest } from './completions';
import { foldUsage, type CompletionStreamEvent } from './streamEvents';

export const EVALUATION_LIMITS = Object.freeze({
  usd: 150,
  inputTokens: 131_072,
  outputTokens: 2048,
  requests: 20,
  rounds: 4,
  workers: 0,
});

export const evaluationContext = new AsyncLocalStorage<EvaluationBudget>();

/** Never interpret a local option as an amendment to the issuer's spending authorization. */
export function liveEvaluationBlockers(): string[] {
  return ['issuer-authorization-amendment-pending', 'backend-billed-token-and-retry-bound-unverified'];
}

export function assertEvaluationTool(name: string): void {
  if (evaluationContext.getStore() && name !== 'file_read') throw new Error('Evaluation tool is not permitted.');
}

export class EvaluationBudget {
  private readonly db: DatabaseSync;
  private active = false;

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
    `);
    this.db.prepare('INSERT OR IGNORE INTO policy VALUES (1, ?)').run(JSON.stringify(EVALUATION_LIMITS));
    const policy = this.db.prepare('SELECT value FROM policy WHERE id=1').get();
    if (policy?.value !== JSON.stringify(EVALUATION_LIMITS)) {
      this.db.close();
      throw new Error('Evaluation ledger policy mismatch.');
    }
  }

  reserve(id: string, request: CompletionRequest, model: ChatModelOption): () => void {
    if (this.active) throw new Error('Evaluation concurrency is limited to one.');
    if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) {
      throw new Error('Evaluation requires a finite positive output bound.');
    }
    if (
      request.model !== 'gpt-6.1-sol' ||
      model.id !== request.model ||
      model.backend !== 'openai' ||
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
      resolveAppliedRates({ pricing: model.pricing!, backend: ModelBackend.OpenAI }, Number(threshold))
    );
    if (rates.some(rate => !rate)) throw new Error('Evaluation pricing tier is unresolved.');
    const inputRate = Math.max(
      ...rates.flatMap(rate => [rate!.input, rate!.cacheRead, rate!.cacheWrite, oneHourCacheWriteRate(rate!)])
    );
    const outputRate = Math.max(...rates.map(rate => rate!.output));
    const reserved =
      Math.ceil((EVALUATION_LIMITS.inputTokens * inputRate + EVALUATION_LIMITS.outputTokens * outputRate) * 1_000_000) /
      1_000_000;
    if (!Number.isFinite(reserved) || reserved <= 0) throw new Error('Invalid evaluation reservation.');
    if (Buffer.byteLength(JSON.stringify(request)) > EVALUATION_LIMITS.inputTokens / 2) {
      throw new Error('Evaluation input envelope exceeded.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const totals = this.db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(reservation),0) AS usd, SUM(CASE WHEN status != 'complete' THEN 1 ELSE 0 END) AS unresolved FROM attempts"
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
    // Holds are never released from client-side usage: hidden retries and cache billing remain unverified.
    this.db
      .prepare('UPDATE attempts SET status=?, usage=?, platform_usd=?, platform_credits=? WHERE id=?')
      .run(
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
        'SELECT model, reservation AS reservedUsd, status, usage, provider_usd AS providerPricedUsd, platform_usd AS platformUsd, platform_credits AS platformCredits FROM attempts ORDER BY rowid'
      )
      .all();
  }

  close(): void {
    this.db.close();
  }
}
