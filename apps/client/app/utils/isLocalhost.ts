// Whether the app is running on a local development host. Used to decide where to surface the
// dev-only network / service-worker status pills (footer when local, tucked by the version otherwise).
export const isLocalhost =
  typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
