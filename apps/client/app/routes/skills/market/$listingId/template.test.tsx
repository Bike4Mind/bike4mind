import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ params: { listingId: 'l1' } }));

vi.mock('@tanstack/react-router', () => ({ useParams: () => h.params }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/components/SkillMarket/TemplateEditor/TemplateEditor', async () => {
  const React = await import('react');
  function EditorStub({ listingId }: { listingId: string }) {
    // A fresh mount per key shows up as a new id; a reused instance keeps the first one.
    const [mountId] = React.useState(() => Math.random());
    return <div data-testid="template-editor-stub" data-listing={listingId} data-mount={String(mountId)} />;
  }
  return { default: EditorStub };
});

import SkillTemplateEditorPage from './template';

describe('SkillTemplateEditorPage', () => {
  it('remounts the editor when the listingId param changes (key={listingId})', () => {
    h.params = { listingId: 'l1' };
    const { rerender } = render(<SkillTemplateEditorPage />);
    const first = screen.getByTestId('template-editor-stub');
    expect(first).toHaveAttribute('data-listing', 'l1');
    const firstMount = first.getAttribute('data-mount');

    h.params = { listingId: 'l2' };
    rerender(<SkillTemplateEditorPage />);
    const second = screen.getByTestId('template-editor-stub');
    expect(second).toHaveAttribute('data-listing', 'l2');
    expect(second.getAttribute('data-mount')).not.toBe(firstMount);
  });
});
