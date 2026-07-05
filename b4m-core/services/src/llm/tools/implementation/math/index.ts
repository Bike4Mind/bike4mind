import { Logger } from '@bike4mind/observability';
import { ToolDefinition } from '../../base/types';
import { create, all } from 'mathjs';

const math = create(all, {
  number: 'BigNumber',
  precision: 14,
});

interface MathParams {
  expression: string;
  precision?: number;
}

async function evaluateMath(params: MathParams): Promise<string> {
  Logger.globalInstance.log('🔢 Math Tool: Starting evaluation of expression:', params.expression);

  try {
    let expression = params.expression.trim();

    // Strip block comments /* ... */ and line comments // (not supported by mathjs)
    expression = expression.replace(/\/\*[\s\S]*?\*\//g, '');
    expression = expression.replace(/\/\/[^\n]*/g, '');
    // Remove trailing semicolons and clean up empty lines
    expression = expression
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')
      .replace(/;\s*$/, '');

    // Validate balanced parentheses before evaluation
    let depth = 0;
    for (const char of expression) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) {
      const issue = depth > 0 ? `${depth} unclosed opening parenthesis` : `unexpected closing parenthesis`;
      return `Error: Unbalanced parentheses in expression "${params.expression}". Found ${issue}. Please fix the parentheses and try again.`;
    }

    // Handle multi-statement semicolon-separated expressions (e.g., "muE=3.986e14; d=3.844e8; muE/d")
    // mathjs natively supports these and returns a ResultSet - we extract the last result
    if (expression.includes(';')) {
      Logger.globalInstance.log('🔢 Math Tool: Detected multi-statement expression, evaluating with shared scope...');
      const result = math.evaluate(expression);

      // math.evaluate returns a ResultSet for semicolon-separated expressions
      if (math.typeOf(result) === 'ResultSet') {
        const entries = result.entries;
        const lastResult = entries[entries.length - 1];

        if (math.typeOf(lastResult) === 'Matrix') {
          return `Matrix result:\n${math.format(lastResult, { precision: params.precision })}`;
        }

        return math.format(lastResult, { precision: params.precision });
      }

      return math.format(result, { precision: params.precision });
    }

    // Handle different equation formats that LLMs might generate
    if (expression.includes('=') || expression.match(/solve\s*\(/)) {
      Logger.globalInstance.log('🔢 Math Tool: Detected equation, processing...');

      // Extract equation from various solve() formats
      const solveMatch = expression.match(/solve\s*\(\s*([^,=]+)\s*=\s*([^,)]+)\s*(?:,\s*([a-zA-Z]\w*))?\s*\)/);
      if (solveMatch) {
        const [, leftSide, rightSide] = solveMatch;
        expression = `${leftSide.trim()} = ${rightSide.trim()}`;
        Logger.globalInstance.log('🔢 Math Tool: Extracted equation from solve():', expression);
      }

      // Handle direct equations (e.g., "5x² + 6x + 1 = 0")
      if (expression.includes('=')) {
        const [leftSide, rightSide] = expression.split('=').map(s => s.trim());

        // Detect variable in the equation
        const variableMatch = leftSide.match(/([a-zA-Z])/);
        const variable = variableMatch ? variableMatch[1] : 'x';

        Logger.globalInstance.log('🔢 Math Tool: Solving equation with variable:', variable);

        // Convert to standard form (everything on left side = 0)
        const equation = rightSide === '0' ? leftSide : `(${leftSide}) - (${rightSide})`;

        try {
          // Try different solving approaches
          let solutions;

          // Method 1: Use mathjs solve function with string format
          try {
            solutions = math.evaluate(`solve("${equation} = 0", "${variable}")`);
            Logger.globalInstance.log('🔢 Math Tool: Solutions found (method 1):', solutions);
          } catch (e1) {
            Logger.globalInstance.log('🔢 Math Tool: Method 1 failed, trying method 2...');

            // Method 2: Simplify first, then solve
            try {
              const simplified = math.simplify(equation);
              solutions = math.evaluate(`solve("${simplified} = 0", "${variable}")`);
              Logger.globalInstance.log('🔢 Math Tool: Solutions found (method 2):', solutions);
            } catch (e2) {
              Logger.globalInstance.log('🔢 Math Tool: Method 2 failed, trying method 3...');

              // Method 3: For quadratic equations, use alternative approach
              if (equation.includes('^2') || equation.includes('**2')) {
                try {
                  // Extract coefficients for quadratic formula
                  const quadraticResult = solveQuadratic(equation, variable);
                  if (quadraticResult) {
                    return quadraticResult;
                  }
                } catch (e3) {
                  Logger.globalInstance.log('🔢 Math Tool: Quadratic method failed');
                }
              }

              throw e2;
            }
          }

          if (solutions === null || solutions === undefined) {
            return 'No solutions found for this equation.';
          }

          return Array.isArray(solutions)
            ? `Solutions: ${solutions.map(s => `${variable} = ${math.format(s, { precision: params.precision })}`).join(', ')}`
            : `Solution: ${variable} = ${math.format(solutions, { precision: params.precision })}`;
        } catch (solveError) {
          Logger.globalInstance.debug('❌ Math Tool: Solve error:', solveError);
          throw new Error(
            `Could not solve equation "${expression}". The equation format may not be supported or may have no real solutions.`
          );
        }
      }
    }

    // Regular expression evaluation
    Logger.globalInstance.log('🔢 Math Tool: Evaluating expression...');
    const result = math.evaluate(expression);
    Logger.globalInstance.log('🔢 Math Tool: Raw result:', result);

    if (math.typeOf(result) === 'Matrix') {
      Logger.globalInstance.log('🔢 Math Tool: Formatting matrix result');
      return `Matrix result:\n${math.format(result, { precision: params.precision })}`;
    }

    const formattedResult = math.format(result, { precision: params.precision });
    Logger.globalInstance.log('🔢 Math Tool: Final formatted result:', formattedResult);
    return formattedResult;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    Logger.globalInstance.error(`❌ Math Tool: Evaluation error for expression "${params.expression}":`, errorMessage);

    // Undefined symbol = the expression uses a variable that was never assigned a value
    // (e.g. "currentRatio = (cashPrior + 100) / debt" without a prior "cashPrior = ..." statement).
    // mathjs throws "Undefined symbol <name>"; give a targeted, self-correctable message instead of
    // the generic "numbers and operators only" hint, which is misleading here.
    const undefinedSymbol = errorMessage.match(/Undefined symbol (\w+)/);
    if (undefinedSymbol) {
      const symbol = undefinedSymbol[1];
      return `Error: Failed to evaluate math expression "${params.expression}". Reason: the symbol "${symbol}" is used but never assigned a value. Assign it first with a semicolon-separated statement (e.g. "${symbol} = <value>; ...") before referencing it, then try again.`;
    }

    return `Error: Failed to evaluate math expression "${params.expression}". Reason: ${errorMessage}. Please provide a valid mathematical expression using numbers and operators only (no natural language).`;
  }
}

