import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { Modal, ModalClose, ModalDialog } from '@mui/joy';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * An IconButton has no text, so a screen reader announces it as just "button" unless it carries
 * a name. This scans the app shell (layout, sidebar, composer) and Profile, the screens every user
 * passes through, and fails on any IconButton without aria-label, aria-labelledby or title.
 * A parent Tooltip is not enough: it names the button only while the tooltip is not open, and
 * not at all when a Badge or Box sits in between. A spread is trusted to carry the name.
 */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED = [
  'components/layouts',
  'components/Session/SessionBottom',
  'components/profile',
  'components/ProfileModal/ProfileDetailTabContent.tsx',
  'routes/profile',
];
const NAMED = /\baria-label(?:ledby)?=|\btitle=|\{\.\.\./;

const sourceFiles = (rel: string): string[] => {
  const full = path.join(APP_DIR, rel);
  if (fs.statSync(full).isFile()) return [full];
  return fs
    .readdirSync(full, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name));
};

/** Opening `<IconButton ...>` tags, read to the closing `>` while skipping braces in props. */
const iconButtonTags = (source: string) => {
  const tags: { tag: string; line: number }[] = [];
  for (const match of source.matchAll(/<IconButton\b/g)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push({ tag: source.slice(match.index, end), line: source.slice(0, match.index).split('\n').length });
  }
  return tags;
};

describe('icon button accessible names', () => {
  const files = SCANNED.flatMap(sourceFiles);

  it('scans a real set of icon buttons, so a broken scan cannot pass vacuously', () => {
    const total = files.reduce((n, file) => n + iconButtonTags(fs.readFileSync(file, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(40);
  });

  it('names every IconButton in the app shell and Profile', () => {
    const unnamed = files.flatMap(file =>
      iconButtonTags(fs.readFileSync(file, 'utf8'))
        .filter(({ tag }) => !NAMED.test(tag))
        .map(({ line }) => `${path.relative(APP_DIR, file)}:${line}`)
    );
    expect(unnamed).toEqual([]);
  });

  it('names the shared dialog close control through the theme', () => {
    const appTheme = extendTheme({ ...getThemeConfig() });
    render(
      <CssVarsProvider theme={appTheme}>
        <Modal open>
          <ModalDialog>
            <ModalClose />
          </ModalDialog>
        </Modal>
      </CssVarsProvider>
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
