/**
 * The shape of a shell command: its source with each run-time word (`$VAR`, `${VAR}`, `$1`, and
 * the same inside double quotes) replaced by a placeholder, and everything else kept as written.
 * Two commands share a shape when they differ only in which variables they read, so an
 * "Allow in this chat" for a command the scan cannot follow also covers the next call that
 * passes a different value. Operators, programs, literal arguments, redirections and the code
 * inside `$(...)` and backticks are all kept, so any change to them is a different shape.
 *
 * Null when the command holds anything this does not fully follow (arithmetic, `${...}` with an
 * operator, ANSI-C quoting, unbalanced quotes or substitutions): no shape means no shape allowance.
 */
export const SHAPE_PLACEHOLDER = '\x00';

type Context = 'plain' | 'double' | 'substitution' | 'backtick';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL = /^[0-9@*#?$!-]/;
const BRACED = /^\{(#?[A-Za-z_][A-Za-z0-9_]*|#?[0-9@*#?$!-])\}/;

export function commandShape(command: string): string | null {
  const stack: Context[] = ['plain'];
  // Open parentheses inside each `$(...)` on the stack, so `$(f (x))` closes on the right one.
  const depths: number[] = [];
  let shape = '';
  let index = 0;
  while (index < command.length) {
    const context = stack[stack.length - 1];
    const char = command[index];
    const rest = command.slice(index);

    if (char === '\\') {
      shape += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === '$') {
      const next = command[index + 1];
      if (next === '(') {
        if (command[index + 2] === '(') return null;
        stack.push('substitution');
        depths.push(0);
        shape += '$(';
        index += 2;
        continue;
      }
      if (next === "'" || next === '"' || next === '[') return null;
      if (next === '{') {
        const braced = BRACED.exec(rest.slice(1));
        if (!braced) return null;
        shape += SHAPE_PLACEHOLDER;
        index += 1 + braced[0].length;
        continue;
      }
      const name = NAME.exec(rest.slice(1)) ?? SPECIAL.exec(rest.slice(1));
      if (name) {
        shape += SHAPE_PLACEHOLDER;
        index += 1 + name[0].length;
        continue;
      }
      shape += char;
      index += 1;
      continue;
    }
    if (context === 'double') {
      if (char === '"') stack.pop();
      else if (char === '`') stack.push('backtick');
      shape += char;
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) return null;
      shape += command.slice(index, close + 1);
      index = close + 1;
      continue;
    }
    if (char === '"') stack.push('double');
    else if (char === '`') {
      if (context === 'backtick') stack.pop();
      else stack.push('backtick');
    } else if (context === 'substitution' && char === '(') {
      depths[depths.length - 1] += 1;
    } else if (context === 'substitution' && char === ')') {
      if (depths[depths.length - 1] === 0) {
        stack.pop();
        depths.pop();
      } else {
        depths[depths.length - 1] -= 1;
      }
    }
    shape += char;
    index += 1;
  }
  return stack.length === 1 ? shape : null;
}
