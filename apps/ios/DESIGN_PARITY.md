# iOS design parity with the web app

The web app (`apps/client`, MUI Joy) is the design reference. iOS keeps native navigation, sheets and
haptics, and matches the web's colors, radii, type and the shape of each chat element.

Colors, spacing, radii and the type ramp are generated from `packages/design-tokens` into
`Packages/B4MKit/Sources/B4MKit/Theme/Generated/BrandTokens.swift` and both `AccentColor` sets
(`make generate-tokens`). The design-tokens tests fail when the committed files drift. Each color role
in `packages/design-tokens/src/emitters/native/nativeTheme.ts` names the web token it mirrors.

Web paths below are relative to `apps/client/app/`.

## Global

| Element | Web source | iOS |
|---|---|---|
| Font | Libre Franklin, variable (`layout.tsx`, tokens `typography.fontFamily`) | Bundled `LibreFranklin.ttf` (OFL, licence alongside), scaled with Dynamic Type via `relativeTo:` |
| Radii | xs 2, sm 6, md 8, lg 12, xl 16 (tokens `radii`) | `BrandTokens.Radius`; replaces the iOS-only 12/16/18 |
| Spacing | 8px unit (tokens `spacing.unit`) | `BrandTokens.Spacing` xs 4 ... xxl 48 |
| Body ink | `text.primary` | `textPrimary` |

## Assistant reply

Web: `components/Session/PromptReplies.tsx` (root ~L1578, body ~L1688). A full-width, unframed block: no
fill, no border, no avatar (agents get a small name chip only). Markdown in `.b4m-md`
(`components/Session/markdown/observatory.css`): body 16px, line height 1.68, ink `reading.ink2`
(text.primary at 85%), paragraph gap ~1em.

iOS: full width, no bubble, `readingInk`, 16pt body with matching line spacing. Agent avatars stay out.

## User message

Web: `components/Session/UserPrompt.tsx` (L308-363, bubble L238-259). Right-aligned bubble, max 78% of
the column, radius 8 (md), padding 12 x 16, fill `#F4F7F9` light / `background.panel` dark, 1px
`border.soft`, ink `text.primary`, 16px.

iOS: same, `promptBubble` fill, `borderSoft` edge, radius md. The old accent-tinted `userBubble` has no
web equivalent and is removed.

## Composer

Web: `components/Session/SessionBottom/SessionBottom.tsx` (L676-712), editor styles `globals.css` L52-81,
send button `SessionToolbar.tsx` L352-376. (The radius-50 pills in `WorkBench.tsx` L468/L533 are attached
file chips, not the input.) At phone width the composer is a full-width bar: `background.panel` fill, 1px
`border.solid` top edge only, radius 0, 12px padding. Input 16px Libre Franklin, placeholder "Type your
message here..." in `chatbox.messageInputColor` at 75% opacity. Send: solid primary, 32x32, radius sm (6).

iOS: the same bar (`panel` fill, `borderSolid` top hairline), a 32pt `sendButton` square at radius sm.

## Drawer / sidebar rows

Web: `components/Session/SidenavItem.tsx` (L741-803), row style
`components/layouts/Notebook/Sidenav/kit/styles.ts` L62-84, metrics `kit/metrics.ts`, colors
`utils/themes/components/sidenav.ts` and `notebooklist.ts`. Rows min 36px, padding 6 x 12, radius 8,
title `body-xs`-`body-sm`, single line. Selected: `notebooklist` focused background plus a 2px accent bar
on the left. Backdrop `gray[50]` light / `gray[850]` dark.

iOS: `sidebar` backdrop, `sidebarText` rows at radius md, `sidebarSelected` plus a 2pt accent bar for the
open conversation. Touch targets stay at 44pt.

## Code blocks

Web: `components/Session/CodeBlockHeader.tsx` L23-75 (frame), `components/common/HighlightedCode.tsx`
L19-25 (code panel), `markdown/syntaxTheme.ts` (mono stack, line height 1.55). Frame: radius 8, 1px
`reading.cardLine`, padding 16, language label in `text.tertiary` mono xs, copy button top right. Code
panel: `reading.surface`, radius 6, padding 12.

iOS: `codeSurface` panel at radius sm inside a `codeFrame` hairline at radius md, language label and copy
button above; monospaced system font (JetBrains Mono is not bundled).

## Empty home state

Web: `components/Session/NotebookSplash.tsx` (L735-845), greeting `formatGreeting.ts`. Centered column,
48px logo on mobile, greeting "Good morning, <FirstName>" at `h3` (24px) weight 500 in `text.primary`.

iOS: centered logo and a time-of-day greeting at 24pt medium Libre Franklin above the composer.