// Helper function to solve quadratic equations using the quadratic formula
function solveQuadratic(equation: string, variable: string): string | null {
  try {
    // Normalize the equation format and remove spaces
    const normalized = equation.replace(/\*\*/g, '^').replace(/\s/g, '');

    // More robust pattern to extract coefficients for ax^2 + bx + c
    // Handle cases like: x^2-4, 5*x^2+6*x+1, etc.
    const patterns = [
      // Pattern 1: a*x^2+b*x+c or variations
      new RegExp(`([+-]?\\d*\\.?\\d*)\\*?${variable}\\^2([+-]\\d*\\.?\\d*)\\*?${variable}([+-]\\d*\\.?\\d*)`),
      // Pattern 2: x^2+c (no x term)
      new RegExp(`([+-]?\\d*\\.?\\d*)\\*?${variable}\\^2([+-]\\d*\\.?\\d*)`),
      // Pattern 3: ax^2+bx (no constant)
      new RegExp(`([+-]?\\d*\\.?\\d*)\\*?${variable}\\^2([+-]\\d*\\.?\\d*)\\*?${variable}$`),
      // Pattern 4: just x^2 (coefficient 1)
      new RegExp(`${variable}\\^2([+-]\\d*\\.?\\d*)`),
    ];

    let a = 0,
      b = 0,
      c = 0;
    let matched = false;

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        matched = true;
        if (match.length >= 4) {
          // ax^2 + bx + c format
          a = parseFloat(match[1] === '' || match[1] === '+' ? '1' : match[1] === '-' ? '-1' : match[1]);
          b = parseFloat(match[2] === '' || match[2] === '+' ? '1' : match[2] === '-' ? '-1' : match[2]);
          c = parseFloat(match[3] || '0');
        } else if (match.length === 3) {
          // ax^2 + c format (no b term) or ax^2 + bx format (no c term)
          a = parseFloat(match[1] === '' || match[1] === '+' ? '1' : match[1] === '-' ? '-1' : match[1]);
          if (match[2].includes(variable)) {
            // ax^2 + bx format
            b = parseFloat(match[2] === '' || match[2] === '+' ? '1' : match[2] === '-' ? '-1' : match[2]);
            c = 0;
          } else {
            // ax^2 + c format
            b = 0;
            c = parseFloat(match[2] || '0');
          }
        } else if (match.length === 2) {
          // x^2 + c format
          a = 1;
          b = 0;
          c = parseFloat(match[1] || '0');
        }
        break;
      }
    }

    if (!matched || a === 0) return null; // Not a quadratic equation

    Logger.globalInstance.log(`🔢 Math Tool: Quadratic coefficients: a=${a}, b=${b}, c=${c}`);

    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) {
      return `No real solutions (discriminant = ${discriminant})`;
    } else if (discriminant === 0) {
      const x = -b / (2 * a);
      return `Solution: ${variable} = ${x}`;
    } else {
      const x1 = (-b + Math.sqrt(discriminant)) / (2 * a);
      const x2 = (-b - Math.sqrt(discriminant)) / (2 * a);
      return `Solutions: ${variable} = ${x1}, ${variable} = ${x2}`;
    }
  } catch (error) {
    Logger.globalInstance.log('🔢 Math Tool: Quadratic formula method failed:', error);
    return null;
  }
}

