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
   * STRUCTURAL field, like `appShell`. `true` -> the route renders for signed-out
   * visitors: parented under the root route with no `RestrictedPage`, no
   * `ProviderBundle` and no consent guard, the way `/login` and `/verify-email`
   * are. The page carries its own authorization (a capability in the URL) and
   * must set none of `appShell`, `requireEntitlement`, `requireFeatureTag` or
   * `fallbackPath`; `partitionPremiumRoutes` throws on that combination.
   */
  public?: boolean;
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

/**
 * A premium overlay's crawler policy for the routes it contributes, consumed by
 * core's `app/robots.ts` and `app/sitemap.ts` via `premiumRouteIndexing.generated.ts`.
 *
 * Core cannot derive this. Which of an overlay's routes are publicly crawlable and
 * which sit behind a gate is the overlay's own knowledge, and core must not name an
 * overlay's surface in this repo. Contributed via `b4mContributions.routeIndexingExport`
 * (a module exporting `routeIndexing`), with the same annotate-both-forms rule as
 * routes/nav so the consumers typecheck identically with no overlay installed.
 *
 * DATA ONLY, and deliberately not the route descriptors: `PremiumRouteDescriptor`
 * carries `lazyImport` thunks, so deriving the policy from `premiumRoutes` would pull
 * the overlay's lazy component graph into a server-rendered route.
 *
 * Both fields are origin-relative paths beginning with `/`, restricted to characters
 * that cannot change the meaning of the file they land in. Next's metadata serializer
 * does no escaping, so `app/seo/crawlPolicy.ts` drops anything else rather than trust
 * it into a served file - a newline would emit extra robots.txt directives, and a bare
 * `&` would make the sitemap XML unparseable.
 */
export interface PremiumRouteIndexing {
  /**
   * Paths safe to publish in the sitemap. Concrete URLs only: a router param segment
   * is not a URL, so a parameterised route either stays out or is expanded by the
   * overlay itself. An overlay whose routes are gated or client-only contributes an
   * empty list - an indexed empty shell is a thin-content signal, and a sitemap full
   * of login redirects is worse than no sitemap.
   *
   * A path covered by ANY `disallowPaths` prefix - this overlay's, another overlay's,
   * or core's - is dropped rather than advertised, because robots.txt is one file for
   * the whole origin. There is deliberately no `allowPaths` sibling to order against a
   * broader disallow: expressing that correctly needs longest-match reasoning across
   * every contributor, so the contract makes the conflict impossible instead of
   * letting an overlay publish a sitemap entry its own robots.txt forbids.
   */
  sitemapPaths: string[];
  /**
   * `Disallow:` patterns for everything else the overlay owns. A trailing `/` makes
   * the entry a subtree prefix, which is how a parameterised route is expressed
   * (robots.txt has no notion of a router param).
   *
   * Never list a path whose URL is itself a capability (a share or invite token). A
   * crawler blocked from fetching such a page never reads the `noindex` it was blocked
   * from seeing, and can still index the URL from a link elsewhere - so a disallow
   * makes a leaked link MORE exposed. Serve those a per-response `X-Robots-Tag`
   * instead, the way the core share surfaces do.
   */
  disallowPaths: string[];
}

/**
 * localStorage key prefixes a premium overlay owns, contributed as literal data in
 * `b4mContributions.localStorageKeyPrefixes` and swept by `clearClientCaches()` on
 * every identity change.
 *
 * Core clears a fixed allowlist of its own keys; it cannot name an overlay's keys
 * without naming the overlay's surface in the open-core repo. A prefix is the
 * narrowest thing an overlay can declare that stays generic here and still lets
 * core clear per-identity keys it has never heard of (`<prefix><userId>` and
 * friends). Matching is `startsWith`, so declare the longest prefix that still
 * covers every key you own.
 *
 * Unlike every other contribution, this one is DATA, not a module specifier: core
 * reads it straight out of package.json and never imports overlay code for it. That
 * is the whole point - the sweep has to work in a tab that never loaded the
 * overlay's routes, which is exactly the tab a lazily-loaded contribution misses.
 * It also means the glue needs no node_modules link (see the generator's grouping).
 *
 * Declaring a prefix here is a promise that core may delete those keys at any
 * identity change. Never declare one that also matches a core key.
 */
export type PremiumLocalStorageKeyPrefixes = string[];

/** What core hands a reply accessory about the reply it sits under. */
export interface PremiumReplyAccessoryProps {
  /** The reply's quest id - the same key the UI side-effect bus dispatches as `dedupeKey`. */
  questId: string;
  sessionId: string;
}

/**
 * A premium component rendered at the foot of a completed assistant reply, above the
 * suggested-navigation block. Contributed via `b4mContributions.replyAccessoryExport`
 * (a module default-exporting the component) and consumed by `PromptReplies` through
 * the generated `premiumReplyAccessories.generated.ts`.
 *
 * Every reply renders every contributor, so an accessory must return `null` for a
 * reply it has nothing to say about - which is nearly all of them - and must not
 * fetch per reply to find that out. Same annotate-both-forms rule as routes/nav: the
 * absent (open-core fork) form is an empty array.
 */
export type PremiumReplyAccessory = ComponentType<PremiumReplyAccessoryProps>;
