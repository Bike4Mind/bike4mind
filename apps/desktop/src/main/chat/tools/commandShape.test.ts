import { describe, expect, it } from 'vitest';
import { commandShape, SHAPE_PLACEHOLDER } from './commandShape';

const P = (name: string) => `${SHAPE_PLACEHOLDER}${name}${SHAPE_PLACEHOLDER}`;

describe('commandShape', () => {
  it('replaces run-time words and keeps everything else as written', () => {
    expect(commandShape('git push origin "$BRANCH"')).toBe(`git push origin "${P('BRANCH')}"`);
    expect(commandShape('echo ${HOME}/x $1 "$@"')).toBe(`echo ${P('HOME')}/x ${P('1')} "${P('@')}"`);
    expect(commandShape('tmp=$(mktemp) && git diff > "$tmp" && wc -l "$tmp"')).toBe(
      `tmp=$(mktemp) && git diff > "${P('tmp')}" && wc -l "${P('tmp')}"`
    );
  });

  it('gives the same shape to however a variable read is spelled', () => {
    expect(commandShape('git push origin "$BRANCH"')).toBe(commandShape('git push origin "${BRANCH}"'));
    expect(commandShape('wc -l $a')).toBe(commandShape('wc -l ${a}'));
  });

  it('gives a different shape when another variable is read, or the same ones are swapped', () => {
    expect(commandShape('git push origin "$BRANCH"')).not.toBe(commandShape('git push origin "$TARGET"'));
    expect(commandShape('cp "$src" "$out"')).not.toBe(commandShape('cp "$out" "$src"'));
    expect(commandShape('echo ${#X}')).not.toBe(commandShape('echo $X'));
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
    expect(commandShape('echo "$(basename "$(pwd)")" $Z')).toBe(`echo "$(basename "$(pwd)")" ${P('Z')}`);
  });

  it('has no shape for what it does not fully follow', () => {
    for (const command of [
      'echo $((1 + $X))',
      'echo ${X:-$(rm -rf ~)}',
      "echo $'\\x41'",
      'echo "unterminated $X',
      "echo 'unterminated",
      'echo $(unclosed',
      "x=$(mktemp) # it's\nperl -e '$a' > \"$x\"",
      "cat <<'EOF' | sh\n$a\nEOF",
    ]) {
      expect(commandShape(command)).toBeNull();
    }
  });
});
