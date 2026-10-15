import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';

/**
 * Rendered to a string, like ApprovalChoice's tests and for the same reason: this package's
 * vitest runs on `node`, so only the CLOSED control is answerable here - the menu is a portal
 * that mounts on open. That is enough for what these cover: which face the control shows, and
 * that it renders at all, which is what a MenuButton outside its Dropdown fails at.
 */
const MODELS: ChatModelOption[] = [
  { id: 'gpt-5', name: 'GPT-5', supportsReasoningEffort: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', supportsReasoningEffort: false },
];

function markup(modelId: string | null, models: ChatModelOption[] = MODELS): string {
  return renderToStaticMarkup(
    <ReasoningEffortPicker models={models} modelId={modelId} effort="high" onSelect={() => {}} />
  );
}

describe('ReasoningEffortPicker', () => {
  it('shows the chosen effort on a model that takes one', () => {
    expect(markup('gpt-5')).toContain('Effort: High');
  });

  it('disables itself and says nothing is in effect on a model that does not', () => {
    const html = markup('claude-opus-5');
    expect(html).toContain('Effort: n/a');
    expect(html).not.toContain('Effort: High');
    expect(html).toContain('disabled');
  });

  it('stays usable while the catalog has not loaded, rather than guessing a model is unsupported', () => {
    expect(markup('gpt-5', [])).toContain('Effort: High');
    expect(markup(null, [])).toContain('Effort: High');
  });

  it('keeps a model the catalog never stated a flag for usable', () => {
    expect(markup('some-local-ollama', [{ id: 'some-local-ollama', name: 'Local' }])).toContain('Effort: High');
  });
});
