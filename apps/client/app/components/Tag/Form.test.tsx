import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { TagType } from '@bike4mind/common';
import type { IFileTag } from '@bike4mind/common';
import TagForm from './Form';

// The pickers pull in emoji-picker-react and dropdown chrome irrelevant to
// the preview card under test
vi.mock('../common/fields/ColorPicker', () => ({ default: () => null }));
vi.mock('../common/fields/EmojiPicker', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeFileTag = (overrides: Partial<IFileTag>): IFileTag =>
  ({
    id: 'tag-1',
    type: TagType.FILE,
    name: 'invoices',
    icon: '😇',
    color: '#185EA5',
    fileCount: 0,
    ...overrides,
  }) as IFileTag;

describe('TagForm preview file count', () => {
  it('shows the tag file count when editing an existing tag', () => {
    render(
      <TestWrapper>
        <TagForm data={makeFileTag({ fileCount: 4 })} onSubmit={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('tag-form-preview-file-count').textContent).toBe('📁 4 files');
  });

  it('singularizes a count of one', () => {
    render(
      <TestWrapper>
        <TagForm data={makeFileTag({ fileCount: 1 })} onSubmit={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('tag-form-preview-file-count').textContent).toBe('📁 1 file');
  });

  it('shows 0 files in create mode, where the tag does not exist yet', () => {
    render(
      <TestWrapper>
        <TagForm onSubmit={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('tag-form-preview-file-count').textContent).toBe('📁 0 files');
  });
});
