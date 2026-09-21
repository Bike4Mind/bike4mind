import { promises as fs } from 'fs';
import { existsSync, readFileSync, writeFileSync, unlinkSync, lstatSync, realpathSync, type Stats } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

/**
 * A checkpoint represents a snapshot of file state before a tool modification
 */
export interface Checkpoint {
  /** Git commit SHA (short) */
  id: string;
  /** Human-readable name, e.g. "before-edit_local_file-utils.ts" */
  name: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Tool that triggered the checkpoint */
  toolName: string;
  /** Files that were snapshotted */
  filePaths: string[];
  /** CLI session this checkpoint belongs to */
  sessionId: string;
}

interface CheckpointMetadata {
  checkpoints: Checkpoint[];
  createdAt: string;
}

/** Maximum file size to checkpoint (10MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Default number of checkpoints to keep */
const DEFAULT_KEEP_COUNT = 50;

/** Marker filename for files that didn't exist at checkpoint time */
const ABSENT_MARKER = '.b4m-absent';

/**
 * A checkpoint id is a git short/full sha we generate. It is later interpolated
 * into a git argv (`git show <id>:<path>`), where an attacker-committed value
 * like `--output=/abs/path` is parsed by git as an option and writes a file
 * outside the checkout. `.b4m/checkpoints.json` is committable by a hostile
 * clone, so reject any id that is not a plain sha before it can reach that sink.
 */
const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{4,40}$/;
function isValidCheckpointId(id: unknown): id is string {
  return typeof id === 'string' && CHECKPOINT_ID_PATTERN.test(id);
}

/**
 * CheckpointStore manages a shadow git repository for file change recovery.
 *
 * Before any file-modifying tool (create_file, edit_local_file, delete_file) executes,
 * the current state of the target file(s) is snapshotted into a hidden git repo.
 * Users can then undo/restore to any previous state.
 */
