import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Modal, ModalClose, ModalDialog } from '@mui/joy';
import AppTheme from '@client/app/utils/themes/AppTheme';

/**
 * An IconButton has no text, so a screen reader announces it as just "button" unless it carries
 * a name. This scans the app shell (layout, sidebar, composer) and Profile, the screens every user
 * passes through, and fails on any IconButton without aria-label, aria-labelledby or title.
 * A parent Tooltip is not enough: it names the button only while the tooltip is not open, and
 * not at all when a Badge or Box sits in between. A top-level spread is trusted to carry the name;
 * an empty label or one that only appears inside a nested prop such as sx does not count.
 */
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED = [
  'components/layouts',
  'components/Session/SessionBottom',
  'components/profile',
  'components/ProfileModal/ProfileDetailTabContent.tsx',
  'routes/profile',
];
const NAMED_LABEL = /\b(?:aria-label|title)=(?:"[^"]+"|\{(?!\s*(?:''|""|``|undefined|null|false)?\s*\}))/;
const NAMED_BY = /\baria-labelledby=(?:"[^"]+"|\{(?!\s*(?:''|""|undefined|null|false)?\s*\}))/;
const SPREAD = /\s\{\.\.\./;

/** Whether an opening tag's own props (not those nested in sx, slotProps and the like) name it. */
const isNamedTag = (tag: string) => {
  let depth = 0;
  let own = '';
  for (const ch of tag) {
    if (ch === '{') depth++;
    if (depth <= 1) own += ch;
    if (ch === '}') depth--;
  }
  return NAMED_LABEL.test(own) || NAMED_BY.test(own) || SPREAD.test(own);
};

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
        .filter(({ tag }) => !isNamedTag(tag))
        .map(({ line }) => `${path.relative(APP_DIR, file)}:${line}`)
    );
    expect(unnamed).toEqual([]);
  });

  it('rejects tags that only look named, so the scan cannot be bypassed trivially', () => {
    expect(isNamedTag('<IconButton onClick={go}>')).toBe(false);
    expect(isNamedTag('<IconButton aria-label="" onClick={go}>')).toBe(false);
    expect(isNamedTag("<IconButton aria-label={''} onClick={go}>")).toBe(false);
    expect(isNamedTag('<IconButton aria-label={undefined} onClick={go}>')).toBe(false);
    expect(isNamedTag('<IconButton sx={{ title="x", aria-label="x" }} onClick={go}>')).toBe(false);
    expect(isNamedTag('<IconButton sx={{...base}} onClick={go}>')).toBe(false);
    expect(isNamedTag('<IconButton aria-label="Close" onClick={go}>')).toBe(true);
    expect(isNamedTag("<IconButton aria-label={t('a', 'A')} onClick={go}>")).toBe(true);
    expect(isNamedTag('<IconButton title="Close" onClick={go}>')).toBe(true);
    expect(isNamedTag('<IconButton {...props} onClick={go}>')).toBe(true);
  });

  it('names the shared dialog close control through the real AppTheme provider', () => {
    render(
      <AppTheme>
        <Modal open>
          <ModalDialog>
            <ModalClose data-testid="dialog-close-btn" />
          </ModalDialog>
        </Modal>
      </AppTheme>
    );
    expect(screen.getByTestId('dialog-close-btn')).toHaveAccessibleName('Close');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
