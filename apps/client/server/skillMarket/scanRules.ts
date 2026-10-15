import {
  b4mLLMTools,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  type ISkillScanFinding,
  type ISkillSnapshot,
  type SkillListingVisibility,
  type SkillReviewStatus,
  type SkillRiskTier,
} from '@bike4mind/common';

/**
 * Deterministic layer of the Skill Market safety scan. It runs before (and independently of) the
 * LLM classifier, and the classifier can only ADD findings, never clear these - so prompt-injecting
 * the classifier cannot launder a body these rules catch.
 *
 * Why strict: a published snapshot is copied into the importer's own skill namespace, so at run time
 * its body is framed as the user's own trusted instructions (renderInvokedSkill in skillSafety.ts),
 * not wrapped as untrusted content - and the copy may be re-shared from there. This scan is the
 * only gate before that happens, so a body that is unsafe to run must be caught here.
 */

/**
 * Tools that act outside the conversation (outbound fetch, file edits, publishing, data-lake
 * writes, delegation). Any listing declaring one goes to human review. Every entry must exist in
 * b4mLLMTools (scanRules.test.ts pins this) or the gate silently passes everything.
 */
export const DEFAULT_HIGH_RISK_TOOLS = [
  'web_fetch',
  'edit_file',
  'blog_publish',
  'blog_edit',
  'blog_draft',
  'create_data_lake',
  'save_content_to_data_lake',
  'delegate_to_agent',
  'optihashi_edit_problem',
] as const;

const KNOWN_TOOLS = new Set<string>(b4mLLMTools.options);

export type ScanOptions = {
  /** Tools that force human review, ADDED to DEFAULT_HIGH_RISK_TOOLS (admin setting). */
  highRiskTools?: string[];
  /** Hosts a skill may reference without a finding; subdomains match. */
  urlAllowlist?: string[];
};

type Rule = { rule: string; severity: ISkillScanFinding['severity']; message: string; pattern: RegExp };

const TEXT_RULES: Rule[] = [
  {
    rule: 'prompt_injection',
    severity: 'critical',
    message: 'Tries to override or discard prior/system instructions',
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system|developer|safety|original)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines|directives|messages?|polic(?:y|ies)|constraints)\b/i,
  },
  {
    rule: 'jailbreak',
    severity: 'critical',
    message: 'Contains a known jailbreak pattern',
    pattern:
      /\b(do anything now|jailbreak(?:ed|ing)?|developer mode|god mode|unfiltered mode|no (?:ethical|safety) (?:guidelines|restrictions|filters))\b|\byou are (?:now )?(?:no longer|not) (?:bound|restricted|limited)\b/i,
  },
  {
    rule: 'role_override',
    severity: 'critical',
    message: 'Fakes a system/assistant role or chat-template delimiter',
    pattern:
      /<\|?\s*(?:im_start|im_end|system|endoftext|eot_id|start_header_id)\s*\|?>|\[\/?(?:INST|SYS)\]|<\/?\s*(?:system|tool|tool_call|tool_result|function_call|function_results)\s*>|^\s*(?:system|developer)\s*(?:prompt)?\s*:|\b(?:new|updated|real|true) (?:system )?(?:instructions|role|persona)\s*:/im,
  },
  {
    rule: 'prompt_extraction',
    severity: 'critical',
    message: 'Asks the model to reveal its system prompt or hidden instructions',
    pattern:
      /\b(reveal|print|repeat|show|output|dump|leak)\b[^.\n]{0,30}\b(system prompt|hidden instructions|initial instructions|developer message|your instructions)\b/i,
  },
  {
    rule: 'credential_harvesting',
    severity: 'critical',
    message: 'Asks the user for credentials or sensitive secrets',
    pattern:
      /\b(ask|request|prompt|collect|get|obtain|require)\b[^.\n]{0,40}\b(?:the user'?s?|their|your|users')\b[^.\n]{0,25}\b(passwords?|passcodes?|api[ _-]?keys?|secret keys?|access tokens?|credit card|card numbers?|cvv|ssn|social security|2fa|otp|one-time (?:code|password)|seed phrase|recovery phrase|private keys?)\b/i,
  },
  {
    rule: 'exfil_endpoint',
    severity: 'critical',
    message: 'References a known data-capture endpoint',
    pattern:
      /\b(?:webhook\.site|requestbin|pipedream\.net|ngrok(?:-free)?\.(?:io|app)|burpcollaborator|interact\.sh|oast\.(?:fun|live|me|pro|site)|canarytokens)\b/i,
  },
  {
    rule: 'markdown_image_exfil',
    severity: 'critical',
    message: 'Markdown image whose URL interpolates data (a known exfiltration channel)',
    pattern: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*(?:\{|\$|%7B|<)/i,
  },
  {
    rule: 'html_or_script',
    severity: 'critical',
    message: 'Contains HTML/script markup or a javascript: URL',
    pattern:
      /<\s*\/?\s*(?:script|iframe|object|embed|style|img|svg|link|meta|form|base)\b|javascript\s*:|\bon(?:error|load|click|mouseover)\s*=/i,
  },
  {
    rule: 'data_uri',
    severity: 'critical',
    message: 'Contains a data: URI',
    pattern: /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i,
  },
  {
    rule: 'encoded_blob',
    severity: 'critical',
    message: 'Contains a large base64 or hex blob that could hide instructions',
    pattern: /[A-Za-z0-9+/]{200,}={0,2}|(?:[0-9a-fA-F]{2}){100,}/,
  },
];

