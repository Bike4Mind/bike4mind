import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/atlassian/config.ts',
    'src/jira/api.ts',
    'src/types/entities/RapidReplyTypes.ts',
    'src/types/entities/UserTypes.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
