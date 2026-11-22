import { Provider as DesktopProvider } from '../src/renderer/src/stories/LadleProvider';

// Ladle finds this by parsing for a declared `Provider`; a bare re-export is not seen.
export const Provider = DesktopProvider;
