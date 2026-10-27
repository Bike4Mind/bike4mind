import { z } from 'zod';
import { EMBEDDING_MODEL_CATALOG } from '@bike4mind/common';
import { embeddingModelsOf } from '../models';
import { assertOneVectorPerInput, preflightEmbeddingRequest, sumReportedTokens } from '../preflight';
import type { EmbeddingContext, EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from '../types';

/** Ollama batches many inputs per /api/embed call; cap sub-batch size to bound memory. */
const OLLAMA_EMBED_BATCH_SIZE = 64;

const ollamaResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())).optional(),
  prompt_eval_count: z.number().optional(),
});

/**
 * Embeds through a local Ollama server (/api/embed) with global fetch. Inline basic auth in the URL
 * (http://user:pass@host) becomes an Authorization header so it works behind a reverse proxy.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';
  readonly models = embeddingModelsOf('ollama');

  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly keepAlive: string;

  constructor({ baseUrl }: { baseUrl?: string | null }) {
    if (!baseUrl) throw new Error('Ollama base URL is required but not provided');
    const url = new URL(baseUrl);
    if (url.username && url.password) {
      this.authHeader = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
      url.username = '';
      url.password = '';
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    // Unload the embedder promptly after each call so it does not pin VRAM on small GPUs shared with the chat model.
    // `||` not `??`: a declared-but-empty var is an invalid Ollama duration.
    this.keepAlive = process.env.OLLAMA_EMBED_KEEP_ALIVE || '0';
  }

  async embed(request: EmbeddingRequest, context: EmbeddingContext = {}): Promise<EmbeddingResult> {
    preflightEmbeddingRequest(this, request);
    if (request.inputs.length === 0) return { vectors: [] };
    context.signal?.throwIfAborted();

    const vectors: number[][] = [];
    const reportedTokens: (number | undefined)[] = [];
    for (let start = 0; start < request.inputs.length; start += OLLAMA_EMBED_BATCH_SIZE) {
      const batch = request.inputs.slice(start, start + OLLAMA_EMBED_BATCH_SIZE);
      const outcome = await this.embedBatch(request.model, batch, context);
      vectors.push(...outcome.vectors);
      reportedTokens.push(outcome.inputTokens);
    }

    assertOneVectorPerInput('Ollama', request.inputs.length, vectors.length);
    return { vectors, inputTokens: sumReportedTokens(reportedTokens) };
  }

  private async embedBatch(
    model: EmbeddingRequest['model'],
    inputs: readonly string[],
    context: EmbeddingContext
  ): Promise<{ vectors: number[][]; inputTokens?: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;

    // Size Ollama's context/batch to this model's window: its embedding defaults (num_ctx 4096, num_ubatch 2048)
    // reserve a ~1.2GB compute buffer that spills a small embedder to CPU on a 4GB card. num_ctx must cover the chunk
    // (else truncation); num_batch stays small since Ollama sub-batches longer inputs without changing the embedding.
    const { maxInputTokens } = EMBEDDING_MODEL_CATALOG[model];
    const options = { num_ctx: maxInputTokens, num_batch: Math.min(512, maxInputTokens) };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: inputs, keep_alive: this.keepAlive, options }),
        signal: context.signal,
      });
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw new Error(
          `Could not connect to Ollama at ${this.baseUrl}: is Ollama running and the "${model}" model pulled?`
        );
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama embed request failed (${response.status} ${response.statusText}): ${body}`);
    }

    const { embeddings, prompt_eval_count } = ollamaResponseSchema.parse(await response.json());
    if (!embeddings || embeddings.length !== inputs.length) {
      throw new Error(
        `Ollama returned ${embeddings?.length ?? 0} embeddings for ${inputs.length} input(s) from "${model}"`
      );
    }
    return { vectors: embeddings, inputTokens: prompt_eval_count };
  }
}
