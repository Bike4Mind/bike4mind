import { describe, it, expect } from 'vitest';
import { CORE_TOOL_DESCRIPTORS } from './coreToolDescriptors.js';
import { ToolCatalog } from './toolCatalog.js';
import { commandTextOf, sandboxedCommandArg, writePathOf } from './toolPolicy.js';
import type { ToolCategory } from './toolDescriptor.js';

/**
 * The policy every core tool had before descriptors, copied literally from the old name tables:
 * the category table (recent_changes and lattice_* fell through to prompt_default), read-only as
 * "not prompt_always", the checkpoint set and the shell-like command fields. A descriptor change
 * that alters any of these is a behaviour change and must update this table on purpose.
 */
const LEGACY_POLICY: ReadonlyArray<[string, ToolCategory, boolean, boolean, string | undefined]> = [
  ['math_evaluate', 'auto_approve', true, false, undefined],
  ['current_datetime', 'auto_approve', true, false, undefined],
  ['dice_roll', 'auto_approve', true, false, undefined],
  ['prompt_enhancement', 'auto_approve', true, false, undefined],
  ['find_definition', 'auto_approve', true, false, undefined],
  ['ask_user_question', 'auto_approve', true, false, undefined],
  ['agent_delegate', 'auto_approve', true, false, undefined],
  ['check_agent_status', 'auto_approve', true, false, undefined],
  ['list_background_agents', 'auto_approve', true, false, undefined],
  ['cancel_background_agent', 'auto_approve', true, false, undefined],
  ['resume_agent', 'auto_approve', true, false, undefined],
  ['create_dynamic_agent', 'auto_approve', true, false, undefined],
  ['coordinate_task', 'auto_approve', true, false, undefined],
  ['decompose_task', 'auto_approve', true, false, undefined],
  ['shared_context_read', 'auto_approve', true, false, undefined],
  ['shared_context_write', 'auto_approve', true, false, undefined],
  ['write_todos', 'auto_approve', true, false, undefined],
  ['read_prior_todos', 'auto_approve', true, false, undefined],
  ['log_decision', 'auto_approve', true, false, undefined],
  ['track_blocker', 'auto_approve', true, false, undefined],
  ['resolve_blocker', 'auto_approve', true, false, undefined],
  ['request_review_gate', 'auto_approve', true, false, undefined],
  ['work_item_create', 'auto_approve', true, false, undefined],
  ['work_item_update', 'auto_approve', true, false, undefined],
  ['work_item_close', 'auto_approve', true, false, undefined],
  ['work_item_ready', 'auto_approve', true, false, undefined],
  ['work_item_graph', 'auto_approve', true, false, undefined],
  ['tool_search', 'auto_approve', true, false, undefined],
  ['weather_info', 'prompt_default', true, false, undefined],
  ['web_search', 'prompt_default', true, false, undefined],
  ['check_shell_output', 'prompt_default', true, false, undefined],
  ['list_background_shells', 'prompt_default', true, false, undefined],
  ['web_fetch', 'prompt_default', true, false, undefined],
  ['decide', 'prompt_default', true, false, undefined],
  ['deep_research', 'prompt_default', true, false, undefined],
  ['file_read', 'prompt_default', true, false, undefined],
  ['grep_search', 'prompt_default', true, false, undefined],
  ['glob_files', 'prompt_default', true, false, undefined],
  ['get_file_tree', 'prompt_default', true, false, undefined],
  ['get_file_structure', 'prompt_default', true, false, undefined],
  ['git_status', 'prompt_default', true, false, undefined],
  ['git_diff', 'prompt_default', true, false, undefined],
  ['git_log', 'prompt_default', true, false, undefined],
  ['git_branch', 'prompt_default', true, false, undefined],
  ['recent_changes', 'prompt_default', true, false, undefined],
  ['lattice_create_model', 'prompt_default', true, false, undefined],
  ['lattice_add_entity', 'prompt_default', true, false, undefined],
  ['lattice_set_value', 'prompt_default', true, false, undefined],
  ['lattice_create_rule', 'prompt_default', true, false, undefined],
  ['lattice_query', 'prompt_default', true, false, undefined],
  ['lattice_explain', 'prompt_default', true, false, undefined],
  ['edit_file', 'prompt_always', false, false, undefined],
  ['edit_local_file', 'prompt_always', false, true, undefined],
  ['create_file', 'prompt_always', false, true, undefined],
  ['delete_file', 'prompt_always', false, true, undefined],
  ['shell_execute', 'prompt_always', false, false, undefined],
  ['bash_execute', 'prompt_always', false, false, 'command'],
  ['write_shell_stdin', 'prompt_always', false, false, 'chars'],
  ['kill_background_shell', 'prompt_always', false, false, undefined],
  ['git_commit', 'prompt_always', false, false, undefined],
  ['git_push', 'prompt_always', false, false, undefined],
  ['skill', 'prompt_always', false, false, undefined],
];

const PROBE_VALUE = 'probe-value';

describe('core tool descriptor parity', () => {
  it('covers exactly the core table', () => {
    expect(LEGACY_POLICY.map(([name]) => name).sort()).toEqual([...CORE_TOOL_DESCRIPTORS.keys()].sort());
  });

  it.each(LEGACY_POLICY)(
    '%s keeps category %s, readOnly %s, checkpoint %s, commandArg %s',
    (name, category, readOnly, checkpoint, commandArg) => {
      const catalog = new ToolCatalog();
      const descriptor = catalog.resolve(name);
      expect(catalog.category(name)).toBe(category);
      expect(catalog.isReadOnly(name)).toBe(readOnly);
      expect(writePathOf(descriptor, { path: PROBE_VALUE }) !== undefined).toBe(checkpoint);
      expect(descriptor?.commandArg).toBe(commandArg);
      if (commandArg) expect(commandTextOf(descriptor, { [commandArg]: PROBE_VALUE })).toBe(PROBE_VALUE);
    }
  );
});

describe('core tool descriptor coherence', () => {
  it.each([...CORE_TOOL_DESCRIPTORS])('%s pairs its effect with a matching approval tier', (_name, descriptor) => {
    if (descriptor.effect === 'write' || descriptor.effect === 'execute') {
      expect(descriptor.approval).toBe('prompt_always');
    }
    if (descriptor.approval === 'auto_approve') {
      expect(['none', 'session', 'read']).toContain(descriptor.effect);
    }
  });
});

describe('core tool sandbox declaration', () => {
  it('is declared by bash_execute and by no other core tool', () => {
    const declared = [...CORE_TOOL_DESCRIPTORS].filter(([, descriptor]) => descriptor.sandbox).map(([name]) => name);
    expect(declared).toEqual(['bash_execute']);
    expect(sandboxedCommandArg(CORE_TOOL_DESCRIPTORS.get('bash_execute'))).toBe('command');
  });
});

describe('core tool checkpoint declaration', () => {
  // writePathArg is what makes the gateway checkpoint a call, so only a file-writing tool may carry it.
  it.each([...CORE_TOOL_DESCRIPTORS].filter(([, descriptor]) => descriptor.writePathArg))(
    '%s declares a write path and a write effect',
    (_name, descriptor) => {
      expect(descriptor.effect).toBe('write');
    }
  );

  it.each(['create_file', 'edit_local_file', 'delete_file'])('%s keeps its checkpoint write path', name => {
    expect(CORE_TOOL_DESCRIPTORS.get(name)?.writePathArg).toBe('path');
  });
});
