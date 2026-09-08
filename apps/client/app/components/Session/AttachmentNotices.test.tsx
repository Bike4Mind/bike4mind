import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import AttachmentNotices from './AttachmentNotices';
import type { IAttachmentDelivery } from '@bike4mind/common';

const delivery = (over: Partial<IAttachmentDelivery> = {}): IAttachmentDelivery => ({
  requested: 0,
  delivered: 0,
  fullyDelivered: 0,
  dropped: 0,
  droppedIds: [],
  ...over,
});

const headingText = () => screen.getByTestId('attachment-notices-heading').textContent;

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('AttachmentNotices', () => {
  it('renders one line per notice under the testid the app keys on', () => {
    render(
      <Wrapper>
        <AttachmentNotices
          attachmentNotices={['"a.md" was not sent: it could not be read.', '"b.png" was not sent.']}
        />
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

  it('heads the banner with the drop count over the denominator', () => {
    render(
      <Wrapper>
        <AttachmentNotices
          attachmentNotices={['"a.md" was not sent.']}
          attachmentDelivery={delivery({
            requested: 21,
            delivered: 18,
            fullyDelivered: 18,
            dropped: 3,
            droppedIds: ['a', 'b', 'c'],
          })}
        />
      </Wrapper>
    );

    expect(headingText()).toBe('3 of 21 attached files did not reach the model intact');
    expect(screen.getByTestId('WarningAmberRoundedIcon')).toBeTruthy();
  });

  it('does not claim a failure when everything arrived and some arrived in part', () => {
    render(
      <Wrapper>
        <AttachmentNotices
          attachmentNotices={['"a.md" was shortened to fit.']}
          attachmentDelivery={delivery({ requested: 12, delivered: 12, fullyDelivered: 8 })}
        />
      </Wrapper>
    );

    expect(headingText()).toBe('All 12 attached files reached the model; 4 in part');
    expect(headingText()).not.toContain('did not reach');
    expect(screen.getByTestId('InfoOutlinedIcon')).toBeTruthy();
    expect(screen.queryByTestId('WarningAmberRoundedIcon')).toBeNull();
  });

  it('drops the partial clause when nothing was truncated either', () => {
    render(
      <Wrapper>
        <AttachmentNotices
          attachmentNotices={['a caveat with no matching count']}
          attachmentDelivery={delivery({ requested: 5, delivered: 5, fullyDelivered: 5 })}
        />
      </Wrapper>
    );

    expect(headingText()).toBe('All 5 attached files reached the model');
  });

  it('says "file" when the count is one', () => {
    render(
      <Wrapper>
        <AttachmentNotices
          attachmentNotices={['"a.md" was not sent.']}
          attachmentDelivery={delivery({ requested: 1, dropped: 1, droppedIds: ['a'] })}
        />
      </Wrapper>
    );

    expect(headingText()).toBe('1 of 1 attached file did not reach the model intact');
  });

  it('keeps the countless wording on a quest written before the counts existed', () => {
    render(
      <Wrapper>
        <AttachmentNotices attachmentNotices={['"a.md" was not sent.']} />
      </Wrapper>
    );

    expect(headingText()).toBe('Some attachments did not reach the model intact');
  });

  it('stays silent on a clean turn - the report is not a success affordance', () => {
    const { container } = render(
      <Wrapper>
        <AttachmentNotices
          attachmentNotices={[]}
          attachmentDelivery={delivery({ requested: 4, delivered: 4, fullyDelivered: 4 })}
        />
      </Wrapper>
    );

    expect(container.textContent).toBe('');
  });
});
