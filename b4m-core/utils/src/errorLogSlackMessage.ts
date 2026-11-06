/**
 * Block Kit rendering for one CloudWatch error-log line relayed to Slack. Pure, so the shape can
 * be tested without the deduplicator. Keeps the headline, the request fields and the first stack
 * frame visible, and folds the rest of the stack into one capped code block instead of dumping
 * the whole structured payload as inline tags.
 */

import type { SlackWebhookPayload } from './slack';

export interface ErrorLogMessageInput {
  message: string;
  severity: string;
  /** The parsed log line as logged; values under the request keys are usually strings but not always. */
  metadata: Record<string, unknown>;
  stage: string;
  logGroup: string;
  /** CloudWatch log event viewer link. */
  url: string;
  count: number;
  /** Span of the grouped occurrences, present only when count > 1. */
  duration?: string;
}

const HEADLINE_MAX = 300;
const ROUTE_MAX = 200;
const FIELD_MAX = 80;
const STACK_FRAME_MAX = 160;
const STACK_LINES_MAX = 6;
const STACK_BLOCK_MAX = 1000;
/** Slack rejects the whole post when a section's text exceeds 3000 characters. */
const SECTION_TEXT_MAX = 3000;
/** Same limit for each entry of a section's fields. */
const FIELD_TEXT_MAX = 2000;

const FIELD_KEYS: { key: string; label: string }[] = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Path' },
  { key: 'requestId', label: 'Request' },
  { key: 'traceId', label: 'Trace' },
  { key: 'clientIp', label: 'Client IP' },
  { key: 'functionName', label: 'Function' },
  { key: 'userId', label: 'User' },
  { key: 'sessionId', label: 'Session' },
];

/** Metadata keys the card already shows or that only repeat the log line. */
const CONTEXT_EXCLUDED_KEYS = new Set([
  'message',
  'msg',
  'severity',
  'level',
  'timestamp',
  'time',
  'ts',
  'error',
  'stack',
  'stage',
]);
const CONTEXT_RAW_MAX = 1000;

const SEVERITY_STYLE: Record<string, { emoji: string; color: string }> = {
  error: { emoji: ':red_circle:', color: '#E01E5A' },
  fatal: { emoji: ':red_circle:', color: '#E01E5A' },
  warn: { emoji: ':large_yellow_circle:', color: '#ECB22E' },
  warning: { emoji: ':large_yellow_circle:', color: '#ECB22E' },
};

