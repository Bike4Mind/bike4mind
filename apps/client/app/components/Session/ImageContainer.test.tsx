import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import ImageContainer from './ImageContainer';

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