export class CheckpointStore {
  private projectDir: string;
  private shadowRepoDir: string;
  private metadataPath: string;
  private metadata: CheckpointMetadata | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  // Symlink-resolved roots captured at init(); every write/read is contained to
  // these, so a `.b4m`/`shadow-repo`/`projectDir` swapped to a symlink after init
  // is detected instead of silently followed.
  private realProjectDir: string | null = null;
  private realShadowRepoDir: string | null = null;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.shadowRepoDir = path.join(projectDir, '.b4m', 'shadow-repo');
    this.metadataPath = path.join(projectDir, '.b4m', 'checkpoints.json');
  }

  /**
   * Initialize the shadow git repository and load metadata
   */
  async init(sessionId: string): Promise<void> {
    this.sessionId = sessionId;

    // Refuse a symlinked/escaping checkpoint path BEFORE creating anything: a
    // committed `.b4m/shadow-repo -> ../..` would make every git command run
    // against the real checkout (or anywhere) instead of the sandbox.
    await this.assertCheckpointPathsSafe();

    // Create .b4m directory
    await fs.mkdir(path.join(this.projectDir, '.b4m'), { recursive: true });

    // Initialize shadow git repo if it doesn't exist. A planted `.git` that is a
    // file (gitlink) or symlink survives `git clone --recurse-submodules` and would
    // point git at an attacker-controlled gitdir, so require a real directory.
    const gitDir = path.join(this.shadowRepoDir, '.git');
    let gitStat: Stats | null = null;
    try {
      gitStat = await fs.lstat(gitDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (gitStat && !gitStat.isDirectory()) {
      throw new Error(`Refusing checkpoint: ${gitDir} is not a real git directory`);
    }
    if (!gitStat) {
      await fs.mkdir(this.shadowRepoDir, { recursive: true });
      this.git('init');
      // Configure the shadow repo to avoid user identity warnings
      this.git('config', 'user.email', 'checkpoint@b4m.local');
      this.git('config', 'user.name', 'B4M Checkpoint');
      // Create initial empty commit
      this.git('commit', '--allow-empty', '-m', 'checkpoint-init');
    }

    // Anchor the real (symlink-resolved) roots now that both dirs exist.
    this.realProjectDir = realpathSync(this.projectDir);
    this.realShadowRepoDir = realpathSync(this.shadowRepoDir);

    // Load or create metadata
    await this.loadMetadata();

    // Ensure .b4m/ is in .gitignore
    await this.ensureGitignore();

    // Auto-prune old checkpoints
    await this.pruneCheckpoints(DEFAULT_KEEP_COUNT);

    this.initialized = true;
  }

  /**
   * Update session ID (e.g., on /clear or /resume)
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Create a checkpoint by snapshotting the current state of target files
   * before they are modified by a tool.
   *
   * @param toolName - The tool about to modify files
   * @param filePaths - Relative paths of files about to be modified
   * @param name - Optional human-readable checkpoint name
   */
  async createCheckpoint(toolName: string, filePaths: string[], name?: string): Promise<Checkpoint | null> {
    if (!this.initialized || !this.sessionId) {
      return null;
    }

    const checkpointName = name || `before-${toolName}-${path.basename(filePaths[0] || 'unknown')}`;

    try {
      // Snapshot each file into the shadow repo
      let hasChanges = false;

      for (const filePath of filePaths) {
        const absolutePath = this.validatePathWithinProject(filePath);
        const shadowPath = path.join(this.shadowRepoDir, filePath);
        const shadowDir = path.dirname(shadowPath);
        const absentMarkerPath = path.join(shadowDir, `${path.basename(filePath)}${ABSENT_MARKER}`);

        // Guard the dir BEFORE mkdir - a symlinked intermediate component would
        // otherwise have `mkdir -p` create real dirs outside the sandbox - then
        // guard both leaf destinations (copyFile/writeFile follow a symlink).
        this.assertContainedSync(shadowDir, this.realShadowRoot());
        await fs.mkdir(shadowDir, { recursive: true });
        this.assertContainedSync(shadowPath, this.realShadowRoot());
        this.assertContainedSync(absentMarkerPath, this.realShadowRoot());

        if (existsSync(absolutePath)) {
          // Use lstat to detect symlinks (don't follow them)
          const stats = await fs.lstat(absolutePath);
          if (stats.isSymbolicLink()) {
            continue; // Skip symlinks for security
          }
          if (stats.size > MAX_FILE_SIZE) {
            continue; // Skip large files
          }

          // Remove absent marker if it exists
          if (existsSync(absentMarkerPath)) {
            await fs.unlink(absentMarkerPath);
          }

          // Copy file to shadow repo
          await fs.copyFile(absolutePath, shadowPath);
          hasChanges = true;
        } else {
          // File doesn't exist yet (will be created) - record as absent
          // Remove actual file from shadow if it exists from a previous checkpoint
          if (existsSync(shadowPath)) {
            await fs.unlink(shadowPath);
          }
          await fs.writeFile(absentMarkerPath, '', 'utf-8');
          hasChanges = true;
        }
      }

      if (!hasChanges) {
        return null;
      }

      // Stage and commit in shadow repo
      this.git('add', '-A');

      // Check if there are actual changes to commit
      try {
        this.git('diff', '--cached', '--quiet');
        // No changes to commit
        return null;
      } catch {
        // There are changes (git diff --quiet exits non-zero when there are diffs)
      }

      this.git('commit', '-m', checkpointName);

      // Get the commit SHA
      const sha = this.git('rev-parse', '--short', 'HEAD').trim();

      const checkpoint: Checkpoint = {
        id: sha,
        name: checkpointName,
        timestamp: new Date().toISOString(),
        toolName,
        filePaths: [...filePaths],
        sessionId: this.sessionId,
      };

      // Save metadata
      if (!this.metadata) {
        this.metadata = { checkpoints: [], createdAt: new Date().toISOString() };
      }
      this.metadata.checkpoints.push(checkpoint);
      await this.saveMetadata();

      return checkpoint;
    } catch {
      // Checkpoint failure should never block tool execution
      return null;
    }
  }

  /**
   * List checkpoints for the current session (most recent first)
   */
  listCheckpoints(): Checkpoint[] {
    if (!this.metadata || !this.sessionId) {
      return [];
    }

    return this.metadata.checkpoints.filter(cp => cp.sessionId === this.sessionId).reverse();
  }

  /**
   * Get a specific checkpoint by 1-based index (1 = most recent)
   */
  getCheckpoint(index: number): Checkpoint | null {
    const checkpoints = this.listCheckpoints();
    if (index < 1 || index > checkpoints.length) {
      return null;
    }
    return checkpoints[index - 1];
  }

  /**
   * Restore files to the state captured in a specific checkpoint
   *
   * @param index - 1-based index (1 = most recent)
   * @returns The checkpoint that was restored to
   */
  async restoreCheckpoint(index: number): Promise<Checkpoint> {
    const checkpoint = this.getCheckpoint(index);
    if (!checkpoint) {
      throw new Error(`Checkpoint #${index} not found. Use /checkpoints to see available restore points.`);
    }

    for (const filePath of checkpoint.filePaths) {
      const absolutePath = this.validatePathWithinProject(filePath);
      try {
        // Get file content at the checkpoint commit
        const content = this.git('show', `${checkpoint.id}:${filePath}`);

        // Write it back to the real working directory
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, 'utf-8');
      } catch {
        // Check if file was marked as absent at this checkpoint
        try {
          this.git('show', `${checkpoint.id}:${path.dirname(filePath)}/${path.basename(filePath)}${ABSENT_MARKER}`);
          // File was absent at this checkpoint - delete it if it exists now
          if (existsSync(absolutePath)) {
            await fs.unlink(absolutePath);
          }
        } catch {
          // File wasn't in the checkpoint at all - skip
        }
      }
    }

    return checkpoint;
  }

  /**
   * Undo the last file change (restore to most recent checkpoint)
   */
  async undoLast(): Promise<Checkpoint> {
    return this.restoreCheckpoint(1);
  }

  /**
   * Get diff between current file state and a checkpoint
   *
   * @param index - 1-based index (1 = most recent, default)
   * @returns Unified diff string
   */
  getCheckpointDiff(index: number = 1): string {
    const checkpoint = this.getCheckpoint(index);
    if (!checkpoint) {
      throw new Error(`Checkpoint #${index} not found. Use /checkpoints to see available restore points.`);
    }

    const diffParts: string[] = [];

    for (const filePath of checkpoint.filePaths) {
      const absolutePath = this.validatePathWithinProject(filePath);

      // Temp files live directly under the shadow root; refuse if a committed
      // `.diff-a`/`.diff-b` symlink would redirect the writeFileSync below.
      const tmpCheckpoint = this.assertContainedSync(path.join(this.shadowRepoDir, '.diff-a'), this.realShadowRoot());
      const tmpCurrent = this.assertContainedSync(path.join(this.shadowRepoDir, '.diff-b'), this.realShadowRoot());

      try {
        // Get checkpoint version
        let checkpointContent: string;
        try {
          checkpointContent = this.git('show', `${checkpoint.id}:${filePath}`);
        } catch {
          checkpointContent = ''; // File was absent at checkpoint
        }

        // Get current version
        let currentContent = '';
        if (existsSync(absolutePath)) {
          currentContent = readFileSync(absolutePath, 'utf-8');
        }

        if (checkpointContent === currentContent) {
          continue; // No changes
        }

        // Write temp files for git diff
        writeFileSync(tmpCheckpoint, checkpointContent, 'utf-8');
        writeFileSync(tmpCurrent, currentContent, 'utf-8');

        try {
          this.git(
            'diff',
            '--no-index',
            '--color',
            `--src-prefix=checkpoint:`,
            `--dst-prefix=current:`,
            tmpCheckpoint,
            tmpCurrent
          );
        } catch (diffError: unknown) {
          // git diff --no-index exits with 1 when files differ (that's expected)
          if (diffError && typeof diffError === 'object' && 'stdout' in diffError) {
            const output = (diffError as { stdout: Buffer }).stdout?.toString() || '';
            if (output) {
              diffParts.push(`--- ${filePath} (checkpoint #${index})\n+++ ${filePath} (current)\n${output}`);
            }
          }
        }
      } catch {
        // Skip files that can't be diffed
      } finally {
        // Always clean up temp files
        try {
          unlinkSync(tmpCheckpoint);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(tmpCurrent);
        } catch {
          /* ignore */
        }
      }
    }

    return diffParts.join('\n');
  }

  /**
   * Prune old checkpoints beyond the keep count
   */
  async pruneCheckpoints(keepCount: number = DEFAULT_KEEP_COUNT): Promise<void> {
    if (!this.metadata) return;

    const total = this.metadata.checkpoints.length;
    if (total <= keepCount) return;

    // Keep only the most recent N checkpoints
    this.metadata.checkpoints = this.metadata.checkpoints.slice(-keepCount);
    await this.saveMetadata();

    // Run git GC to clean up unreferenced objects
    try {
      this.git('gc', '--auto', '--quiet');
    } catch {
      // GC failure is non-critical
    }
  }

  /**
   * Clean up the shadow repository entirely
   */
  async cleanup(): Promise<void> {
    try {
      await fs.rm(this.shadowRepoDir, { recursive: true, force: true });
      if (existsSync(this.metadataPath)) {
        await fs.unlink(this.metadataPath);
      }
      this.metadata = null;
      this.initialized = false;
    } catch {
      // Cleanup failure is non-critical
    }
  }

  // --- Private helpers ---

  /**
   * Validate that a file path resolves within the project directory.
   * Prevents path traversal attacks (e.g., ../../etc/passwd).
   */
  private validatePathWithinProject(filePath: string): string {
    const absolutePath = path.resolve(this.projectDir, filePath);
    const normalizedProject = path.resolve(this.projectDir) + path.sep;
    if (!absolutePath.startsWith(normalizedProject) && absolutePath !== path.resolve(this.projectDir)) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    // Lexical containment is not enough: a committed symlink (intermediate dir or
    // leaf) makes the real target escape at write/read time. realpath + lstat it.
    return this.assertContainedSync(absolutePath, this.realProjectRoot());
  }

  /**
   * Refuse a checkpoint path that is a symlink or resolves outside the project.
   * A planted `.b4m` or `.b4m/shadow-repo` symlink would redirect the shadow git
   * repo out of the sandbox; lstat does not follow the link.
   */
  private async assertCheckpointPathsSafe(): Promise<void> {
    const b4mDir = path.join(this.projectDir, '.b4m');

    for (const p of [b4mDir, this.shadowRepoDir, this.metadataPath]) {
      try {
        if ((await fs.lstat(p)).isSymbolicLink()) {
          throw new Error(`Refusing symlinked checkpoint path: ${p}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // ENOENT - not created yet, nothing to follow.
      }
    }

    // Containment: the real .b4m must stay under the real project dir (guards a
    // symlinked projectDir/.b4m). Skipped when .b4m does not exist yet.
    try {
      const realProject = await fs.realpath(this.projectDir);
      const realB4m = await fs.realpath(b4mDir);
      const base = path.join(realProject, '.b4m');
      if (realB4m !== base && !realB4m.startsWith(base + path.sep)) {
        throw new Error(`Checkpoint dir escaped project: ${realB4m}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private realProjectRoot(): string {
    if (this.realProjectDir === null) this.realProjectDir = realpathSync(this.projectDir);
    return this.realProjectDir;
  }

  private realShadowRoot(): string {
    if (this.realShadowRepoDir === null) this.realShadowRepoDir = realpathSync(this.shadowRepoDir);
    return this.realShadowRepoDir;
  }

  /**
   * Refuse an absolute write/read target that escapes `realRoot` once symlinks are
   * resolved, or whose final component is itself a symlink. The single containment
   * guard for every checkpoint sink (create/restore/diff/metadata/gitignore): a
   * committed symlink - an intermediate dir or the leaf - makes the real target
   * escape at write time, which a lexical prefix check misses. For a not-yet-created
   * path we realpath the nearest existing ancestor (the missing tail cannot hold a
   * link yet) and re-append it. Returns `target` unchanged so callers can inline it.
   */
  private assertContainedSync(target: string, realRoot: string): string {
    // Refuse a symlinked leaf: copyFile/writeFile/unlink would follow it.
    try {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(`Refusing symlinked checkpoint path: ${target}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // realpath the nearest existing ancestor so a symlinked intermediate dir
    // cannot smuggle the resolved path outside realRoot.
    let existing = target;
    const tail: string[] = [];
    while (!existsSync(existing)) {
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break; // reached filesystem root
      existing = parent;
    }
    const realTarget = path.join(realpathSync(existing), ...tail);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error(`Refusing checkpoint path outside sandbox: ${target}`);
    }
    return target;
  }

  /**
   * Execute a git command in the shadow repo.
   *
   * Neutralize ambient/planted git config so an attacker `.gitconfig` or hook in
   * the clone cannot execute: /dev/null for global+system config, and
   * `core.hooksPath=/dev/null` so no hook runs on commit. Inherited env can also
   * inject config or redirect the repo, so unset the config/dir override vars
   * (GIT_CONFIG_COUNT + numbered keys, GIT_CONFIG_PARAMETERS, GIT_DIR,
   * GIT_WORK_TREE) - undefined values are dropped from the child env by Node.
   */
  private git(...args: string[]): string {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: this.shadowRepoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_COUNT: undefined,
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
      },
    });
  }

  /**
   * Load checkpoint metadata from disk
   */
  private async loadMetadata(): Promise<void> {
    try {
      if (existsSync(this.metadataPath)) {
        const data = await fs.readFile(this.metadataPath, 'utf-8');
        this.metadata = JSON.parse(data) as CheckpointMetadata;
        // Drop any entry whose id is not a plain sha (see CHECKPOINT_ID_PATTERN):
        // it would otherwise reach `git show <id>:<path>` as an option-injection.
        this.metadata.checkpoints = (this.metadata.checkpoints ?? []).filter(cp => isValidCheckpointId(cp.id));
      } else {
        this.metadata = {
          checkpoints: [],
          createdAt: new Date().toISOString(),
        };
      }
    } catch {
      this.metadata = {
        checkpoints: [],
        createdAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Save checkpoint metadata to disk
   */
  private async saveMetadata(): Promise<void> {
    if (!this.metadata) return;
    this.assertContainedSync(this.metadataPath, this.realProjectRoot());
    await fs.writeFile(this.metadataPath, JSON.stringify(this.metadata, null, 2), 'utf-8');
  }

  /**
   * Ensure .b4m/ is in .gitignore
   */
  private async ensureGitignore(): Promise<void> {
    const gitignorePath = path.join(this.projectDir, '.gitignore');
    const entryToAdd = '.b4m/';

    try {
      // A committed `.gitignore` symlink would make the readFile/writeFile below
      // follow the link and corrupt a file outside the checkout - at CLI startup,
      // with no user action. Refuse it before touching the file.
      this.assertContainedSync(gitignorePath, this.realProjectRoot());

      let content = '';
      try {
        content = await fs.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist
      }

      // Check if .b4m/ is already ignored
      if (content.includes(entryToAdd) || content.includes('.b4m')) {
        return;
      }

      const newContent = content.trim() + (content ? '\n' : '') + `\n# B4M checkpoint data\n${entryToAdd}\n`;
      await fs.writeFile(gitignorePath, newContent, 'utf-8');
    } catch {
      // Gitignore update failure is non-critical
    }
  }
}
