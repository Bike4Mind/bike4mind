import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * The projects whose `.claude/skills/` the user has agreed to load.
 *
 * A project skill is executable instruction text that arrives WITH A CLONE. Opening someone
 * else's repository in Code mode must not arm `/deploy` with whatever that repository's author
 * wrote, so a project contributes no skills until the user says so once, for that path, and the
 * answer is remembered. This is the desktop's half of CustomCommandStore.setProjectTrusted -
 * that flag defaults false precisely so a caller that forgets this store gets silence rather
 * than repo skills.
 *
 * Matching is EXACT, not prefix. Trusting ~/work/myrepo must not trust ~/work/somebody-elses,
 * and a worktree the user made is its own path. The one exception is `inheritsFrom`: a worktree
 * this app created for a session answers with its main checkout's trust, because every session
 * gets a fresh one and asking again each time taught nothing but to click through. Revoking the
 * main checkout therefore revokes them all.
 *
 * Written the way AccessStore writes grants - 0600, write-then-rename - because a truncated
 * file here reads as "nothing trusted", which is the direction a corrupt read should fail in.
 */
export class ProjectTrustStore {
  private trusted: string[] | null = null;

  constructor(
    private readonly filePath: string,
    private readonly inheritsFrom?: (directory: string) => Promise<string | null>
  ) {}

  async list(): Promise<string[]> {
    if (this.trusted) return this.trusted;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { trusted?: unknown };
      this.trusted = Array.isArray(parsed.trusted)
        ? parsed.trusted.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      // Missing or corrupt reads as "nothing trusted", which fails closed.
      this.trusted = [];
    }
    return this.trusted;
  }

  async isTrusted(directory: string): Promise<boolean> {
    const absolute = resolve(directory);
    const trusted = await this.list();
    if (trusted.includes(absolute)) return true;
    const owner = await this.inheritsFrom?.(absolute).catch(() => null);
    return owner ? trusted.includes(resolve(owner)) : false;
  }

  async trust(directory: string): Promise<string[]> {
    const absolute = resolve(directory);
    const current = await this.list();
    if (current.includes(absolute)) return current;
    return this.write([...current, absolute]);
  }

  async revoke(directory: string): Promise<string[]> {
    const absolute = resolve(directory);
    return this.write((await this.list()).filter(entry => entry !== absolute));
  }

  private async write(trusted: string[]): Promise<string[]> {
    this.trusted = trusted;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ trusted }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
    return trusted;
  }
}
