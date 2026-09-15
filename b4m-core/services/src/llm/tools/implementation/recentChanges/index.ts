import { ToolDefinition } from '../../base/types';
import { spawn } from 'child_process';

interface RecentChangesParams {
  since?: string;
  path?: string;
  limit?: number;
  include_stats?: boolean;
}

interface FileChange {
  path: string;
  changes: number;
  additions?: number;
  deletions?: number;
}

interface WorkingTreeFile {
  path: string;
  status: 'staged' | 'unstaged' | 'untracked';
  type: string; // e.g. 'modified', 'added', 'deleted', 'renamed'
}

interface RecentChangesResult {
  files: FileChange[];
  workingTree: WorkingTreeFile[];
  timeRange: string;
  totalFiles: number;
  error?: string;
}

/**
 * Default parameters
 */
const DEFAULT_SINCE = '7 days ago';
const DEFAULT_LIMIT = 50;
const DEFAULT_INCLUDE_STATS = false;

/**
 * Parse git status --porcelain output into WorkingTreeFile entries
 */
function parseStatusLine(line: string): WorkingTreeFile[] {
  const results: WorkingTreeFile[] = [];
  if (line.length < 4) return results;

  const indexStatus = line[0];
  const workTreeStatus = line[1];
  const filePath = line.slice(3);

  const typeMap: Record<string, string> = {
    M: 'modified',
    A: 'added',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
  };

  // Staged change (index has a status)
  if (indexStatus !== ' ' && indexStatus !== '?') {
    results.push({
      path: filePath,
      status: 'staged',
      type: typeMap[indexStatus] || 'modified',
    });
  }

  // Unstaged change (work tree has a status)
  if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
    results.push({
      path: filePath,
      status: 'unstaged',
      type: typeMap[workTreeStatus] || 'modified',
    });
  }

  // Untracked file
  if (indexStatus === '?' && workTreeStatus === '?') {
    results.push({
      path: filePath,
      status: 'untracked',
      type: 'added',
    });
  }

  return results;
}

/**
 * Get working tree changes (staged, unstaged, untracked) via git status
 */
