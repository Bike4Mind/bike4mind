import { useEffect, useRef, useState, type RefObject } from 'react';
import { useExperimentalFeatureSettings } from '@client/app/hooks/data/settings';

/**
 * Parent-side handshake for rendering a React artifact in the /api/react-artifact-sandbox
 * iframe. Shared by both surfaces (in-chat InlineArtifactPreview + full-panel
 * ReactArtifactViewer) so the postMessage contract lives in exactly one place and the two
 * cannot drift.
 *
 * Model (mirrors the proven HtmlArtifactViewer): the iframe is REMOUNTED via `iframeKey`
 * whenever the code/deps change - React artifacts already full-reload on each debounced
 * edit today, so this is no UX regression and avoids warm-iframe React-root teardown.
 * On each (re)mount the sandbox posts `react-sandbox-ready`; we reply with the latest
 * `{ code, dependencies, mode }`. The payload is buffered in a ref so a ready signal that
 * fires before the effect re-runs still gets the current code (post-before-ready race).
 * `mode` is 'inert' (inline-script execution, no eval) when the EnableInertArtifactRender
 * flag is on, else 'eval' (Function constructor).
 *
 * `event.source === iframeRef.current?.contentWindow` scopes messages to THIS iframe, so
 * two concurrently-mounted viewers never cross-talk (works without allow-same-origin).
 */
export const REACT_ARTIFACT_SANDBOX_SRC = '/api/react-artifact-sandbox';

interface UseReactArtifactSandboxResult {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Remount key - bump forces a fresh sandbox load when code/deps change. */
  iframeKey: number;
  /** The route URL to set as the iframe `src`. */
  src: string;
  /** True from a content change until the code has been posted to a ready sandbox. */
  isLoading: boolean;
  /** Runtime/transform error reported back from inside the sandbox, if any. */
  error: string | null;
}

export function useReactArtifactSandbox(
  code: string | null | undefined,
  dependencies: string[] = []
): UseReactArtifactSandboxResult {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const payloadRef = useRef<{ code: string; dependencies: string[]; mode: 'inert' | 'eval' } | null>(null);

  const depsKey = dependencies.join(',');

  // Flag: when on, execute via injected inline <script> ('unsafe-inline') instead
  // of new Function() ('unsafe-eval'). Defaults off -> today's eval path, byte-identical.
  const { data: experimentalSettings } = useExperimentalFeatureSettings();
  const inertMode =
    experimentalSettings?.find(s => s.settingName === 'EnableInertArtifactRender')?.settingValue === 'true';

  // On content change: buffer the payload and remount the iframe for a fresh render.
  // When there's no code to render (disabled / mid-edit-invalid), clear loading so the
  // surface doesn't hang on a spinner over a blank sandbox.
  useEffect(() => {
    if (code == null) {
      payloadRef.current = null;
      setIsLoading(false);
      return;
    }
    payloadRef.current = { code, dependencies, mode: inertMode ? 'inert' : 'eval' };
    setError(null);
    setIsLoading(true);
    setIframeKey(k => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, depsKey, inertMode]);

  // Single message listener for the lifetime of the component: deliver code on ready,
  // surface sandbox errors. Scoped to this iframe via event.source.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'react-sandbox-ready') {
        if (!payloadRef.current) return;
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'react-artifact-render',
            code: payloadRef.current.code,
            dependencies: payloadRef.current.dependencies,
            mode: payloadRef.current.mode,
          },
          '*'
        );
        setIsLoading(false);
      } else if (data.type === 'react-sandbox-error') {
        setError(typeof data.message === 'string' && data.message ? data.message : 'Error rendering component');
        // The sandbox has rendered its error inline - clear loading so the overlay doesn't hang.
        setIsLoading(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return { iframeRef, iframeKey, src: REACT_ARTIFACT_SANDBOX_SRC, isLoading, error };
}
