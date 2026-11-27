import { describe, expect, it } from 'vitest';
import { compareFunctionOutput, parseFunctionContract } from '../schemas/functionContract';
import { CALLABLE_FUNCTIONS_PROMPT_NOTE, withCallableFunctions } from './callableFunctionsPromptNote';

describe('withCallableFunctions', () => {
  const PROMPT = 'PYTHON ARTIFACTS: no network.';

  it('returns the prompt byte for byte when callable functions are off', () => {
    expect(withCallableFunctions(PROMPT, false)).toBe(PROMPT);
  });

  it('appends the note once when they are on', () => {
    expect(withCallableFunctions(PROMPT, true)).toBe(`${PROMPT}\n\n${CALLABLE_FUNCTIONS_PROMPT_NOTE}`);
    expect(CALLABLE_FUNCTIONS_PROMPT_NOTE.startsWith('CALLABLE FUNCTIONS: ')).toBe(true);
  });
});

describe('the example in CALLABLE_FUNCTIONS_PROMPT_NOTE', () => {
  const artifact = CALLABLE_FUNCTIONS_PROMPT_NOTE.match(/<artifact ([^>]*)>\n([\s\S]*)\n<\/artifact>$/);
  const code = artifact?.[2] ?? '';
  const functionLiteral = code.match(/^FUNCTION = (\{[\s\S]*?\n\})$/m)?.[1] ?? '';
  // The literal is written in the JSON-compatible subset of Python, so three swaps make it JSON.
  const contract: unknown = JSON.parse(
    functionLiteral
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bTrue\b/g, 'true')
      .replace(/,(\s*[}\]])/g, '$1')
  );

  it('is a whole Python artifact', () => {
    expect(artifact?.[1]).toContain('type="application/vnd.ant.python"');
    expect(code).toMatch(/^FUNCTION = \{/m);
    expect(code).toMatch(/^def run\(/m);
  });

  it('is accepted by parseFunctionContract', () => {
    expect(parseFunctionContract(contract)).toMatchObject({ ok: true });
  });

  it('declares one test that the formula in run passes', () => {
    const parsed = parseFunctionContract(contract);
    if (!parsed.ok) throw new Error('the example contract was refused');
    expect(parsed.contract.tests).toHaveLength(1);
    const [test] = parsed.contract.tests ?? [];
    expect(code).toContain('return {"deflection": 5 * load * span**4 / (384 * elastic_modulus * second_moment)}');
    const { load, span, elastic_modulus, second_moment } = test.input as Record<string, number>;
    const deflection = (5 * load * span ** 4) / (384 * elastic_modulus * second_moment);
    expect(compareFunctionOutput(test.expected, { deflection }, test.tolerance)).toBeNull();
  });

  it('defines run with exactly the input names as its parameters', () => {
    const parsed = parseFunctionContract(contract);
    if (!parsed.ok) throw new Error('the example contract was refused');
    const params = code
      .match(/^def run\(([^)]*)\):/m)?.[1]
      .split(',')
      .map(name => name.trim());
    expect(params).toEqual(Object.keys(parsed.contract.inputs.properties));
  });
});
