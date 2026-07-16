/**
 * Blessed, self-hosted artifact library script paths (root-relative).
 *
 * Single source of truth shared across the artifact pipeline:
 *  - publish validation + viewer CSP (server: validateBundle.ts, viewerSecurity.ts)
 *  - publish srcdoc absolutization (server: renderSandboxedBundle.ts)
 *  - in-app sandbox sanitizer absolutization (client: htmlSanitizer.ts)
 *  - /api/artifact-sandbox CSP (server)
 *
 * Keeping the list here (rather than in a server-only module) lets the client
 * sanitizer absolutize EXACTLY these paths without pulling server-only deps
 * (cheerio) into the client bundle - so the client and publish paths can never
 * drift apart on what counts as "blessed".
 *
 * These are paths only; the deployment-specific host allowlist (PUBLISH_HOST,
 * derived from SERVER_DOMAIN) stays in validateBundle.ts.
 */
/**
 * React runtime libs self-hosted for PUBLISHABLE React artifacts (issue #21). Pinned,
 * self-hosted UMD builds under `/static/lib/` (mirrors `chart.js@4.x.js`). The publish-time
 * transpiler references these to assemble a React artifact's inert HTML bundle; kept as a
 * named subset so the assembler and the validator share one list.
 */
export const REACT_BLESSED_SCRIPT_PATHS: readonly string[] = [
  '/static/lib/react@18.x.js',
  '/static/lib/react-dom@18.x.js',
  '/static/lib/prop-types@15.x.js',
];

/** A blessed, self-hosted UMD for one optional React-artifact dependency. */
export interface PublishReactDepScript {
  /** Blessed `/static/lib` path of the pinned self-hosted UMD (see REACT_BLESSED_SCRIPT_PATHS). */
  path: string;
  /** `window` global the UMD exposes; the require() shim in the assembled bundle binds to it. */
  global: string;
}

/**
 * Optional React-artifact dependencies self-hosted + blessed for PUBLISH (issue #21, PR 2), keyed
 * by the module specifier an artifact imports. Mirrors the in-app CDN contract
 * (`OPTIONAL_DEP_CDN` in apps/client/app/utils/reactArtifactDeps.ts) so a PUBLISHED artifact
 * resolves the same globals as the in-chat preview - but from pinned, self-hosted UMDs instead of
 * a CDN. Filenames pin the significant version (`react@18.x.js` style). `lucide-react` loads the
 * `lucide` UMD (raw global `lucide`), which the publish assembler wraps as `LucideReactWrapper`
 * (the require() target recorded here), exactly like the in-app sandbox.
 * MUST stay in sync with OPTIONAL_DEP_CDN's globalVar values.
 */
export const PUBLISH_REACT_DEP_SCRIPTS: Readonly<Record<string, PublishReactDepScript>> = {
  recharts: { path: '/static/lib/recharts@2.x.js', global: 'Recharts' },
  'lucide-react': { path: '/static/lib/lucide@1.x.js', global: 'LucideReactWrapper' },
  d3: { path: '/static/lib/d3@7.x.js', global: 'd3' },
  lodash: { path: '/static/lib/lodash@4.x.js', global: '_' },
  mathjs: { path: '/static/lib/mathjs@11.x.js', global: 'math' },
  papaparse: { path: '/static/lib/papaparse@5.x.js', global: 'Papa' },
  xlsx: { path: '/static/lib/xlsx@0.18.x.js', global: 'XLSX' },
};

/** Blessed `/static/lib` paths for the optional React deps above (derived - never drifts). */
export const OPTIONAL_DEP_BLESSED_SCRIPT_PATHS: readonly string[] = Object.values(PUBLISH_REACT_DEP_SCRIPTS).map(
  d => d.path
);

export const BLESSED_SCRIPT_PATHS: readonly string[] = [
  '/static/lib/chart.js@4.x.js',
  '/static/b4m-client.js@1.x.js',
  ...REACT_BLESSED_SCRIPT_PATHS,
  ...OPTIONAL_DEP_BLESSED_SCRIPT_PATHS,
];
