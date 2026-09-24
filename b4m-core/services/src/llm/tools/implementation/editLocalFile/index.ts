import { ToolDefinition } from '../../base/types';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { diffLines, type Change } from 'diff';
import { assertPathAllowed } from '../../utils/pathValidation';
import { fuzzyMatch, type FuzzyStrategy } from './fuzzyMatch';

interface EditLocalFileParams {
  path: string;
  old_string: string;
  new_string: string;
  /**
   * Internal, NOT part of the tool schema. sha256 of the file content the caller
   * approved. A fuzzy fallback can write a wider span than old_string names, so
   * the write proceeds only when the file still hashes to this value - binding
   * the approval to the exact bytes seen at confirmation time (closes the gate
   * -> write TOCTOU). Injected by the CLI permission layer; the model cannot set
   * it (absent from the schema, and it would need the exact content hash anyway).
   * Exact matches are deterministic and ignore it.
   */
  confirmedFuzzyHash?: string;
  /**
   * Internal, NOT part of the tool schema. The gate's already-resolved span (see
   * {@link resolveEditLocalFile}), paired with the content hash it was resolved
   * against. The write path still reads the file fresh - the file can change between
   * the gate and the write with no permission prompt involved (another tool call, a
   * formatter, a watcher), so the read itself can never be safely skipped - but when
   * the fresh hash still matches `contentHash`, it reuses `resolvedEdit` instead of
   * re-running resolveEdit()'s string-matching pass. Injected by the CLI permission
   * layer, which strips any caller-supplied value before conditionally re-adding its
   * own - this file does not rely on that alone, and independently verifies the
   * reused span against the actual bytes (see {@link isResolvedEditConsistent})
   * before trusting it.
   */
  gateSnapshot?: {
    contentHash: string;
    resolvedEdit: ResolvedEdit;
  };
}

interface EditLocalFileResult {
  /** Human/model-facing summary of the edit (success message + diff). */
  message: string;
  /** Set when the edit was resolved via the fuzzy fallback rather than an exact match. */
  strategy?: FuzzyStrategy;
}

interface DiffResult {
  additions: number;
  deletions: number;
  diff: string;
}

/** The span of the file to replace and what to replace it with. */
export interface ResolvedEdit {
  startIndex: number;
  matchedText: string;
  replacement: string;
  /** Set only when the exact fast path missed and a fuzzy matcher resolved the span. */
  strategy?: FuzzyStrategy;
}

/**
 * Raised by the write path when a fuzzy edit is not bound to the current file
 * snapshot (no `confirmedFuzzyHash`, or it no longer matches the file on disk).
 * The CLI permission layer catches this, re-prompts with {@link diffPreview} - the
 * REAL resolved span - and retries bound to {@link contentHash}. Carries `code`
 * (survives the tool-output sanitizer, which only rewrites `.message`) so callers
 * can detect it without relying on `instanceof` across a package boundary.
 */
export class FuzzyEditConfirmationRequiredError extends Error {
  readonly code = 'FUZZY_EDIT_CONFIRMATION_REQUIRED';
  constructor(
    readonly resolvedPath: string,
    readonly contentHash: string,
    readonly diffPreview: string
  ) {
    super(
      'edit_local_file resolved via a fuzzy fallback, which can write a wider span than old_string names. ' +
        'Confirm the current file snapshot before applying.'
    );
    this.name = 'FuzzyEditConfirmationRequiredError';
  }
}

export function isFuzzyEditConfirmationRequired(err: unknown): err is FuzzyEditConfirmationRequiredError {
  return err instanceof Error && (err as { code?: string }).code === 'FUZZY_EDIT_CONFIRMATION_REQUIRED';
}

