import legacy from './admin-joy-legacy.mjs';
import imports from './admin-joy-legacy-imports.mjs';
import { createHash } from 'node:crypto';

const restricted = new Set(['Card', 'Modal', 'Table']);
const adminPath = '/apps/client/app/components/admin/';

function classifyModule(source) {
  const subpath = source
    .replace(/^@mui\/joy\/?/, '')
    .replace(/^(?:node|modern)(?:\/|$)/, '')
    .replace(/\.js$/, '');
  if (subpath === '' || subpath === 'index') return '*';
  const [component, entry, ...remaining] = subpath.split('/');
  if (!restricted.has(component) || remaining.length) return undefined;
  return entry === undefined || entry === 'index' || entry === component ? component : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    schema: [],
    docs: { description: 'Keep admin UI on the shared toolkit' },
    messages: {
      raw: 'Raw Joy {{component}} bypasses the admin toolkit. Use SectionCard, ActionDialog or DataTable from admin/shared. An exception needs an immediately preceding "admin-toolkit-allow YYYY-MM-DD -- reason" comment. See admin/DESIGN_GUIDE.md.',
      stale:
        'Remove or explicitly re-justify the stale admin toolkit exception for import at line {{line}} in eslint-rules/admin-joy-legacy-imports.mjs.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const relative = filename.split(adminPath)[1];
    if (!relative || relative.startsWith('shared/')) return {};
    const remaining = [...(imports[relative] ?? [])];

    function check(node) {
      if (!node.source || node.importKind === 'type' || node.exportKind === 'type') return;
      const source = node.source.value;
      if (typeof source !== 'string' || !/^@mui\/joy(?:\/|$)/.test(source)) return;
      const moduleComponent = classifyModule(source);
      const components = restricted.has(moduleComponent)
        ? (node.specifiers ?? []).flatMap(specifier => {
            if (specifier.importKind === 'type' || specifier.exportKind === 'type') return [];
            if (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') {
              return [moduleComponent];
            }
            const imported = specifier.imported ?? specifier.local;
            const name = imported?.name ?? imported?.value;
            return !imported || name === 'default' || name === moduleComponent ? [moduleComponent] : [];
          })
        : moduleComponent === '*'
          ? (node.specifiers ?? []).flatMap(specifier => {
              if (specifier.importKind === 'type' || specifier.exportKind === 'type') return [];
              if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
                return ['*'];
              }
              const imported = specifier.imported ?? specifier.local;
              const name = imported?.name ?? imported?.value;
              return restricted.has(name) ? [name] : [];
            })
          : [];
      if (node.type === 'ExportAllDeclaration') {
        if (moduleComponent) components.push(moduleComponent);
      }
      if (!components.length) return;
      const fingerprint = createHash('sha256').update(context.sourceCode.getText(node)).digest('hex').slice(0, 16);
      const index = remaining.findIndex(([line, hash]) => line === node.loc.start.line && hash === fingerprint);
      if (index !== -1 && legacy[relative]) {
        remaining.splice(index, 1);
        return;
      }
      const comment = context.sourceCode.getCommentsBefore(node).at(-1);
      const allowed =
        comment &&
        comment.loc.end.line === node.loc.start.line - 1 &&
        /^admin-toolkit-allow \d{4}-\d{2}-\d{2} -- \S.*\S$/.test(comment.value.trim());
      for (const component of components) {
        if (!allowed) context.report({ node, messageId: 'raw', data: { component } });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      'Program:exit'(node) {
        for (const [line] of remaining) context.report({ node, messageId: 'stale', data: { line } });
      },
    };
  },
};
