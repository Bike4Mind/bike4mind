import { describe, it, expect, afterEach } from 'vitest';
import { ACTOR_COLOR_SLOT_COUNT, actorColorIndex } from '@bike4mind/hearth';
import { ACTOR_ANSI_COLORS, colorizeActor } from '../actorColors.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_IS_TTY = process.stdout.isTTY;

function setTty(value: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  Object.defineProperty(process.stdout, 'isTTY', { value: ORIGINAL_IS_TTY, configurable: true });
});

describe('hearth CLI actor colors', () => {
  it('has exactly one color per shared slot', () => {
    // The cross-surface guarantee: a palette shorter than the slot count folds
    // two slots onto one color, so an actor could read as a different identity
    // in the CLI than in the SPA.
    expect(ACTOR_ANSI_COLORS).toHaveLength(ACTOR_COLOR_SLOT_COUNT);
  });

  it('colors by actorId deterministically', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(colorizeActor('actor-1', 'erik')).toBe(colorizeActor('actor-1', 'erik'));
    expect(colorizeActor('actor-1', 'erik')).toContain(ACTOR_ANSI_COLORS[actorColorIndex('actor-1')]);
  });

  it('always preserves the actor text, so color is never the only signal', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(colorizeActor('actor-1', 'amber-otter')).toContain('amber-otter');
  });

  it('resets after the name so the color cannot bleed into the message', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    expect(colorizeActor('actor-1', 'erik').endsWith('\x1b[0m')).toBe(true);
  });

  it('emits no escape codes when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    setTty(true);
    expect(colorizeActor('actor-1', 'erik')).toBe('erik');
  });

  it("emits no escape codes when FORCE_COLOR is '0', even on a TTY", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '0';
    setTty(true);
    // '0' is the standard force-DISABLE signal and is truthy in JS, so this
    // guards the ordering in colorEnabled. bashExecute sets it when capturing
    // tool output.
    expect(colorizeActor('actor-1', 'erik')).toBe('erik');
  });

  it('emits no escape codes when stdout is not a TTY', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    setTty(false);
    // Piping `/hearth` to a file or a grep must stay readable.
    expect(colorizeActor('actor-1', 'erik')).toBe('erik');
  });
});
