import { useState } from 'react';
import {
  Alert,
  Box,
  Dropdown,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminModelRow, PerMTokRate } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ADMIN_MODELS_QUERY_KEY } from '@client/app/hooks/data/adminModels';
import {
  ActionDialog,
  ChangePreview,
  DataTable,
  EmptyState,
  MissingPermissionState,
  UpdatingBar,
  useMissingAdminPermission,
  type DataColumn,
} from '../../shared';
import { adminFocus } from '../../shared/adminStyles';
import { SuccessorCostChip, SuccessorCostPanel } from '../../SuccessorCostDelta';
import { ModelWriteAction } from '../ModelWriteAction';
import { useModelsNavigation } from '../modelsNavigation';
import {
  LIFECYCLE_STATUS_PATH,
  LIFECYCLE_STATUS_QUERY_KEY,
  apiCodeOf,
  apiErrorMessage,
  apiStatusOf,
  useLifecycleStatus,
  type LifecycleQueueItem,
  type LifecycleStatus,
} from './discoveryApi';
import { lifecycleWord } from './discoveryCopy';
import { modelName, useModelIndex } from './useModelIndex';

const ACCEPT_REASONS = [
  'Provider announced the deprecation',
  'Confirmed in the provider docs',
  'Confirmed with the provider',
];
const DISMISS_REASONS = ['Provider signal is wrong', 'Model is still supported', 'Duplicate of another suggestion'];

type ModelIndex = ReadonlyMap<string, AdminModelRow> | undefined;

/**
 * The accept route's 409: the auto-remap clauses this successor missed. The one refusal an admin may overrule, so it
 * renders as a decision rather than as an error.
 */
const replacementBlockers = (error: unknown): string[] | null => {
  if (apiStatusOf(error) !== 409 || apiCodeOf(error) !== 'replacement-blocked') return null;
  const details = (error as { response?: { data?: { details?: unknown } } }).response?.data?.details;
  return Array.isArray(details) && details.length > 0 ? details.map(String) : ['the automation refused this successor'];
};

function ModelCell({ id, index, testId }: { id: string; index: ModelIndex; testId?: string }) {
  const name = modelName(index, id);
  return (
    <Stack sx={{ minWidth: 0 }} data-testid={testId}>
      <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
        {name}
      </Typography>
      {name !== id && (
        <Typography level="body-xs" fontFamily="code" noWrap sx={{ color: 'admin.inkMuted' }}>
          {id}
        </Typography>
      )}
    </Stack>
  );
}

const suggestedDates = (item: LifecycleQueueItem) =>
  [
    item.suggestion?.deprecationDate && `deprecates ${item.suggestion.deprecationDate}`,
    item.suggestion?.retirementDate && `retires ${item.suggestion.retirementDate}`,
  ]
    .filter(Boolean)
    .join(', ');

function suggestionColumns(index: ModelIndex, rates: Record<string, PerMTokRate>): DataColumn<LifecycleQueueItem>[] {
  return [
    {
      id: 'model',
      label: 'Model',
      render: item => <ModelCell id={item.modelId} index={index} />,
      sortValue: item => modelName(index, item.modelId),
    },
    {
      id: 'suggested',
      label: 'Suggested',
      width: '13rem',
      render: item => (
        <Stack>
          <Typography level="body-sm">{lifecycleWord(item.suggestion?.status)}</Typography>
          {suggestedDates(item) && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {suggestedDates(item)}
            </Typography>
          )}
        </Stack>
      ),
    },
    {
      id: 'successor',
      label: 'Successor',
      render: item => {
        const successor = item.suggestion?.replacedBy;
        if (!successor) return <Box sx={{ color: 'admin.inkMuted' }}>-</Box>;
        return (
          <Stack gap={0.25} sx={{ minWidth: 0 }}>
            <ModelCell id={successor} index={index} testId={`discovery-suggestion-successor-${item.modelId}`} />
            <Box>
              <SuccessorCostChip modelId={item.modelId} successorId={successor} rates={rates} />
            </Box>
          </Stack>
        );
      },
    },
    {
      id: 'source',
      label: 'Source',
      width: '10rem',
      render: item => (
        <Stack>
          <Typography level="body-sm">{item.suggestion?.source ?? 'unknown'}</Typography>
          {item.suggestion?.suggestedAt && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {new Date(item.suggestion.suggestedAt).toLocaleDateString()}
            </Typography>
          )}
        </Stack>
      ),
    },
  ];
}

