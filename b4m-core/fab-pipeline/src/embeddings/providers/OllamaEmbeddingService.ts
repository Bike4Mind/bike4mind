import { OllamaEmbeddingModel } from '@bike4mind/common';
import { EmbeddingModelInfo, EmbeddingService, embeddingModelInfoMap } from '../EmbeddingService';

export const OLLAMA_EMBEDDING_MODEL_MAP = embeddingModelInfoMap(Object.values(OllamaEmbeddingModel));

/** Ollama batches many inputs per /api/embed call; cap sub-batch size to bound memory. */
const OLLAMA_EMBED_BATCH_SIZE = 64;

/**
 * Embedding provider backed by a local Ollama server (/api/embed). No SDK and no
 * new dependency: uses global fetch. Mirrors OllamaBackend's inline basic-auth
 * handling so a URL like http://user:pass@host works behind a reverse proxy.
 */
export class OllamaEmbeddingService implements EmbeddingService {
  private baseUrl: string;
  private model: OllamaEmbeddingModel;
  private authHeader?: string;
  private keepAlive: string;

  constructor(baseUrl: string, model: OllamaEmbeddingModel = OllamaEmbeddingModel.NOMIC_EMBED_TEXT) {
    const url = new URL(baseUrl);
    if (url.username && url.password) {
      this.authHeader = `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
      url.username = '';
      url.password = '';
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.validateModel(model);
    this.model = model;
    // Unload the embedder promptly after each call by default so it does not pin
    // VRAM on small (e.g. 4GB) GPUs shared with the chat model. Override via env.
    // Use || not ??: a declared-but-empty var ('') is an invalid Ollama duration.
    this.keepAlive = process.env.OLLAMA_EMBED_KEEP_ALIVE || '0';
  }

  private validateModel(model: OllamaEmbeddingModel): void {
    if (!OLLAMA_EMBEDDING_MODEL_MAP[model]) {
      throw new Error(`Invalid Ollama embedding model: ${model}`);
    }
  }

  private async embed(input: string | string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }

    // Size Ollama's context/batch to this model's window. Ollama's embedding defaults
    // (num_ctx 4096, num_ubatch 2048) reserve a ~1.2GB compute buffer that inflates a
    // 0.6B embedder to ~2.3GB and spills it to CPU on a 4GB card. num_ctx must cover the
    // chunk (else truncation); num_batch stays small since Ollama sub-batches longer inputs
    // with no meaningful change to the embedding (verified: cosine ~0.9997 vs one batch).
    const { contextWindow } = OLLAMA_EMBEDDING_MODEL_MAP[this.model];
    const options = { num_ctx: contextWindow, num_batch: Math.min(512, contextWindow) };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input, keep_alive: this.keepAlive, options }),
      });
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw new Error(
          `Could not connect to Ollama at ${this.baseUrl}: is Ollama running and the "${this.model}" model pulled?`
        );
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama embed request failed (${response.status} ${response.statusText}): ${body}`);
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    const embeddings = data.embeddings;
    const inputCount = Array.isArray(input) ? input.length : 1;
    if (!Array.isArray(embeddings) || embeddings.length !== inputCount) {
      throw new Error(
        `Ollama returned ${embeddings?.length ?? 0} embeddings for ${inputCount} input(s) from "${this.model}"`
      );
    }
    return embeddings;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.embed(text);
    return embedding;
  }

  async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += OLLAMA_EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + OLLAMA_EMBED_BATCH_SIZE);
      results.push(...(await this.embed(batch)));
    }
    return results;
  }

  getModelInfo(): EmbeddingModelInfo<OllamaEmbeddingModel> {
    return OLLAMA_EMBEDDING_MODEL_MAP[this.model];
  }
}
