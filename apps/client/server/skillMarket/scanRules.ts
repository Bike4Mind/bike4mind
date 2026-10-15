import {
  b4mLLMTools,
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
 * Why strict: a published snapshot is copied into the importer's own skill namespace and can be
 * re-shared or re-listed from there, so this scan is the only gate before someone runs the body as
 * their own. (At run time an imported body is framed as an untrusted market copy - see
 * `importedFrom` in skillSafety.ts - and the CLI drops imports, but a human can still re-share it.)
 *
 * Every regex here runs on author-controlled text up to the body limit, so each one is bounded:
 * no nested ambiguous quantifiers, and gaps are counted words or capped character runs.
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

// CLI/local tools that are not in b4mLLMTools but act on the user's machine. A declared one is
// already held as unknown; this list lets a body that merely names one be held too.
const LOCAL_RISKY_TOOLS = [
  'bash_execute',
  'create_file',
  'delete_file',
  'edit_local_file',
  'write_shell_stdin',
  'kill_background_shell',
];

/** Case- and separator-insensitive tool key: web_fetch, web-fetch, WebFetch and webFetch collide. */
const toolKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const KNOWN_TOOL_KEYS = new Set<string>(b4mLLMTools.options.map(toolKey));

export type ScanOptions = {
  /** Tools that force human review, ADDED to DEFAULT_HIGH_RISK_TOOLS (admin setting). */
  highRiskTools?: string[];
  /** Hosts a skill may reference without a finding; subdomains match. */
  urlAllowlist?: string[];
};

type Rule = { rule: string; severity: ISkillScanFinding['severity']; message: string; pattern: RegExp };

const INJECTION_MESSAGE = 'Tries to override or discard prior/system instructions';
const CREDENTIAL_MESSAGE = 'Asks the user for credentials or sensitive secrets';
const FORGERY_MESSAGE = 'Forges the untrusted-content delimiters or a skill header';

/** Rules over the NFKC text as written (case-insensitive). */
const TEXT_RULES: Rule[] = [
  {
    rule: 'prompt_injection',
    severity: 'critical',
    message: INJECTION_MESSAGE,
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
    // Specific token shapes only (chat-template markers, bracketed/tagged roles, a header that is
    // just a role, a role label opening a sentence) so prose like "the operating system: Linux" or
    // "## System design" stays clean.
    pattern:
      /<\|?\s*(?:im_start|im_end|system|endoftext|eot_id|start_header_id)\s*\|?>|<\|[ \t]*[a-z_]{2,30}[ \t]*\|>|\[\/?[ \t]*(?:INST|SYS|SYSTEM|ASSISTANT|DEVELOPER)[ \t]*\]|<\/?\s*(?:system|developer|assistant|instructions|system_prompt|tool|tool_call|tool_result|function_call|function_results)\s*>|^[ \t]*#{1,6}[ \t]*(?:system|developer|assistant)(?:[ \t]+(?:prompt|message|instructions))?[ \t]*:?[ \t]*$|(?:^|[.!?][ \t]+)[ \t]*(?:system|developer)(?:[ \t]+(?:prompt|message))?[ \t]*:|\b(?:new|updated|real|true) (?:system )?(?:instructions|role|persona)\s*:/im,
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
    message: CREDENTIAL_MESSAGE,
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
    rule: 'delimiter_forgery',
    severity: 'critical',
    message: FORGERY_MESSAGE,
    pattern: /^[ \t]*#{1,6}[ \t]*skill(?:[ \t]+invoked)?[ \t]*:[ \t]*\//im,
  },
];

const ENCODED_BLOB_RULE: Rule = {
  rule: 'encoded_blob',
  severity: 'critical',
  message: 'Contains a large base64 or hex blob that could hide instructions',
  pattern: /[A-Za-z0-9+/]{200,}={0,2}|(?:[0-9a-fA-F]{2}){100,}/,
};

const INJECTION_VERBS = 'ignore|disregard|forget|override|bypass|discard|abandon|nullify|neglect';
const INJECTION_QUALIFIERS =
  'previous|prior|above|earlier|all|any|system|developer|safety|original|preceding|existing|initial|former|default|your';
const INJECTION_NOUNS =
  'instructions?|prompts?|rules|guidelines|guidance|directives|messages?|polic(?:y|ies)|constraints|commands|orders|programming';
const SECRET_NOUNS =
  'passwords?|passcodes?|api keys?|secret keys?|access tokens?|credentials|credit card|card numbers?|cvv|ssn|social security|2fa|otp|one time (?:code|password)|seed phrase|recovery phrase|private keys?|login details';
const CJK_IGNORE = '\\u5FFD\\u7565|\\u65E0\\u89C6|\\u5FFD\\u89C6|\\u7121\\u8996';
const CJK_INSTRUCTIONS = '\\u6307\\u4EE4|\\u6307\\u793A|\\u89C4\\u5219|\\u898F\\u5247|\\u63D0\\u793A|\\u8BF4\\u660E';

/**
 * Rules over the folded copy (see foldForMatching): lowercase, accents and invisibles stripped,
 * leet/homoglyphs folded, every run of punctuation/whitespace a single space. `(?: \S+){0,N}` is a
 * gap of at most N words.
 */
const FOLDED_RULES: Rule[] = [
  {
    rule: 'prompt_injection',
    severity: 'critical',
    message: INJECTION_MESSAGE,
    pattern: new RegExp(
      `\\b(?:${INJECTION_VERBS})(?: \\S+){0,12} (?:${INJECTION_QUALIFIERS})(?: \\S+){0,4} (?:${INJECTION_NOUNS})\\b`
    ),
  },
  {
    rule: 'prompt_injection',
    severity: 'critical',
    message: INJECTION_MESSAGE,
    pattern:
      /\b(?:stop|cease|quit) (?:following|obeying|listening to|using|applying)(?: \S+){0,3} (?:system prompt|instructions|rules|guidelines|guidance|developer message|polic(?:y|ies))\b|\b(?:pretend|act as if|act as though|imagine|assume)(?: \S+){0,6} (?:instructions|rules|guidance|guidelines|prompt|messages?|polic(?:y|ies))(?: \S+){0,3} (?:never existed|never happened|do not exist|don t exist|does not exist|doesn t exist|were never|was never|are void|is void|no longer apply|do not apply|don t apply)\b|\b(?:ignore|disregard|forget)(?: all| everything)?(?: of)?(?: the| what is| what s)? (?:above|preceding|foregoing)\b/,
  },
  {
    rule: 'prompt_injection',
    severity: 'critical',
    message: `${INJECTION_MESSAGE} (non-English)`,
    pattern: new RegExp(
      [
        '\\b(?:ignora|ignore|ignoren|olvida|olvide|olviden|omite|descarta)(?: \\S+){0,4} (?:instrucciones|reglas|indicaciones|directrices)\\b',
        '\\b(?:ignore[zr]?|oublie[zr]?)(?: \\S+){0,4} (?:instructions|consignes|regles|directives)(?: \\S+)? (?:precedentes|anterieures|systeme|ci dessus)\\b',
        '\\b(?:ignoriere|ignorieren|ignoriert|vergiss|vergesst|vergessen)(?: \\S+){0,4} (?:anweisungen|regeln|instruktionen|vorgaben|befehle)\\b',
        `(?:${CJK_IGNORE})[^ ]{0,12}?(?:${CJK_INSTRUCTIONS})`,
        `(?:${CJK_INSTRUCTIONS})[^ ]{0,6}?(?:${CJK_IGNORE})`,
      ].join('|')
    ),
  },
  {
    rule: 'credential_harvesting',
    severity: 'critical',
    message: CREDENTIAL_MESSAGE,
    // The negation lookbehind keeps "never ask for passwords" (a safety note) clean.
    pattern: new RegExp(
      `(?<!\\b(?:not|never|t|no|without) )\\b(?:ask|request|prompt|collect|obtain|require)(?: \\S+){0,3} (?:for|to provide|to enter|to share|to give|to type|to paste|to send)(?: \\S+){0,3} (?:${SECRET_NOUNS})\\b`
    ),
  },
  {
    rule: 'delimiter_forgery',
    severity: 'critical',
    message: FORGERY_MESSAGE,
    pattern:
      /\buntrusted skill content\b|\bend untrusted\b|\bshared by (?:the system|your organization|another user|a skill market author)\b/,
  },
  {
    rule: 'url_data_append',
    severity: 'high',
    message: 'Tells the model to put data into an image URL or query string',
    pattern:
      /\b(?:append|add|attach|encode|put|include|insert|embed)\b(?: \S+){0,8} (?:to|in|into|onto) (?:the |an |a |this |that |each |every )?(?:(?:markdown )?(?:image|img|picture|pixel)(?: \S+)? (?:url|urls|link|src|source|address)|query string|query parameters?|url parameters?)\b/,
  },
];

/** Rules over the folded copy with the spaces removed too: catches letter-spaced phrases. */
const COMPACT_RULES: Rule[] = [
  {
    rule: 'prompt_injection',
    severity: 'critical',
    message: INJECTION_MESSAGE,
    pattern:
      /(?:ignore|disregard|forget|override|bypass)(?:all|any|of|the|your|every){0,3}(?:previous|prior|above|earlier|system|developer|original|preceding|initial)(?:instructions?|prompts?|rules|guidelines|directives|messages?|guidance)/,
  },
];

// Instruction-shaped exfiltration with no URL/email (a URL makes it the critical rule below).
const EXFIL_INSTRUCTION = new RegExp(
  '\\b(?:send|post|forward|upload|leak|exfiltrate|transmit|e ?mail)(?: \\S+){0,4} ' +
    '(?:conversations?|chat (?:history|logs?)|(?:previous|prior|earlier|all) messages|message history|system prompt|' +
    'api keys?|access tokens?|tokens|credentials|passwords?|secrets|files|documents|memor(?:y|ies)|' +
    'personal (?:data|information)|user data)\\b(?: \\S+){0,4} (?:to|at|into|via|onto) ' +
    '(?!(?:the |a |this )?(?:user|users|requester|caller|invoker|me|you|yourself|them)\\b)\\S'
);

// Natural-language asks that need a high-risk tool even when no tool is named.
const RISKY_TOOL_PHRASE =
  /\b(?:fetch|download|scrape|crawl|browse to|open) (?:the |a |this |that |any |each )?(?:web ?pages?|pages?|urls?|websites?|sites?|links?)\b|\bpublish (?:the |a |this )?(?:blog|post|article)|\bdelegate (?:this |the )?(?:task |work )?to (?:an |another )?agent\b/;

const EXFIL_VERB_DATA =
  /\b(send|post|upload|forward|exfiltrate|transmit|e-?mail|leak|copy|sync|beacon|report)\b[^.\n]{0,80}\b(conversations?|chat history|messages|files?|documents?|attachments?|api[ _-]?keys?|keys|tokens?|secrets?|credentials?|passwords?|memor(?:y|ies)|context|system prompt|personal (?:data|information)|user data)\b/i;
const URL_PATTERN = /\b(?:https?|s?ftp|wss?):\/\/[^\s<>"'`)\]]+/gi;
// A scheme-less host ("evil.com/c") is still a destination the model can be told to use. Without a
// path only TLDs that are not also common file extensions count, so "notes.md" and "Node.js" stay
// prose; with a path any alphabetic TLD counts, minus source-file extensions ("src/x.ts/").
const BARE_TLDS =
  'com|net|org|io|co|ai|app|dev|me|info|biz|xyz|site|online|top|ru|cn|tk|ly|gg|cc|de|uk|fr|jp|kr|br|nl|ch|se|pl|eu|us|ca|au|tv|ws|su|pw|club|live|shop|store|tech|cloud|link|click|icu|buzz|fun|page|work';
const BARE_HOST_PATTERN = new RegExp(`(?<![@\\w./-])((?:[a-z0-9-]+\\.)+(?:${BARE_TLDS}))(?![\\w-]|\\.\\w)`, 'gi');
const PATH_HOST_PATTERN = /(?<![@\w./-])((?:[a-z0-9-]+\.)+([a-z]{2,24}))(?=\/)/gi;
const SOURCE_FILE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'md', 'py', 'json', 'txt', 'yml', 'yaml', 'html']);
const IPV4_PATTERN = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w]|\.\d)/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const MARKDOWN_IMAGE = /!\[[^\]\n]{0,500}\]\(\s*<?([^)\s>]{1,2000})/g;

