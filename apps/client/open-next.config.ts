// Read by the OpenNext build that sst.aws.Nextjs runs (infra/web.ts). Kept a plain object with no
// @opennextjs/aws type import: that package is fetched by npx at deploy time, not installed here.
const config = {
  default: {},
  imageOptimization: {
    // OpenNext's default sharp install passes --arch but not --cpu, and npm picks sharp >=0.33's native
    // @img/sharp-<os>-<cpu> package by --cpu. On an x64 deploy runner that bundles the x64 binary
    // into the arm64 image Lambda, sharp fails to load, and /_next/image serves originals untouched.
    // Version must equal apps/client's lockfile-resolved sharp (asserted in infra/__tests__).
    // --ignore-scripts: this npm install runs with the full deploy env and no lockfile; sharp has no script.
    install: {
      packages: ['sharp@0.35.5'],
      os: 'linux',
      arch: 'arm64',
      libc: 'glibc',
      nodeVersion: '24',
      additionalArgs: '--cpu=arm64 --ignore-scripts',
    },
  },
} as const;

export default config;
