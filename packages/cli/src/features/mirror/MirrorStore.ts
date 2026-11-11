import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { withLockDir } from '../../storage/lockDir.js';

export const DESTINATION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const DESTINATION_NAME_ERROR = "Destination name must be 1-64 letters, digits, '_' or '-'";

export function assertValidDestinationName(name: string): void {
  if (!DESTINATION_NAME_PATTERN.test(name)) throw new Error(DESTINATION_NAME_ERROR);
}

const DestinationSchema = z.object({
  name: z.string().regex(DESTINATION_NAME_PATTERN),
  directory: z.string().min(1),
  accountId: z.string().min(1),
  apiUrl: z.string().url(),
  paused: z.boolean(),
  createdAt: z.string().datetime(),
});

export type MirrorDestination = z.infer<typeof DestinationSchema>;

const RegistrySchema = z.object({ version: z.literal(1), destinations: z.array(DestinationSchema) });
type Registry = z.infer<typeof RegistrySchema>;

export class MirrorStore {
  constructor(private readonly file = path.join(homedir(), '.bike4mind', 'mirrors.json')) {}

  private async read(): Promise<Registry> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, destinations: [] };
      throw error;
    }
    const malformed = new Error(`${this.file} is malformed; fix or remove it`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw malformed;
    }
    const parsed = RegistrySchema.safeParse(json);
    if (!parsed.success) throw malformed;
    return parsed.data;
  }

  async list(): Promise<MirrorDestination[]> {
    return (await this.read()).destinations;
  }

  private async change(edit: (destinations: MirrorDestination[]) => MirrorDestination[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await withLockDir(
      `${this.file}.lock`,
      async held => {
        const current = await this.read();
        const next = RegistrySchema.parse({ version: 1, destinations: edit(current.destinations) });
        const target = await fs.realpath(this.file).catch(() => this.file);
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
          await held.assertHeld();
          await fs.rename(temp, target);
          await fs.chmod(target, 0o600);
        } catch (error) {
          await fs.rm(temp, { force: true });
          throw error;
        }
      },
      { waitMs: 15_000, staleMs: 10_000, pollMs: 10, heldMessage: 'Mirror registry is busy' }
    );
  }

  async add(destination: Omit<MirrorDestination, 'paused' | 'createdAt'>): Promise<void> {
    const parsed = DestinationSchema.safeParse({ ...destination, paused: false, createdAt: new Date().toISOString() });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0] ?? 'value')))];
      throw new Error(fields.includes('name') ? DESTINATION_NAME_ERROR : `Invalid destination: ${fields.join(', ')}`);
    }
    if (!path.isAbsolute(parsed.data.directory)) throw new Error('Destination directory must be an absolute path');
    const entry = { ...parsed.data, directory: path.resolve(parsed.data.directory) };
    await this.change(destinations => {
      if (destinations.some(existing => existing.name === entry.name)) throw new Error('Destination already exists');
      return [...destinations, entry];
    });
  }

  async pause(name: string, paused: boolean): Promise<void> {
    await this.change(destinations => {
      if (!destinations.some(destination => destination.name === name)) throw new Error('Destination not found');
      return destinations.map(destination => (destination.name === name ? { ...destination, paused } : destination));
    });
  }

  async revoke(name: string): Promise<void> {
    await this.change(destinations => {
      if (!destinations.some(destination => destination.name === name)) throw new Error('Destination not found');
      return destinations.filter(destination => destination.name !== name);
    });
  }
}
