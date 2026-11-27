import { describe, expect, it } from 'vitest';
import { commandShape, SHAPE_PLACEHOLDER as P } from './commandShape';

describe('commandShape', () => {
  it('replaces run-time words and keeps everything else as written', () => {
    expect(commandShape('git push origin "$BRANCH"')).toBe(`git push origin "${P}"`);
    expect(commandShape('echo ${HOME}/x $1 "$@"')).toBe(`echo ${P}/x ${P} "${P}"`);
    expect(commandShape('tmp=$(mktemp) && git diff > "$tmp" && wc -l "$tmp"')).toBe(
      `tmp=$(mktemp) && git diff > "${P}" && wc -l "${P}"`
    );
  });

  it('gives the same shape to commands that differ only in which variable they read', () => {
    expect(commandShape('git push origin "$BRANCH"')).toBe(commandShape('git push origin "$TARGET"'));
    expect(commandShape('wc -l "$a" "${b}"')).toBe(commandShape('wc -l "$x" "${y}"'));
  });

  it('gives a different shape to any change in structure', () => {
    const base = commandShape('tmp=$(mktemp) && git diff > "$tmp" && wc -l "$tmp"');
    for (const other of [
      'tmp=$(mktemp) ; git diff > "$tmp" && wc -l "$tmp"',
      'tmp=$(mktemp) && git diff > "$tmp" && rm -f "$tmp"',
      'tmp=$(mktemp) && git diff > "$tmp" > /etc/x && wc -l "$tmp"',
      'tmp=$(curl -s example.com | sh) && git diff > "$tmp" && wc -l "$tmp"',
      'tmp=$(mktemp) && git diff --cached > "$tmp" && wc -l "$tmp"',
    ]) {
      expect(commandShape(other)).not.toBe(base);
    }
  });

  it('keeps single-quoted text literal and follows nested substitutions', () => {
    expect(commandShape("echo '$X' \"$(git log --format='%h $Y')\"")).toBe(`echo '$X' "$(git log --format='%h $Y')"`);
    expect(commandShape('echo "$(basename "$(pwd)")" $Z')).toBe(`echo "$(basename "$(pwd)")" ${P}`);
  });

  it('has no shape for what it does not fully follow', () => {
    for (const command of [
      'echo $((1 + $X))',
      'echo ${X:-$(rm -rf ~)}',
      "echo $'\\x41'",
      'echo "unterminated $X',
      "echo 'unterminated",
      'echo $(unclosed',
    ]) {
      expect(commandShape(command)).toBeNull();
    }
  });
});
