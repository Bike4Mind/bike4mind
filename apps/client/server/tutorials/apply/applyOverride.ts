// Writes an exported bundle of live tutorial edits back into the repo module they were made on. Pure: the CLI
// reads the files, and writes what this returns.
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type { TutorialStep } from '@bike4mind/common';
import {
  OverrideBundleSchema,
  STRUCTURAL_KINDS,
  unitKey,
  type OverrideBundle,
  type OverrideUnit,
} from '@bike4mind/common';
import { currentRepoValue, lockedReason, unitState } from '../overrides';
import type { TutorialTurn } from '../types';
import { escapeNonAscii, identifiersOf, type TutorialRepoLayout } from './layout';
import { checkBundleOwner } from './owner';

export { unitKey };

// The server model's pattern; repeated here so the library does not load the database layer.
const MODULE_ID = /^[a-z0-9-]{1,40}$/;

export function parseBundle(raw: unknown): OverrideBundle {
  const id = (raw as { moduleId?: unknown } | null)?.moduleId;
  if (typeof id !== 'string' || !MODULE_ID.test(id)) {
    throw new Error(`moduleId ${JSON.stringify(id)} is not a module id (${MODULE_ID})`);
  }
  const parsed = OverrideBundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`not a tutorial override bundle: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** The one directory a bundle may write into, besides the version line in the layout's version file. */
export function moduleDirOf(layout: TutorialRepoLayout, moduleId: string): string {
  if (!MODULE_ID.test(moduleId)) throw new Error(`moduleId ${JSON.stringify(moduleId)} is not a module id`);
  const base = resolve(layout.root, layout.modulesDir);
  const dir = resolve(base, moduleId);
  if (dirname(dir) !== base) throw new Error(`moduleId ${moduleId} resolves outside ${base}`);
  return dir;
}

export function assertWritable(layout: TutorialRepoLayout, moduleId: string, path: string): void {
  const target = resolve(path);
  if (target === resolve(layout.root, layout.version.path)) return;
  if (dirname(target) !== moduleDirOf(layout, moduleId)) {
    throw new Error(`refusing to write ${target}: outside ${layout.modulesDir}/${moduleId}/`);
  }
}

export interface RepoModule {
  version: number;
  /** The module's index in the version array, for a layout that locates its entry by position. */
  index: number;
  /** As served before the finale, which is what a unit was written against. */
  steps: readonly TutorialStep[];
  transcript: readonly TutorialTurn[];
  stepsSource: string;
  versionSource: string;
}

export interface ApplyResult {
  applied: string[];
  /** Retired: the repo already says what the unit says. */
  already: string[];
  /** The repo moved under the unit since it was saved; a person reconciles it. */
  refused: { key: string; repoValue: unknown; now: unknown }[];
  manual: { key: string; edit: string }[];
  /** Null when the file is unchanged. */
  stepsSource: string | null;
  transcript: TutorialTurn[] | null;
  versionSource: string | null;
  bump: { from: number; to: number } | null;
  warnings: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

type Literal = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
const isLiteral = (node: ts.Node | undefined): node is Literal =>
  !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

function quote(value: string, quoteChar: string): string {
  const escaped = value.replace(/\\/g, '\\\\');
  if (quoteChar === '`') return `\`${escapeNonAscii(escaped.replace(/`/g, '\\`').replace(/\$\{/g, '\\${'))}\``;
  const q = quoteChar === '"' ? '"' : "'";
  return `${q}${escapeNonAscii(escaped.split(q).join(`\\${q}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r'))}${q}`;
}

const propOf = (obj: ts.ObjectLiteralExpression, name: string) =>
  obj.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
  );

