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
   * STRUCTURAL field, meaningful only with `appShell: true`. `true` -> the notebook
   * layout drops its content padding on this route (and its sub-paths) so the page
   * runs edge to edge; every other route keeps the default gutter. Read by
   * `getContentPadding` in components/layouts/Notebook/index.tsx.
   */
  edgeToEdge?: boolean;
  /**
   * STRUCTURAL field, meaningful only with `appShell: true`. A registered workspace id (see
   * `WORKSPACE_SURFACES` in @bike4mind/common): the notebook sidebar on this route draws that
   * workspace's conversation list - the `notebookSidenavExport` component - in place of the default
   * notebook list, as it does on the workspace's own route. Omitted -> the default list. An id this
   * repo does not register is inert. Matched against the route's `path`, where a `$param` segment
   * stands for any one segment. `partitionPremiumRoutes` throws when it is set without `appShell`,
   * since only the notebook layout has a sidebar to draw the list in.
   */
  hostsWorkspace?: string;
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
  /**
   * `true` -> also render the item as a row in the primary notebook sidebar (SidenavNav), under the
   * same visibility rule. Omitted -> the "More" flyout only. Use for a product's main launch point.
   */
  sidebar?: boolean;
}

/**
 * A premium package's full-surface notebook sidenav - a component that REPLACES
 * the default notebook sidenav body on its workspace's own route, and on any app-shell
 * route that declares `hostsWorkspace` (see `hostedWorkspaceAt`). Contributed via
 * `b4mContributions.notebookSidenavExport` (a module default-exporting the component)
 * and consumed by the Notebook layout's `Sidenav` through the generated
 * `premiumNotebookSidenav.generated.ts`.
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

/**
 * Extra entitlements, per registered workspace id, whose holders may fork, snip or clone a session
 * that lives in that workspace and keep the copy there. Contributed as literal data in
 * `b4mContributions.workspaceCopyEntitlements` (`{ "<surface id>": ["<entitlement key>"] }`) and
 * enforced by `canCopyWithinSurface` (@bike4mind/common surfaces.ts) on the server and in the
 * clone/fork menus alike.
 *
 * Core cannot hold this table without naming an overlay's workspace, so the overlay declares it.
 * A grant only keeps a copy where its source already lives: creating a session in the workspace,
 * moving one into it, or naming it as an explicit copy target still needs the workspace's own
 * `requiredEntitlement`. An id this repo does not register as a workspace is inert.
 *
 * Every granted key must also pass the workspace's own route gate AND its API gates. A kept copy
 * carries the workspace's surface, so it leaves the main list; if those gates then turn its owner
 * away, the owner holds a session no list shows and no page opens. Core cannot see those gates, so
 * the overlay declares them alongside the grants, as data of the same shape, in
 * `b4mContributions.workspaceGateEntitlements`: every key the workspace's route and API gates admit
 * (the route descriptor's `requireEntitlement`, plus whatever an in-page or API check accepts).
 * Codegen fails the build when a package grants a key that its own gate declaration for that
 * workspace does not list. The declaration is the overlay's promise, so keep it in step with the
 * gates themselves; widening the gates and declaring a grant belong in the same change.
 *
 * DATA, like `PremiumLocalStorageKeyPrefixes`: read straight out of package.json, so server-side
 * enforcement sees it without importing overlay code. Grants from several overlays are merged.
 *
 * An entry may also be an object, `{ "key": "<entitlement key>", "label": "...", "sessionHref": "..." }`,
 * which grants `key` exactly as the bare string does and also says how the workspace is shown to a
 * user who reaches it only through that key (see `PremiumWorkspaceGrantDisplay`). This table keeps
 * only the keys; the display half lands in `premiumWorkspaceGrantDisplays.generated.ts`.
 */
export type PremiumWorkspaceCopyEntitlements = Readonly<Record<string, readonly string[]>>;

/**
 * How a workspace is named and opened for a user whose access to it comes through a copy grant: one
 * who holds `key` but cannot use the workspace outright (`canUseSurface` is false). Without it that
 * user sees the registry's label and link, which name a product they do not hold. Declared as the
 * object form of a `workspaceCopyEntitlements` entry; everyone else keeps the registry's values.
 */
export interface PremiumWorkspaceGrantDisplay {
  /** The granted entitlement key, lowercased. */
  key: string;
  /** Name shown for the workspace in the clone/fork/move menus and dialogs, in place of the registry label. */
  label: string;
  /**
   * Same-origin path template with exactly one `{sessionId}` slot, e.g. `/route?session={sessionId}`,
   * that opens a session for this user. Its path (before `?`) also stands in for the registry's
   * `routePrefix` when checking the build ships the route. Omitted -> the registry's link.
   */
  sessionHref?: string;
}

/** Grant displays per registered workspace id, in declaration order; a user holding several gets the first. */
export type PremiumWorkspaceGrantDisplays = Readonly<Record<string, readonly PremiumWorkspaceGrantDisplay[]>>;

/**
 * Names shown for an overlay's LLM tools wherever a reply lists the tools it used (`getToolDisplayName`
 * in app/utils/toolMapping.ts), keyed by tool id. Contributed as literal data in
 * `b4mContributions.toolDisplayLabels` (`{ "<tool id>": "Label" }`), like the copy grants above, so the
 * labels reach the client without importing overlay code. A core tool keeps its own name; a tool with
 * no label from either gets a humanized form of its id. Two overlays naming one tool differently fail
 * the build.
 */
export type PremiumToolDisplayLabels = Readonly<Record<string, string>>;

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
