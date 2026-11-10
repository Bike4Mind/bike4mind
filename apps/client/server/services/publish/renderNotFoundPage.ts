/**
 * Static page a browser gets for a published link that resolves to nothing: an unknown,
 * revoked or lapsed `/a/<token>`, a removed `/p/...` page, or an owner who can no longer
 * publish. It must read the same for every one of those cases so it never tells a visitor
 * (or a prober) which one it was, so it carries no per-request data at all.
 */
export function renderNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Link not available</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 28rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; opacity: 0.75; line-height: 1.5; }
</style>
</head>
<body>
<main data-testid="publish-not-found">
  <h1>This link is no longer available</h1>
  <p>It may have been turned off or removed, or the address may be incomplete. Ask the person who shared it for a new link.</p>
</main>
</body>
</html>`;
}
