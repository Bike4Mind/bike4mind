import { describe, it, expect } from 'vitest';
import { B4MLLMToolsList } from './llm';
import { getToolSideEffects, listDeclaredToolSideEffects } from './toolSideEffects';

describe('tool side-effect declarations', () => {
  it('declares a side-effect class for every tool in b4mLLMTools', () => {
    // The `Record<B4MLLMTools, ToolSideEffects>` annotation makes this a compile error too;
    // the runtime assertion is here so the failure names the tool rather than a type position.
    const undeclared = B4MLLMToolsList.filter(tool => getToolSideEffects(tool) === undefined);
    expect(undeclared).toEqual([]);
  });

  it('declares only valid classes', () => {
    const invalid = Object.entries(listDeclaredToolSideEffects()).filter(
      ([, effects]) => !['none', 'local', 'external'].includes(effects)
    );
    expect(invalid).toEqual([]);
  });

  it('classifies the read-only lookups that used to demand approval as `none`', () => {
    // The tools named in the agent-mode approval-fatigue report. Each is a pure lookup and
    // none has any business pausing a run.
    for (const tool of [
      'current_datetime',
      'sunrise_sunset',
      'planet_visibility',
      'wikipedia_on_this_day',
      'mission_status',
      'moon_phase',
      'iss_tracker',
    ]) {
      expect(getToolSideEffects(tool), tool).toBe('none');
    }
  });

  it('keeps the artifact-only visualization tools paired', () => {
    expect(getToolSideEffects('recharts')).toBe('local');
    expect(getToolSideEffects('mermaid_chart')).toBe('local');
  });

  it('keeps all five OptiHashi tools on one class', () => {
    const optihashi = [
      'optihashi_decompose',
      'optihashi_formulate',
      'optihashi_edit_problem',
      'optihashi_schedule',
      'optihashi_solve',
    ].map(getToolSideEffects);
    expect(new Set(optihashi)).toEqual(new Set(['local']));
  });

  it('classifies tools that mutate stored data or call out as `external`', () => {
    for (const tool of [
      'image_generation',
      'edit_image',
      'music_generation',
      'audio_generation',
      'excel_generation',
      'blog_publish',
      'delegate_to_agent',
      'send_slack_message',
      'bash_execute',
      'delete_file',
    ]) {
      expect(getToolSideEffects(tool), tool).toBe('external');
    }
  });

  it('declares nothing for names it has never heard of', () => {
    expect(getToolSideEffects('mcp__github__get_issue')).toBeUndefined();
    expect(getToolSideEffects('totally_unknown_tool')).toBeUndefined();
  });
});
