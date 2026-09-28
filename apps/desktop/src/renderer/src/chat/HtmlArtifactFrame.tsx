import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';

/** Must match ARTIFACT_SANDBOX_URL in main/chat/artifacts/sandboxProtocol.ts. */
const SANDBOX_URL = 'b4m-artifact://sandbox/';

/**
 * Everything the frame is allowed to do. `allow-scripts` alone, and the omissions are the point.
 *
 * Without `allow-same-origin` the document runs on an OPAQUE origin: it is cross-origin to this
 * renderer whatever it was served from, so it cannot touch `window.parent`'s document, read
 * anything off it, or reach `window.b4m` - the preload bridge is exposed on the renderer's own
 * window, which the frame has no access to. Adding `allow-same-origin` here would hand every
 * artifact the full bridge, and with it this app's filesystem and shell tools.
 *
 * `allow-popups`, `allow-modals`, `allow-top-navigation` and `allow-forms` are left out for the
 * smaller reasons: an artifact should not be able to open a window, block the app behind an
 * alert(), navigate the app out from under the user, or submit anywhere.
 */
const FRAME_SANDBOX = 'allow-scripts';

const FRAME_HEIGHT = 420;

/**
 * Render one HTML artifact in isolation.
 *
 * The frame loads this app's own `b4m-artifact:` scheme rather than being given the artifact in
 * a `srcdoc`: a srcdoc document inherits the embedding page's CSP, which here is
 * `script-src 'self'` and would stop the artifact's own inline scripts dead. A real navigation
 * to a served document gets that document's own policy instead, and main sets one that allows
 * inline script and style and nothing remote at all (see sandboxProtocol.ts).
 *
 * Content crosses by postMessage after the frame says it is ready, exactly as the web app's
 * HtmlArtifactViewer does: the frame cannot be handed the markup before it has a listener, and
 * an opaque origin cannot be named as a targetOrigin, hence '*'. Nothing is read back - the
 * parent only ever posts - so there is no channel from artifact to renderer to get wrong.
 */
export function HtmlArtifactFrame({ content, title }: { content: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);

    const onMessage = (event: MessageEvent) => {
      // Provenance is the window reference, not the origin: an opaque origin reports 'null',
      // which is not something to check against. No other window holds a handle to this frame.
      if (event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type !== 'artifact-sandbox-ready') return;
      frame.current?.contentWindow?.postMessage({ type: 'artifact-html', content }, '*');
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [content]);

  if (failed) {
    return (
      <Typography level="body-xs" textColor="text.tertiary" sx={{ p: 1.5 }} data-testid="chat-artifact-frame-error">
        This artifact could not be displayed. Its source is below.
      </Typography>
    );
  }

  return (
    <Box
      component="iframe"
      ref={frame}
      src={SANDBOX_URL}
      sandbox={FRAME_SANDBOX}
      title={title}
      onError={() => setFailed(true)}
      sx={{ display: 'block', width: '100%', height: FRAME_HEIGHT, border: 'none', bgcolor: 'common.white' }}
      data-testid="chat-artifact-frame"
    />
  );
}
