import { beforeEach, describe, expect, it } from 'vitest';
import { isRecordedTutorialTurn } from './walkActive';
import { useTutorialPicker } from './tutorialPickerStore';

describe('isRecordedTutorialTurn', () => {
  beforeEach(() => {
    useTutorialPicker.setState({ walkOnScreen: true, walkPrompt: 'Hello there?' });
  });

  it('matches the same prompt regardless of case and spacing', () => {
    expect(isRecordedTutorialTurn('Hello there?')).toBe(true);
    expect(isRecordedTutorialTurn('  hello   THERE?  ')).toBe(true);
  });

  it('rejects a different prompt', () => {
    expect(isRecordedTutorialTurn('Something else')).toBe(false);
  });

  it('rejects everything when the step has no prompt', () => {
    useTutorialPicker.setState({ walkPrompt: null });
    expect(isRecordedTutorialTurn('Hello there?')).toBe(false);
  });

  it('rejects everything when no walk is on screen', () => {
    useTutorialPicker.setState({ walkOnScreen: false });
    expect(isRecordedTutorialTurn('Hello there?')).toBe(false);
  });
});
