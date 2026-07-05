/**
 * Completely disable service workers in development
 */
export async function disableServiceWorkerInDev() {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') {
    return;
  }

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      await registration.unregister();
      console.log('Unregistered service worker:', registration.scope);
    }
  }

  // Prevent any new registrations
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register = async (...args: any[]) => {
      console.log('Blocked service worker registration in development:', args[0]);
      // Return a fake registration that does nothing
      return Promise.resolve({
        scope: '/',
        updateViaCache: 'none',
        active: null,
        installing: null,
        waiting: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        unregister: async () => true,
        update: async () => ({}) as any,
        navigationPreload: {
          enable: async () => {},
          disable: async () => {},
          setHeaderValue: async () => {},
          getState: async () => ({ enabled: false, headerValue: '' }),
        },
      } as unknown as ServiceWorkerRegistration);
    };
  }
}

export function shouldDisableServiceWorker(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('disableServiceWorker') === 'true';
}

export function setServiceWorkerDisabled(disabled: boolean) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('disableServiceWorker', disabled.toString());
  if (disabled) {
    disableServiceWorkerInDev();
  } else {
    // Reload to re-enable service worker
    window.location.reload();
  }
}
