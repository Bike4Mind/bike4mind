// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rewriteBarrelImports } from './vitest.barrelImports';

const exports = new Map([
  ['Box', { module: '@mui/joy/Box', imported: 'default' }],
  ['Tab', { module: '@mui/joy/Tab', imported: 'default' }],
  ['tabClasses', { module: '@mui/joy/Tab', imported: 'tabClasses' }],
  ['useTheme', { module: '@mui/joy/styles', imported: 'useTheme' }],
]);

const rewrite = (code: string) => rewriteBarrelImports(code, '@mui/joy', exports);

describe('rewriteBarrelImports', () => {
  it('turns default re-exports into default imports and named ones into named imports', () => {
    expect(rewrite(`import { Box, tabClasses } from '@mui/joy';`)).toBe(
      `import Box from '@mui/joy/Box'; import { tabClasses } from '@mui/joy/Tab';`
    );
  });

  it('keeps the local alias', () => {
    expect(rewrite(`import { Box as JoyBox, useTheme as useJoyTheme } from "@mui/joy";`)).toBe(
      `import JoyBox from '@mui/joy/Box'; import { useTheme as useJoyTheme } from '@mui/joy/styles';`
    );
  });

  it('preserves the line count of a multi-line import so later line numbers do not move', () => {
    const code = `import {\n  Box,\n  Tab,\n} from '@mui/joy';\nconst x = 1;`;
    const out = rewrite(code);
    expect(out.split('\n')).toHaveLength(code.split('\n').length);
    expect(out.split('\n')[4]).toBe('const x = 1;');
  });

  it('leaves the barrel import alone when any name is unknown', () => {
    const code = `import { Box, NotAnExport } from '@mui/joy';`;
    expect(rewrite(code)).toBe(code);
  });

  it('does not touch subpath imports or other packages', () => {
    const code = `import Box from '@mui/joy/Box';\nimport { Box as B } from '@mui/material';`;
    expect(rewrite(code)).toBe(code);
  });
});
