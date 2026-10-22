import { classifyCommandRisk } from '../../../config/commandRisk.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import { commandTextOf } from '../toolPolicy.js';

export type CommandRisk = ReturnType<typeof classifyCommandRisk>;

/**
 * Command-level risk gate: inspect the actual command text (not just the tool name) so a
 * destructive command hidden behind a wrapper (`sh -c "rm -rf /"`, `sudo bash -c ...`,
 * `curl ... | sh`) is never silently auto-run. A high-risk command ALWAYS requires an explicit
 * prompt - this overrides host-allowlist / trust / sandbox-auto-allow / auto-accept
 * short-circuits. It only ever tightens: benign commands keep their existing (possibly
 * auto-approved) behavior. Null for a tool with no command argument in this call.
 */
export function assessCommandRisk(descriptor: ToolDescriptor | undefined, args: unknown): CommandRisk | null {
  const commandText = commandTextOf(descriptor, args);
  if (commandText === undefined) return null;
  // `classifyCommandRisk` is documented never to throw, but this call sits on the security
  // boundary for every shell command - if it ever does, treat that as a high-risk command
  // (force the prompt) rather than letting the error escape the permission gate.
  try {
    return classifyCommandRisk(commandText);
  } catch {
    return { level: 'high', reasons: ['command risk analysis failed (fail closed)'] };
  }
}

/**
 * Prepend a high-risk warning banner (with the classifier's reasons) to a tool
 * preview shown in the permission prompt. Explains WHY a normally auto-approved
 * command is being surfaced for explicit confirmation.
 */
export function prependRiskBanner(basePreview: string | undefined, reasons: string[]): string {
  const details =
    reasons.length > 0 ? reasons.map(reason => `- ${reason}`).join('\n') : '- flagged by command analysis';
  const banner = `\u{1F6D1} HIGH-RISK COMMAND \u2014 flagged by static command analysis:\n\n${details}`;
  return basePreview ? `${banner}\n\n${basePreview}` : banner;
}
