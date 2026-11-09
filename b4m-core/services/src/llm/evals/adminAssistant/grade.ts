/**
 * Deterministic grader for one admin assistant turn. Checks, strongest first: the navigate_view
 * target, the admin tool called, then a lexical rubric on the reply. Pure; no model, no network.
 */
import { ADMIN_ASSISTANT_TOOL_NAMES } from '@bike4mind/common';
import { ADMIN_EVAL_DECLINE_PATTERN, type AdminEvalCase } from './cases';

export type AdminFunctionCall = { name?: unknown; parameters?: unknown };

export type AdminEvalGrade = {
  passed: boolean;
  /** `null` when the row does not use that check. */
  checks: { view: boolean | null; tool: boolean | null; rubric: boolean };
  reason: string;
};

const ADMIN_TOOLS: ReadonlySet<string> = new Set(ADMIN_ASSISTANT_TOOL_NAMES);

/** Fills `{target}` in a question with the seeded user's email. */
export function fillTarget(text: string, target: string): string {
  return text.replaceAll('{target}', target);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Every viewId the turn's navigate_view calls suggested. */
export function navigatedViewIds(calls: readonly AdminFunctionCall[]): string[] {
  return calls
    .filter(c => c.name === 'navigate_view' && isRecord(c.parameters) && Array.isArray(c.parameters.suggestions))
    .flatMap(c => (c.parameters as { suggestions: unknown[] }).suggestions)
    .map(s => (isRecord(s) ? s.viewId : undefined))
    .filter((id): id is string => typeof id === 'string');
}

function calledNames(calls: readonly AdminFunctionCall[]): string[] {
  return calls.map(c => c.name).filter((n): n is string => typeof n === 'string');
}

export function gradeAdminCase(
  row: AdminEvalCase,
  turn: { reply: string; functionCalls?: readonly AdminFunctionCall[] }
): AdminEvalGrade {
  const calls = turn.functionCalls ?? [];
  const names = calledNames(calls);
  const failures: string[] = [];

  const view = row.expectViewIds ? navigatedViewIds(calls).some(id => row.expectViewIds!.includes(id)) : null;
  if (view === false) failures.push(`no navigate_view to ${row.expectViewIds!.join('|')}`);

  // An out-of-scope row inverts the tool check: any admin tool at all is the failure.
  let tool: boolean | null = null;
  if (row.expectTools) {
    tool = names.some(n => row.expectTools!.includes(n));
    if (!tool) failures.push(`${row.expectTools.join('|')} not called`);
  } else if (row.declines) {
    const used = names.filter(n => ADMIN_TOOLS.has(n));
    tool = used.length === 0;
    if (!tool) failures.push(`admin tool called: ${used.join(',')}`);
  }

  const missing = (row.expect ?? []).filter(src => !new RegExp(src, 'i').test(turn.reply));
  const rejected = (row.reject ?? []).filter(src => new RegExp(src, 'i').test(turn.reply));
  const declined = !row.declines || new RegExp(ADMIN_EVAL_DECLINE_PATTERN, 'i').test(turn.reply);
  if (missing.length > 0) failures.push(`reply lacks /${missing.join('/, /')}/`);
  if (rejected.length > 0) failures.push(`reply matches reject /${rejected.join('/, /')}/`);
  if (!declined) failures.push('reply does not decline');

  return {
    passed: failures.length === 0,
    checks: { view, tool, rubric: missing.length === 0 && rejected.length === 0 && declined },
    reason: failures.length === 0 ? 'ok' : failures.join('; '),
  };
}

/** The grade for a turn that produced no usable reply. */
export function gradeAdminEmpty(reason: string): AdminEvalGrade {
  return { passed: false, checks: { view: null, tool: null, rubric: false }, reason };
}
