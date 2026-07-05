import { promises as fs } from 'fs';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
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

    // Create .b4m directory
    await fs.mkdir(path.join(this.projectDir, '.b4m'), { recursive: true });

    // Initialize shadow git repo if it doesn't exist
    if (!existsSync(path.join(this.shadowRepoDir, '.git'))) {
      await fs.mkdir(this.shadowRepoDir, { recursive: true });
      this.git('init');
      // Configure the shadow repo to avoid user identity warnings
      this.git('config', 'user.email', 'checkpoint@b4m.local');
      this.git('config', 'user.name', 'B4M Checkpoint');
      // Create initial empty commit
      this.git('commit', '--allow-empty', '-m', 'checkpoint-init');
    }

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

        await fs.mkdir(shadowDir, { recursive: true });

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

      const tmpCheckpoint = path.join(this.shadowRepoDir, '.diff-a');
      const tmpCurrent = path.join(this.shadowRepoDir, '.diff-b');

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
    return absolutePath;
  }

  /**
   * Execute a git command in the shadow repo
   */
  private git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.shadowRepoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
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
    await fs.writeFile(this.metadataPath, JSON.stringify(this.metadata, null, 2), 'utf-8');
  }

  /**
   * Ensure .b4m/ is in .gitignore
   */
  private async ensureGitignore(): Promise<void> {
    const gitignorePath = path.join(this.projectDir, '.gitignore');
    const entryToAdd = '.b4m/';

    try {
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
