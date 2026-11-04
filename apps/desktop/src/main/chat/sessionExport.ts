import type { ChatArtifact, ChatMessage, ChatSession, ChatToolCall } from '@shared/chat';
import { sessionForRenderer } from './ChatService';

const FILENAME_MAX = 100;
const SUMMARY_MAX = 80;

/** A title as a filename that is legal on macOS, Windows and Linux. */
export function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .slice(0, FILENAME_MAX)
    .replace(/^[. ]+|[. ]+$/g, '');
  return cleaned || 'notebook';
}

// Tried in order; the first string value found names what the call acted on.
const SUMMARY_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name', 'title', 'prompt'];

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  const values = input ?? {};
  const key = SUMMARY_KEYS.find(candidate => typeof values[candidate] === 'string' && values[candidate] !== '');
  const text = key ? (values[key] as string) : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 3)}...` : flat;
}

function toolLine(call: ChatToolCall): string {
  const summary = summarizeToolInput(call.input);
  const status = call.status === 'done' ? '' : ` [${call.status}]`;
  return `- Tool: \`${call.name}\`${summary ? ` - ${summary.replaceAll('`', "'")}` : ''}${status}`;
}

/** Longer than any backtick run inside, so the body cannot close its own fence. */
function fenced(body: string, language: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

function artifactBlock(artifact: ChatArtifact): string {
  const language = artifact.language || artifact.type;
  return `**Artifact: ${artifact.title}**\n\n${fenced(artifact.content, language)}`;
}

function userSection(message: ChatMessage): string {
  const parts: string[] = [];
  const text = message.skill
    ? `/${message.skill.name}${message.skill.args ? ` ${message.skill.args}` : ''}`
    : message.content.trim();
  if (text) parts.push(text);
  if (message.attachments?.length) {
    parts.push(message.attachments.map(file => `- Attachment: ${file.name} (${file.kind})`).join('\n'));
  }
  return parts.length ? `## User\n\n${parts.join('\n\n')}` : '';
}

function assistantSection(message: ChatMessage): string {
  const parts: string[] = [];
  const calls = message.toolCalls ?? [];
  if (message.rounds?.length) {
    for (const round of message.rounds) {
      if (round.text.trim()) parts.push(round.text.trim());
      const lines = round.toolCallIds.flatMap(id => {
        const call = calls.find(entry => entry.id === id);
        return call ? [toolLine(call)] : [];
      });
      if (lines.length) parts.push(lines.join('\n'));
    }
  } else {
    if (message.content.trim()) parts.push(message.content.trim());
    if (calls.length) parts.push(calls.map(toolLine).join('\n'));
  }
  for (const artifact of message.artifacts ?? []) parts.push(artifactBlock(artifact));
  if (message.error) parts.push(`_Error: ${message.error.replace(/\s+/g, ' ').trim()}_`);
  return parts.length ? `## Assistant\n\n${parts.join('\n\n')}` : '';
}

function messageSection(message: ChatMessage): string {
  if (message.boundary) return `---\n\n_Context ${message.boundary.kind === 'compact' ? 'compacted' : 'cleared'}._`;
  if (message.system) {
    const text = (message.display ?? message.content).trim();
    return text ? `## Notice\n\n${text}` : '';
  }
  return message.role === 'user' ? userSection(message) : assistantSection(message);
}

export function sessionToMarkdown(session: ChatSession): string {
  const header = [`# ${session.title}`, `Created ${session.createdAt.slice(0, 10)} - Model: ${session.model}`];
  const sections = session.messages.map(messageSection).filter(section => section !== '');
  return `${[header.join('\n\n'), ...sections].join('\n\n')}\n`;
}

export function sessionToJson(session: ChatSession): string {
  // The renderer's view, so per-round request payloads kept for cache replay stay out of the file.
  return JSON.stringify(sessionForRenderer(session), null, 2);
}
