import { RuleTester } from 'eslint';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule from '../../eslint-rules/require-update-validators.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

for (const method of ['findOneAndUpdate', 'updateOne', 'updateMany']) {
  const invalid = code => ({ code, errors: [{ messageId: 'validators', data: { method } }] });
  tester.run(`require-update-validators: ${method}`, rule, {
    valid: [
      `Model.${method}({}, update, { runValidators: true });`,
      `Model.${method}({}, update, { ...options, runValidators: true });`,
      `Model.${method}({}, update, { ['runValidators']: true });`,
      `Model.${method}({}, update, { runValidators: true } as const);`,
      `Model.${method}({}, update).setOptions({ runValidators: true }).lean();`,
      `Model.${method}({}, update, { runValidators: true }).setOptions({ session });`,
      `Model.${method}({}, update).setOptions({ runValidators: true }).setOptions({ session });`,
      `Model.${method}({}, update, { runValidators: false }).setOptions({ runValidators: true });`,
      `Model.${method}({}, update, { /* update-validators-off: counter uses $inc */ runValidators: false });`,
      `Model.${method}({}, update /* update-validators-off: native driver has no schema */);`,
      `// update-validators-off: native driver has no schema\nModel.collection.${method}({}, update);`,
      `const result = await Model.${method}(\n  // update-validators-off: pipeline is validated separately\n  {}, pipeline\n);`,
      `other.save({}, update);`,
    ],
    invalid: [
      invalid(`Model.${method}({}, update);`),
      invalid(`Model.${method}({}, update, {});`),
      invalid(`Model.${method}({}, update, { runValidators: false });`),
      invalid(`Model.${method}({}, update, { runValidators });`),
      invalid(`Model.${method}({}, update, options);`),
      invalid(`Model.${method}({}, update, { runValidators: true, ...options });`),
      invalid(`Model.${method}({}, update, { runValidators: true, [key]: false });`),
      invalid(`Model.${method}({}, update, { runValidators: true, runValidators: false });`),
      invalid(`Model.${method}({}, update, { nested: { runValidators: true } });`),
      invalid(`Model.${method}({ runValidators: true }, update);`),
      invalid(`Model['${method}']({}, update);`),
      invalid(`Model?.${method}?.({}, update);`),
      invalid(`this.model.${method}({}, update).session(session);`),
      invalid(`Model.${method}({}, update, { runValidators: true }).setOptions({ runValidators: false });`),
      invalid(`Model.${method}({}, update).setOptions({ runValidators: true }).setOptions(options);`),
      invalid(`Model.${method}({}, update); // update-validators-off:`),
      invalid(`// update-validators-off: \nModel.${method}({}, update);`),
      invalid(`// update-validators-off: unrelated call\nother();\nModel.${method}({}, update);`),
      invalid(`Model.${method}({}, update);\n// update-validators-off: unrelated next call\nother();`),
    ],
  });
}

describe('bulk suppression enforcement through the repository config', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const eslint = fileURLToPath(new URL('../bin/eslint.js', import.meta.resolve('eslint')));
  const lint = code =>
    spawnSync(
      process.execPath,
      [eslint, '--stdin', '--stdin-filename', 'scripts/update-validator-fixture.mjs', '--quiet'],
      { cwd, input: code, encoding: 'utf8' }
    );
  const call = 'globalThis.model.updateOne({}, {});\n';

  it('consumes the existing two-call baseline without changing it', () => {
    const result = spawnSync(process.execPath, [eslint, 'scripts/migrate-sre-v2.mjs', '--quiet'], {
      cwd,
      encoding: 'utf8',
    });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects an additional unvalidated call', () => {
    const result = lint(call.repeat(3));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('b4m/require-update-validators');
  });

  it('accepts an additional call with a reasoned opt-out', () => {
    const result = lint('// update-validators-off: native driver has no schema\n' + call);
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
