import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { withLockDir } from '../../storage/lockDir.js';

const DestinationSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
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
    return RegistrySchema.parse(JSON.parse(text) as unknown);
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
        } finally {
          await fs.rm(temp, { force: true });
        }
      },
      { waitMs: 15_000, staleMs: 10_000, pollMs: 10, heldMessage: 'Mirror registry is busy' }
    );
  }

  async add(destination: Omit<MirrorDestination, 'paused' | 'createdAt'>): Promise<void> {
    const entry = DestinationSchema.parse({ ...destination, paused: false, createdAt: new Date().toISOString() });
    if (!path.isAbsolute(entry.directory)) throw new Error('Destination directory must be an absolute path');
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
