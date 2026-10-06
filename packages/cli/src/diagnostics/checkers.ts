import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { logger } from '../utils/Logger';

/** One error-severity finding for a changed file. Warnings/hints never become a Diagnostic. */
export type Diagnostic = {
  /** Absolute, `path.resolve`d - the key PostEditDiagnostics matches changed files on. */
  filePath: string;
  line: number;
  column: number;
  /** `TS2322`, an eslint rule id, or `eslint` for rule-less errors (parse failures). */
  code: string;
  message: string;
};

/** Checks a batch of changed files; resolves to their errors. Must not reject for "no checker available". */
export type DiagnosticsChecker = (filePaths: readonly string[]) => Promise<Diagnostic[]>;

type ProcessOutcome = { kind: 'exited'; stdout: string } | { kind: 'failed'; reason: string };

const CHECK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const ESLINT_EXTENSIONS = new Set([...TYPESCRIPT_EXTENSIONS, '.js', '.jsx', '.mjs', '.cjs']);
const ESLINT_ERROR_SEVERITY = 2;
const TSC_ENTRY = path.join('node_modules', 'typescript', 'bin', 'tsc');
const ESLINT_ENTRY = path.join('node_modules', 'eslint', 'bin', 'eslint.js');
// `--pretty false` line shape: `src/a.ts(12,5): error TS2322: Type 'string' is not ...`
const TSC_ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Runs a binary without a shell (paths are passed as argv, never interpolated).
 * A non-zero exit is a normal outcome - tsc/eslint exit non-zero when they find errors.
 */
function runProcess(file: string, args: string[], cwd: string): Promise<ProcessOutcome> {
  return new Promise(resolve => {
    execFile(
      file,
      args,
      { cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ kind: 'exited', stdout });
          return;
        }
        if (error.killed) {
          resolve({ kind: 'failed', reason: `timed out after ${CHECK_TIMEOUT_MS}ms` });
          return;
        }
        if (typeof error.code !== 'number') {
          resolve({ kind: 'failed', reason: error.message });
          return;
        }
        // Both checkers report findings on stdout; a non-zero exit with nothing
        // there is a crash (missing module, bad config), not a clean result.
        if (!stdout.trim()) {
          resolve({ kind: 'failed', reason: `exit ${error.code}: ${stderr.trim().slice(0, 300)}` });
          return;
        }
        resolve({ kind: 'exited', stdout });
      }
    );
  });
}

/**
 * Runs a package's JS entry under the current Node. `node_modules/.bin/*` are sh
 * shims (`.cmd` on Windows) that `execFile` cannot launch without a shell.
 */
function runNodeScript(script: string, args: string[], cwd: string): Promise<ProcessOutcome> {
  return runProcess(process.execPath, [script, ...args], cwd);
}

/** Nearest `relativePath` at or above `startDir`, or null. */
export function findUp(startDir: string, relativePath: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Groups files by a key derived from each; files whose key is null are dropped. */
function groupBy(filePaths: readonly string[], keyOf: (filePath: string) => string | null): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const filePath of filePaths) {
    const key = keyOf(filePath);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), filePath]);
  }
  return groups;
}

const hasExtension = (extensions: Set<string>) => (filePath: string) => extensions.has(path.extname(filePath));

export function parseTscOutput(stdout: string, cwd: string): Diagnostic[] {
  return stdout.split('\n').flatMap(line => {
    const match = TSC_ERROR_LINE.exec(line.trimEnd());
    if (!match) return [];
    const [, file, lineNumber, column, code, message] = match;
    return [{ filePath: path.resolve(cwd, file), line: Number(lineNumber), column: Number(column), code, message }];
  });
}

type EslintFileResult = {
  filePath: string;
  messages: Array<{ severity: number; line?: number; column?: number; ruleId: string | null; message: string }>;
};

function isEslintReport(value: unknown): value is EslintFileResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      entry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as EslintFileResult).filePath === 'string' &&
        Array.isArray((entry as EslintFileResult).messages)
    )
  );
}

export function parseEslintOutput(stdout: string): Diagnostic[] {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    // eslint exits 2 with a plain-text message (bad config, missing plugin) - nothing to report.
    logger.debug(`[diagnostics] eslint produced non-JSON output: ${stdout.slice(0, 200)}`);
    return [];
  }
  if (!isEslintReport(report)) return [];
  return report.flatMap(fileResult =>
    fileResult.messages
      .filter(message => message.severity === ESLINT_ERROR_SEVERITY)
      .map(message => ({
        filePath: path.resolve(fileResult.filePath),
        line: message.line ?? 1,
        column: message.column ?? 1,
        code: message.ruleId ?? 'eslint',
        message: message.message,
      }))
  );
}

/**
 * Type-checks each changed file's nearest tsconfig project with the project's
 * own `tsc` (never a global one). Project-wide so path aliases and compiler
 * options are honored; output is filtered to the changed files by the caller.
 */
export const checkTypeScript: DiagnosticsChecker = async filePaths => {
  const projects = groupBy(filePaths.filter(hasExtension(TYPESCRIPT_EXTENSIONS)), filePath =>
    findUp(path.dirname(filePath), 'tsconfig.json')
  );
  const diagnostics: Diagnostic[] = [];
  for (const tsconfigPath of projects.keys()) {
    const projectDir = path.dirname(tsconfigPath);
    const tsc = findUp(projectDir, TSC_ENTRY);
    if (!tsc) {
      logger.debug(`[diagnostics] no local tsc found for ${tsconfigPath}; skipping type check`);
      continue;
    }
    const outcome = await runNodeScript(tsc, ['--noEmit', '--pretty', 'false', '-p', tsconfigPath], projectDir);
    if (outcome.kind === 'failed') {
      logger.debug(`[diagnostics] tsc skipped for ${tsconfigPath}: ${outcome.reason}`);
      continue;
    }
    diagnostics.push(...parseTscOutput(outcome.stdout, projectDir));
  }
  return diagnostics;
};

/** Lints changed files with the eslint installed nearest to each file, run from that package root. */
export const checkEslint: DiagnosticsChecker = async filePaths => {
  const groups = groupBy(filePaths.filter(hasExtension(ESLINT_EXTENSIONS)), filePath =>
    findUp(path.dirname(filePath), ESLINT_ENTRY)
  );
  const diagnostics: Diagnostic[] = [];
  for (const [eslint, files] of groups) {
    // <root>/node_modules/eslint/bin/eslint.js
    const packageRoot = path.resolve(path.dirname(eslint), '..', '..', '..');
    const outcome = await runNodeScript(eslint, ['--format', 'json', ...files], packageRoot);
    if (outcome.kind === 'failed') {
      logger.debug(`[diagnostics] eslint skipped under ${packageRoot}: ${outcome.reason}`);
      continue;
    }
    diagnostics.push(...parseEslintOutput(outcome.stdout));
  }
  return diagnostics;
};

/** The default checker: tsc and eslint side by side. */
export const checkTypeScriptAndEslint: DiagnosticsChecker = async filePaths => {
  const [typeErrors, lintErrors] = await Promise.all([checkTypeScript(filePaths), checkEslint(filePaths)]);
  return [...typeErrors, ...lintErrors];
};
