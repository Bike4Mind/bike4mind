import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { KnowledgeType, SupportedFabFileMimeTypes, TagType } from '@bike4mind/common';
import type { IFabFileDocument, IFileTagWithFileCount } from '@bike4mind/common';

/**
 * Which tags the Manage Tags dialog puts in each column. Not cosmetic: fabFileService/toggleTags
 * picks add-vs-remove by folding the name, so a tag offered as "available" whose name folds to one
 * the file already stores un-applies that tag when you click Add.
 */
const mockTags = vi.fn<() => IFileTagWithFileCount[]>(() => []);

vi.mock('@client/app/hooks/data/tag', () => ({
  useGetFileTags: () => ({ data: mockTags() }),
  useToggleTagToFiles: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useCloneFabFile: () => ({ mutateAsync: vi.fn() }),
  useDeleteFile: () => ({ mutateAsync: vi.fn() }),
  useUpdateFabFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useGetPresignedUrl: () => ({ mutateAsync: vi.fn() }),
  useAutoRenameFabFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useApplyAutoRenameFabFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => ({ confirm: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { FileTagsModal } from './ItemActions';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderModal = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const makeTag = (id: string, name: string): IFileTagWithFileCount =>
  ({ id, name, userId: 'u1', type: TagType.FILE, fileCount: 0, color: '#FF0000' }) as IFileTagWithFileCount;

const makeFile = (tagNames: string[]): IFabFileDocument =>
  ({
    id: 'f1',
    userId: 'u1',
    fileName: 'f1.txt',
    type: KnowledgeType.FILE,
    mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
    tags: tagNames.map(name => ({ name, strength: 1 })),
  }) as IFabFileDocument;

const LOWER = makeTag('lower', 'run2-alpha');
const UPPER = makeTag('upper', 'RUN2-Alpha');
const BETA = makeTag('beta', 'run2-beta');

const namesIn = (testId: string) => screen.queryAllByTestId(testId).map(el => el.getAttribute('data-tag-name'));
const onFile = () => namesIn('file-tags-modal-current-row');
const available = () => namesIn('file-tags-modal-available-row');

describe('FileTagsModal tag columns', () => {
  beforeEach(() => mockTags.mockReturnValue([LOWER, UPPER, BETA]));

  // The reported defect: the dialog listed a tag the file did not carry, and the remove button on
  // that row stripped the OTHER casing's tag instead, because toggleTags matches by fold.
  it('lists only the tag the file carries, with a case variant document present', () => {
    renderModal(<FileTagsModal file={makeFile(['run2-alpha'])} open onClose={vi.fn()} />);

    expect(onFile()).toEqual(['run2-alpha']);
  });

  // The dangerous direction. `RUN2-Alpha` must NOT be offered while the file stores `run2-alpha`:
  // toggleTags folds, so applying it pulls `run2-alpha` and the file loses its only tag.
  it('does not offer a tag whose name folds to one the file already stores', () => {
    renderModal(<FileTagsModal file={makeFile(['run2-alpha'])} open onClose={vi.fn()} />);

    expect(available()).toEqual(['run2-beta']);
  });

  it('offers a tag the file genuinely does not have', () => {
    renderModal(<FileTagsModal file={makeFile(['run2-alpha', 'RUN2-Alpha'])} open onClose={vi.fn()} />);

    expect(onFile()).toEqual(['run2-alpha', 'RUN2-Alpha']);
    expect(available()).toEqual(['run2-beta']);
  });

  // A casing no document uses resolves to nothing, so the file shows no chip for it - but applying
  // either document would still pull it, so neither may be offered.
  it('withholds both documents when the stored casing is too ambiguous to resolve', () => {
    renderModal(<FileTagsModal file={makeFile(['RUN2-ALPHA'])} open onClose={vi.fn()} />);

    expect(onFile()).toEqual([]);
    expect(available()).toEqual(['run2-beta']);
  });

  it('offers everything for a file with no tags', () => {
    renderModal(<FileTagsModal file={makeFile([])} open onClose={vi.fn()} />);

    expect(onFile()).toEqual([]);
    expect(available()).toEqual(['run2-alpha', 'RUN2-Alpha', 'run2-beta']);
  });

  it('resolves a stored casing no document uses when exactly one document folds to it', () => {
    mockTags.mockReturnValue([LOWER, BETA]);

    renderModal(<FileTagsModal file={makeFile(['RUN2-ALPHA'])} open onClose={vi.fn()} />);

    expect(onFile()).toEqual(['run2-alpha']);
    expect(available()).toEqual(['run2-beta']);
  });
});