function SuggestionMenu({
  item,
  name,
  onAccept,
  onDismiss,
}: {
  item: LifecycleQueueItem;
  name: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <ModelWriteAction>
      {disabled => (
        <Dropdown>
          <MenuButton
            disabled={disabled}
            slots={{ root: IconButton }}
            slotProps={{
              root: {
                size: 'sm',
                variant: 'plain',
                'aria-label': `Decide the suggestion for ${name}`,
                sx: { ...adminFocus, color: 'admin.inkMuted' },
              },
            }}
            data-testid={`discovery-suggestion-actions-${item.modelId}`}
          >
            <MoreHorizIcon sx={{ fontSize: 18 }} />
          </MenuButton>
          <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
            <MenuItem onClick={onAccept} data-testid={`discovery-suggestion-accept-${item.modelId}`}>
              Accept change
            </MenuItem>
            <MenuItem onClick={onDismiss} data-testid={`discovery-suggestion-dismiss-${item.modelId}`}>
              Dismiss suggestion
            </MenuItem>
          </Menu>
        </Dropdown>
      )}
    </ModelWriteAction>
  );
}

function AcceptSuggestionDialog({
  item,
  index,
  rates,
  onClose,
  onAccepted,
}: {
  item: LifecycleQueueItem;
  index: ModelIndex;
  rates: Record<string, PerMTokRate>;
  onClose: () => void;
  onAccepted: (status: string) => void;
}) {
  const [replacedBy, setReplacedBy] = useState(item.suggestion?.replacedBy ?? '');
  // Set only by a 409: the clauses the chosen successor missed, held until it is overruled or changed.
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const name = modelName(index, item.modelId);
  const status = item.suggestion?.status ?? 'deprecated';
  const successor = replacedBy.trim();
  const successorRow = successor ? index?.get(successor) : undefined;
  const dates = [
    item.suggestion?.deprecationDate && `Deprecation ${item.suggestion.deprecationDate}`,
    item.suggestion?.retirementDate && `retirement ${item.suggestion.retirementDate}`,
  ]
    .filter(Boolean)
    .join(', ');

  const accept = async (reason: string) => {
    setFailure(null);
    try {
      await api.post(LIFECYCLE_STATUS_PATH, {
        modelId: item.modelId,
        action: 'accept',
        note: reason,
        ...(successor ? { replacedBy: successor } : {}),
        ...(blockers ? { acknowledgeBlockers: true } : {}),
      });
    } catch (error) {
      const refused = replacementBlockers(error);
      if (refused) setBlockers(refused);
      else setFailure(apiErrorMessage(error, 'Accept failed'));
      throw error;
    }
    onAccepted(status);
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Accept lifecycle change"
      description={`Records ${name} as ${lifecycleWord(status).toLowerCase()}, effective now. It drops out of pickers once its deprecation date passes.`}
      reasonPresets={ACCEPT_REASONS}
      confirmLabel={blockers ? 'Accept anyway' : `Mark as ${lifecycleWord(status).toLowerCase()}`}
      onConfirm={accept}
      data-testid="discovery-accept-dialog"
    >
      <Stack gap={1.5}>
        <ChangePreview
          before={lifecycleWord(index?.get(item.modelId)?.lifecycle.status ?? 'active')}
          after={lifecycleWord(status)}
          data-testid="discovery-accept-preview"
        />
        {dates && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            {dates}
          </Typography>
        )}
        {item.suggestion?.detail && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-accept-detail">
            {item.suggestion.detail}
          </Typography>
        )}
        {failure && (
          <Alert color="danger" size="sm" data-testid="discovery-accept-error">
            {failure}
          </Alert>
        )}
        {blockers && (
          <Alert color="warning" size="sm" data-testid="discovery-accept-blockers">
            <Box>
              <Typography level="body-sm">
                Discovery would not apply {successor ? modelName(index, successor) : 'this successor'} on its own:
              </Typography>
              <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
                {blockers.map(blocker => (
                  <li key={blocker}>
                    <Typography level="body-sm">{blocker}</Typography>
                  </li>
                ))}
              </Box>
              <Typography level="body-sm">
                Accepting anyway records the override and these reasons in its note.
              </Typography>
            </Box>
          </Alert>
        )}
        <FormControl>
          <FormLabel>Successor</FormLabel>
          <Input
            size="sm"
            value={replacedBy}
            onChange={event => {
              // The held blockers describe the previous successor.
              setBlockers(null);
              setReplacedBy(event.target.value);
            }}
            slotProps={{ input: { 'data-testid': 'discovery-accept-successor-input' } }}
          />
          <FormHelperText data-testid="discovery-accept-successor-name">
            {!successor
              ? 'No successor: users of this model are not moved.'
              : successorRow
                ? successorRow.name
                : 'Not a model this console knows yet.'}
          </FormHelperText>
        </FormControl>
        {/* Priced against what is typed: the override is the decision that needs the number. */}
        <SuccessorCostPanel modelId={item.modelId} successorId={successor} rates={rates} />
      </Stack>
    </ActionDialog>
  );
}

