// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { DocFrontMatter } from '@docusaurus/plugin-content-docs';

declare module '@docusaurus/plugin-content-docs' {
  interface DocFrontMatter {
    private?: boolean;
  }
}
