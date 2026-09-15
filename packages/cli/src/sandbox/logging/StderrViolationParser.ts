import type { SandboxViolation } from '../types.js';

/** Parsed violation detail from sandbox runtime stderr */
export interface ParsedViolation {
  type: 'filesystem' | 'network';
  operation?: string;
  path?: string;
  detail: string;
}

/**
 * Parse macOS Seatbelt denial messages from stderr.
 *
 * Format: sandbox-exec: deny(1) file-write-data /path/to/file
 */
export function parseSeatbeltStderr(stderr: string): ParsedViolation[] {
  const violations: ParsedViolation[] = [];
  const regex = /sandbox-exec:\s*deny\(\d+\)\s+(\S+)\s+(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stderr)) !== null) {
    const operation = match[1];
    const targetPath = match[2].trim();
    const type = classifySeatbeltOperation(operation);

    violations.push({
      type,
      operation,
      path: type === 'filesystem' ? targetPath : undefined,
      detail: match[0],
    });
  }

  return violations;
}

/**
 * Parse Linux Bubblewrap error messages from stderr.
 *
 * Format: bwrap: Can't open file /path: Permission denied
 */
export function parseBwrapStderr(stderr: string): ParsedViolation[] {
  const violations: ParsedViolation[] = [];
  const regex = /bwrap:\s+(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stderr)) !== null) {
    const message = match[1].trim();

    // Extract path from common bwrap error patterns
    const pathMatch = message.match(/(?:Can't open file |Can't bind mount )(\S+)/);
    const extractedPath = pathMatch?.[1]?.replace(/:$/, '');

    violations.push({
      type: 'filesystem',
      path: extractedPath,
      detail: match[0],
    });
  }

  return violations;
}

/**
 * Parse sandbox stderr (auto-detects platform from content).
 * Runs both parsers since they match only their own patterns.
 */
export function parseSandboxStderr(stderr: string): ParsedViolation[] {
  return [...parseSeatbeltStderr(stderr), ...parseBwrapStderr(stderr)];
}

/**
 * Convert parsed violations to SandboxViolation records.
 */
export function toSandboxViolations(parsed: ParsedViolation[], command: string): SandboxViolation[] {
  return parsed.map(p => ({
    type: p.type,
    path: p.path,
    command,
    blockedBy: 'sandbox' as const,
    timestamp: new Date(),
    detail: p.detail,
  }));
}

/** Map Seatbelt operation to violation type */
function classifySeatbeltOperation(operation: string): 'filesystem' | 'network' {
  if (operation.startsWith('network')) return 'network';
  return 'filesystem';
}
