import type { PremiumRouteDescriptor } from './premiumContract';

export interface PremiumRoutePartition<T extends PremiumRouteDescriptor> {
  /** Bare under the root route: the URL is the authorization, so no gate and no ProviderBundle. */
  public: T[];
  /** Own chrome, gated by RestrictedPage, wrapped in ProviderBundle. */
  standalone: T[];
  /** Inside the notebook layout, gated by RestrictedPage. */
  appShell: T[];
}

/**
 * Splits premium route descriptors by how the router mounts them, and refuses one that
 * asks for two things at once: a gate on a public route would be invisible to the reader
 * it blocks, and the app shell's beforeLoad redirects a signed-out visitor before render.
 */
export function partitionPremiumRoutes<T extends PremiumRouteDescriptor>(
  descriptors: readonly T[]
): PremiumRoutePartition<T> {
  const partition: PremiumRoutePartition<T> = { public: [], standalone: [], appShell: [] };
  for (const descriptor of descriptors) {
    if (descriptor.public) {
      const gated =
        descriptor.requireEntitlement !== undefined ||
        descriptor.requireFeatureTag !== undefined ||
        descriptor.fallbackPath !== undefined;
      if (gated) {
        throw new Error(
          `Premium route ${descriptor.path} is public and gated; a public route carries no requireEntitlement, requireFeatureTag or fallbackPath`
        );
      }
      if (descriptor.appShell) {
        throw new Error(
          `Premium route ${descriptor.path} is public and appShell; the app shell redirects signed-out visitors to login`
        );
      }
      partition.public.push(descriptor);
    } else if (descriptor.appShell) {
      partition.appShell.push(descriptor);
    } else {
      partition.standalone.push(descriptor);
    }
  }
  return partition;
}
