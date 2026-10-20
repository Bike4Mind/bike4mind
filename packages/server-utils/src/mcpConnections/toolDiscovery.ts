import { createHash } from 'node:crypto';
import { MCP_CONNECTION_LIMITS, type IMcpConnectionTool, type IMcpConnectionToolAnnotations } from '@bike4mind/common';

/**
 * Tool discovery for custom remote MCP connectors (design #4845 section 6): cleaning what an
 * untrusted server says about its tools, fingerprinting the list, and merging a fresh list into the
 * stored one so new or changed tools wait for the user's review (the rug-pull defence).
 *
 * Pure apart from hashing; the dispatcher in apps/client/server/mcpConnections/ does the I/O.
 */

/** What `RemoteMcpClient.listTools` returns per tool (`@bike4mind/mcp/remote`), typed structurally. */
export interface DiscoveredMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface CleanedMcpTool {
  name: string;
  title?: string;
  description: string;
  descriptionRawHash: string;
  inputSchema: Record<string, unknown>;
  annotations?: IMcpConnectionToolAnnotations;
}

export type DroppedMcpToolReason = 'invalid_name' | 'duplicate_name' | 'schema_invalid';

/** A refused tool. The name itself is hostile input, so only its hash is kept (for the audit log). */
export interface DroppedMcpTool {
  reason: DroppedMcpToolReason;
  nameSha256: string;
}

/**
 * Tools reach the model as `<slug>__<tool>`, which providers cap at 64 characters of
 * `[A-Za-z0-9_-]`. Slugs are at most 20 characters (must stay in sync with
 * MCP_CONNECTION_SLUG_PATTERN in @bike4mind/common), leaving 42 for the tool name.
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64 - '__'.length - 20;
export const MCP_TOOL_NAME_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MCP_TOOL_NAME_MAX_LENGTH}}$`);

const TITLE_MAX_CHARS = MCP_CONNECTION_LIMITS.serverInfoFieldLength;
/** Per prose string (`description`, `title`, `$comment`) inside an input schema. */
export const MCP_SCHEMA_TEXT_MAX_CHARS = 512;
/** Nesting allowed in an input schema; a deeper one drops the tool as `schema_invalid`. */
export const MCP_SCHEMA_MAX_DEPTH = 32;
// Leaves room for the wrappers toolSignature adds around a schema already within MCP_SCHEMA_MAX_DEPTH.
const CANONICAL_JSON_MAX_DEPTH = 64;

