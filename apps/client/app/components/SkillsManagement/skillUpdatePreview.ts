import type { ISkillFile } from '@bike4mind/common';
import type { SkillMdFields } from '@bike4mind/common/utils/skillMd';

export interface SkillFormValues {
  name: string;
  description: string;
  body: string;
  argumentHint: string;
  disableModelInvocation: boolean;
  claudeCodeAllowedTools: string[];
  claudeCodeModel: string;
  files: ISkillFile[];
}

export interface SkillUpdateChange {
  key: string;
  label: string;
  /** Omitted for long text, where only the fact that it changed is shown. */
  before?: string;
  after?: string;
}

export interface SkillUpdatePreviewData {
  changes: SkillUpdateChange[];
  /** The imported name when it differs from the skill's current name. */
  nameMismatch?: string;
  /** A script was added or changed: it runs on the user's machine, so it gets a person's review before a market listing. */
  scriptsChanged: boolean;
}

const show = (value: string) => (value === '' ? '(none)' : value);
const showList = (list: string[]) => (list.length ? list.join(', ') : '(none)');

/**
 * What applying an imported SKILL.md (and, for a folder or zip, its supporting files) would change.
 * Mirrors how SkillForm applies an import: argument hint, Claude Code tools and model, and the invocation flag
 * take the file's value or reset, description and body change only when the file sets them.
 */
export function diffSkillUpdate(
  current: SkillFormValues,
  fields: SkillMdFields,
  bundle?: { files: ISkillFile[] }
): SkillUpdatePreviewData {
  const changes: SkillUpdateChange[] = [];

  const description = fields.description ?? current.description;
  if (description !== current.description) {
    changes.push({ key: 'description', label: 'Description', before: current.description, after: description });
  }

  const argumentHint = fields.argumentHint?.trim() ?? '';
  if (argumentHint !== current.argumentHint.trim()) {
    changes.push({
      key: 'argument-hint',
      label: 'Argument hint',
      before: show(current.argumentHint),
      after: show(argumentHint),
    });
  }

  const body = fields.body ?? current.body;
  if (body !== current.body) changes.push({ key: 'body', label: 'Body' });

  const tools = fields.claudeCodeAllowedTools ?? [];
  if (tools.join('\n') !== current.claudeCodeAllowedTools.join('\n')) {
    changes.push({
      key: 'claude-code-tools',
      label: 'Claude Code tools',
      before: showList(current.claudeCodeAllowedTools),
      after: showList(tools),
    });
  }

  const model = fields.claudeCodeModel ?? '';
  if (model !== current.claudeCodeModel) {
    changes.push({
      key: 'claude-code-model',
      label: 'Claude Code model',
      before: show(current.claudeCodeModel),
      after: show(model),
    });
  }

  const hidden = fields.disableModelInvocation ?? false;
  if (hidden !== current.disableModelInvocation) {
    changes.push({
      key: 'model-invocation',
      label: 'Hide from LLM auto-invocation',
      before: current.disableModelInvocation ? 'on' : 'off',
      after: hidden ? 'on' : 'off',
    });
  }

  let scriptsChanged = false;
  if (bundle) {
    const before = new Map(current.files.map(f => [f.path, f.content]));
    const after = new Map(bundle.files.map(f => [f.path, f.content]));
    const added = [...after.keys()].filter(path => !before.has(path));
    const changed = [...after.keys()].filter(path => before.has(path) && before.get(path) !== after.get(path));
    const removed = [...before.keys()].filter(path => !after.has(path));
    if (added.length || changed.length || removed.length) {
      const parts = [
        added.length ? `added ${added.join(', ')}` : '',
        changed.length ? `changed ${changed.join(', ')}` : '',
        removed.length ? `removed ${removed.join(', ')}` : '',
      ].filter(Boolean);
      changes.push({ key: 'files', label: 'Supporting files', after: parts.join('; ') });
    }
    scriptsChanged = [...added, ...changed].some(path => path.startsWith('scripts/'));
  }

  const nameMismatch = fields.name !== undefined && fields.name !== current.name ? fields.name : undefined;
  return { changes, nameMismatch, scriptsChanged };
}
