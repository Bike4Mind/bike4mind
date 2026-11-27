const UPDATE_METHODS = new Set(['findOneAndUpdate', 'findByIdAndUpdate', 'updateOne', 'updateMany']);
const OPT_OUT = /\bupdate-validators-off:\s*\S[^\r\n]*/;

function unwrap(node) {
  while (
    node &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression'].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

function propertyName(node) {
  if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
  if (node.property?.type === 'Literal') return node.property.value;
  return undefined;
}

function validatorSetting(node, previous) {
  node = unwrap(node);
  if (node?.type !== 'ObjectExpression') return undefined;
  let setting = previous;
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') {
      setting = undefined;
    } else {
      const name = property.computed
        ? property.key.type === 'Literal'
          ? property.key.value
          : undefined
        : (property.key.name ?? property.key.value);
      if (name === undefined || name === 'runValidators') {
        const value = unwrap(property.value);
        setting = name === 'runValidators' && value.type === 'Literal' && value.value === true;
      }
    }
  }
  return setting;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require explicit validator handling on database update methods (syntax-only)',
    },
    schema: [],
    messages: {
      validators:
        '{{method}}() requires explicit runValidators: true in its third argument or chained setOptions(). ' +
        'For an intentional bypass (including native-driver calls), add a call-local ' +
        '"update-validators-off: <reason>" comment. Existing calls are baselined in eslint-suppressions.json.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression') return;
        const method = propertyName(callee);
        if (!UPDATE_METHODS.has(method)) return;

        let enabled = validatorSetting(node.arguments[2]);
        let outer = node;
        while (outer.parent) {
          const parent = outer.parent;
          if (
            ['ChainExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(parent.type)
          ) {
            outer = parent;
          } else if (
            parent.type === 'MemberExpression' &&
            parent.object === outer &&
            parent.parent?.type === 'CallExpression' &&
            parent.parent.callee === parent
          ) {
            outer = parent.parent;
            if (propertyName(parent) === 'setOptions') {
              // A later setOptions can override an earlier explicit validator setting.
              enabled = validatorSetting(outer.arguments[0], enabled);
            }
          } else {
            break;
          }
        }
        if (enabled === true) return;

        let statement = outer;
        while (statement.parent) {
          const parent = statement.parent;
          if (
            (parent.type === 'AwaitExpression' && parent.argument === statement) ||
            (parent.type === 'VariableDeclarator' && parent.init === statement) ||
            (parent.type === 'VariableDeclaration' && parent.declarations.length === 1) ||
            (parent.type === 'AssignmentExpression' && parent.right === statement) ||
            (parent.type === 'ReturnStatement' && parent.argument === statement) ||
            (parent.type === 'ArrowFunctionExpression' && parent.body === statement) ||
            (parent.type === 'ExportNamedDeclaration' && parent.declaration === statement) ||
            (parent.type === 'ExpressionStatement' && parent.expression === statement)
          ) {
            statement = parent;
          } else {
            break;
          }
        }
        const comments = [
          ...source.getCommentsInside(outer),
          ...source
            .getCommentsBefore(statement)
            .filter(
              comment =>
                comment.loc.end.line >= statement.loc.start.line - 1 &&
                source.text.slice(comment.range[1], statement.range[0]).trim() === '' &&
                source.lines[comment.loc.start.line - 1].slice(0, comment.loc.start.column).trim() === ''
            ),
          ...source
            .getCommentsAfter(statement)
            .filter(
              comment =>
                comment.loc.start.line === statement.loc.end.line &&
                source.text.slice(statement.range[1], comment.range[0]).trim() === ''
            ),
        ];
        if (comments.some(comment => OPT_OUT.test(comment.value))) return;
        context.report({ node, messageId: 'validators', data: { method } });
      },
    };
  },
};
