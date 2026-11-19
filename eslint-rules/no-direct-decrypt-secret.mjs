/**
 * Flags any use of the single-key `decryptSecret` primitive outside the modules that own key
 * selection. Stored values are read through `decryptAtRest` (b4m-core/utils/src/security/secretsAtRest.ts)
 * or `decryptToken` / `decryptStoredSecret` (packages/server-utils/src/security/tokenEncryption.ts),
 * which try the current key and then the previous one; a caller that picks one key itself stops
 * reading every value still stored under the other. The files allowed to call the primitive are
 * listed where the rule is enabled, in eslint.config.mjs.
 *
 * Named imports and re-exports are reported even when renamed. A member access covers a namespace import
 * and a required module.
 */
const PRIMITIVE = 'decryptSecret';

/** The name an import or export specifier refers to, whether written as an identifier or a string. */
function specifierName(node) {
  if (!node) return undefined;
  return node.type === 'Identifier' ? node.name : node.value;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow single-key decryptSecret outside the key-selecting helper modules' },
    schema: [],
    messages: {
      direct:
        'Do not call decryptSecret directly: it reads with one key only. Use decryptAtRest (@bike4mind/utils/security), ' +
        'or decryptToken / decryptStoredSecret (@bike4mind/server-utils/security/tokenEncryption), which fall back to the previous key.',
    },
  },
  create(context) {
    return {
      ImportSpecifier: node => {
        if (specifierName(node.imported) === PRIMITIVE) context.report({ node, messageId: 'direct' });
      },
      ExportSpecifier: node => {
        if (specifierName(node.local) === PRIMITIVE) context.report({ node, messageId: 'direct' });
      },
      MemberExpression: node => {
        const name = node.computed
          ? node.property.type === 'Literal' && node.property.value
          : node.property.type === 'Identifier' && node.property.name;
        if (name === PRIMITIVE) context.report({ node: node.property, messageId: 'direct' });
      },
      // const { decryptSecret } = require(...) / await import(...)
      VariableDeclarator: node => {
        if (node.id.type !== 'ObjectPattern') return;
        for (const property of node.id.properties) {
          if (property.type === 'Property' && !property.computed && specifierName(property.key) === PRIMITIVE) {
            context.report({ node: property, messageId: 'direct' });
          }
        }
      },
    };
  },
};