// Zero-width, bidi marks/overrides/isolates, soft hyphen, BOM, invisible tag characters, C0/C1
// controls other than tab/newline/CR, variation selectors (incl. the supplementary block used to
// smuggle bytes), Mongolian FVS/vowel separator, Hangul fillers, braille blank, CGJ and ALM.
// U+FE0E/U+FE0F only count when not attached to an emoji or keycap base, so normal emoji pass.
// The lone combining marks (CGJ, FVS, variation selectors) are the point, hence the
// misleading-character-class opt-out.
const HIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u2800\u3164\uFE00-\uFE0D\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]|(?<![\p{Extended_Pictographic}#*0-9])[\uFE0E\uFE0F]/u;
// Same set without the emoji exemption: stripped from the matching copy.
const INVISIBLE_CHAR =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class
  /^(?:[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}])$/u;

// Leet digits/symbols and the Cyrillic/Greek letters that render like Latin ones.
const CONFUSABLES: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043E': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0445': 'x',
  '\u0443': 'y',
  '\u0456': 'i',
  '\u0455': 's',
  '\u0458': 'j',
  '\u04BB': 'h',
  '\u03B1': 'a',
  '\u03B9': 'i',
  '\u03BD': 'v',
  '\u03BF': 'o',
  '\u03C1': 'p',
};

