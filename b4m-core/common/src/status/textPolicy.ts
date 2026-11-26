import { classifyLink, type LinkPolicyOptions } from './linkPolicy';
import {
  normalizePublicText,
  parseMarkdown,
  sanitizeParsedMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from './markdown';
import { TEXT_LIMITS, type IncidentClassification } from './types';

export type PublicTextField = 'title' | 'updateBody' | 'postmortemBody' | 'componentDescription' | 'label';

export interface TextIssue {
  code: string;
  message: string;
  /** The matched text, when there is one. */
  match?: string;
}

export interface TextPolicyOptions extends LinkPolicyOptions {
  classification?: IncidentClassification;
  /** Warning codes the author has already acknowledged. */
  acknowledged?: readonly string[];
}

export interface TextPolicyResult {
  /** No hard errors. */
  ok: boolean;
  normalized: string;
  /** Sanitized form of a markdown field; absent when over the limit before formatting, or not markdown. */
  stored?: string;
  errors: TextIssue[];
  warnings: TextIssue[];
  /** Warnings not covered by `acknowledged`; the write needs these acknowledged in the audit entry. */
  unacknowledged: TextIssue[];
}

const FIELD_LIMITS: Record<PublicTextField, number> = {
  title: TEXT_LIMITS.title,
  updateBody: TEXT_LIMITS.updateBody,
  postmortemBody: TEXT_LIMITS.postmortemBody,
  componentDescription: TEXT_LIMITS.componentDescription,
  label: TEXT_LIMITS.label,
};

const MARKDOWN_FIELDS: ReadonlySet<PublicTextField> = new Set(['updateBody', 'postmortemBody']);

const PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9_]*\}/g;

export function findUnfilledPlaceholders(value: string): string[] {
  return [...new Set(value.match(PLACEHOLDER) ?? [])];
}

interface LintRule {
  code: string;
  message: string;
  /** The matched text, or null. Every finder runs in linear time on adversarial input. */
  find: (text: string) => string | null;
}

const fromPattern =
  (pattern: RegExp) =>
  (text: string): string | null =>
    pattern.exec(text)?.[0] ?? null;

const HOSTNAME_TAIL = /\.(?:internal|local|lan|corp|intranet|cluster|svc|compute)\b/gi;
const HOSTNAME_LABEL_CHAR = /[a-z0-9-]/i;
const HOSTNAME_CHAR = /[a-z0-9.-]/i;

// Scans for the rare tail and walks back over the labels only on a hit, so no pattern retries from
// every start.
function findHostname(text: string): string | null {
  HOSTNAME_TAIL.lastIndex = 0;
  for (let tail = HOSTNAME_TAIL.exec(text); tail; tail = HOSTNAME_TAIL.exec(text)) {
    if (tail.index === 0 || !HOSTNAME_LABEL_CHAR.test(text[tail.index - 1])) continue;
    let start = tail.index - 1;
    while (start > 0 && HOSTNAME_CHAR.test(text[start - 1])) start--;
    return text.slice(start, tail.index + tail[0].length).replace(/^\.+/, '');
  }
  return null;
}

const EMAIL_LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/y;

function findEmail(text: string): string | null {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > 0 && EMAIL_LOCAL_CHAR.test(text[start - 1])) start--;
    if (start === at) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = EMAIL_DOMAIN.exec(text);
    if (domain) return text.slice(start, at + 1 + domain[0].length);
  }
  return null;
}

