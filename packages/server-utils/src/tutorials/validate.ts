// The rules a tutorial module must hold, as data a server can return. A runtime edit is refused when they
// fail, so this file stays free of React, Zustand and fs. Rules about one owner's steps are passed in.
import { TUTORIAL_CARD_SIDES, type TutorialStep, type ValidationIssue } from '@bike4mind/common';
import type { TutorialModule, TutorialModuleIntro } from './types';

/** A property one module's copy must keep, whatever an edit changes. */
export interface ModuleRule {
  rule: string;
  check: (module: TutorialModule) => Omit<ValidationIssue, 'rule'>[];
}

/** What an anchor, scope or avoid selector may be: whatever the owner's shipped modules already use. */
export interface KnownSelectors {
  anchors: ReadonlySet<string>;
  anchorScopes: ReadonlySet<string>;
  avoids: ReadonlySet<string>;
}

export interface ValidatorOptions {
  known: KnownSelectors;
  /** Rules per module id, for what only that module can state. */
  rules?: Readonly<Record<string, readonly ModuleRule[]>>;
}

/** The step fields a learner reads; each transcript reply is checked the same way. */
export const EDITABLE_TEXT_FIELDS = ['title', 'body', 'doneBody', 'prompt'] as const;

/** Anchors, scopes and avoid selectors reach the DOM as typed, so an edit picks from what shipped modules use. */
export function knownSelectorsOf(modules: readonly Pick<TutorialModule, 'steps'>[]): KnownSelectors {
  const used = (pick: (step: TutorialStep) => string | undefined) =>
    new Set(modules.flatMap(m => m.steps.map(pick)).filter((v): v is string => v !== undefined));
  return {
    anchors: used(s => s.anchor),
    anchorScopes: used(s => s.anchorScope),
    avoids: used(s => s.avoid),
  };
}

export function validateTutorialModule(module: TutorialModule, options: ValidatorOptions): ValidationIssue[] {
  return [
    ...structure(module),
    ...textFields(module),
    ...anchors(module, options.known),
    ...(module.sheet ? validateSheet(module.sheet) : []),
    ...(options.rules?.[module.id] ?? []).flatMap(({ rule, check }) =>
      check(module).map(found => ({ ...found, rule }))
    ),
  ];
}

function collector() {
  const issues: ValidationIssue[] = [];
  const add = (rule: string, message: string, stepId?: string) =>
    issues.push(stepId === undefined ? { rule, message } : { stepId, rule, message });
  return { issues, add };
}

const stepOfTurn = (steps: readonly TutorialStep[], turn: number) => steps.find(s => s.turn === turn)?.id;

function structure({ steps, transcript }: TutorialModule) {
  const { issues, add } = collector();

  const ids = new Set<string>();
  for (const { id } of steps) {
    if (ids.has(id)) add('unique-ids', `step id "${id}" repeats`, id);
    ids.add(id);
  }

  // Every recorded turn is sent by one step, in order, word for word: the server matches a sent prompt to its turn.
  const sendSteps = steps.filter(s => s.turn !== undefined);
  const turns = sendSteps.map(s => s.turn);
  if (turns.length !== transcript.length || turns.some((turn, i) => turn !== i)) {
    add(
      'turn-order',
      `steps send turns [${turns.join(', ')}]; each of the ${transcript.length} turns is sent once, in order`
    );
  }
  for (const step of sendSteps) {
    const turn = transcript[step.turn!];
    if (turn && step.prompt !== turn.prompt)
      add('prompt-matches-transcript', `prompt differs from turn ${step.turn}`, step.id);
  }
  transcript.forEach((turn, i) => {
    if (!turn.reply.trim()) add('reply-present', `turn ${i} has no reply`, stepOfTurn(steps, i));
  });
  return issues;
}