const MAX_DECODED_TOKENS = 20;
const ENCODED_TOKEN = /[A-Za-z0-9+/]{16,400}={0,2}/g;

/** A matching-only copy of `text` plus, per output char, its index in `text` (for excerpts). */
type FoldedText = { text: string; origin: number[] };

function foldForMatching(text: string): FoldedText {
  let out = '';
  const origin: number[] = [];
  let index = 0;
  for (const ch of text) {
    const at = index;
    index += ch.length;
    if (INVISIBLE_CHAR.test(ch)) continue;
    for (const lower of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      const c = CONFUSABLES[lower] ?? lower;
      if (/[\p{L}\p{N}]/u.test(c)) {
        out += c;
        origin.push(at);
      } else if (out.length > 0 && !out.endsWith(' ')) {
        out += ' ';
        origin.push(at);
      }
    }
  }
  return { text: out, origin };
}

function compact(folded: FoldedText): FoldedText {
  let out = '';
  const origin: number[] = [];
  for (let i = 0; i < folded.text.length; i++) {
    if (folded.text[i] === ' ') continue;
    out += folded.text[i];
    origin.push(folded.origin[i]);
  }
  return { text: out, origin };
}

/** Undo common link defanging ("hxxps://evil[.]com") so the host rules see the real link. */
const defang = (text: string): string =>
  text
    .replace(/\bhxxp(s?)(?=:|\[:\])/gi, 'http$1')
    .replace(/\[:\]/g, ':')
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/gi, '.');

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

