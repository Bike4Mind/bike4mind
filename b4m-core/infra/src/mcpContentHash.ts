import { createHash } from 'node:crypto';

/**
 * Inputs to the MCP content hash, injected so the computation is testable without a git repo.
 */
export interface McpContentHashSources {
  /**
   * Workspace directories whose code the MCP bundle carries. Must stay in sync with the
   * `b4m-core/*` entries in copyFiles in infra/mcp.ts - a path dropped here stops moving the
   * version. That file's comment is the fuller statement of the obligation, including what may be
   * copied without being hashed.
   */
  paths: readonly string[];
  /**
   * `git ls-tree -r HEAD <path>` output for ONE path. Read per path, not as a single multi-path
   * invocation, because a multi-path read cannot tell a path that vanished from one that did not.
   */
  readTree: (path: string) => string;
}

/**
 * Content hash of the workspace code copied into the MCP lambda, used as MCP_VERSION so a
 * code-only change redeploys the handler. SST does not notice copyFiles CONTENT changes, so
 * without this the lambda keeps serving whatever code it had when its config last changed.
 *
 * Every failure mode here is deliberately loud, because this value's whole job is to CHANGE and a
 * silently-constant one re-creates the staleness it exists to prevent. The shell pipeline this
 * replaced had three such holes, none of which surfaced as an error:
 *   - it ended in `awk`, so the shell reported awk's status, not md5sum's, and a missing `md5sum`
 *     (not a stock macOS binary) yielded an empty hash from a successful pipeline;
 *   - `git ls-tree -r HEAD <path>` exits 0 with NO output for a path absent from the tree, so a
 *     partial checkout hashed a smaller set, and a wholly absent one hashed to md5("") - an 8-hex
 *     constant that reads like a real answer;
 *   - it kept only the blob SHA column, so a file renamed with identical content moved no bits.
 * Hashing the raw ls-tree text keeps paths and modes in the digest, which closes the third.
 */
export function computeMcpContentHash(sources: McpContentHashSources): string {
  if (sources.paths.length === 0) {
    throw new Error('MCP content hash: no paths given, which would hash to a constant and pin MCP_VERSION.');
  }

  const digest = createHash('md5');
  for (const path of sources.paths) {
    const tree = sources.readTree(path);
    if (tree.trim().length === 0) {
      throw new Error(
        `MCP content hash: \`git ls-tree\` listed no files under ${path}. That exits 0 when the path ` +
          'is absent from the tree, so this would otherwise hash a smaller set of code, or a constant, ' +
          'and pin MCP_VERSION while the lambda serves previous code.'
      );
    }
    // Path is folded in so the digest reflects the configured set, not just the bytes git returned.
    digest.update(path).update('\0').update(tree).update('\0');
  }

  return digest.digest('hex').slice(0, 8);
}
