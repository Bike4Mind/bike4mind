/**
 * A content-free summary of a Bedrock request body, for error logs.
 *
 * Error logs are forwarded to a shared alert channel, so they must never carry prompt text. This keeps
 * only the payload's structure - sizes, counts, numeric/boolean config, and the handful of role and
 * content-block-type names below - and drops every string value. It is deliberately generic over the
 * per-provider body shapes (Anthropic `messages`, Llama `prompt`, Titan `inputText`, ...). Role and
 * block-type values are the only strings read from the body, so unknown ones become '?' rather than
 * passing through.
 */
export type PayloadShape = {
  bodyChars: number;
  parseable: boolean;
  fields?: Record<string, FieldShape>;
  messageCount?: number;
  roles?: string;
  lastMessageBlocks?: string[];
};

type FieldShape = number | boolean | null | { chars: number } | { items: number } | { keys: number };

const MAX_ROLES_LISTED = 40;
const MAX_FIELDS_LISTED = 30;

const KNOWN_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const KNOWN_BLOCK_TYPES = new Set([
  'text',
  'image',
  'document',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
  'search_result',
  'video',
  'guard_content',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const knownName = (value: unknown, known: Set<string>): string =>
  typeof value === 'string' && known.has(value) ? value : '?';

function describeField(value: unknown): FieldShape {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string') return { chars: value.length };
  if (Array.isArray(value)) return { items: value.length };
  if (isRecord(value)) return { keys: Object.keys(value).length };
  return null;
}

function blockTypes(content: unknown): string[] {
  if (typeof content === 'string') return ['string'];
  if (!Array.isArray(content)) return [];
  return content.map(block => (isRecord(block) ? knownName(block.type, KNOWN_BLOCK_TYPES) : typeof block));
}

export function describePayloadShape(body: string): PayloadShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { bodyChars: body.length, parseable: false };
  }
  if (!isRecord(parsed)) return { bodyChars: body.length, parseable: true };

  const shape: PayloadShape = {
    bodyChars: body.length,
    parseable: true,
    fields: Object.fromEntries(
      Object.entries(parsed)
        .slice(0, MAX_FIELDS_LISTED)
        .map(([key, value]) => [key, describeField(value)])
    ),
  };

  const messages = parsed.messages;
  if (Array.isArray(messages)) {
    const roles = messages.map(message => (isRecord(message) ? knownName(message.role, KNOWN_ROLES) : '?'));
    shape.messageCount = messages.length;
    // The tail is where a malformed turn (tool pairing, thinking block order) usually lives.
    shape.roles = (roles.length > MAX_ROLES_LISTED ? ['...', ...roles.slice(-MAX_ROLES_LISTED)] : roles).join(',');
    const last = messages[messages.length - 1];
    if (isRecord(last)) shape.lastMessageBlocks = blockTypes(last.content);
  }

  return shape;
}
