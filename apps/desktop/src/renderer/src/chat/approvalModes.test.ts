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

  it('names what full access still asks about', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/"Full access" asks before an action that cannot be undone/);
    expect(notes).not.toMatch(/credits/i);
    expect(notes).toMatch(/cannot be undone/i);
    expect(notes).toMatch(/browser page you are signed in to/i);
    expect(notes).toMatch(/permission and hook settings/i);
    expect(notes).toMatch(/WSL distro this project has no folder in/i);
  });

  it('does not promise that approve-for-me checks everything', () => {
    expect(approvalModeOption('auto').description).toMatch(/everything except/i);
    expect(approvalModeOption('auto').description).toMatch(/write outside this project/i);
    expect(approvalModeOption('auto').description).toMatch(/write protected settings/i);
  });

  it('says approve-for-me and full access run what Desktop cannot follow, and when they still ask', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/"Approve for me" and "Full access" run commands Desktop cannot fully follow or parse/);
    expect(notes).toMatch(/names permission and hook settings and may write/i);
    expect(notes).toMatch(/names a \.env file or runs outside your folders/i);
  });

  it('says approve-for-me runs reads outside your folders and commands that send data out', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
    expect(notes).toMatch(/only reads outside your folders runs/i);
    expect(notes).toMatch(/send data off this computer/i);
    expect(notes).toMatch(/whatever the reply has read/i);
  });

  it('names the folders file edits can never reach', () => {
    expect(APPROVAL_MODE_FOOTNOTES.join(' ')).toMatch(/~\/\.ssh are refused in every mode/);
  });

  /** The limits that hold in every mode, plus the two scoping rules. */
  it('states the limits that hold in every mode', () => {
    const notes = APPROVAL_MODE_FOOTNOTES.join(' ');
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
