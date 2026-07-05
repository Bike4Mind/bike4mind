import { useEffect, useState } from 'react';

/**
 * Hook to detect if the app is running as a PWA (Progressive Web App)
 * Checks for standalone display mode on both iOS and other platforms
 */
export const useIsPWA = (): boolean => {
  const [isPWA, setIsPWA] = useState(false);

  useEffect(() => {
    // Check if running in standalone mode (PWA)
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone || // iOS Safari
      document.referrer.includes('android-app://');

    setIsPWA(isStandalone);
  }, []);

  return isPWA;
};