const PRINTABLE = /^[\t\n\x20-\x7e]*$/;
// Inline links, reference definitions (also inside a quote or list item) and autolinks: everywhere markdown
// takes a destination. An angle destination may hold whitespace, so it is captured whole.
const LINK_TARGETS = [
  /\]\(\s*(<[^>]*>|[^)\s]*)/g,
  /^(?:[ \t]*(?:>|[-*+]|\d+[.)])[ \t]*)*[ \t]{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S*)/gm,
  /<([a-z][a-z0-9+.-]*:[^>\s]*)>/gi,
];
// Allowed, not denied: a relative target holds no colon, so no scheme can hide in it, and an entity is refused
// because markdown decodes it before the browser reads the scheme.
const SAFE_TARGET = /^(?:https?:\/\/\S+|mailto:\S+|#\S*|[^\s:]*)$/i;

export function unsafeLinkTargets(text: string): string[] {
  return LINK_TARGETS.flatMap(pattern =>
    [...text.matchAll(pattern)]
      .map(m => (m[1] ?? '').replace(/^<([^>]*)>$/, '$1').trim())
      .filter(t => !SAFE_TARGET.test(t) || /&[#a-z0-9]+;/i.test(t))
  );
}

function checkText(
  add: (rule: string, message: string, stepId?: string) => void,
  field: string,
  text: string,
  stepId?: string
) {
  if (!PRINTABLE.test(text)) add('ascii', `${field} holds a character outside printable ASCII`, stepId);
  for (const target of unsafeLinkTargets(text)) add('link-scheme', `${field} links to "${target}"`, stepId);
}

function textFields({ steps, transcript }: TutorialModule) {
  const { issues, add } = collector();
  for (const step of steps) {
    for (const field of EDITABLE_TEXT_FIELDS) {
      const text = step[field];
      if (typeof text === 'string') checkText(add, field, text, step.id);
    }
  }
  transcript.forEach((turn, i) => checkText(add, `turn ${i} reply`, turn.reply, stepOfTurn(steps, i)));
  return issues;
}

function anchors({ steps }: TutorialModule, known: KnownSelectors) {
  const { issues, add } = collector();
  for (const { id, anchor, anchorScope, avoid, placement } of steps) {
    if (anchor !== undefined && !known.anchors.has(anchor))
      add('anchor-known', `anchor "${anchor}" is not one the modules use`, id);
    if (anchorScope !== undefined && !known.anchorScopes.has(anchorScope))
      add('anchor-known', `anchorScope "${anchorScope}" is not one the modules use`, id);
    if (avoid !== undefined && !known.avoids.has(avoid))
      add('anchor-known', `avoid "${avoid}" is not one the modules use`, id);
    if (placement !== undefined && !TUTORIAL_CARD_SIDES.includes(placement))
      add('anchor-known', `placement "${placement}" is not a side`, id);
  }
  return issues;
}

export const SHEET_MAX_BYTES = 64 * 1024;
const SHEET_NAME = /^[\w .-]{1,96}\.csv$/;
const PLAIN_NUMBER = /^-?\d[\d,]*(?:\.\d+)?$/;

/** Splits RFC 4180 CSV, quoted fields and doubled quotes included. */
export function csvCells(csv: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    // A lone CR ends a row in some spreadsheets, so it splits cells here too.
    else if (ch === ',' || ch === '\n' || (ch === '\r' && csv[i + 1] !== '\n')) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r') continue;
    else cell += ch;
  }
  if (cell !== '') cells.push(cell);
  return cells;
}

/** The sheet lands in every learner's files, so a spreadsheet must not read any cell as a formula. */
export function validateSheet({ name, csv }: NonNullable<TutorialModuleIntro['sheet']>): ValidationIssue[] {
  const { issues, add } = collector();
  if (!SHEET_NAME.test(name)) add('sheet-name', `"${name}" is not a plain .csv file name`);
  const bytes = new TextEncoder().encode(csv).length;
  if (bytes > SHEET_MAX_BYTES) add('sheet-size', `the sheet is ${bytes} bytes, over ${SHEET_MAX_BYTES}`);
  for (const cell of csvCells(csv)) {
    if (/^[\t\r]/.test(cell) || (/^\s*[=+\-@]/.test(cell) && !PLAIN_NUMBER.test(cell.trim()))) {
      add('sheet-formula', `cell "${cell.slice(0, 40)}" starts like a formula`);
    }
  }
  return issues;
}