/** The literal `id` of a step written as an object, or as a helper call whose argument is one. */
function stepIdOf(node: ts.Node): string | undefined {
  const obj = ts.isCallExpression(node) ? node.arguments.find(ts.isObjectLiteralExpression) : node;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  const id = propOf(obj, 'id')?.initializer;
  return isLiteral(id) ? id.text : undefined;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

class StepsSource {
  readonly file: ts.SourceFile;
  private readonly objects = new Map<string, ts.ObjectLiteralExpression[]>();

  constructor(readonly text: string) {
    this.file = ts.createSourceFile('steps.ts', text, ts.ScriptTarget.Latest, true);
    walk(this.file, node => {
      // A spread can replace any field after the literal, so such an object is never written to.
      if (!ts.isObjectLiteralExpression(node) || node.properties.some(ts.isSpreadAssignment)) return;
      const id = propOf(node, 'id')?.initializer;
      if (isLiteral(id)) this.objects.set(id.text, [...(this.objects.get(id.text) ?? []), node]);
    });
  }

  /** Replaces one step field written as a literal holding exactly `from`, or says why it cannot. */
  literalEdit(stepId: string, field: string, from: string, to: string): Edit | string {
    const objects = this.objects.get(stepId) ?? [];
    if (objects.length !== 1) return `step ${stepId} is not one object literal in steps.ts`;
    const init = propOf(objects[0], field)?.initializer;
    if (!isLiteral(init)) return `${stepId}.${field} is built in code, not a literal`;
    if (init.text !== from) return `${stepId}.${field} in steps.ts is not the served text, so code changes it`;
    const start = init.getStart(this.file);
    return { start, end: init.getEnd(), text: quote(to, this.text[start]) };
  }

  /** Reorders the one array that lists exactly the served steps, each a literal object or a helper call on one. */
  orderEdits(repoIds: readonly string[], ids: readonly string[]): Edit[] | string {
    const arrays: ts.ArrayLiteralExpression[] = [];
    walk(this.file, node => {
      if (!ts.isArrayLiteralExpression(node)) return;
      const found = node.elements.map(stepIdOf);
      if (found.length === repoIds.length && found.every((id, i) => id === repoIds[i])) arrays.push(node);
    });
    if (arrays.length !== 1) return 'the steps are not one array of literal steps in steps.ts';
    const elements = arrays[0].elements;
    const textOf = new Map(elements.map(el => [stepIdOf(el)!, this.text.slice(el.getFullStart(), el.getEnd())]));
    return elements.map((el, i) => ({ start: el.getFullStart(), end: el.getEnd(), text: textOf.get(ids[i])! }));
  }
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  sorted.forEach((edit, i) => {
    if (i > 0 && edit.end > sorted[i - 1].start) throw new Error('two edits touch the same text in steps.ts');
  });
  return sorted.reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), text);
}

function versionEdit(
  layout: TutorialRepoLayout,
  source: string,
  moduleId: string,
  index: number,
  version: number
): Edit | string {
  const { arrayName, locate, path } = layout.version;
  const file = ts.createSourceFile('version.ts', source, ts.ScriptTarget.Latest, true);
  let array: ts.ArrayLiteralExpression | undefined;
  walk(file, node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === arrayName &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      array = node.initializer;
    }
  });
  const introId = `${identifiersOf(moduleId).camel}Module`;
  if (locate === 'index' && array?.elements.some(ts.isSpreadElement)) return `set version to ${version + 1} in ${path}`;
  const entry =
    locate === 'index'
      ? array?.elements[index]
      : array?.elements.find(
          el =>
            ts.isObjectLiteralExpression(el) &&
            ((init: ts.Expression | undefined) => !!init && ts.isIdentifier(init) && init.text === introId)(
              propOf(el, 'intro')?.initializer
            )
        );
  const init = entry && ts.isObjectLiteralExpression(entry) ? propOf(entry, 'version')?.initializer : undefined;
  if (!init || !ts.isNumericLiteral(init) || Number(init.text) !== version) {
    return `set version to ${version + 1} in ${path}`;
  }
  return { start: init.getStart(file), end: init.getEnd(), text: String(version + 1) };
}

/** Each served step that sends `turn`, so a prompt edit lands in the step and the transcript together. */
const stepsSending = (steps: readonly TutorialStep[], turn: number) =>
  steps.filter(step => step.turn === turn && step.prompt !== undefined);

/** The edits one live unit makes to steps.ts and the transcript, or what a person has to do instead. */
function unitEdits(
  unit: OverrideUnit,
  repo: RepoModule,
  steps: StepsSource,
  transcript: TutorialTurn[]
): { edits: Edit[]; turn?: [number, TutorialTurn] } | { orderTo: string[] } | string {
  switch (unit.kind) {
    case 'reply':
      return { edits: [], turn: [unit.turn, { ...transcript[unit.turn], reply: unit.value }] };
    case 'copy': {
      const edit = steps.literalEdit(unit.stepId, unit.field, unit.repoValue, unit.value);
      return typeof edit === 'string' ? edit : { edits: [edit] };
    }
    case 'prompt': {
      const edits: Edit[] = [];
      for (const step of stepsSending(repo.steps, unit.turn)) {
        const edit = steps.literalEdit(step.id, 'prompt', unit.repoValue.prompt, unit.value.prompt);
        if (typeof edit === 'string') return `${edit}; the step and transcript turn ${unit.turn} change together`;
        edits.push(edit);
      }
      return { edits, turn: [unit.turn, { ...transcript[unit.turn], ...unit.value }] };
    }
    case 'anchor': {
      const keys = ['anchor', 'anchorScope', 'placement', 'avoid'] as const;
      const edits: Edit[] = [];
      for (const key of keys) {
        const from = unit.repoValue[key];
        const to = unit.value[key];
        if (from === to) continue;
        if (from === undefined || to === undefined) {
          return `${to === undefined ? 'remove' : 'add'} ${key} on step ${unit.stepId} (a literal edit only replaces)`;
        }
        const edit = steps.literalEdit(unit.stepId, key, from, to);
        if (typeof edit === 'string') return edit;
        edits.push(edit);
      }
      return { edits };
    }
    case 'order':
      return { orderTo: unit.value };
  }
}