export const mathTool: ToolDefinition = {
  name: 'math_evaluate',
  implementation: () => ({
    toolFn: value => evaluateMath(value as MathParams),
    toolSchema: {
      name: 'math_evaluate',
      description: `Evaluate mathematical expressions using mathjs syntax. Supports arithmetic, algebra, trigonometry, calculus, and statistics. Supports multi-step calculations with semicolon-separated statements sharing a scope (e.g., "x = 5; y = 10; x * y" returns 50). IMPORTANT: Use simple mathematical notation only - no loops or programming constructs.

**LaTeX Rendering Support:**
When showing mathematical work, equations, or formulas in your response, use LaTeX syntax for professional rendering:

- **Inline math:** Use $equation$ for math within text
  Example: "The solution is $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$ from the quadratic formula."

- **Display math:** Use $$equation$$ for centered block equations
  Example:
  $$
  \\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
  $$

**Common LaTeX commands:**
- Fractions: \\frac{numerator}{denominator}
- Square roots: \\sqrt{x} or \\sqrt[n]{x}
- Superscripts: x^2 or x^{10}
- Subscripts: x_i or x_{ij}
- Greek: \\alpha, \\beta, \\gamma, \\Delta, \\Sigma
- Integrals: \\int_a^b, \\iint, \\oint
- Summations: \\sum_{i=1}^n
- Limits: \\lim_{x \\to \\infty}
- Matrices: \\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}

Always use LaTeX for mathematical notation to ensure clear, professional presentation. The LaTeX syntax is part of your response text - no tool call needed for rendering.`,
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'The mathematical expression to evaluate using mathjs syntax. Supports single expressions (e.g., "5 * 6 + 3", "sin(pi/4)") and multi-step semicolon-separated statements with variable assignments (e.g., "muE=3.986e14; d=3.844e8; muE/d"). Array results are supported (e.g., "a=3; b=4; [a, b]"). DO NOT use loops (for/while) or comments (//).',
          },
          precision: {
            type: 'number',
            description: 'Number of significant digits (default: 14)',
            minimum: 1,
            maximum: 64,
          },
        },
        required: ['expression'],
      },
    },
  }),
};
