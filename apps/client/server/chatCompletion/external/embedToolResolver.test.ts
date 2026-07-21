import { describe, it, expect } from 'vitest';
import { EMBED_KB_DEFAULT_TOOLS, EMBED_OPT_IN_TOOLS, resolveEmbedTools } from './embedToolResolver';

const KB = [...EMBED_KB_DEFAULT_TOOLS];

// Tools that must NEVER materialize on the embed surface, no matter what allowedTools
// says. If one of these ever appears in a resolver result, the curated-universe guard
// has been broken.
const NEVER_FOR_EMBED = [
  'image_generation',
  'edit_image',
  'edit_file',
  'blog_publish',
  'blog_edit',
  'blog_draft',
  'skill',
  'deep_research',
  'prompt_enhancement',
  'generate_jupyter_notebook',
  'excel_generation',
  'delegate_to_agent',
  'coordinate_task',
  'navigate_view',
  'recharts',
  'mermaid_chart',
];

describe('resolveEmbedTools', () => {
  it('defaults to exactly the KB tools when nothing is allowed or denied', () => {
    expect(resolveEmbedTools({ allowedTools: [], deniedTools: [] })).toEqual(KB);
  });

  it('opts in a named tool from the curated universe', () => {
    const out = resolveEmbedTools({ allowedTools: ['web_search'], deniedTools: [] });
    expect(out).toEqual([...KB, 'web_search']);
  });

  it('expands wildcards against the curated universe only', () => {
    const out = resolveEmbedTools({ allowedTools: ['web_*'], deniedTools: [] });
    expect(out).toEqual([...KB, 'web_search', 'web_fetch']);
  });

  it("'*' grants the full curated set and NOTHING beyond it", () => {
    const out = resolveEmbedTools({ allowedTools: ['*'], deniedTools: [] });
    expect(out).toEqual([...KB, ...EMBED_OPT_IN_TOOLS]);
    for (const name of NEVER_FOR_EMBED) {
      expect(out).not.toContain(name);
    }
  });

  it('names outside the universe are silently ignored, even when explicitly allowed', () => {
    const out = resolveEmbedTools({
      allowedTools: ['image_generation', 'skill', 'delegate_to_agent', 'blog_publish'],
      deniedTools: [],
    });
    expect(out).toEqual(KB);
  });

  it("deny wins over everything: deniedTools ['*'] turns tools off entirely", () => {
    expect(resolveEmbedTools({ allowedTools: ['*'], deniedTools: ['*'] })).toEqual([]);
  });

  it('deny can remove a KB default', () => {
    const out = resolveEmbedTools({ allowedTools: [], deniedTools: ['search_knowledge_base'] });
    expect(out).toEqual(['retrieve_knowledge_content']);
  });

  it('deny beats an explicit allow of the same tool', () => {
    const out = resolveEmbedTools({ allowedTools: ['web_search'], deniedTools: ['web_search'] });
    expect(out).toEqual(KB);
  });

  it('deny wildcards apply to the whole union', () => {
    const out = resolveEmbedTools({ allowedTools: ['web_*', 'moon_phase'], deniedTools: ['*_knowledge_*', 'web_*'] });
    expect(out).toEqual(['moon_phase']);
  });

  it('deduplicates overlapping allow patterns', () => {
    const out = resolveEmbedTools({ allowedTools: ['web_search', 'web_*'], deniedTools: [] });
    expect(out.filter(n => n === 'web_search')).toHaveLength(1);
  });
});