function generateDiff(original: string, modified: string): DiffResult {
  const differences = diffLines(original, modified);
  let diffString = '';
  let additions = 0;
  let deletions = 0;

  differences.forEach((part: Change) => {
    if (part.added) {
      additions += part.count || 0;
      diffString += part.value
        .split('\n')
        .filter(line => line)
        .map((line: string) => `+ ${line}`)
        .join('\n');
      if (diffString && !diffString.endsWith('\n')) diffString += '\n';
    } else if (part.removed) {
      deletions += part.count || 0;
      diffString += part.value
        .split('\n')
        .filter(line => line)
        .map((line: string) => `- ${line}`)
        .join('\n');
      if (diffString && !diffString.endsWith('\n')) diffString += '\n';
    }
  });

  return { additions, deletions, diff: diffString.trim() };
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Single source of truth for how an edit's span is chosen: the exact fast path,
 * then the validated fuzzy fallback. Pure over `currentContent` so the resolve-
 * only preflight and the write path cannot drift. Throws the same actionable
 * errors as before on multiple/no matches.
 */
function resolveEdit(currentContent: string, old_string: string, new_string: string): ResolvedEdit {
  if (currentContent.includes(old_string)) {
    const occurrences = currentContent.split(old_string).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of the string to replace. ` +
          `Please provide a more specific old_string that matches exactly one location.`
      );
    }
    return { startIndex: currentContent.indexOf(old_string), matchedText: old_string, replacement: new_string };
  }

  // Throws AmbiguousMatchError / DisproportionateMatchError with actionable
  // messages; returns null when no tolerant matcher resolves the block.
  const fuzzy = fuzzyMatch(currentContent, old_string, new_string);
  if (!fuzzy) {
    const preview = old_string.length > 100 ? old_string.substring(0, 100) + '...' : old_string;
    throw new Error(
      `String to replace not found in file. ` +
        `Make sure the old_string matches exactly (including whitespace and line endings). ` +
        `Searched for: "${preview}"`
    );
  }
  return {
    startIndex: fuzzy.startIndex,
    matchedText: fuzzy.matchedText,
    replacement: fuzzy.replacement,
    strategy: fuzzy.strategy,
  };
}

/**
 * Defense in depth for a reused `gateSnapshot.resolvedEdit`: even once its
 * `contentHash` has matched, confirm the span it claims is actually the real bytes
 * at that offset in `currentContent` before trusting it - so a caller cannot use a
 * hash-matching `gateSnapshot` to smuggle in a span/replacement that never came from
 * `resolveEdit()` matching `old_string`/`new_string` against real content.
 */
function isResolvedEditConsistent(currentContent: string, edit: ResolvedEdit): boolean {
  return (
    edit.startIndex >= 0 &&
    edit.startIndex + edit.matchedText.length <= currentContent.length &&
    currentContent.slice(edit.startIndex, edit.startIndex + edit.matchedText.length) === edit.matchedText
  );
}

/** A preview of the REAL span an edit will replace (not the model's typed old_string). */
function formatSpanPreview(filePath: string, matchedText: string, replacement: string): string {
  const { diff } = generateDiff(matchedText, replacement);
  return `[Edit in: ${filePath}]\n\n${diff}`;
}

/**
 * A resolved, authorization-checked edit bound to the file's current bytes. The
 * permission layer uses this to decide whether to re-prompt (a fuzzy `strategy`)
 * and to bind approval to `contentHash`, so the confirmed edit is the one that
 * gets written.
 */
export interface EditPlan {
  resolvedPath: string;
  contentHash: string;
  /** Set only when the edit resolves via the fuzzy fallback. */
  strategy?: FuzzyStrategy;
  /** Diff of the real matched span -> replacement, for the permission preview. */
  diffPreview: string;
  /**
   * The span resolved from `contentHash`'s bytes. Handed back to the write path as
   * `gateSnapshot` (see {@link EditLocalFileParams}) so a call doesn't pay for a
   * second resolveEdit() pass when the file hasn't changed since.
   */
  resolvedEdit: ResolvedEdit;
}

/**
 * Authorized, read-only resolve for the permission layer: validate the path,
 * read the file, and resolve the span WITHOUT writing. Runs the SAME path
 * authorization ({@link assertPathAllowed}) and matcher ({@link resolveEdit}) as
 * the write path, so a preflight can never read a path the tool itself would
 * refuse (no raw-model-path read - closes the auth-bypass / special-file-DoS
 * hole) and its fuzzy verdict matches what execution will do. Throws the same
 * errors as the write path.
 */
export async function resolveEditLocalFile(
  params: EditLocalFileParams,
  allowedDirectories?: string[]
): Promise<EditPlan> {
  const { path: filePath, old_string, new_string } = params;
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'edit');
  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const currentContent = await fs.readFile(resolvedPath, 'utf-8');
  const resolved = resolveEdit(currentContent, old_string, new_string);
  return {
    resolvedPath,
    contentHash: sha256(currentContent),
    strategy: resolved.strategy,
    diffPreview: formatSpanPreview(filePath, resolved.matchedText, resolved.replacement),
    resolvedEdit: resolved,
  };
}

async function editLocalFile(params: EditLocalFileParams, allowedDirectories?: string[]): Promise<EditLocalFileResult> {
  const { path: filePath, old_string, new_string, confirmedFuzzyHash, gateSnapshot } = params;

  // Validate path is within allowed directories (cwd is always included)
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'edit');

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // The file can change between the gate's resolve and this write with no permission
  // prompt involved at all (another tool call, a formatter, a watcher) - see the
  // TOCTOU regression test this guards. The read can never be safely skipped, so it
  // always happens here, same as before this file's gateSnapshot reuse existed.
  const currentContent = await fs.readFile(resolvedPath, 'utf-8');
  const currentHash = sha256(currentContent);

  // Reuse the gate's already-resolved span only when the file hasn't changed since,
  // AND the span still checks out against the real bytes (isResolvedEditConsistent) -
  // the hash match alone binds the snapshot to this content, but says nothing about
  // whether the span itself is genuine, so both gate the reuse. This is what skips
  // the redundant resolveEdit() string-matching pass.
  const resolved =
    gateSnapshot &&
    gateSnapshot.contentHash === currentHash &&
    isResolvedEditConsistent(currentContent, gateSnapshot.resolvedEdit)
      ? gateSnapshot.resolvedEdit
      : resolveEdit(currentContent, old_string, new_string);

  // A fuzzy fallback can write a wider span than old_string names, so it must be
  // confirmed against the exact bytes present. Refuse unless the caller approved
  // THIS content hash; the CLI re-prompts on this and retries bound to the hash.
  // Exact matches are deterministic and need no confirmation. Verified here, against
  // the same read that writes below, so there is no gate -> write window.
  if (resolved.strategy && confirmedFuzzyHash !== currentHash) {
    throw new FuzzyEditConfirmationRequiredError(
      resolvedPath,
      currentHash,
      formatSpanPreview(filePath, resolved.matchedText, resolved.replacement)
    );
  }

  // Splice the replacement in literally. (String.prototype.replace would
  // interpret `$&`, `$$`, `$1`, etc. in `replacement` as substitution patterns;
  // slicing avoids that so the new content is inserted byte-for-byte.)
  const newContent =
    currentContent.slice(0, resolved.startIndex) +
    resolved.replacement +
    currentContent.slice(resolved.startIndex + resolved.matchedText.length);

  await fs.writeFile(resolvedPath, newContent, 'utf-8');

  // Generate diff for feedback against the span actually replaced.
  const diffResult = generateDiff(resolved.matchedText, resolved.replacement);

  // When the exact match missed, tell the model its old_string drifted so it can
  // be more precise next time (indentation and line endings were preserved).
  const fuzzyNote = resolved.strategy
    ? `\n\nNote: old_string was not an exact match; it was resolved with a fuzzy fallback (${resolved.strategy}), ` +
      `preserving the file's original indentation and line endings.`
    : '';

  const message =
    `File edited successfully: ${filePath}\n` +
    `Changes: +${diffResult.additions} lines, -${diffResult.deletions} lines\n` +
    `\nDiff:\n${diffResult.diff}${fuzzyNote}`;

  return { message, strategy: resolved.strategy };
}

export const editLocalFileTool: ToolDefinition = {
  name: 'edit_local_file',
  implementation: context => ({
    toolFn: async value => {
      const params = value as EditLocalFileParams;

      context.logger.info(`📝 EditLocalFile: Editing file`, {
        path: params.path,
        oldStringLength: params.old_string.length,
        newStringLength: params.new_string.length,
      });

      try {
        const { message, strategy } = await editLocalFile(params, context.allowedDirectories);
        context.logger.info('✅ EditLocalFile: Success', {
          path: params.path,
          matchType: strategy ?? 'exact',
        });
        return message;
      } catch (error) {
        context.logger.error('❌ EditLocalFile: Failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'edit_local_file',
      description:
        'Edit a file by replacing a specific string with new content. ' +
        'The old_string must match exactly one location in the file (including whitespace). ' +
        'Use this for precise edits to existing files. ' +
        'For creating new files or complete rewrites, use create_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit (relative to current working directory)',
          },
          old_string: {
            type: 'string',
            description:
              'The exact string to find and replace. Must match exactly one location in the file, including all whitespace and line endings.',
          },
          new_string: {
            type: 'string',
            description: 'The string to replace old_string with. Can be empty to delete the old_string.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  }),
};