const EXFIL_VERB_DATA =
  /\b(send|post|upload|forward|exfiltrate|transmit|e-?mail|leak|copy|sync|beacon|report)\b[^.\n]{0,80}\b(conversations?|chat history|messages|files?|documents?|attachments?|api[ _-]?keys?|keys|tokens?|secrets?|credentials?|passwords?|memor(?:y|ies)|context|system prompt|personal (?:data|information)|user data)\b/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
// A scheme-less host ("evil.com/c") is still a destination the model can be told to use. Common TLDs
// only, so prose like "Node.js" or "e.g." doesn't read as a link.
const BARE_HOST_PATTERN =
  /(?<![@\w./-])((?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ai|app|dev|me|info|biz|xyz|site|online|top|ru|cn|tk|ly|gg))(?![\w-]|\.\w)/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Zero-width, bidi overrides/isolates, soft hyphen, BOM, invisible tag characters, and C0/C1
// controls other than tab/newline/CR. Checked on the raw text, before any normalization.
const HIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;

const excerptAround = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - 30);
  return text
    .slice(start, Math.min(text.length, index + length + 30))
    .replace(/\s+/g, ' ')
    .slice(0, 200);
};

const finding = (
  rule: string,
  severity: ISkillScanFinding['severity'],
  message: string,
  excerpt?: string
): ISkillScanFinding => ({ rule, severity, message, source: 'rules', ...(excerpt ? { excerpt } : {}) });

/** Every textual field the importer's model will read. */
const scannableText = (s: ISkillSnapshot): string => [s.name, s.description, s.argumentHint ?? '', s.body].join('\n');

const hostAllowed = (host: string, allowlist: string[]): boolean =>
  allowlist.some(a => host === a || host.endsWith(`.${a}`));

export function extractUrlHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      hosts.add(match[0].slice(0, 80));
    }
  }
  for (const match of text.replace(URL_PATTERN, ' ').matchAll(BARE_HOST_PATTERN)) hosts.add(match[1].toLowerCase());
  return [...hosts];
}