const LINT_RULES: LintRule[] = [
  {
    code: 'ip_address',
    message: 'Looks like an IP address',
    find: fromPattern(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/i),
  },
  { code: 'hostname', message: 'Looks like an internal hostname', find: findHostname },
  {
    code: 'resource_shape',
    message: 'Looks like a cloud resource identifier',
    find: fromPattern(/\barn:[a-z0-9-]+:[a-z0-9-]*:|\b(?:i|sg|vpc|subnet|vol|ami|eni|igw|rtb|snap)-[0-9a-f]{8,17}\b/i),
  },
  { code: 'email', message: 'Contains an email address', find: findEmail },
  { code: 'object_id', message: 'Looks like a database object id', find: fromPattern(/\b[0-9a-f]{24}\b/i) },
  {
    code: 'ticket',
    message: 'Looks like a ticket reference',
    find: fromPattern(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b|(?:^|\s)#\d{2,}\b/),
  },
  {
    code: 'stack_trace',
    message: 'Looks like a stack trace',
    find: fromPattern(
      /^[^\S\n]*at[^\S\n]+\S[^\n(]*\([^)\n]*:\d+:\d+\)|Traceback \(most recent call last\)|\b\w+(?:Error|Exception):\s/m
    ),
  },
];

const SECURITY_TERMS =
  /\b(?:vulnerabilit(?:y|ies)|exploit(?:s|ed|able)?|CVE-\d{4}-\d+|inject(?:ion|ed)|XSS|SSRF|CSRF|RCE|bypass(?:ed|es)?|breach(?:ed)?|unauthori[sz]ed|credentials?|api keys?|secrets?|tokens?|brute[- ]force|penetration|malware|ransomware|privilege escalation|remote code execution|attack(?:er|ers|s)?|threshold|rate limit(?:s|ed|ing)?|WAF|firewall|detection)\b/i;

function inlineChildren(node: MarkdownInline): MarkdownInline[] {
  return node.type === 'strong' || node.type === 'em' || node.type === 'link' ? node.children : [];
}

function collectLinks(blocks: MarkdownBlock[]): number {
  let count = 0;
  const walk = (nodes: MarkdownInline[]) => {
    for (const node of nodes) {
      if (node.type === 'link') count++;
      walk(inlineChildren(node));
    }
  };
  for (const block of blocks) {
    if (block.type === 'paragraph') walk(block.children);
    else block.items.forEach(walk);
  }
  return count;
}

// Same matches as /\[[^\]\n]*\]\(([^)\n]*)\)/g, found with indexOf so a long run of brackets or
// parentheses cannot make the scan retry from every start.
function countLinkLikes(source: string): { total: number; hrefs: string[] } {
  const hrefs: string[] = [];
  for (const line of source.split('\n')) {
    let from = 0;
    for (let open = line.indexOf('[', from); open !== -1; open = line.indexOf('[', from)) {
      const close = line.indexOf(']', open + 1);
      if (close === -1) break;
      if (line[close + 1] !== '(') {
        from = close + 1;
        continue;
      }
      const end = line.indexOf(')', close + 2);
      if (end === -1) break;
      hrefs.push(line.slice(close + 2, end));
      from = end + 1;
    }
  }
  return { total: hrefs.length, hrefs };
}

// Same answer as /<\/?[A-Za-z][^>]*>/ and /!\[[^\]]*\]\([^)]*\)/, without their quadratic retries.
function hasRawHtml(text: string): boolean {
  const open = /<\/?[A-Za-z]/.exec(text);
  return open !== null && text.indexOf('>', open.index + open[0].length) !== -1;
}

function hasImage(text: string): boolean {
  for (let start = text.indexOf('!['); start !== -1; start = text.indexOf('![', start + 2)) {
    const close = text.indexOf(']', start + 2);
    if (close === -1) return false;
    if (text[close + 1] === '(') return text.indexOf(')', close + 2) !== -1;
    start = close - 1;
  }
  return false;
}

/**
 * Runs in the admin API, the admin UI, the CLI and again in reconcile. Hard errors block; warnings
 * need an acknowledgement recorded in the audit entry. Length is checked first, on the stored
 * (sanitized) form for markdown fields, and an over-limit text is never linted.
 */
export function validatePublicText(
  field: PublicTextField,
  input: string,
  options: TextPolicyOptions
): TextPolicyResult {
  const normalized = normalizePublicText(input);
  const limit = FIELD_LIMITS[field];
  const markdown = MARKDOWN_FIELDS.has(field);
  const length = Array.from(normalized).length;
  const tooLong = (count: number, suffix = '', stored?: string): TextPolicyResult => ({
    ok: false,
    normalized,
    ...(stored === undefined ? {} : { stored }),
    errors: [{ code: 'too_long', message: `Text is ${count} characters${suffix}, the limit is ${limit}` }],
    warnings: [],
    unacknowledged: [],
  });
  if (length > limit) return tooLong(length);
  let stored: string | undefined;
  let blocks: MarkdownBlock[] = [];
  if (markdown) {
    blocks = parseMarkdown(normalized, options);
    stored = sanitizeParsedMarkdown(blocks, options);
    const storedLength = Array.from(stored).length;
    if (storedLength > limit) return tooLong(storedLength, ' once formatted', stored);
  }

  const errors: TextIssue[] = [];
  const warnings: TextIssue[] = [];
  if (normalized.trim() === '') errors.push({ code: 'empty', message: 'Text is required' });
  if (!markdown && normalized.includes('\n')) {
    errors.push({ code: 'multiline', message: 'This field is a single line of plain text' });
  }
  for (const placeholder of findUnfilledPlaceholders(normalized)) {
    errors.push({ code: 'unfilled_placeholder', message: `Unfilled placeholder ${placeholder}`, match: placeholder });
  }

  for (const rule of LINT_RULES) {
    const found = rule.find(normalized);
    if (found !== null) warnings.push({ code: rule.code, message: rule.message, match: found.trim() });
  }

  if (markdown) {
    if (hasRawHtml(normalized)) warnings.push({ code: 'raw_html', message: 'Raw HTML is shown as text' });
    if (hasImage(normalized)) {
      warnings.push({ code: 'image', message: 'Images are not supported and are shown as text' });
    }
    if (/^#{1,6}\s/m.test(normalized)) {
      warnings.push({ code: 'heading', message: 'Headings are not supported and are shown as text' });
    }
    const written = countLinkLikes(normalized);
    const rendered = collectLinks(blocks);
    if (rendered < written.total) {
      const lost = written.hrefs.filter(href => !classifyLink(href, options).allowed);
      warnings.push({
        code: 'link_plain_text',
        message: 'A link will render as plain text because its destination is not on the allowlist',
        match: lost.join(', '),
      });
    }
  }

  if (options.classification === 'security') {
    const found = SECURITY_TERMS.exec(normalized);
    if (found) {
      warnings.push({
        code: 'security_term',
        message: 'Security incidents describe what users experience and what changed, never the weakness',
        match: found[0],
      });
    }
  }

  const acknowledged = new Set(options.acknowledged ?? []);
  return {
    ok: errors.length === 0,
    normalized,
    ...(stored === undefined ? {} : { stored }),
    errors,
    warnings,
    unacknowledged: warnings.filter(warning => !acknowledged.has(warning.code)),
  };
}

/** Public text of one incident (title, update bodies, postmortem body) is capped as a whole. */
export function incidentPublicTextLength(parts: readonly string[]): number {
  return parts.reduce((sum, part) => sum + Array.from(part).length, 0);
}
