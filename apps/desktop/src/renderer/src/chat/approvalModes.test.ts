import { describe, expect, it } from 'vitest';
import { APPROVAL_MODE_FOOTNOTES, APPROVAL_MODE_OPTIONS, approvalModeLabel, approvalModeOption } from './approvalModes';

describe('approval mode copy', () => {
  it('offers the three modes safest first', () => {
    expect(APPROVAL_MODE_OPTIONS.map(option => option.mode)).toEqual(['ask', 'auto', 'full']);
  });

  /** The one coloured row. Two outliers would be no outlier at all. */
  it('marks exactly one option as the warning', () => {
    const flagged = APPROVAL_MODE_OPTIONS.filter(option => option.tone === 'warning');
    expect(flagged.map(option => option.mode)).toEqual(['full']);
  });

  /**
   * The honesty requirement. Commands are not confined, so a mode that stops asking
   * really does let a command read any file this user can read. Wording that implied
   * otherwise would be the most dangerous string in the app, so it is asserted rather than
   * left to whoever edits the copy next.
   */
  it('says plainly what full access allows', () => {
    const full = approvalModeOption('full');
    expect(full.description).toMatch(/read any file on this computer/i);
    expect(full.description).toMatch(/internet/i);
    expect(full.description).toMatch(/without asking/i);
  });

  it('does not promise that approve-for-me checks everything', () => {
    expect(approvalModeOption('auto').description).toMatch(/everything except/i);
    expect(approvalModeOption('auto').description).toMatch(/outside this project/i);
    expect(approvalModeOption('auto').description).toMatch(/send data out/i);
  });

  it('says approve-for-me asks before sending data out and after reading untrusted content', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/send data off this computer/i);
    expect(notes).toMatch(/read web, browser, MCP or skill content/i);
    expect(notes).toMatch(/browsing a site/i);
  });

  /**
   * The copy states the gap rather than implying the list is exhaustive: what a shell command
   * prints does not count as content the reply read, so a page reached with `curl` does not by
   * itself turn on the asks above.
   */
  it('admits that what a command printed is not counted as reading', () => {
    expect(APPROVAL_MODE_FOOTNOTES.join(' ')).toMatch(/downloaded and printed is not counted/i);
  });

  /** The two axes the popover has to keep visibly apart, plus the two scoping rules. */
  it('states the limits that hold in every mode', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/spend credits/i);
    expect(notes).toMatch(/cannot be undone/i);
    expect(notes).toMatch(/folders you have shared/i);
    expect(notes).toMatch(/until you quit/i);
    expect(notes).toMatch(/never runs at full access/i);
  });

  /**
   * The other half of the honesty requirement, and the one that is easy to lose: 'auto' reads
   * as "unsafe things still ask", and builds, installs and downloads run unasked. The copy
   * has to say so, so the saying of it is asserted and not left to the next copy edit.
   */
  it('admits that approve-for-me runs most commands unasked', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/every other command and edit without asking/i);
  });

  it('falls back to asking for a mode it does not recognise', () => {
    expect(approvalModeLabel('ask')).toBe('Ask for approval');
    expect(approvalModeOption('nonsense' as never).mode).toBe('ask');
  });
});
