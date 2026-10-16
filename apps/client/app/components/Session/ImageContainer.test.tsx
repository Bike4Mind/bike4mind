import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import ImageContainer, { extractS3KeyFromUrl, isGeneratedImage } from './ImageContainer';
import { SessionReadOnlyProvider } from './SessionReadOnlyContext';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  index: 0,
  totalImages: 1,
  images: ['https://example.com/image.png'],
  onSendMessage: vi.fn(async () => {}),
};

// The "Scanning for safety" upload-moderation placeholder must only ever apply to
// uploaded FabFile images (which pass `moderationStatus`), never to generated reply
// images (PromptReplies.tsx), which never pass that prop.
describe('ImageContainer (upload moderation gating)', () => {
  it('shows the scanning placeholder when moderationStatus is set and src is empty (uploaded, mid-scan)', () => {
    render(
      <TestWrapper>
        <ImageContainer {...baseProps} src="" moderationStatus="pending" />
      </TestWrapper>
    );

    expect(screen.getByTestId('image-moderation-scanning')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-response-image')).not.toBeInTheDocument();
  });

  it('shows the blocked placeholder when moderationStatus is blocked', () => {
    render(
      <TestWrapper>
        <ImageContainer {...baseProps} src="" moderationStatus="blocked" />
      </TestWrapper>
    );

    expect(screen.getByTestId('image-moderation-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-response-image')).not.toBeInTheDocument();
  });

  it('does NOT show the scanning placeholder for a generated image with an empty src and no moderationStatus', () => {
    render(
      <TestWrapper>
        <ImageContainer {...baseProps} src="" />
      </TestWrapper>
    );

    expect(screen.queryByTestId('image-moderation-scanning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-moderation-blocked')).not.toBeInTheDocument();
    // Falls back to prior behavior: the plain <img>, even with an empty src.
    expect(screen.getByTestId('ai-response-image')).toBeInTheDocument();
  });

  it('renders the image normally when moderationStatus is clean and src is present', () => {
    render(
      <TestWrapper>
        <ImageContainer {...baseProps} src="https://example.com/image.png" moderationStatus="clean" />
      </TestWrapper>
    );

    expect(screen.queryByTestId('image-moderation-scanning')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-response-image')).toBeInTheDocument();
  });
});

describe('ImageContainer (missing image)', () => {
  it('shows a no-longer-available state instead of a broken image when the image fails to load', () => {
    render(
      <TestWrapper>
        <ImageContainer {...baseProps} src="https://example.com/image.png" />
      </TestWrapper>
    );

    fireEvent.error(screen.getByTestId('ai-response-image'));

    expect(screen.queryByTestId('ai-response-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-response-image-unavailable')).toHaveTextContent('no longer available');
  });
});

describe('ImageContainer (read-only)', () => {
  it('offers Edit Image normally', () => {
    render(
      <TestWrapper>
        <ImageContainer {...baseProps} src="https://example.com/image.png" />
      </TestWrapper>
    );

    expect(screen.getAllByTestId('image-edit-btn').length).toBeGreaterThan(0);
  });

  // Editing uploads a mask file before sending, so hiding only the send would still write.
  it('hides Edit Image but keeps download when read-only', () => {
    render(
      <TestWrapper>
        <SessionReadOnlyProvider readOnly>
          <ImageContainer {...baseProps} src="https://example.com/image.png" />
        </SessionReadOnlyProvider>
      </TestWrapper>
    );

    expect(screen.queryByTestId('image-edit-btn')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('image-download-btn').length).toBeGreaterThan(0);
  });
});

describe('extractS3KeyFromUrl / isGeneratedImage', () => {
  const KEY = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';
  const SIGNATURE = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abc123';

  it.each([
    [
      'virtual-hosted presigned',
      `https://prod-x-generatedimagesbucket-abc.s3.us-east-1.amazonaws.com/${KEY}?${SIGNATURE}`,
    ],
    ['path-style presigned', `https://s3.us-east-1.amazonaws.com/prod-x-generatedimagesbucket-abc/${KEY}?${SIGNATURE}`],
  ])('yields the bare key from a %s url', (_label, url) => {
    expect(extractS3KeyFromUrl(url)).toBe(KEY);
    expect(isGeneratedImage(url)).toBe(true);
  });

  it('decodes a percent-encoded key', () => {
    const url = `https://prod-x-generatedimagesbucket-abc.s3.us-east-1.amazonaws.com/report%201%2B2.xlsx?${SIGNATURE}`;
    expect(extractS3KeyFromUrl(url)).toBe('report 1+2.xlsx');
  });

  it('returns null for a non-S3 url and for an unparseable one', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(extractS3KeyFromUrl('https://example.com/image.png')).toBeNull();
    expect(extractS3KeyFromUrl('not a url')).toBeNull();
    consoleError.mockRestore();
    expect(isGeneratedImage('https://example.com/image.png')).toBe(false);
  });
});