const isIpv4 = (candidate: string): boolean => candidate.split('.').every(octet => Number(octet) <= 255);

export function extractUrlHosts(input: string): string[] {
  const text = defang(input);
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      hosts.add(match[0].slice(0, 80));
    }
  }
  const rest = text.replace(URL_PATTERN, ' ');
  for (const match of rest.matchAll(BARE_HOST_PATTERN)) hosts.add(match[1].toLowerCase());
  for (const match of rest.matchAll(PATH_HOST_PATTERN)) {
    if (!SOURCE_FILE_EXTENSIONS.has(match[2].toLowerCase())) hosts.add(match[1].toLowerCase());
  }
  for (const match of rest.matchAll(IPV4_PATTERN)) if (isIpv4(match[1])) hosts.add(match[1]);
  return [...hosts];
}

/** Runs one rule list over a (possibly folded) copy; excerpts point back into `original`. */
function matchRules(rules: Rule[], copy: FoldedText | string, original: string): ISkillScanFinding[] {
  const haystack = typeof copy === 'string' ? copy : copy.text;
  const found: ISkillScanFinding[] = [];
  for (const r of rules) {
    const m = haystack.match(r.pattern);
    if (m?.index === undefined) continue;
    if (typeof copy === 'string') {
      found.push(finding(r.rule, r.severity, r.message, excerptAround(original, m.index, m[0].length)));
      continue;
    }
    const start = copy.origin[m.index];
    const end = copy.origin[m.index + m[0].length - 1] + 1;
    found.push(finding(r.rule, r.severity, r.message, excerptAround(original, start, end - start)));
  }
  return found;
}

