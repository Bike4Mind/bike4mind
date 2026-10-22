import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS,
  WEBHOOK_DELIVERY_ID_PARAM,
  webhookAuditLogsViewFromSearch,
  webhookAuditLogsViewToSearch,
  type WebhookAuditLogsView,
} from './webhookAuditLogsTabSearch';

type SearchRecord = Record<string, unknown>;

// ms of typing idle before the repository filter is written to the URL (and so queried).
export const REPO_FILTER_URL_DEBOUNCE_MS = 250;

/**
 * The Webhook Audit Logs tab's filters and open delivery, owned by the URL. Writes use `replace`
 * and are computed from the URL at write time. The repository box keeps local state (a router-bound
 * input lags a navigation behind each keystroke) and writes back once typing pauses, the same as
 * useAdminSettingsSearchParams. Leaving the tab needs no cleanup: the tab-sync rebuild in
 * useAdminTabUrlSync drops these keys through the param registry; unmount cancels a pending write.
 */
export const useWebhookAuditLogsSearch = () => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const view = useMemo(() => webhookAuditLogsViewFromSearch(search), [search]);
  const deliveryId = WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS[WEBHOOK_DELIVERY_ID_PARAM](search[WEBHOOK_DELIVERY_ID_PARAM]);

  const writeSearch = useCallback(
    (update: (previous: SearchRecord) => SearchRecord) => {
      navigate({
        to: '/admin',
        search: (previous: SearchRecord) => ({ ...previous, ...update(previous) }),
        replace: true,
      });
    },
    [navigate]
  );

  const writeView = useCallback(
    (patch: Partial<WebhookAuditLogsView>) =>
      writeSearch(previous => webhookAuditLogsViewToSearch({ ...webhookAuditLogsViewFromSearch(previous), ...patch })),
    [writeSearch]
  );

  const [repoInput, setRepoInputState] = useState(view.repository);
  // The last repository this hook pushed to the URL, so its own echo does not re-seed the box.
  const writtenRepoRef = useRef(view.repository);
  const pendingRepoWriteRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Follow a repository that changed from outside while the tab stayed mounted (back/forward):
  // the box and the URL must not disagree.
  useEffect(() => {
    if (view.repository === writtenRepoRef.current) return;
    clearTimeout(pendingRepoWriteRef.current);
    writtenRepoRef.current = view.repository;
    setRepoInputState(view.repository);
  }, [view.repository]);

  useEffect(() => () => clearTimeout(pendingRepoWriteRef.current), []);

  // A repository in the patch (a chip, "Clear all") supersedes any typing still waiting to be
  // written; the effect above cannot catch that when the URL value does not change.
  const updateView = useCallback(
    (patch: Partial<WebhookAuditLogsView>) => {
      if (patch.repository !== undefined) {
        clearTimeout(pendingRepoWriteRef.current);
        writtenRepoRef.current = patch.repository.trim();
        setRepoInputState(patch.repository);
      }
      writeView(patch);
    },
    [writeView]
  );

  const setRepoInput = useCallback(
    (repository: string) => {
      setRepoInputState(repository);
      clearTimeout(pendingRepoWriteRef.current);
      pendingRepoWriteRef.current = setTimeout(() => {
        // What the URL will hold once parsed, so the echo check above matches a trimmed value.
        writtenRepoRef.current = repository.trim();
        writeView({ repository });
      }, REPO_FILTER_URL_DEBOUNCE_MS);
    },
    [writeView]
  );

  const openDelivery = useCallback(
    (id: string) => writeSearch(() => ({ [WEBHOOK_DELIVERY_ID_PARAM]: id })),
    [writeSearch]
  );

  const closeDelivery = useCallback(
    () => writeSearch(() => ({ [WEBHOOK_DELIVERY_ID_PARAM]: undefined })),
    [writeSearch]
  );

  return { view, updateView, repoInput, setRepoInput, deliveryId, openDelivery, closeDelivery };
};
