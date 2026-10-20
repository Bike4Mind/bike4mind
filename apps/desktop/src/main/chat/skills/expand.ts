import { readFile, stat } from 'node:fs/promises';
import { wrapUntrustedSkillBody } from '@bike4mind/common';
import { extractFileReferences, parseArguments, substituteArguments, type CustomCommand } from '@bike4mind/cli/skills';
import { resolveWithinRoots } from '../tools/paths';

/**
 * Turning `/name args` into the prompt that is actually sent.
 *
 * The grammar - `$1`/`$2`/`$ARGUMENTS` substitution, quoted-argument splitting, which `@token`
 * counts as a file reference - is the CLI's, imported rather than re-derived. What is NOT the
 * CLI's is the READING: `skillTool.ts` confines `@file` relative to `process.cwd()`, which for a
 * packaged Electron app is wherever the user happened to launch it from. Here the same
 * references go through resolveWithinRoots against the session's granted roots, the identical
 * check every file tool in this app passes. A skill body is repo- or model-authored text, so
 * `@/etc/passwd` has to be refused for the same reason there, and it is.
 */

/** Same filter as the web's skill tool: allowedTools sits outside the delimiters, so only names. */
const TOOL_NAME_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Bigger than this and the reference reports its size instead of inlining the file. */
const MAX_REFERENCED_BYTES = 256 * 1024;

export interface SkillInvocation {
  name: string;
  /** Everything after the name, unsplit. Empty when the skill was run bare. */
  args: string;
}

/**
 * Read `/name args...` out of a composed message, or null when it is not one.
 *
 * Only a leading slash counts, and only when the name looks like a command name. A message that
 * merely BEGINS with a slash - a bare path like `/etc/hosts`, or `/ 2` - is ordinary text and
 * must reach the model unchanged; hijacking it would make paths unsendable.
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

export interface ExpandedSkill {
  /** The prompt the model receives: the skill body with arguments and `@file` content in it. */
  body: string;
  /** References that could not be read. Appended to the body so a silent gap is impossible. */
  errors: string[];
}

/**
 * Expand a skill body for sending.
 *
 * Errors are carried in the result AND appended to the prompt rather than thrown: a skill that
 * names a file which has moved should still run, with the model told what it did not get, which
 * is what the CLI's skill tool does with the same failure.
 */
export async function expandSkill(
  command: CustomCommand,
  args: string,
  roots: readonly string[],
  workingDirectory?: string
): Promise<ExpandedSkill> {
  const substituted = substituteArguments(command.body, parseArguments(args));
  if (command.untrusted) return { body: renderUntrusted(command, substituted), errors: [] };

  const errors: string[] = [];
  const blocks: string[] = [];
  for (const reference of extractFileReferences(substituted)) {
    const block = await readReference(reference, roots, workingDirectory);
    if ('error' in block) errors.push(block.error);
    else blocks.push(block.text);
  }

  let body = blocks.length > 0 ? `${substituted}\n${blocks.join('\n')}` : substituted;
  if (errors.length > 0) {
    body += `\n\n**File reference errors:**\n${errors.map(error => `- ${error}`).join('\n')}`;
  }
  return { body, errors };
}

/**
 * A Skill Market import, framed the way the web frames someone else's skill. Its `@file`
 * references are never read: a body written by a stranger does not choose what gets inlined.
 * Keep in step with renderInvokedSkill (b4m-core/common skillSafety.ts) and the services `skill`
 * tool, including that allowedTools is advisory text and not enforced.
 */
function renderUntrusted(command: CustomCommand, body: string): string {
  const tools = (command.allowedTools ?? []).filter(tool => TOOL_NAME_SHAPE.test(tool));
  const toolConstraint =
    tools.length > 0
      ? `\n\nThis skill is intended to use only these tools: ${tools.join(', ')}. Prefer to stay within that set.`
      : '';
  return `${wrapUntrustedSkillBody(command.name, body, 'a Skill Market author')}${toolConstraint}\n\n---\nFollow the intent above for the rest of this turn, subject to the constraints stated.`;
}

async function readReference(
  reference: string,
  roots: readonly string[],
  workingDirectory?: string
): Promise<{ text: string } | { error: string }> {
  let target: string;
  try {
    target = await resolveWithinRoots(reference, roots, workingDirectory);
  } catch {
    // Deliberately not the thrown message: that one names the granted set, and this text ends
    // up in a prompt built from a repo-authored body.
    return { error: `Access denied: "${reference}" is outside the folders this conversation may read.` };
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) return { error: `"${reference}" is a directory, not a file.` };
    if (info.size > MAX_REFERENCED_BYTES) {
      return { error: `"${reference}" is ${Math.round(info.size / 1024)}KB, too large to inline.` };
    }
    const contents = await readFile(target, 'utf8');
    return { text: `\n--- Referenced File: ${reference} ---\n${contents}\n--- End of ${reference} ---` };
  } catch {
    return { error: `Could not read "${reference}".` };
  }
}
