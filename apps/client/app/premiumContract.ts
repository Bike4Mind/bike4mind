import type { ComponentType } from 'react';

/**
 * Core-owned contract for premium overlay contributions (Open Core).
 *
 * apps/client owns these interfaces; premium packages conform to them via their
 * `spaRoutes` / `navItems` exports. Codegen annotates the generated arrays with
 * these types in BOTH the present and absent (empty) forms, so consumers such as
 * router.tsx typecheck identically whether or not a premium overlay is installed.
 * This keeps the open-core fork build (empty overlay, no premium package) green:
 * without the annotation the empty form falls back to `unknown[]`, which collapses
 * the route-tree types and cascades type errors into unrelated routes.
 *
 * The premium package's own descriptor type must be structurally assignable to
 * these interfaces (packages may also import them directly, type-only, via the
 * `@client/*` alias).
 */

/**
 * A premium SPA route. The gating fields are the serializable subset of
 * `RestrictedPage`'s gating props - any future gating field added here must map
 * 1:1 to a `RestrictedPage` prop (`requireAdmin` is deliberately excluded:
 * premium products gate on entitlements/tags, not admin status).
 */
export interface PremiumRouteDescriptor {
  path: string;
  lazyImport: () => Promise<{ default: ComponentType }>;
  /**
   * STRUCTURAL field (like `path`/`lazyImport`, NOT a gating prop - the
   * "gating fields map 1:1 to RestrictedPage" rule above does not apply to it).
   * Selects the route's parent in the SPA tree:
   *  - omitted / `false` (default) -> parented under the root route as a
   *    STANDALONE product surface with its own chrome.
   *  - `true` -> parented under the authenticated app-shell route, so the route
   *    renders INSIDE the notebook layout (sidebar/nav) and inherits the shell's
   *    `beforeLoad` (login redirect, forced-password-change, OAuth-return
   *    handling) and its `ProviderBundle`. Use for premium features that are a
   *    page/tab within the app rather than a standalone product.
   */
  appShell?: boolean;
  /**
   * Entitlement key gating the route (`RestrictedPage.requireEntitlement`).
   * Omitted -> no entitlement gate; with no other gate set the route is
   * login-only.
   */
  requireEntitlement?: string;
  /**
   * Feature tag gating the route (`RestrictedPage.requireFeatureTag`). When
   * both this and `requireEntitlement` are set, satisfying EITHER grants (OR).
   */
  requireFeatureTag?: string;
  /**
   * Where denied users are redirected (`RestrictedPage.fallbackPath`).
   * Omitted -> `/new`. Must point at an UNGATED route (e.g. the product's
   * upgrade/marketing page) - a gated fallback whose gate also denies would
   * ping-pong between the two pages.
   */
  fallbackPath?: string;
}

/**
 * A premium nav entry (e.g. a ProfileMenu row). Consumed by ProfileMenu's
 * "More" flyout, which renders `premiumNavItems.generated.ts` generically.
 *
 * The gating fields share names and OR-semantics with `PremiumRouteDescriptor`,
 * but nav visibility differs from route gating in two deliberate ways:
 * a denied item is HIDDEN (never redirected - the route's own gate handles
 * direct navigation), and there is NO admin/developer bypass (each access
 * gate keeps its own bypass set; launch points show only for actual holders).
 */
export interface PremiumNavDescriptor {
  /** SPA route path to navigate to (normally one of the package's contributed routes). */
  path: string;
  label: string;
  /** Stable `data-testid` for the rendered menu row. */
  testId?: string;
  /** Icon component; render at menu-row size (self-sized - the consumer renders it bare). */
  icon?: ComponentType;
  /** Show only when the user holds the server-resolved entitlement (no bypass). */
  requireEntitlement?: string;
  /** Show only when the user carries the tag; OR with `requireEntitlement` when both set. */
  requireFeatureTag?: string;
}

/**
 * A premium package's full-surface notebook sidenav - a component that REPLACES
 * the default notebook sidenav body on the package's own appShell route (e.g.
 * OptiHashi's `/opti` surface). Contributed via `b4mContributions.notebookSidenavExport`
 * (a module default-exporting the component) and consumed by the Notebook layout's
 * `Sidenav` through the generated `premiumNotebookSidenav.generated.ts`.
 *
 * `null` is the absent (open-core fork) form: the same annotate-both-forms rule as
 * routes/nav keeps the consumer's type stable whether or not an overlay is installed,
 * and - critically - the generated glue is the ONLY place the premium package specifier
 * appears, so core never statically imports an absent package (the fork build stays green).
 */
export type PremiumNotebookSidenav = ComponentType | null;
