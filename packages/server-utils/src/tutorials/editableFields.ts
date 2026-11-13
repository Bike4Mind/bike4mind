// Finds, per module and step, the copy fields a steps file writes as a plain string literal. Only those may be
// overridden live: a template or a reference is derived in code, and an export could not write an edit back
// over it. Each owner commits the result as its own `editableFields.json`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const TEXT_FIELDS = ['title', 'body', 'doneBody', 'prompt'] as const;

export interface EditableFieldsModule {
  id: string;
  /** The ids of the steps the module ships, in order. */
  stepIds: readonly string[];
  /** The source file that writes the steps, relative to the root. */
  stepsFile: string;
}

const literal = (node: ts.Expression) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** Step id to its literal text fields, for every object literal in `source` with a literal `id`. */
export function literalFieldsOf(source: string): Record<string, string[]> {
  const file = ts.createSourceFile('steps.ts', source, ts.ScriptTarget.Latest, true);
  const found: Record<string, string[]> = {};
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(
        node.properties
          .filter(ts.isPropertyAssignment)
          .map(p => [ts.isIdentifier(p.name) ? p.name.text : '', p.initializer] as const)
      );
      const id = props.get('id');
      // A spread can override any field after the fact, so its object stays read-only.
      if (id && literal(id) && !node.properties.some(ts.isSpreadAssignment)) {
        found[(id as ts.StringLiteral).text] = TEXT_FIELDS.filter(f => {
          const init = props.get(f);
          return init !== undefined && literal(init);
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function editableFieldsFor(root: string, modules: readonly EditableFieldsModule[]) {
  return Object.fromEntries(
    modules.map(module => {
      const literals = literalFieldsOf(readFileSync(join(root, module.stepsFile), 'utf8'));
      const steps = module.stepIds
        .map(id => [id, literals[id] ?? []] as const)
        .filter(([, fields]) => fields.length > 0);
      return [module.id, Object.fromEntries(steps)];
    })
  ) as Record<string, Record<string, string[]>>;
}

/** The exact text an owner commits as `editableFields.json`. */
export const renderEditableFields = (root: string, modules: readonly EditableFieldsModule[]) =>
  `${JSON.stringify(editableFieldsFor(root, modules), null, 2)}\n`;