// Invisible and direction-changing characters: soft hyphen, combining grapheme joiner, Arabic letter
// mark, Hangul fillers, Mongolian selectors, zero-width space/joiners, LRM/RLM, bidi embeddings and
// isolates, word joiner and invisible operators, variation selectors, BOM, interlinear annotations.
// Each code point is stripped on its own, so the combining-mark lint does not apply.
const INVISIBLE_BMP =
  // eslint-disable-next-line no-misleading-character-class
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;
// Unicode tag characters (invisible ASCII smuggling) and the variation selectors supplement.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_ASTRAL = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// Anything shaped like an XML/HTML tag (`<system>`, `</instructions>`, `<tool_call foo="x"/>`).
// Descriptions are plain text for a model, so no legitimate tag is lost; the inner text is kept.
const MARKUP_TAG = /<\/?[A-Za-z][A-Za-z0-9:_.-]*(?:\s[^<>]*)?\/?>/g;
// Chat-template control tokens: `<|im_start|>`, `[INST]`, `<<SYS>>`.
const TEMPLATE_TOKEN = /<\|[^<>|]{0,64}\|>|\[\/?INST\]|<<\/?SYS>>/gi;
const MAX_TAG_PASSES = 5;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * JSON with object keys sorted at every depth, so equal values always hash equal. Throws a
 * RangeError past {@link CANONICAL_JSON_MAX_DEPTH} rather than exhausting the stack.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > CANONICAL_JSON_MAX_DEPTH) throw new RangeError('Value is nested too deeply to fingerprint');
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// UTF-16 code units, because that is what Mongoose `maxlength` counts; a dangling high surrogate
// left by the cut is dropped too.
function truncateUtf16(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Cleans a server-supplied description (or title) before the model can see it: NFKC-normalise (so
 * fullwidth brackets become real ones and are caught below), drop invisible and bidi characters,
 * turn control characters into spaces, strip HTML/XML comments, tag-shaped markup and chat-template
 * tokens, collapse whitespace, and truncate to `maxChars` UTF-16 code units.
 */
export function cleanMcpToolText(raw: string, maxChars: number = MCP_CONNECTION_LIMITS.toolDescriptionLength): string {
  let text = raw.normalize('NFKC').replace(INVISIBLE_BMP, '').replace(INVISIBLE_ASTRAL, '').replace(CONTROL_CHARS, ' ');
  text = text.replace(HTML_COMMENT, ' ');
  // Repeat, because removing one tag can join its neighbours into another (`<<b>system>`). A tag
  // right after a `<` is removed without a space so the outer brackets can meet and match next pass.
  for (let pass = 0; pass < MAX_TAG_PASSES; pass++) {
    const next = text
      .replace(TEMPLATE_TOKEN, ' ')
      .replace(MARKUP_TAG, (_tag: string, offset: number, whole: string) => (whole[offset - 1] === '<' ? '' : ' '));
    if (next === text) break;
    text = next;
  }
  return truncateUtf16(text.replace(/\s+/g, ' ').trim(), maxChars);
}

function cleanAnnotations(raw: unknown): IMcpConnectionToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const annotations: IMcpConnectionToolAnnotations = {};
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof source[hint] === 'boolean') annotations[hint] = source[hint];
  }
  if (typeof source.title === 'string') {
    const title = cleanMcpToolText(source.title, TITLE_MAX_CHARS);
    if (title) annotations.title = title;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

class InvalidSchemaError extends Error {}

/** Human prose in a schema object: rewritten like a description. Every other string is a value. */
const SCHEMA_PROSE_KEYS: ReadonlySet<string> = new Set(['description', 'title', '$comment']);
/** Keywords whose children are property names, not schema keywords. */
const SCHEMA_NAME_MAP_KEYS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
/** Keywords whose contents are data the model or server reads verbatim. */
const SCHEMA_DATA_KEYS: ReadonlySet<string> = new Set(['enum', 'const', 'default', 'examples']);

type SchemaPosition = 'schema' | 'names' | 'data';

/**
 * Whether a machine-read string (a key, an enum member, a default, a pattern...) carries what the
 * cleaner would strip. Such a string is never rewritten, since that would change what the server
 * receives; the tool is refused instead. Tag-shaped tokens are looked for in the NFKC form (so
 * fullwidth brackets count) without rewriting the string, and not in a regex `pattern`, where
 * `(?<name>...)` is legitimate syntax.
 */
function machineStringIsHostile(value: string, isPattern: boolean): boolean {
  for (const re of [CONTROL_CHARS, INVISIBLE_BMP, INVISIBLE_ASTRAL]) if (value.search(re) !== -1) return true;
  if (isPattern) return false;
  const folded = value.normalize('NFKC');
  return [HTML_COMMENT, MARKUP_TAG, TEMPLATE_TOKEN].some(re => folded.search(re) !== -1);
}

function cleanSchemaValue(value: unknown, depth: number, position: SchemaPosition, key?: string): unknown {
  if (depth > MCP_SCHEMA_MAX_DEPTH) throw new InvalidSchemaError('too deep');
  if (typeof value === 'string') {
    if (position === 'schema' && key !== undefined && SCHEMA_PROSE_KEYS.has(key)) {
      return cleanMcpToolText(value, MCP_SCHEMA_TEXT_MAX_CHARS);
    }
    if (machineStringIsHostile(value, position === 'schema' && key === 'pattern')) {
      throw new InvalidSchemaError('hostile value');
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Array members inherit the keyword: `enum`/`examples` members are data, `allOf` members schemas.
    return value.map(item => cleanSchemaValue(item, depth + 1, position === 'names' ? 'schema' : position, key));
  }
  if (value && typeof value === 'object') {
    const entries: [string, unknown][] = [];
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      if (machineStringIsHostile(childKey, false)) throw new InvalidSchemaError('hostile key');
      const childPosition: SchemaPosition =
        position === 'data'
          ? 'data'
          : position === 'names'
            ? 'schema'
            : SCHEMA_DATA_KEYS.has(childKey)
              ? 'data'
              : SCHEMA_NAME_MAP_KEYS.has(childKey)
                ? 'names'
                : 'schema';
      entries.push([childKey, cleanSchemaValue(item, depth + 1, childPosition, childKey)]);
    }
    // fromEntries defines own properties, so a `__proto__` key stays data instead of a prototype.
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * The schema with its prose (`description`, `title`, `$comment`) cleaned like a description, since
 * it reaches the model. Keys and every other string are values the model or server reads verbatim,
 * so they are never rewritten. Null (the tool is dropped as `schema_invalid`) when the schema is
 * nested deeper than {@link MCP_SCHEMA_MAX_DEPTH} or a key or value carries control, invisible,
 * bidi or tag characters or a tag-like injection token. A missing or non-object schema becomes an
 * empty object schema.
 */
function cleanInputSchema(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { type: 'object' };
  try {
    return cleanSchemaValue(raw, 0, 'schema') as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidSchemaError) return null;
    throw error;
  }
}

/**
 * Cleans every tool and refuses the ones whose name the model could not address safely (a name
 * outside {@link MCP_TOOL_NAME_PATTERN}, or a second tool with a name already seen) and the ones
 * whose input schema {@link cleanInputSchema} refuses.
 */
export function cleanDiscoveredTools(raw: readonly DiscoveredMcpTool[]): {
  tools: CleanedMcpTool[];
  dropped: DroppedMcpTool[];
} {
  const tools: CleanedMcpTool[] = [];
  const dropped: DroppedMcpTool[] = [];
  const seen = new Set<string>();
  for (const tool of raw) {
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      dropped.push({ reason: 'invalid_name', nameSha256: sha256(name) });
      continue;
    }
    if (seen.has(name)) {
      dropped.push({ reason: 'duplicate_name', nameSha256: sha256(name) });
      continue;
    }
    seen.add(name);
    const inputSchema = cleanInputSchema(tool.inputSchema);
    if (!inputSchema) {
      dropped.push({ reason: 'schema_invalid', nameSha256: sha256(name) });
      continue;
    }
    const rawDescription = typeof tool.description === 'string' ? tool.description : '';
    const title = typeof tool.title === 'string' ? cleanMcpToolText(tool.title, TITLE_MAX_CHARS) : '';
    const annotations = cleanAnnotations(tool.annotations);
    tools.push({
      name,
      ...(title ? { title } : {}),
      description: cleanMcpToolText(rawDescription),
      descriptionRawHash: sha256(rawDescription),
      inputSchema,
      ...(annotations ? { annotations } : {}),
    });
  }
  return { tools, dropped };
}

type ToolIdentity = Pick<
  CleanedMcpTool,
  'name' | 'title' | 'description' | 'descriptionRawHash' | 'inputSchema' | 'annotations'
>;

/** Everything about a tool that, when it changes, must send the tool back to review. */
function toolSignature(tool: ToolIdentity): string {
  return canonicalJson([
    tool.name,
    tool.title ?? null,
    tool.description,
    tool.descriptionRawHash,
    sha256(canonicalJson(tool.inputSchema)),
    tool.annotations ?? null,
  ]);
}

/** The per-tool `versionHash` a review is bound to: sha256 of the same fields the fingerprint covers. */
export function computeMcpToolVersionHash(tool: ToolIdentity): string {
  return sha256(toolSignature(tool));
}

/**
 * sha256 over the tools sorted by name, each as (name, title, cleaned description, raw description
 * hash, schema hash, annotations). Independent of server order and key order. It covers the same
 * fields as the per-tool change check in {@link mergeDiscoveredTools}, so an unchanged fingerprint
 * means no tool needs review.
 */
export function computeMcpToolsFingerprint(tools: readonly ToolIdentity[]): string {
  const signatures = tools.map(toolSignature).sort();
  return sha256(`[${signatures.join(',')}]`);
}

export interface McpToolMergeResult {
  tools: IMcpConnectionTool[];
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * Merges a fresh, cleaned list into the stored tools, in server order. New tools and tools whose
 * title, description, schema or annotations changed arrive as `pending_review`, disabled, with the
 * default approval (an `always_allow` given to the old tool does not carry over to what replaced
 * it). Unchanged tools keep every review choice. Tools the server no longer lists are dropped.
 */
export function mergeDiscoveredTools(
  existing: readonly IMcpConnectionTool[],
  discovered: readonly CleanedMcpTool[],
  now: Date = new Date()
): McpToolMergeResult {
  const byName = new Map(existing.map(tool => [tool.name, tool]));
  const added: string[] = [];
  const changed: string[] = [];
  const tools = discovered.map((fresh): IMcpConnectionTool => {
    const stored = byName.get(fresh.name);
    const versionHash = computeMcpToolVersionHash(fresh);
    if (stored && toolSignature(stored) === toolSignature(fresh)) {
      return {
        ...fresh,
        versionHash,
        enabled: stored.enabled,
        approval: stored.approval,
        state: stored.state,
        firstSeenAt: stored.firstSeenAt,
      };
    }
    (stored ? changed : added).push(fresh.name);
    return {
      ...fresh,
      versionHash,
      enabled: false,
      approval: 'default',
      state: 'pending_review',
      firstSeenAt: stored?.firstSeenAt ?? now,
    };
  });
  const freshNames = new Set(discovered.map(tool => tool.name));
  const removed = existing.filter(tool => !freshNames.has(tool.name)).map(tool => tool.name);
  return { tools, added, changed, removed };
}
