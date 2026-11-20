import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_PROMPT_CACHE_TTL, isPromptCacheTtl, type PromptCacheTtl } from '@bike4mind/common';

/**
 * The prompt-cache lifetime a new conversation starts with: the last one the user picked in the
 * composer, '5m' until then or when the file cannot be read. The same shape as
 * ApprovalModePreference; an existing conversation keeps the lifetime it was given.
 */
export class PromptCacheTtlPreference {
  private ttl: PromptCacheTtl | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<PromptCacheTtl> {
    if (this.ttl) return this.ttl;
    let stored: unknown;
    try {
      stored = (JSON.parse(await readFile(this.filePath, 'utf8')) as { ttl?: unknown }).ttl;
    } catch {
      stored = undefined;
    }
    this.ttl = isPromptCacheTtl(stored) ? stored : DEFAULT_PROMPT_CACHE_TTL;
    return this.ttl;
  }

  async record(ttl: PromptCacheTtl): Promise<void> {
    this.ttl = ttl;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ ttl }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
