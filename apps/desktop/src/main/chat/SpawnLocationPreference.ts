import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseSpawnLocation, type SpawnLocation } from '@shared/spawnLocation';

/**
 * The Settings choice of where a suggested session starts (see @shared/spawnLocation). Read by
 * ChatService.suggestionHost on every session_spawn, so it is cached after the first read.
 */
export class SpawnLocationPreference {
  private location: SpawnLocation | null = null;
  // Serialised so two quick changes land in order and never interleave two renames.
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<SpawnLocation> {
    if (this.location) return this.location;
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      stored = undefined;
    }
    const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
    this.location = parseSpawnLocation(record.location);
    return this.location;
  }

  async record(next: unknown): Promise<SpawnLocation> {
    const location = parseSpawnLocation(next);
    this.location = location;
    this.writes = this.writes.then(() => this.write(location));
    await this.writes;
    return location;
  }

  private async write(location: SpawnLocation): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ location }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
