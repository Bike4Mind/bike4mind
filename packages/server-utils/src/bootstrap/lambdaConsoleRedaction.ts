// Injected into every Lambda bundle by the sst.aws.Function transform in sst.config.ts, so it runs
// before the handler module and covers raw console calls from any handler or library.
import { installConsoleRedaction } from '@bike4mind/observability';

installConsoleRedaction();
