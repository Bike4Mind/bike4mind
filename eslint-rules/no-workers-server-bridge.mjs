/**
 * Flags any `@server/*` module specifier in apps/workers: the interim alias into apps/client/server
 * that is being removed (tsconfig, vitest and Dockerfile mappings go with it), so every new use is
 * one more thing blocking that removal. Covers static, type-only, dynamic and require imports, and
 * the module argument of vitest's vi.mock family, since a mocked path needs the alias as much as an
 * import does. Existing uses are baselined per file in eslint-suppressions.json.
 */
const BRIDGE = /^@server(?:\/|$)/;
const VI_MODULE_METHODS = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);

/** The string value of a literal or an expression-free template literal, else undefined. */
function staticString(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function isModuleCall(callee) {
  if (callee.type === 'Identifier') return callee.name === 'require';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'vi' &&
    callee.property.type === 'Identifier' &&
    VI_MODULE_METHODS.has(callee.property.name)
  );
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow new @server/* module specifiers in apps/workers' },
    schema: [],
    messages: {
      bridge:
        "apps/workers must not add new uses of '{{specifier}}' (the interim @server/* bridge into apps/client is being removed). " +
        'Import the module from @bike4mind/server-utils, or move it there first. Existing uses are baselined in ' +
        'eslint-suppressions.json; after removing one, run `pnpm lint --prune-suppressions`.',
    },
  },
  create(context) {
    function check(node, specifier) {
      if (specifier !== undefined && BRIDGE.test(specifier)) {
        context.report({ node, messageId: 'bridge', data: { specifier } });
      }
    }

    return {
      ImportDeclaration: node => check(node.source, node.source.value),
      ExportNamedDeclaration: node => node.source && check(node.source, node.source.value),
      ExportAllDeclaration: node => check(node.source, node.source.value),
      ImportExpression: node => check(node.source, staticString(node.source)),
      // typescript-eslint 8.x exposes the string as `source`; earlier 8.x only had the deprecated
      // `argument` (a TSLiteralType wrapping it), which warns when read, so it is the fallback.
      TSImportType: node => {
        const source = node.source ?? node.argument?.literal;
        check(source, staticString(source));
      },
      TSExternalModuleReference: node => check(node.expression, staticString(node.expression)),
      CallExpression: node => {
        if (isModuleCall(node.callee)) check(node.arguments[0], staticString(node.arguments[0]));
      },
    };
  },
};
