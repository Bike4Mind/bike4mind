import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { KnowledgeType, SupportedFabFileMimeTypes, TagType } from '@bike4mind/common';
import type { IFabFileDocument, IFileTag } from '@bike4mind/common';

/**
 * Which tag documents a row's chips come from. The rest of the row (icons, actions, filters) pulls
 * in context this test does not care about, so Item stands in as a probe that reports the tags it
 * was handed - that prop IS the behaviour under test.
 */
vi.mock('./Item', () => ({
  default: ({ tags }: { tags?: IFileTag[] }) => (
    <div>
      {(tags ?? []).map(tag => (
        <span key={tag.id} data-testid="row-tag" data-tag-name={tag.name} data-tag-id={tag.id} />
      ))}
    </div>
  ),
}));
vi.mock('./TagFilter', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import FileBrowserList from './List';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderList = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const makeTag = (id: string, name: string): IFileTag =>
  ({ id, name, userId: 'u1', type: TagType.FILE, fileCount: 0, color: '#FF0000' }) as IFileTag;

const makeFile = (id: string, tagNames: string[]): IFabFileDocument =>
  ({
    id,
    userId: 'u1',
    fileName: `${id}.txt`,
    type: KnowledgeType.FILE,
    mimeType: SupportedFabFileMimeTypes.TXT_PLAIN,
    tags: tagNames.map(name => ({ name, strength: 1 })),
  }) as IFabFileDocument;

const LOWER = makeTag('lower', 'run2-alpha');
const UPPER = makeTag('upper', 'RUN2-Alpha');

const chipNames = () => screen.queryAllByTestId('row-tag').map(el => el.getAttribute('data-tag-name'));

describe('FileBrowserList tag chips', () => {
  // The reported defect: with `run2-alpha` and `RUN2-Alpha` both existing as documents, a file
  // carrying only the lowercase name grew a phantom `RUN2-Alpha` chip - on every file in the
  // lowercase tag, including ones no apply had ever touched.
  it('shows only the tag the file actually carries when a case variant document exists', () => {
    renderList(<FileBrowserList files={[makeFile('f1', ['run2-alpha'])]} fileTags={[LOWER, UPPER]} />);

    expect(chipNames()).toEqual(['run2-alpha']);
  });

  it('shows the variant, and only the variant, on a file that carries the variant', () => {
    renderList(<FileBrowserList files={[makeFile('f2', ['RUN2-Alpha'])]} fileTags={[LOWER, UPPER]} />);

    expect(chipNames()).toEqual(['RUN2-Alpha']);
  });

  it('shows both when the file genuinely carries both names', () => {
    renderList(<FileBrowserList files={[makeFile('f3', ['run2-alpha', 'RUN2-Alpha'])]} fileTags={[LOWER, UPPER]} />);

    expect(chipNames()).toEqual(['run2-alpha', 'RUN2-Alpha']);
  });

  // A stored casing no document uses is still that document's tag while only one folds to it -
  // toggleTags writes the name as the caller spelled it, and legacy rows predate even that.
  it('still resolves a stored casing no document uses, when only one document folds to it', () => {
    renderList(<FileBrowserList files={[makeFile('f4', ['RUN2-ALPHA'])]} fileTags={[LOWER]} />);

    expect(chipNames()).toEqual(['run2-alpha']);
  });

  it('renders one chip when two stored casings resolve to the same document', () => {
    renderList(<FileBrowserList files={[makeFile('f5', ['run2-alpha', 'RUN2-ALPHA'])]} fileTags={[LOWER]} />);

    expect(chipNames()).toEqual(['run2-alpha']);
  });

  it('renders nothing for a file with no tags', () => {
    renderList(<FileBrowserList files={[makeFile('f6', [])]} fileTags={[LOWER, UPPER]} />);

    expect(chipNames()).toEqual([]);
  });

  // The shared view synthesizes a chip for a name the viewer holds no document for, so it must keep
  // matching per stored name rather than intersecting the document list.
  describe('shared files', () => {
    // Variant document listed FIRST on purpose: a loose folded `.find` would return it, so this
    // fails unless the exact name wins.
    it('uses the viewer document that matches the stored name exactly', () => {
      renderList(
        <FileBrowserList files={[makeFile('f7', ['run2-alpha'])]} fileTags={[UPPER, LOWER]} fileFilterType="shared" />
      );

      expect(screen.getAllByTestId('row-tag').map(el => el.getAttribute('data-tag-id'))).toEqual(['lower']);
    });

    it('still shows a tag the viewer has no document for', () => {
      renderList(
        <FileBrowserList files={[makeFile('f8', ['someone-elses-tag'])]} fileTags={[]} fileFilterType="shared" />
      );

      expect(chipNames()).toEqual(['someone-elses-tag']);
    });

    it('shows an ambiguous stored name as its own chip rather than picking a document', () => {
      renderList(
        <FileBrowserList files={[makeFile('f9', ['RUN2-ALPHA'])]} fileTags={[LOWER, UPPER]} fileFilterType="shared" />
      );

      expect(chipNames()).toEqual(['RUN2-ALPHA']);
    });
  });
});