async function getWorkingTreeChanges(filterPath?: string): Promise<WorkingTreeFile[]> {
  const args = ['status', '--porcelain'];

  if (filterPath) {
    args.push('--', filterPath);
  }

  return new Promise(resolve => {
    const proc = spawn('git', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', exitCode => {
      if (exitCode !== 0) {
        resolve([]);
        return;
      }

      const files = stdout
        .split('\n')
        .filter(line => line.length > 0)
        .flatMap(parseStatusLine);

      resolve(files);
    });

    proc.on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Execute git log command to get recently changed files
 */
async function getRecentChanges(params: RecentChangesParams): Promise<RecentChangesResult> {
  const {
    since = DEFAULT_SINCE,
    path: filterPath,
    limit = DEFAULT_LIMIT,
    include_stats = DEFAULT_INCLUDE_STATS,
  } = params;

  // Build git log command
  const args = ['log', `--since=${since}`, '--name-only', '--pretty=format:'];

  // Add path filter if specified
  if (filterPath) {
    args.push('--', filterPath);
  }

  return new Promise(resolve => {
    const proc = spawn('git', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', async exitCode => {
      // Always fetch working tree changes
      const workingTree = await getWorkingTreeChanges(filterPath);

      if (exitCode !== 0) {
        resolve({
          files: [],
          workingTree,
          timeRange: since,
          totalFiles: 0,
          error: stderr || 'Git command failed',
        });
        return;
      }

      // Parse output to count file changes
      const files = stdout
        .split('\n')
        .filter(line => line.trim().length > 0)
        .reduce((acc, filePath) => {
          const existing = acc.find(f => f.path === filePath);
          if (existing) {
            existing.changes++;
          } else {
            acc.push({ path: filePath, changes: 1 });
          }
          return acc;
        }, [] as FileChange[]);

      // Sort by number of changes (most active first)
      files.sort((a, b) => b.changes - a.changes);

      // Limit results
      const limitedFiles = files.slice(0, limit);

      // Get stats if requested
      if (include_stats && limitedFiles.length > 0) {
        const filesWithStats = await getFileStats(limitedFiles, since, filterPath);
        resolve({
          files: filesWithStats,
          workingTree,
          timeRange: since,
          totalFiles: files.length,
        });
      } else {
        resolve({
          files: limitedFiles,
          workingTree,
          timeRange: since,
          totalFiles: files.length,
        });
      }
    });

    proc.on('error', async error => {
      const workingTree = await getWorkingTreeChanges(filterPath);
      resolve({
        files: [],
        workingTree,
        timeRange: since,
        totalFiles: 0,
        error: `Failed to execute git command: ${error.message}`,
      });
    });
  });
}

/**
 * Get detailed stats (additions/deletions) for files
 */
async function getFileStats(files: FileChange[], since: string, filterPath?: string): Promise<FileChange[]> {
  const args = ['log', `--since=${since}`, '--numstat', '--pretty=format:'];

  if (filterPath) {
    args.push('--', filterPath);
  }

  return new Promise(resolve => {
    const proc = spawn('git', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', () => {
      // Parse numstat output
      const stats = new Map<string, { additions: number; deletions: number }>();
      stdout.split('\n').forEach(line => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
          const [, additions, deletions, filePath] = match;
          const existing = stats.get(filePath);
          if (existing) {
            existing.additions += parseInt(additions, 10);
            existing.deletions += parseInt(deletions, 10);
          } else {
            stats.set(filePath, {
              additions: parseInt(additions, 10),
              deletions: parseInt(deletions, 10),
            });
          }
        }
      });

      // Add stats to files
      const result = files.map(file => {
        const stat = stats.get(file.path);
        if (stat) {
          return { ...file, ...stat };
        }
        return file;
      });

      resolve(result);
    });

    proc.on('error', () => {
      // If stats fail, just return files without stats
      resolve(files);
    });
  });
}

/**
 * Format the result for display
 */
function formatResult(result: RecentChangesResult): string {
  const parts: string[] = [];

  if (result.error) {
    parts.push(`Error: ${result.error}`);
    parts.push('');
    parts.push('Make sure you are running this command in a git repository.');
    // Still show working tree changes even if git log failed
    if (result.workingTree.length > 0) {
      parts.push('');
      parts.push(formatWorkingTree(result.workingTree));
    }
    return parts.join('\n');
  }

  // Working tree section (staged, unstaged, untracked)
  if (result.workingTree.length > 0) {
    parts.push(formatWorkingTree(result.workingTree));
    parts.push('');
  }

  // Committed changes section
  parts.push(`Recently committed files (${result.timeRange}):`);
  parts.push('');

  if (result.files.length === 0) {
    parts.push('No files changed in this time period.');
  } else {
    // Format file list
    result.files.forEach((file, index) => {
      const stats =
        file.additions !== undefined && file.deletions !== undefined ? ` (+${file.additions}/-${file.deletions})` : '';
      parts.push(`${index + 1}. ${file.path} (${file.changes} commits)${stats}`);
    });

    // Add summary
    if (result.totalFiles > result.files.length) {
      parts.push('');
      parts.push(`Showing ${result.files.length} of ${result.totalFiles} changed files.`);
      parts.push(`Use the 'limit' parameter to see more files.`);
    }
  }

  return parts.join('\n');
}

/**
 * Format working tree changes for display
 */
