import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import SearchResultCards from './SearchResultCards';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderCards = (content: string, replyComplete = false) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SearchResultCards content={content} replyComplete={replyComplete} />
    </CssVarsProvider>
  );

const block = (cards: unknown[]) => JSON.stringify({ cards });

const oneCard = block([
  {
    name: 'Orient Bambino',
    note: 'The default answer to this exact question.',
    meta: '~$200',
    url: 'https://orientwatch.co/bambino',
    images: [
      { url: 'https://cdn.example.com/a.jpg', source: 'orientwatch.co' },
      { url: 'https://cdn.example.com/b.jpg', source: 'jomashop' },
    ],
  },
]);

describe('SearchResultCards', () => {
  it('renders the model-authored name, note and meta line', () => {
    renderCards(oneCard);

    expect(screen.getByText('Orient Bambino')).toBeInTheDocument();
    expect(screen.getByText('The default answer to this exact question.')).toBeInTheDocument();
    expect(screen.getByText('~$200')).toBeInTheDocument();
  });

  it('links the card to its URL and opens it safely in a new tab', () => {
    renderCards(oneCard);

    const card = screen.getByTestId('search-result-card');
    expect(card).toHaveAttribute('href', 'https://orientwatch.co/bambino');
    expect(card).toHaveAttribute('target', '_blank');
    expect(card).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('lazy-loads every image and withholds the referrer from the third-party host', () => {
    const { container } = renderCards(oneCard);

    const images = Array.from(container.querySelectorAll('img'));
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    }
  });

  it('attributes each tile to the host its picture came from', () => {
    renderCards(oneCard);

    expect(screen.getByText('orientwatch.co')).toBeInTheDocument();
    expect(screen.getByText('jomashop')).toBeInTheDocument();
  });

  it('replaces an image that fails to load with a placeholder, leaving the others alone', () => {
    const { container } = renderCards(oneCard);

    fireEvent.error(container.querySelectorAll('img')[0]);

    expect(screen.getByText('Image unavailable')).toBeInTheDocument();
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('shows a skeleton, not raw JSON, while the block is still streaming', () => {
    renderCards('{"cards":[{"name":"Orient Bam');

    expect(screen.getByTestId('search-result-cards-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(/"cards"/)).not.toBeInTheDocument();
  });

  it('drops a never-closed fence once the reply is complete, rather than leaving a skeleton', () => {
    const { container } = renderCards('{"cards":[{"name":"Orient Bam', true);

    expect(container).toBeEmptyDOMElement();
  });

  it('drops an empty fence body once the reply is complete', () => {
    const { container } = renderCards('', true);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the skeleton for a half-written fence while the reply is still streaming', () => {
    renderCards('{"cards":[{"name":"Orient Bam', false);

    expect(screen.getByTestId('search-result-cards-skeleton')).toBeInTheDocument();
  });

  it('renders two same-named cards independently, so one failed image does not affect the other', () => {
    const { container } = renderCards(
      block([
        { name: 'Bambino', images: ['https://cdn.example.com/1.jpg'] },
        { name: 'Bambino', images: ['https://cdn.example.com/2.jpg'] },
      ])
    );

    expect(screen.getAllByTestId('search-result-card')).toHaveLength(2);
    fireEvent.error(container.querySelectorAll('img')[0]);

    expect(screen.getAllByText('Image unavailable')).toHaveLength(1);
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders nothing for a block that finished malformed', () => {
    const { container } = renderCards('{"cards":[]}');

    expect(container).toBeEmptyDOMElement();
  });

  it('renders a single full-width tile when the card has one image', () => {
    const { container } = renderCards(block([{ name: 'Solo', images: ['https://cdn.example.com/only.jpg'] }]));

    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getByText('Solo')).toBeInTheDocument();
  });
});
