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
  metadata: Record<string, string>;
  stage: string;
  logGroup: string;
  /** CloudWatch log event viewer link. */
  url: string;
  count: number;
  /** Span of the grouped occurrences, present only when count > 1. */
  duration?: string;
}

const HEADLINE_MAX = 300;
const STACK_FRAME_MAX = 160;
const STACK_LINES_MAX = 6;
const STACK_BLOCK_MAX = 1000;

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

const SEVERITY_STYLE: Record<string, { emoji: string; color: string }> = {
  error: { emoji: ':red_circle:', color: '#E01E5A' },
  fatal: { emoji: ':red_circle:', color: '#E01E5A' },
  warn: { emoji: ':large_yellow_circle:', color: '#ECB22E' },
  warning: { emoji: ':large_yellow_circle:', color: '#ECB22E' },
};

/** Slack mrkdwn treats &, < and > as control characters; escape them in interpolated text. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

interface ErrorDetail {
  code?: string;
  name?: string;
  message?: string;
  stack?: string;
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
        const pick = (...keys: string[]) => {
          for (const key of keys) {
            const value = detail[key];
            if (typeof value === 'string') return value;
            if (Array.isArray(value) && value.every(line => typeof line === 'string')) return value.join('\n');
          }
          return undefined;
        };
        return {
          headline: trimmed.slice(0, brace).trim(),
          detail: {
            code: pick('code'),
            name: pick('name', 'errorType'),
            message: pick('message', 'errorMessage'),
            stack: pick('stack'),
          },
        };
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

export function formatErrorLogSlackMessage(input: ErrorLogMessageInput): SlackWebhookPayload {
  const severity = input.severity.toLowerCase();
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.error;
  const { headline, detail } = splitErrorDetail(input.message);
  const title = clip(errorTitle(headline, detail), HEADLINE_MAX);
  const route = [input.metadata.method, input.metadata.path].filter(Boolean).join(' ');
  const headerLine = `${style.emoji} *${severity.toUpperCase()} on ${escape(input.stage)}*${route ? `  |  ${escape(route)}` : ''}`;

  const fields: string[] = [];
  for (const { key, label } of FIELD_KEYS) {
    const value = input.metadata[key];
    if (value && !(key === 'method' || key === 'path')) fields.push(`*${label}*\n${escape(clip(value, 80))}`);
  }
  if (detail?.code) fields.push(`*Code*\n${escape(clip(detail.code, 80))}`);
  const logGroupName = input.logGroup.replace(/^\/aws\/lambda\//, '');
  if (!input.metadata.functionName && logGroupName) fields.push(`*Log group*\n${escape(clip(logGroupName, 80))}`);
  if (input.count > 1) fields.push(`*Seen*\n${input.count} times in ${input.duration ?? 'the last few minutes'}`);

  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `${headerLine}\n${escape(title)}` } }];
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
      stackLines.push(`\`\`\`${escape(clip(folded + more, STACK_BLOCK_MAX))}\`\`\``);
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: stackLines.join('\n') } });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${input.url}|Open in CloudWatch>  |  ${escape(input.stage)}` }],
  });

  return {
    text: escape(`${severity.toUpperCase()} on ${input.stage}: ${title}`),
    attachments: [{ color: style.color, blocks }],
  };
}
