import { beforeEach, describe, expect, it } from 'vitest';
import { isCoreTutorialWalkActive, isRecordedTutorialTurn } from './walkActive';
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

describe('isCoreTutorialWalkActive', () => {
  beforeEach(() => {
    useTutorialPicker.setState({ walkOnScreen: false, launching: false, requestedTrack: null });
  });

  it('is false with no walk on screen or on its way', () => {
    expect(isCoreTutorialWalkActive()).toBe(false);
  });

  it('holds while a walk shows', () => {
    useTutorialPicker.setState({ walkOnScreen: true });
    expect(isCoreTutorialWalkActive()).toBe(true);
  });

  it('holds while a start or resume is in flight, before the first step shows', () => {
    useTutorialPicker.setState({ launching: true });
    expect(isCoreTutorialWalkActive()).toBe(true);
  });

  it('holds while a track asked for waits for the host to start it', () => {
    useTutorialPicker.setState({ requestedTrack: 'basics' });
    expect(isCoreTutorialWalkActive()).toBe(true);
  });
});
