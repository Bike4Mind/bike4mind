import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProductionDetail,
  ProductionMedia,
  ProductionsApi,
  ProductionsErrorKind,
  ProductionsResult,
  ProductionSummary,
} from '@shared/productions';
import { describeLibraryError } from '../../library/useLibraryFeed';
import { MEDIA_RETRY } from './renderPolling';

export type ProductionsError = { kind: ProductionsErrorKind; message: string };

/** An IPC call as a result: a rejected invoke (a request the main side refused to parse) becomes `failed`. */
async function call<T>(send: () => Promise<ProductionsResult<T>>): Promise<ProductionsResult<T>> {
  try {
    return await send();
  } catch (error) {
    return { ok: false, error: { kind: 'failed', message: describeLibraryError(error) } };
  }
}

/**
 * The production list. Loads the first page once per account; later pages only on `loadMore`, so
 * nothing here fetches in a loop.
 */
export function useProductionList(api: Pick<ProductionsApi, 'list'>, accountKey: string) {
  const [items, setItems] = useState<ProductionSummary[]>([]);
  const [nextSkip, setNextSkip] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProductionsError | null>(null);
  const [run, setRun] = useState(0);
  // Bumped by an account change or refresh, so a page from before it is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setItems([]);
    setNextSkip(null);
    setError(null);
    setLoading(true);
    void call(() => api.list({})).then(result => {
      if (current !== generation.current) return;
      if (result.ok) {
        setItems(result.value.items);
        setNextSkip(result.value.nextSkip);
      } else setError(result.error);
      setLoading(false);
    });
  }, [api, accountKey, run]);

  const loadMore = useCallback(async () => {
    if (nextSkip === null || loading) return;
    const current = generation.current;
    setLoading(true);
    const result = await call(() => api.list({ skip: nextSkip }));
    if (current !== generation.current) return;
    if (result.ok) {
      setItems(previous => [...previous, ...result.value.items]);
      setNextSkip(result.value.nextSkip);
    } else setError(result.error);
    setLoading(false);
  }, [api, nextSkip, loading]);

  /** Patch one row in place after an edit in the editor, so going back shows it without a reload. */
  const update = useCallback((summary: ProductionSummary) => {
    setItems(previous => previous.map(item => (item.id === summary.id ? summary : item)));
  }, []);

  return { items, loading, error, hasMore: nextSkip !== null, loadMore, refresh: () => setRun(v => v + 1), update };
}

/** One production, with rename and reorder; each edit answers with the saved production. */
export function useProduction(api: Pick<ProductionsApi, 'get' | 'rename' | 'reorder'>, id: string) {
  const [detail, setDetail] = useState<ProductionDetail | null>(null);
  const [error, setError] = useState<ProductionsError | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    void call(() => api.get({ id })).then(result => {
      if (!live) return;
      if (result.ok) setDetail(result.value);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [api, id, run]);

  const save = useCallback(async (send: () => Promise<ProductionsResult<ProductionDetail>>) => {
    setSaving(true);
    setSaveError(null);
    const result = await call(send);
    if (result.ok) setDetail(result.value);
    else setSaveError(result.error.message);
    setSaving(false);
    return result.ok ? result.value : null;
  }, []);

  const rename = useCallback((title: string) => save(() => api.rename({ id, title })), [api, id, save]);
  const reorder = useCallback(
    (trackId: string, clipIds: string[]) => save(() => api.reorder({ id, trackId, clipIds })),
    [api, id, save]
  );

  return { detail, error, saving, saveError, rename, reorder, reload: () => setRun(v => v + 1) };
}

export type RenderMediaState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; media: ProductionMedia }
  | { status: 'error'; message: string };

/**
 * A finished render's local copy, fetched when `fileId` is set. A `not-ready` answer (the file is
 * still being saved) is retried every MEDIA_RETRY.delayMs, at most MEDIA_RETRY.maxAttempts times.
 */
export function useRenderMedia(api: Pick<ProductionsApi, 'media'>, fileId: string | null) {
  const [state, setState] = useState<RenderMediaState>({ status: 'idle' });
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (!fileId) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (count: number) => {
      const result = await call(() => api.media({ fileId }));
      if (!live) return;
      if (result.ok) return setState({ status: 'ready', media: result.value });
      if (result.error.kind === 'not-ready' && count + 1 < MEDIA_RETRY.maxAttempts) {
        timer = setTimeout(() => void attempt(count + 1), MEDIA_RETRY.delayMs);
        return;
      }
      setState({ status: 'error', message: result.error.message });
    };
    setState({ status: 'loading' });
    void attempt(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, fileId, run]);
  return { ...state, retry: () => setRun(v => v + 1) };
}
