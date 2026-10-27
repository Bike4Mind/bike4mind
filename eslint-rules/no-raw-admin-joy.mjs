import legacy from './admin-joy-legacy.mjs';

const restricted = new Set(['Card', 'Modal', 'Table']);
const adminPath = '/apps/client/app/components/admin/';

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    schema: [],
    docs: { description: 'Keep admin UI on the shared toolkit' },
    messages: {
      raw: 'Raw Joy {{component}} bypasses the admin toolkit. Use SectionCard, ActionDialog or DataTable from admin/shared. An exception needs an immediately preceding "admin-toolkit-allow YYYY-MM-DD -- reason" comment. See admin/DESIGN_GUIDE.md.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const relative = filename.split(adminPath)[1];
    if (!relative || relative.startsWith('shared/')) return {};
    const remaining = [...(legacy[relative] ?? [])];

    function check(node) {
      if (!node.source || node.importKind === 'type' || node.exportKind === 'type') return;
      const source = node.source.value;
      if (typeof source !== 'string' || !/^@mui\/joy(?:\/|$)/.test(source)) return;
      const subpath = source.slice('@mui/joy/'.length).split('/')[0];
      const components = restricted.has(subpath)
        ? [subpath]
        : source === '@mui/joy'
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
      if (node.type === 'ExportAllDeclaration' && source === '@mui/joy') components.push('*');
      if (!components.length) return;
      const comment = context.sourceCode.getCommentsBefore(node).at(-1);
      const allowed =
        comment &&
        comment.loc.end.line === node.loc.start.line - 1 &&
        /^admin-toolkit-allow \d{4}-\d{2}-\d{2} -- \S.*\S$/.test(comment.value.trim());
      for (const component of components) {
        const index = remaining.indexOf(component);
        if (index !== -1) remaining.splice(index, 1);
        else if (!allowed) context.report({ node, messageId: 'raw', data: { component } });
      }
    }

    return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
  },
};
