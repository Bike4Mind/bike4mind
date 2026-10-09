// Read by the OpenNext build that sst.aws.Nextjs runs (infra/web.ts). Kept a plain object with no
// @opennextjs/aws type import: that package is fetched by npx at deploy time, not installed here.
const config = {
  default: {},
  imageOptimization: {
    // OpenNext's default sharp install passes --arch but not --cpu, and npm picks sharp >=0.33's native
    // @img/sharp-<os>-<cpu> package by --cpu. On an x64 deploy runner that bundles the x64 binary
    // into the arm64 image Lambda, sharp fails to load, and /_next/image serves originals untouched.
    // Version tracks apps/client's sharp and the root pnpm override floor.
    install: {
      packages: ['sharp@0.35.5'],
      os: 'linux',
      arch: 'arm64',
      libc: 'glibc',
      nodeVersion: '24',
      additionalArgs: '--cpu=arm64',
    },
  },
} as const;

export default config;