const describeManual = (unit: OverrideUnit, why: string): string => {
  const value = unit.kind === 'order' ? unit.value.join(', ') : JSON.stringify(unit.value);
  return `${why}. Write by hand: ${value}`;
};

export function applyBundle(bundle: OverrideBundle, repo: RepoModule, layout: TutorialRepoLayout): ApplyResult {
  const verdict = checkBundleOwner(bundle, layout);
  if (!verdict.ok) throw new Error(verdict.message);
  const result: ApplyResult = {
    applied: [],
    already: [],
    refused: [],
    manual: [],
    stepsSource: null,
    transcript: null,
    versionSource: null,
    bump: null,
    warnings: [],
  };
  if (bundle.version !== repo.version) {
    result.warnings.push(`exported at version ${bundle.version}; the repo is at ${repo.version}`);
  }
  const steps = new StepsSource(repo.stepsSource);
  const transcript = repo.transcript.map(t => ({ ...t }));
  const edits: Edit[] = [];
  let order: { unit: OverrideUnit; to: string[] } | undefined;
  let structural = false;
  let transcriptChanged = false;

  for (const unit of bundle.units) {
    const key = unitKey(unit);
    const state = unitState(unit, repo.steps, repo.transcript);
    if (state === 'retired') {
      result.already.push(key);
      continue;
    }
    if (state === 'stale') {
      result.refused.push({ key, repoValue: unit.repoValue, now: currentRepoValue(unit, repo.steps, repo.transcript) });
      continue;
    }
    const locked = lockedReason(bundle.moduleId, unit, repo.steps, layout.policy);
    if (locked) {
      result.refused.push({ key, repoValue: unit.repoValue, now: currentRepoValue(unit, repo.steps, repo.transcript) });
      result.warnings.push(`${key} is refused: ${locked}`);
      continue;
    }
    if (STRUCTURAL_KINDS.has(unit.kind)) structural = true;
    const planned = unitEdits(unit, repo, steps, transcript);
    if (typeof planned === 'string') {
      result.manual.push({ key, edit: describeManual(unit, planned) });
    } else if ('orderTo' in planned) {
      order = { unit, to: planned.orderTo };
    } else {
      edits.push(...planned.edits);
      if (planned.turn) {
        transcript[planned.turn[0]] = planned.turn[1];
        transcriptChanged = true;
      }
      result.applied.push(key);
    }
  }

  let stepsText = edits.length > 0 ? applyEdits(repo.stepsSource, edits) : repo.stepsSource;
  if (order) {
    // Reordered after the literal edits, on the edited text, so a moved step keeps its new words.
    const reordered = new StepsSource(stepsText).orderEdits(
      repo.steps.map(s => s.id),
      order.to
    );
    if (typeof reordered === 'string')
      result.manual.push({ key: 'order', edit: describeManual(order.unit, reordered) });
    else {
      stepsText = applyEdits(stepsText, reordered);
      result.applied.push('order');
    }
  }
  if (stepsText !== repo.stepsSource) result.stepsSource = stepsText;
  if (transcriptChanged) result.transcript = transcript;

  // A manual structural edit still changes the module once a person makes it, so it bumps here too.
  if (structural && bundle.version !== repo.version) {
    result.manual.push({
      key: 'version',
      edit: `the repo is already at version ${repo.version} and the bundle was exported at ${bundle.version}; decide by hand whether another bump is needed`,
    });
  } else if (structural) {
    const edit = versionEdit(layout, repo.versionSource, bundle.moduleId, repo.index, repo.version);
    if (typeof edit === 'string') result.manual.push({ key: 'version', edit });
    else result.versionSource = applyEdits(repo.versionSource, [edit]);
    result.bump = { from: repo.version, to: repo.version + 1 };
  }
  return result;
}

/** Spec files that quote a unit's old text word for word, which the export would break. */
export function specsQuoting(units: readonly OverrideUnit[], specs: readonly { path: string; text: string }[]) {
  const quoted = units.flatMap(unit => {
    if (unit.kind === 'copy' || unit.kind === 'reply') return [unit.repoValue];
    if (unit.kind === 'prompt') return [unit.repoValue.prompt, unit.repoValue.reply];
    return [];
  });
  return specs.filter(spec => quoted.some(text => text.length > 0 && spec.text.includes(text))).map(s => s.path);
}

export function prChecklist(result: ApplyResult, specs: readonly string[]): string[] {
  return [
    '- [ ] Copy rule: ASCII only, a plain-string body with no markdown, short enough for the card',
    '- [ ] testids: every anchor still names a testid the page renders (the guard checks the known set)',
    specs.length > 0
      ? `- [ ] e2e: update the specs quoting the old text: ${specs.join(', ')}`
      : '- [ ] e2e: no spec quotes the old text; say so in the PR',
    result.bump
      ? `- [ ] version ${result.bump.from} -> ${result.bump.to}: the export holds a prompt, order or anchor change`
      : '- [ ] version unchanged: copy and reply edits restart no learner',
    '- [ ] After the deploy, the module editor shows each exported edit as retired',
  ];
}