/** The phrase-level rules, run over the text as written and over its folded/compact copies. */
function scanPhrases(text: string): ISkillScanFinding[] {
  const folded = foldForMatching(text);
  return [
    ...matchRules(TEXT_RULES, text, text),
    ...matchRules(FOLDED_RULES, folded, text),
    ...matchRules(COMPACT_RULES, compact(folded), text),
  ];
}

const isMostlyText = (decoded: string): boolean => {
  if (decoded.length < 8) return false;
  const readable = decoded.match(/[\p{L}\p{N}\p{P}\p{Zs}\n\t]/gu)?.length ?? 0;
  return readable / decoded.length >= 0.9;
};

/** Decode short base64/hex tokens (the encoded_blob rule covers long ones) and rescan them. */
function scanEncodedTokens(text: string): ISkillScanFinding[] {
  const found: ISkillScanFinding[] = [];
  let checked = 0;
  for (const match of text.matchAll(ENCODED_TOKEN)) {
    if (checked++ >= MAX_DECODED_TOKENS) break;
    const token = match[0];
    const isHex = /^(?:[0-9a-fA-F]{2})+$/.test(token);
    const decoded = Buffer.from(token, isHex ? 'hex' : 'base64').toString('utf8');
    if (!isMostlyText(decoded)) continue;
    for (const f of scanPhrases(decoded)) {
      found.push({
        ...f,
        message: `${f.message} (hidden in an encoded string)`,
        excerpt: excerptAround(text, match.index ?? 0, token.length),
      });
    }
  }
  return found;
}

/** Legacy completion-format turn markers: a Human: turn followed later by an Assistant: turn. */
function findRoleTurnPair(text: string): number | undefined {
  const human = /(?:^|\n)[ \t]*human[ \t]*:/i.exec(text);
  if (!human) return undefined;
  return /\bassistant[ \t]*:/i.test(text.slice(human.index + human[0].length)) ? human.index : undefined;
}

function scanMarkdownImages(text: string, allowlist: string[]): ISkillScanFinding | undefined {
  let checked = 0;
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    if (checked++ >= 50) break;
    const url = defang(match[1]);
    let reason: string | undefined;
    if (/[?{}$<]|%7B/i.test(url)) reason = 'whose URL carries a query string or placeholder';
    else if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url)) {
      let host = '';
      try {
        host = new URL(url.startsWith('//') ? `https:${url}` : url).hostname.toLowerCase();
      } catch {
        host = '';
      }
      if (!host || !hostAllowed(host, allowlist)) reason = 'on a host outside the allowlist';
    }
    if (reason) {
      return finding(
        'markdown_image_exfil',
        'critical',
        `Markdown image ${reason} (a known exfiltration channel)`,
        excerptAround(text, match.index ?? 0, match[0].length)
      );
    }
  }
  return undefined;
}

