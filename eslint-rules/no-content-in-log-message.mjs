/**
 * Flags a log call whose message text carries user or model content: a prompt, question, search
 * query or model response interpolated into a template literal, concatenated, or passed as a
 * positional argument. Message text is not covered by the key-based redaction in
 * b4m-core/observability/src/redactLogValue.ts, so log a length or count instead
 * (`{ promptLength: prompt.length }`), or a redacted metadata key at debug level.
 *
 * Matched by variable or property name, so it is a guard for the common shapes, not a proof.
 * Metadata objects (`{ query }`) are left to key redaction; `.length` of a content value is allowed.
 */
const LOG_METHODS = new Set(['info', 'warn', 'error', 'log']);
const LOGGER_NAME = /(?:^|\.)(?:logger|log|console|imageLogger)$/i;
const CONTENT_NAME =
  /^(?:prompt|userPrompt|systemPrompt|cleanPrompt|generatedPrompt|question|query|searchQuery|llmResponse|completion|generatedData|generatedText|generatedName|cleanDescription|deviceLabel|transcript|body)$/;

function calleeObjectName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const object = calleeObjectName(node.object);
    return object ? `${object}.${node.property.name}` : node.property.name;
  }
  return undefined;
}

/** Returns the first content-named identifier that would be rendered into the message, if any. */
function findContent(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Identifier':
      return CONTENT_NAME.test(node.name) ? node.name : undefined;
    case 'MemberExpression':
      if (!node.computed && node.property.type === 'Identifier') {
        if (node.property.name === 'length') return undefined;
        if (CONTENT_NAME.test(node.property.name)) return node.property.name;
      }
      return undefined;
    case 'CallExpression':
      // `query.slice(0, 50)`, `String(prompt)`, `JSON.stringify(query)`: the content still reaches the line.
      if (node.callee.type === 'MemberExpression') {
        return findContent(node.callee.object) ?? node.arguments.map(findContent).find(Boolean);
      }
      return node.arguments.map(findContent).find(Boolean);
    case 'TemplateLiteral':
      return node.expressions.map(findContent).find(Boolean);
    case 'BinaryExpression':
      return node.operator === '+' ? (findContent(node.left) ?? findContent(node.right)) : undefined;
    case 'LogicalExpression':
      return findContent(node.left) ?? findContent(node.right);
    case 'ConditionalExpression':
      return findContent(node.consequent) ?? findContent(node.alternate);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ChainExpression':
      return findContent(node.expression);
    default:
      return undefined;
  }
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow user or model content in log message text' },
    schema: [],
    messages: {
      content:
        "'{{name}}' looks like user or model content and would be written into the log message. Log its length or an id instead.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        if (!LOG_METHODS.has(callee.property.name)) return;
        const loggerName = calleeObjectName(callee.object);
        if (!loggerName || !LOGGER_NAME.test(loggerName)) return;
        for (const arg of node.arguments) {
          if (arg.type === 'ObjectExpression') continue;
          const name = findContent(arg);
          if (name) {
            context.report({ node: arg, messageId: 'content', data: { name } });
            return;
          }
        }
      },
    };
  },
};
