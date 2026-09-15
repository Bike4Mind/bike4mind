import { describe, it, expect } from 'vitest';
import { mathTool } from './index';

const evaluate = mathTool.implementation().toolFn;

describe('math_evaluate', () => {
  describe('single expressions', () => {
    it('should evaluate basic arithmetic', async () => {
      const result = await evaluate({ expression: '5 * 6 + 3' });
      expect(result).toBe('33');
    });

    it('should evaluate trigonometric functions', async () => {
      const result = await evaluate({ expression: 'sin(pi / 2)' });
      expect(result).toBe('1');
    });
  });

  describe('multi-statement semicolon-separated expressions', () => {
    it('should evaluate variable assignments and return the last result', async () => {
      const result = await evaluate({ expression: 'x = 5; y = 10; x * y' });
      expect(result).toBe('50');
    });

    it('should handle scientific notation with variable assignments', async () => {
      const result = await evaluate({
        expression: 'muE = 3.986004418e14; muM = 4.9048695e12; muE / muM',
      });
      expect(result).toBe('81.266268511323');
    });

    it('should return matrix/array results from multi-statement expressions', async () => {
      const result = await evaluate({ expression: 'a = 3; b = 4; [a, b]' });
      expect(result).toContain('3');
      expect(result).toContain('4');
    });

    it('should support complex multi-step calculations (orbital mechanics)', async () => {
      const result = await evaluate({
        expression:
          'muE = 3.986004418e14; muM = 4.9048695e12; d = 3.844e8; ratio = muE / muM; xb = d / (1 + ratio^(1/3)); [xb, ratio]',
      });
      // Should not throw - this is the exact pattern from the bug report
      expect(result).toContain('7.2099992795002e+7');
      expect(result).toContain('81.266268511323');
    });
  });

  describe('equation solving', () => {
    it('should solve equations with solve() syntax', async () => {
      const result = await evaluate({ expression: 'solve(x^2 - 4 = 0, x)' });
      expect(result).toContain('2');
      expect(result).toContain('-2');
    });
  });

  describe('precision', () => {
    it('should respect custom precision', async () => {
      const result = await evaluate({ expression: 'pi', precision: 5 });
      expect(result).toBe('3.1416');
    });
  });

  describe('sanitization', () => {
    it('strips trailing semicolon on a single statement', async () => {
      const result = await evaluate({ expression: '5 * 6 + 3;' });
      expect(result).toBe('33');
    });

    it('strips trailing semicolon from last statement in multi-statement expression', async () => {
      const result = await evaluate({ expression: 'a = 5; b = 10; a + b;' });
      expect(result).toBe('15');
    });

    // LLMs generate semicolon-separated assignments with inline // comments.
    // mathjs does not support // and fails with 'Value expected (char 1)' without this stripping.
    it('strips inline // comments from semicolon-separated statements (#7663)', async () => {
      const result = await evaluate({
        expression:
          'MR_SK75 = exp(1.5); // Core mass ratio - SK75\nMR_SK99 = exp(2.0); // Core mass ratio - SK99\nMR_SK75 + MR_SK99',
      });
      expect(result).not.toContain('Error:');
      expect(parseFloat(result)).toBeCloseTo(Math.exp(1.5) + Math.exp(2.0), 5);
    });

    it('strips a comment-only line between semicolon-separated statements', async () => {
      const result = await evaluate({
        expression: 'a = 3;\n// intermediate step\nb = 4;\na + b',
      });
      expect(result).toBe('7');
    });

    // LLMs generate /* block comments */ which mathjs does not support.
    it('strips /* block comments */ from multi-line expressions (#7780)', async () => {
      const result = await evaluate({
        expression:
          '/* Habitat dimensions */\ndiameter = 10;\nlength = 20;\nradius = diameter/2;\n\n/* Surface areas */\ncylindrical_wall_area = pi * diameter * length;\nend_cap_area = pi * radius^2;\ntotal_end_caps = 2 * end_cap_area;\ntotal_surface_area = cylindrical_wall_area + total_end_caps;\n\n[cylindrical_wall_area, total_end_caps, total_surface_area]',
      });
      // Verify actual computed values, not just absence of errors
      // cylindrical_wall_area = π x 10 x 20 ≈ 628.318, total_end_caps = 2 x π x 25 ≈ 157.079
      // total_surface_area = 250π ≈ 785.398
      expect(result).toContain('628');
      expect(result).toContain('157');
      expect(result).toContain('785');
    });
  });

  describe('error handling', () => {
    it('should return error string with the expression on invalid input', async () => {
      const result = await evaluate({ expression: '???invalid' });
      expect(result).toContain('Error: Failed to evaluate math expression');
      expect(result).toContain('???invalid');
    });

    it('should return error string for natural language input', async () => {
      const result = await evaluate({ expression: 'no. of days' });
      expect(result).toContain('Error: Failed to evaluate math expression');
      expect(result).toContain('no. of days');
    });

    it('returns the generic hint for input with no resolvable symbol', async () => {
      const result = await evaluate({ expression: '???invalid' });
      expect(result).toContain('valid mathematical expression');
    });

    // LLM generates expression with unclosed parenthesis
    it('detects unclosed opening parenthesis (#7825)', async () => {
      const result = await evaluate({ expression: '(2 + 3' });
      expect(result).toContain('Unbalanced parentheses');
      expect(result).toContain('unclosed opening parenthesis');
    });

    it('detects unexpected closing parenthesis', async () => {
      const result = await evaluate({ expression: '2 + 3)' });
      expect(result).toContain('Unbalanced parentheses');
      expect(result).toContain('unexpected closing parenthesis');
    });

    it('still evaluates valid nested parentheses', async () => {
      const result = await evaluate({ expression: '((2 + 3) * (4 - 1))' });
      expect(result).toBe('15');
    });

    // LLM references a variable it never assigned (e.g. forgot the
    // "cashPrior = ..." statement). Surface a targeted, self-correctable message that names
    // the symbol instead of the misleading generic "numbers and operators only" hint.
    it('returns a targeted message naming the undefined symbol (#8626)', async () => {
      const result = await evaluate({
        expression:
          'shortDebtRecent = 5782931; currentRatioPrior = (cashPrior + 547390) / shortDebtRecent; currentRatioPrior',
      });
      expect(result).toContain('Error: Failed to evaluate math expression');
      expect(result).toContain('cashPrior');
      expect(result).toContain('never assigned a value');
      // Should NOT fall back to the misleading natural-language hint
      expect(result).not.toContain('no natural language');
    });

    it('names the undefined symbol for a bare unassigned variable', async () => {
      const result = await evaluate({ expression: 'foo + 1' });
      expect(result).toContain('foo');
      expect(result).toContain('never assigned a value');
    });
  });
});
