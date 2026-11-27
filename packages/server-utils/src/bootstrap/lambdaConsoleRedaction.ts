// Built into a self-contained script by infra/consoleRedactionBanner.ts and prepended to every
// esbuild-bundled sst.aws.Function as `nodejs.banner` (see sst.config.ts), so it runs before the
// handler module. sst.aws.Nextjs ships prebuilt OpenNext bundles the banner never reaches; its server
// function installs the shim through apps/client/instrumentation.node.ts instead.
import { installConsoleRedaction } from '@bike4mind/observability';

installConsoleRedaction();