/** Slack mrkdwn treats &, < and > as control characters; escape them in interpolated text. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

/** Clips already-escaped text without leaving a half-cut entity such as "&am" at the end. */
const clipEscaped = (s: string, max: number) => {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3).replace(/&[a-z]{0,3}$/, '')}...`;
};

/** Escaping expands text after it was clipped, so the Slack limits are enforced on the escaped result. */
const section = (text: string) => ({
  type: 'section',
  text: { type: 'mrkdwn', text: clipEscaped(text, SECTION_TEXT_MAX) },
});

const metadataText = (metadata: Record<string, unknown>, key: string): string | undefined => {
  const value = metadata[key];
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : String(value);
};

interface ErrorDetail {
  code?: string;
  name?: string;
  message?: string;
  stack?: string;
}

const pick = (source: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every(line => typeof line === 'string')) return value.join('\n');
  }
  return undefined;
};

const toErrorDetail = (source: Record<string, unknown>): ErrorDetail => ({
  code: pick(source, 'code'),
  name: pick(source, 'name', 'errorType'),
  message: pick(source, 'message', 'errorMessage'),
  stack: pick(source, 'stack'),
});

/** The error the logger attached to the line, for messages that carry no JSON tail. */
function metadataErrorDetail(metadata: Record<string, unknown>): ErrorDetail | undefined {
  const error = metadata.error;
  if (typeof error === 'string') return error ? { message: error } : undefined;
  if (error && typeof error === 'object' && !Array.isArray(error))
    return toErrorDetail(error as Record<string, unknown>);
  return undefined;
}

/** The Node runtime prefixes unhandled-error lines with "<ts>\t<requestId>\t<LEVEL>\t". */
const RUNTIME_PREFIX = /^\S+\t\S+\t[A-Z]+\t/;

/**
 * Splits a log message of the form "<headline> {json}": the logger's "message {error}" lines and
 * the runtime's "Invoke Error {errorType, errorMessage, stack[]}" lines. Returns the headline and
 * whatever structured detail parsed.
 */
export function splitErrorDetail(message: string): { headline: string; detail?: ErrorDetail } {
  const trimmed = message.trim().replace(RUNTIME_PREFIX, '');
  const brace = trimmed.indexOf('{');
  if (brace > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(brace));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const detail = parsed as Record<string, unknown>;
        return { headline: trimmed.slice(0, brace).trim(), detail: toErrorDetail(detail) };
      }
    } catch {
      // Not JSON after all; the whole message is the headline.
    }
  }
  return { headline: trimmed.split('\n')[0] };
}

/** Headline plus the error's own "Name: message" when the headline does not already carry it. */
export function errorTitle(headline: string, detail?: ErrorDetail): string {
  const described = detail?.message
    ? detail.name && !detail.message.startsWith(detail.name)
      ? `${detail.name}: ${detail.message}`
      : detail.message
    : undefined;
  if (!described) return headline || 'Error';
  if (!headline || headline.includes(detail?.message ?? '')) return headline || described;
  return `${headline}: ${described}`;
}

/** Stack frames after the "Name: message" line, trimmed and capped. */
export function stackFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at '));
}

/** Scalar metadata the card has no dedicated slot for (ids, status codes, model names), as one line. */
function leftoverContext(metadata: Record<string, unknown>): string | undefined {
  const known = new Set(FIELD_KEYS.map(({ key }) => key));
  const entries: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (known.has(key) || CONTEXT_EXCLUDED_KEYS.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = String(value);
    if (!text) continue;
    entries.push(`${key}: ${clip(text, FIELD_MAX)}`);
  }
  if (entries.length === 0) return undefined;
  return clipEscaped(escape(clip(entries.join('  |  '), CONTEXT_RAW_MAX)), SECTION_TEXT_MAX);
}

export function formatErrorLogSlackMessage(input: ErrorLogMessageInput): SlackWebhookPayload {
  const severity = input.severity.toLowerCase();
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.error;
  const split = splitErrorDetail(input.message);
  const { headline } = split;
  const detail = split.detail ?? metadataErrorDetail(input.metadata);
  const title = clip(errorTitle(headline, detail), HEADLINE_MAX);
  const route = clip(
    [metadataText(input.metadata, 'method'), metadataText(input.metadata, 'path')].filter(Boolean).join(' '),
    ROUTE_MAX
  );
  const headerLine = `${style.emoji} *${severity.toUpperCase()} on ${escape(input.stage)}*${route ? `  |  ${escape(route)}` : ''}`;

  const fields: string[] = [];
  const field = (label: string, value: string) =>
    fields.push(clip(`*${label}*\n${escape(clip(value, FIELD_MAX))}`, FIELD_TEXT_MAX));
  for (const { key, label } of FIELD_KEYS) {
    const value = metadataText(input.metadata, key);
    if (value && !(key === 'method' || key === 'path')) field(label, value);
  }
  if (detail?.code) field('Code', detail.code);
  const logGroupName = input.logGroup.replace(/^\/aws\/lambda\//, '');
  if (!metadataText(input.metadata, 'functionName') && logGroupName) field('Log group', logGroupName);
  if (input.count > 1) fields.push(`*Seen*\n${input.count} times in ${input.duration ?? 'the last few minutes'}`);

  const blocks: unknown[] = [section(`${headerLine}\n${escape(title)}`)];
  if (fields.length > 0) {
    blocks.push({ type: 'section', fields: fields.slice(0, 10).map(text => ({ type: 'mrkdwn', text })) });
  }

  const frames = stackFrames(detail?.stack);
  if (frames.length > 0) {
    const [first, ...rest] = frames;
    const stackLines = [`*First frame*\n\`${escape(clip(first, STACK_FRAME_MAX))}\``];
    if (rest.length > 0) {
      const folded = rest
        .slice(0, STACK_LINES_MAX)
        .map(line => clip(line, STACK_FRAME_MAX))
        .join('\n');
      const more = rest.length > STACK_LINES_MAX ? `\n... ${rest.length - STACK_LINES_MAX} more` : '';
      // Budget the escaped body so the closing fence is never the part that gets clipped off.
      const prefixLength = `${stackLines.join('\n')}\n\`\`\``.length;
      const body = clipEscaped(escape(clip(folded + more, STACK_BLOCK_MAX)), SECTION_TEXT_MAX - prefixLength - 3);
      stackLines.push(`\`\`\`${body}\`\`\``);
    }
    blocks.push(section(stackLines.join('\n')));
  }

  const leftover = leftoverContext(input.metadata);
  if (leftover) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: leftover }] });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${input.url}|Open in CloudWatch>  |  ${escape(input.stage)}` }],
  });

  return {
    text: escape(`${severity.toUpperCase()} on ${input.stage}: ${title}`),
    attachments: [{ color: style.color, blocks }],
  };
}