function scanTools(
  snapshot: ISkillSnapshot,
  text: string,
  folded: FoldedText,
  highRiskTools: string[]
): ISkillScanFinding[] {
  const highRiskKeys = new Set(highRiskTools.map(toolKey));
  const findings: ISkillScanFinding[] = [];

  // A tool outside the built-in catalog (an MCP or overlay tool) is unknown to this gate, so it is
  // treated as high-risk rather than silently trusted; a namespaced mcp__server__tool always is,
  // whatever its final segment is called.
  const riskyTools = (snapshot.allowedTools ?? []).filter(tool => {
    const segments = tool.split('__');
    const key = toolKey(segments[segments.length - 1]);
    return segments.length > 1 || !KNOWN_TOOL_KEYS.has(key) || highRiskKeys.has(key);
  });
  if (riskyTools.length > 0) {
    findings.push(
      finding('high_risk_tools', 'high', 'Declares tools that act outside the conversation', riskyTools.join(', '))
    );
  }

  // No declared tools means no restriction at run time (see intersectAllowedTools), so a body that
  // names a high-risk tool, in any casing or separator style, can still drive it.
  if (snapshot.allowedTools?.length) return findings;
  const mentionKeys = new Set([...highRiskKeys, ...LOCAL_RISKY_TOOLS.map(toolKey)]);
  const named = new Set<string>();
  for (const token of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*/g)) {
    if (mentionKeys.has(toolKey(token[0]))) named.add(token[0]);
  }
  const phrase = folded.text.match(RISKY_TOOL_PHRASE);
  if (phrase) named.add(phrase[0]);
  if (named.size > 0) {
    findings.push(
      finding(
        'high_risk_tools',
        'high',
        'Names tools that act outside the conversation',
        [...named].slice(0, 5).join(', ')
      )
    );
  }
  return findings;
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
  const folded = foldForMatching(text);

  const add = (f: ISkillScanFinding) => {
    if (!findings.some(existing => existing.rule === f.rule && existing.severity === f.severity)) findings.push(f);
  };

  scanPhrases(text).forEach(add);
  matchRules([ENCODED_BLOB_RULE], text, text).forEach(add);
  scanEncodedTokens(text).forEach(add);

  const turnPair = findRoleTurnPair(text);
  if (turnPair !== undefined) {
    add(
      finding(
        'role_override',
        'critical',
        'Fakes a system/assistant role or chat-template delimiter',
        excerptAround(text, turnPair, 20)
      )
    );
  }

  const allowlist = (options.urlAllowlist ?? []).map(h => h.toLowerCase());
  const image = scanMarkdownImages(text, allowlist);
  if (image) add(image);

  const hosts = extractUrlHosts(text);
  const exfil = text.match(EXFIL_VERB_DATA);
  if (exfil?.index !== undefined && (hosts.length > 0 || EMAIL_PATTERN.test(text))) {
    add(
      finding(
        'data_exfiltration',
        'critical',
        'Instructs sending user data to an external URL or email',
        excerptAround(text, exfil.index, exfil[0].length)
      )
    );
  } else {
    const instruction = matchRules(
      [
        {
          rule: 'data_exfiltration',
          severity: 'high',
          message: 'Instructs sending conversation data, secrets or files to a third party',
          pattern: EXFIL_INSTRUCTION,
        },
      ],
      folded,
      text
    );
    instruction.forEach(add);
  }

  const outside = hosts.filter(h => !hostAllowed(h, allowlist));
  if (outside.length > 0) {
    add(finding('external_url', 'medium', 'References URLs outside the allowlist', outside.slice(0, 5).join(', ')));
  }

  // The admin setting ADDS to the built-in list: a custom tool must never silently drop web_fetch
  // and the other defaults out of the review gate.
  scanTools(snapshot, text, folded, [...DEFAULT_HIGH_RISK_TOOLS, ...(options.highRiskTools ?? [])]).forEach(f =>
    findings.push(f)
  );

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