export function runDeterministicScan(snapshot: ISkillSnapshot, options: ScanOptions): ISkillScanFinding[] {
  const raw = scannableText(snapshot);
  const findings: ISkillScanFinding[] = [];

  const hidden = raw.match(HIDDEN_CHARS);
  if (hidden?.index !== undefined) {
    const code = hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    findings.push(finding('hidden_characters', 'critical', `Contains an invisible/control character (U+${code})`));
  }

  // NFKC folds full-width and compatibility forms so full-width letters can't dodge the phrase rules.
  const text = raw.normalize('NFKC');

  if (text.includes(UNTRUSTED_OPEN) || text.includes(UNTRUSTED_CLOSE) || /<<<\s*(?:END_)?UNTRUSTED/i.test(text)) {
    findings.push(finding('delimiter_forgery', 'critical', 'Forges the untrusted-content delimiters'));
  }

  for (const r of TEXT_RULES) {
    const m = text.match(r.pattern);
    if (m?.index !== undefined)
      findings.push(finding(r.rule, r.severity, r.message, excerptAround(text, m.index, m[0].length)));
  }

  const hosts = extractUrlHosts(text);
  const exfil = text.match(EXFIL_VERB_DATA);
  if (exfil?.index !== undefined && (hosts.length > 0 || EMAIL_PATTERN.test(text))) {
    findings.push(
      finding(
        'data_exfiltration',
        'critical',
        'Instructs sending user data to an external URL or email',
        excerptAround(text, exfil.index, exfil[0].length)
      )
    );
  }

  const allowlist = (options.urlAllowlist ?? []).map(h => h.toLowerCase());
  const outside = hosts.filter(h => !hostAllowed(h, allowlist));
  if (outside.length > 0) {
    findings.push(
      finding('external_url', 'medium', 'References URLs outside the allowlist', outside.slice(0, 5).join(', '))
    );
  }

  // The admin setting ADDS to the built-in list: a custom tool must never silently drop web_fetch
  // and the other defaults out of the review gate.
  const highRisk = new Set<string>([...DEFAULT_HIGH_RISK_TOOLS, ...(options.highRiskTools ?? [])]);
  // A tool outside the built-in catalog (an MCP or overlay tool) is unknown to this gate, so it is
  // treated as high-risk rather than silently trusted.
  const riskyTools = (snapshot.allowedTools ?? []).filter(t => highRisk.has(t) || !KNOWN_TOOLS.has(t));
  if (riskyTools.length > 0) {
    findings.push(
      finding('high_risk_tools', 'high', 'Declares tools that act outside the conversation', riskyTools.join(', '))
    );
  }
  // No declared tools means no restriction at run time (see intersectAllowedTools), so a body that
  // names a high-risk tool can still drive it.
  if (!snapshot.allowedTools?.length) {
    const named = [...highRisk].filter(t =>
      new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
    );
    if (named.length > 0) {
      findings.push(
        finding(
          'high_risk_tools',
          'high',
          'Names tools that act outside the conversation',
          named.slice(0, 5).join(', ')
        )
      );
    }
  }

  return findings;
}

/**
 * Lighter scan for user-written rating reviews and AI-written summaries shown to other users. Links
 * are refused unless every host is on `urlAllowlist` (reviews pass none, so any link is refused).
 */
export function scanPublicText(text: string, urlAllowlist: string[] = []): ISkillScanFinding[] {
  const findings: ISkillScanFinding[] = [];
  if (HIDDEN_CHARS.test(text)) findings.push(finding('hidden_characters', 'critical', 'Contains invisible characters'));
  if (/<\s*\/?\s*[a-z]+[^>]*>|javascript\s*:/i.test(text)) {
    findings.push(finding('html_or_script', 'critical', 'Contains HTML or script markup'));
  }
  const allowlist = urlAllowlist.map(h => h.toLowerCase());
  if (extractUrlHosts(text).some(h => !hostAllowed(h, allowlist))) {
    findings.push(finding('external_url', 'critical', 'Links are not allowed'));
  }
  return findings;
}

export type ClassifierOutcome = { verdict: 'pass' | 'fail'; confidence: number; descriptionMatches: boolean };

/**
 * Decide the tier from all findings plus the classifier's verdict. `failed` means not publishable.
 * The classifier can push a version toward failed/high/review but never toward clean.
 */
export function computeTier(
  findings: ISkillScanFinding[],
  classifier: ClassifierOutcome,
  minConfidence: number
): SkillRiskTier | 'failed' {
  if (classifier.verdict === 'fail' || findings.some(f => f.severity === 'critical')) return 'failed';
  if (findings.some(f => f.severity === 'high')) return 'high';
  if (
    findings.some(f => f.severity === 'medium') ||
    classifier.confidence < minConfidence ||
    !classifier.descriptionMatches
  ) {
    return 'review';
  }
  return 'clean';
}

/**
 * clean -> live at any visibility; review -> live for org/unlisted (with an "auto-checked" note),
 * held for Public; high -> held at every visibility.
 */
export function reviewStatusFor(tier: SkillRiskTier, visibility: SkillListingVisibility): SkillReviewStatus {
  if (tier === 'clean') return 'auto_approved';
  if (tier === 'review') return visibility === 'public' ? 'pending' : 'auto_approved';
  return 'pending';
}