function formatWorkingTree(workingTree: WorkingTreeFile[]): string {
  const parts: string[] = [];

  const staged = workingTree.filter(f => f.status === 'staged');
  const unstaged = workingTree.filter(f => f.status === 'unstaged');
  const untracked = workingTree.filter(f => f.status === 'untracked');

  parts.push('Working tree changes:');

  if (staged.length > 0) {
    parts.push('');
    parts.push(`  Staged (${staged.length}):`);
    staged.forEach(f => parts.push(`    ${f.type}: ${f.path}`));
  }

  if (unstaged.length > 0) {
    parts.push('');
    parts.push(`  Unstaged (${unstaged.length}):`);
    unstaged.forEach(f => parts.push(`    ${f.type}: ${f.path}`));
  }

  if (untracked.length > 0) {
    parts.push('');
    parts.push(`  Untracked (${untracked.length}):`);
    untracked.forEach(f => parts.push(`    ${f.path}`));
  }

  return parts.join('\n');
}

export const recentChangesTool: ToolDefinition = {
  name: 'recent_changes',
  implementation: context => ({
    toolFn: async value => {
      const params = value as RecentChangesParams;

      context.logger.info('RecentChanges: Getting recently changed files', {
        since: params.since || DEFAULT_SINCE,
        path: params.path || 'all',
        limit: params.limit || DEFAULT_LIMIT,
        include_stats: params.include_stats || DEFAULT_INCLUDE_STATS,
      });

      // Notify start
      if (context.onStart) {
        await context.onStart('recent_changes', {
          since: params.since,
          path: params.path,
        });
      }

      try {
        const result = await getRecentChanges(params);
        const formattedResult = formatResult(result);

        context.logger.info('RecentChanges: Retrieved file changes', {
          totalFiles: result.totalFiles,
          displayedFiles: result.files.length,
          error: result.error,
        });

        // Notify finish
        if (context.onFinish) {
          await context.onFinish('recent_changes', {
            totalFiles: result.totalFiles,
            displayedFiles: result.files.length,
          });
        }

        return formattedResult;
      } catch (error) {
        context.logger.error('RecentChanges: Failed to get changes', error);

        // Notify finish with error
        if (context.onFinish) {
          await context.onFinish('recent_changes', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        throw error;
      }
    },
    toolSchema: {
      name: 'recent_changes',
      description: `Get a list of recently changed files in the git repository, including uncommitted working tree changes (staged, unstaged, and untracked files) plus committed changes sorted by activity. This tool is extremely useful for:

- **Debugging recent issues**: "Something broke after my last commit" → See exactly what changed
- **Understanding active development**: "What are we working on?" → See most active files and current work-in-progress
- **Code review preparation**: "What changed since last release?" → Get comprehensive file list
- **Feature context**: "What files are part of the new dashboard?" → Filter by path
- **Current work-in-progress**: See staged, unstaged, and untracked files alongside commit history

The tool combines git status (working tree) with git log (commit history) to give a complete picture of recent activity. Working tree changes are shown first, followed by committed files ranked by number of commits (most active first).

**Time Range Examples:**
- "7 days ago" (default)
- "2 hours ago"
- "3 weeks ago"
- "2025-01-01"
- "yesterday"

**Path Filter Examples:**
- "src/components" - Only files in components directory
- "apps/client" - Only client app files
- "**/*.test.ts" - Only test files (use glob patterns)

**Performance:** Very fast (< 1 second) since it only queries git metadata, not file contents.`,
      parameters: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description:
              'Time range for changes (default: "7 days ago"). Examples: "2 hours ago", "3 weeks ago", "2025-01-01", "yesterday".',
          },
          path: {
            type: 'string',
            description:
              'Optional path filter to limit results to specific directory or pattern. Examples: "src/components", "apps/client", "**/*.test.ts".',
          },
          limit: {
            type: 'number',
            description:
              'Maximum number of files to return (default: 50). Files are sorted by activity (most commits first).',
          },
          include_stats: {
            type: 'boolean',
            description:
              'Include lines added/removed statistics for each file (default: false). Note: This makes the command slightly slower.',
          },
        },
        required: [],
      },
    },
  }),
};
