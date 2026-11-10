// Injected into every esbuild-bundled sst.aws.Function by the transform in sst.config.ts, so it runs
// before the handler module. sst.aws.Nextjs ships prebuilt OpenNext bundles the inject never reaches;
// its server function installs the shim through apps/client/instrumentation.node.ts instead.
import { installConsoleRedaction } from '@bike4mind/observability';

installConsoleRedaction();
