import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { studioIdSchema, studioWorkspaceIdentitySchema, type StudioWorkspaceIdentity } from '@shared/studio';
import type { ChatSession } from '@shared/chat';

/** Kept beside the conversation files, so a scan of a scope directory must skip it. */
export const STUDIO_BINDINGS_DIRECTORY = '.studio-bindings';

export class StudioFamilyStore {
  async resolve(
    directory: string,
    sessionId: string,
    read: (id: string) => Promise<ChatSession | null>,
    requirePresent = true
  ): Promise<StudioWorkspaceIdentity | null> {
    studioIdSchema.parse(sessionId);
    try {
      await stat(join(directory, `${sessionId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (requirePresent) return null;
      } else {
        throw error;
      }
    }
    const visited: string[] = [];
    let current = sessionId;
    let identity: StudioWorkspaceIdentity;
    while (true) {
      if (visited.includes(current) || visited.length >= 256) return null;
      const bound = await this.readBinding(directory, current);
      if (bound) {
        identity = bound;
        break;
      }
      visited.push(current);
      const session = await read(current);
      if (session?.studioWorkspaceId && session.studioRootSessionId) {
        identity = { workspaceId: session.studioWorkspaceId, rootSessionId: session.studioRootSessionId };
        break;
      }
      const parent = session?.origin?.parentSessionId;
      if (!parent) {
        identity = { workspaceId: current, rootSessionId: current };
        break;
      }
      if (!studioIdSchema.safeParse(parent).success) return null;
      current = parent;
    }
    // Bind ancestors first: overlapping resolutions must adopt the same winner.
    for (const id of visited.reverse()) identity = await this.bind(directory, id, identity);
    return identity;
  }

  private async readBinding(directory: string, id: string): Promise<StudioWorkspaceIdentity | null> {
    try {
      return studioWorkspaceIdentitySchema.parse(
        JSON.parse(await readFile(join(directory, STUDIO_BINDINGS_DIRECTORY, id), 'utf8'))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async bind(
    directory: string,
    id: string,
    identity: StudioWorkspaceIdentity
  ): Promise<StudioWorkspaceIdentity> {
    const bindings = join(directory, STUDIO_BINDINGS_DIRECTORY);
    await mkdir(bindings, { recursive: true });
    const temporary = join(bindings, `${id}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(identity), 'utf8');
    try {
      await link(temporary, join(bindings, id));
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readBinding(directory, id);
      if (!existing) throw new Error('Studio binding disappeared');
      return existing;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
