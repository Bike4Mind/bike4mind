/**
 * Ambient declaration for the `react-syntax-highlighter/dist/cjs` sub-path.
 *
 * The package ships JS-only for /dist/cjs with no companion .d.ts, and
 * @types/react-syntax-highlighter types only the root entry — so a
 * `from 'react-syntax-highlighter/dist/cjs'` import trips TS7016 under `tsc`
 * (seen when the optihashi package type-checks apps/client files through its
 * @client/* paths). Re-export the root types for that sub-path to suppress it.
 *
 * Do NOT also declare `/dist/cjs/styles/prism`: @types already types the styles
 * sub-path (its `oneDark`/`prism` exports resolve), and an ambient `export =`
 * override there shadows those named exports and breaks the native compiler
 * (tsgo) used by the open-core fork typecheck.
 *
 * NOTE: Must be a script file (no top-level imports) so the `declare module`
 * block is an ambient declaration rather than a module augmentation.
 */

declare module 'react-syntax-highlighter/dist/cjs' {
  export * from 'react-syntax-highlighter';
  export { default } from 'react-syntax-highlighter';
}
