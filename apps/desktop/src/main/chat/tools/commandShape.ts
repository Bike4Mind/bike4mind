/**
 * The shape of a shell command: its source with each variable read (`$VAR`, `${VAR}`, `$1`, and
 * the same inside double quotes) written as one placeholder that keeps the variable's name, and
 * everything else kept as written. Two commands share a shape when they read the same variables
 * however those are spelled, so the run-time values may differ but which variable feeds which
 * argument never does. Operators, programs, literal arguments, redirections and the code inside
 * `$(...)` and backticks are all kept, so any change to them is a different shape.
 *
 * Null when the command holds anything this does not fully follow (arithmetic, `${...}` with an
 * operator, ANSI-C quoting, comments, heredocs, unbalanced quotes or substitutions): no shape
 * means no shape allowance.
 */
export const SHAPE_PLACEHOLDER = '\x00';

const placeholder = (name: string) => `${SHAPE_PLACEHOLDER}${name}${SHAPE_PLACEHOLDER}`;

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
        shape += placeholder(braced[1] ?? '');
        index += 1 + braced[0].length;
        continue;
      }
      const name = NAME.exec(rest.slice(1)) ?? SPECIAL.exec(rest.slice(1));
      if (name) {
        shape += placeholder(name[0]);
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
    // A comment or heredoc body is text this does not track quotes in.
    if (char === '#' && (shape === '' || /[\s;&|()]$/.test(shape))) return null;
    if (char === '<' && command[index + 1] === '<') return null;
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