function DismissSuggestionDialog({
  item,
  index,
  onClose,
  onDismissed,
}: {
  item: LifecycleQueueItem;
  index: ModelIndex;
  onClose: () => void;
  onDismissed: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const name = modelName(index, item.modelId);

  const dismiss = async (reason: string) => {
    setFailure(null);
    try {
      await api.post(LIFECYCLE_STATUS_PATH, { modelId: item.modelId, action: 'dismiss', note: reason });
    } catch (error) {
      setFailure(apiErrorMessage(error, 'Dismiss failed'));
      throw error;
    }
    onDismissed();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Dismiss suggestion"
      description={`Dismisses the suggestion for ${name} for good: it cannot be settled again, and discovery does not raise it again while the provider's signal is unchanged. There is no undo.`}
      reasonPresets={DISMISS_REASONS}
      // The route takes the note but does not record it for a dismiss.
      reasonAudited={false}
      confirmLabel="Dismiss suggestion"
      tone="danger"
      onConfirm={dismiss}
      data-testid="discovery-dismiss-dialog"
    >
      {failure && (
        <Alert color="danger" size="sm" data-testid="discovery-dismiss-error">
          {failure}
        </Alert>
      )}
    </ActionDialog>
  );
}

/**
 * The lifecycle suggestion queue (pendingSuggestions of GET /api/admin/model-deprecation-status) with Accept and
 * Dismiss, until each model's Lifecycle tab carries it (docs/admin-models-spec.md section 5.3).
 */
export function LifecycleSuggestions() {
  const queryClient = useQueryClient();
  const missing = useMissingAdminPermission('settings:manage');
  const lifecycle = useLifecycleStatus(!missing);
  const index = useModelIndex().data;
  const { openModel } = useModelsNavigation();
  const [accepting, setAccepting] = useState<LifecycleQueueItem | null>(null);
  const [dismissing, setDismissing] = useState<LifecycleQueueItem | null>(null);
  const queue = lifecycle.data?.queue ?? [];
  const rates = lifecycle.data?.perMTokRates ?? {};

  // Settled locally: a refetch would ask every provider again for the reference report the same GET carries.
  const settle = (modelId: string, message: string) => {
    queryClient.setQueryData<LifecycleStatus>(LIFECYCLE_STATUS_QUERY_KEY, current =>
      current ? { ...current, queue: current.queue.filter(item => item.modelId !== modelId) } : current
    );
    void queryClient.invalidateQueries({ queryKey: ADMIN_MODELS_QUERY_KEY });
    toast.success(message);
  };

  return (
    <Stack component="section" gap={1} data-testid="discovery-suggestions">
      <Box>
        <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
          Lifecycle suggestions
        </Typography>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
          Models a provider marked deprecated or retired. Accept to record it, or dismiss it.
        </Typography>
      </Box>
      {missing ? (
        <MissingPermissionState requirement="settings:manage" />
      ) : (
        <>
          <UpdatingBar active={lifecycle.isFetching && !lifecycle.isLoading} testId="discovery-suggestions-updating" />
          <DataTable
            label="Lifecycle suggestions"
            testId="discovery-suggestions-table"
            rows={queue}
            columns={suggestionColumns(index, rates)}
            getRowId={item => item.modelId}
            loading={lifecycle.isLoading}
            error={
              lifecycle.isError && !lifecycle.data
                ? apiErrorMessage(lifecycle.error, 'Could not load lifecycle suggestions')
                : undefined
            }
            onRetry={() => void lifecycle.refetch()}
            onRowActivate={item => void openModel(item.modelId)}
            rowTestId={item => `discovery-suggestion-row-${item.modelId}`}
            rowActions={item => (
              <SuggestionMenu
                item={item}
                name={modelName(index, item.modelId)}
                onAccept={() => setAccepting(item)}
                onDismiss={() => setDismissing(item)}
              />
            )}
            pagination={queue.length > 25 ? undefined : false}
            empty={
              <Box data-testid="discovery-suggestions-empty">
                <EmptyState title="No lifecycle suggestions are waiting" action={null} />
              </Box>
            }
          />
        </>
      )}
      {accepting && (
        <AcceptSuggestionDialog
          key={accepting.modelId}
          item={accepting}
          index={index}
          rates={rates}
          onClose={() => setAccepting(null)}
          onAccepted={status => {
            setAccepting(null);
            settle(accepting.modelId, `Recorded ${modelName(index, accepting.modelId)} as ${status}.`);
          }}
        />
      )}
      {dismissing && (
        <DismissSuggestionDialog
          key={dismissing.modelId}
          item={dismissing}
          index={index}
          onClose={() => setDismissing(null)}
          onDismissed={() => {
            setDismissing(null);
            settle(dismissing.modelId, `Dismissed the suggestion for ${modelName(index, dismissing.modelId)}.`);
          }}
        />
      )}
    </Stack>
  );
}
