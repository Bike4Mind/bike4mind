import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import AttachmentNotices from './AttachmentNotices';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('AttachmentNotices', () => {
  it('renders one line per notice under the testid the app keys on', () => {
    render(
      <Wrapper>
        <AttachmentNotices attachmentNotices={['"a.md" was not sent: it could not be read.', '"b.png" was not sent.']} />
      </Wrapper>
    );

    const banner = screen.getByTestId('attachment-notices-list');
    expect(banner.textContent).toContain('a.md');
    expect(banner.textContent).toContain('b.png');
    expect(screen.getAllByTestId('attachment-notice-item')).toHaveLength(2);
  });

  it('renders nothing when there is nothing to report', () => {
    const { container } = render(
      <Wrapper>
        <AttachmentNotices attachmentNotices={[]} />
      </Wrapper>
    );

    expect(container.textContent).toBe('');
  });

  it('renders nothing when the field is absent, as it is on every pre-existing quest', () => {
    const { container } = render(
      <Wrapper>
        <AttachmentNotices />
      </Wrapper>
    );

    expect(container.textContent).toBe('');
  });
});
