import { useState, type ReactElement } from 'react';
import { Box, Button, Chip, Divider, Option, Select, Stack, Switch, Tooltip, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { isReadOnlyMcpConnectionTool, type IMcpConnectionPublic, type McpToolApprovalMode } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import {
  mcpConnectionErrorCode,
  mcpConnectionErrorMessage,
  mcpConnectionKeys,
  useUpdateMcpConnection,
  type McpConnectionScope,
} from '@client/app/hooks/data/mcpConnections';
import { initialToolDrafts, toReviewEntries, type ToolDraft } from './customMcpModel';

const APPROVAL_LABELS: Record<McpToolApprovalMode, string> = {
  default: 'Ask for writes',
  always_allow: 'Always allow',
  always_ask: 'Always ask',
};

const ALL_APPROVALS = Object.keys(APPROVAL_LABELS) as McpToolApprovalMode[];
// The server never asks before a read-only tool under `default`, so it reads as Always allow.
const READ_ONLY_APPROVALS: McpToolApprovalMode[] = ['always_allow', 'always_ask'];

/** A control the viewer may not use: disabled, with the reason on hover and focus. */
const Locked = ({ reason, children }: { reason: string | null | undefined; children: ReactElement }) =>
  reason ? (
    <Tooltip title={reason}>
      {/* A disabled control fires no pointer events, so the tooltip needs a focusable wrapper. */}
      <span tabIndex={0} aria-label={reason} data-testid="mcp-review-locked">
        {children}
      </span>
    </Tooltip>
  ) : (
    children
  );

/**
 * Review of one connection's tools: what each does (as the server describes it), read or write,
 * on or off, and when to ask before a call. Saving marks every listed tool reviewed; until then
 * a new or changed tool is not offered to the model. `readOnlyReason` shows the review with every
 * control disabled and that reason on each.
 */
const McpToolReview = ({
  connection,
  scope = 'user',
  readOnlyReason,
  onDone,
}: {
  connection: IMcpConnectionPublic;
  scope?: McpConnectionScope;
  readOnlyReason?: string | null;
  onDone: () => void;
}) => {
  const platform = scope === 'platform';
  // The tools as they were when the review opened. A refetch while it is open (Refresh tools, a background
  // update) must not swap in versions the user never saw: saving names these versions, so a change made
  // since fails with tool_version_conflict instead of being approved unseen.
  const [tools] = useState(() => connection.tools);
  const [drafts, setDrafts] = useState<Record<string, ToolDraft>>(() => initialToolDrafts(tools));
  const update = useUpdateMcpConnection(scope);
  const queryClient = useQueryClient();
  const testId = `custom-mcp-review-${connection.id}`;

  const setDraft = (name: string, patch: Partial<ToolDraft>) =>
    setDrafts(current => ({ ...current, [name]: { ...current[name]!, ...patch } }));

  const entries = toReviewEntries(tools, drafts);
  // A tool stored before versions were recorded cannot be reviewed until discovery runs again.
  const unversioned = tools.length - entries.length;

  const save = () =>
    update.mutate(
      { id: connection.id, tools: entries },
      {
        onSuccess: () => {
          toast.success('Tool review saved.');
          onDone();
        },
        onError: error => {
          const code = mcpConnectionErrorCode(error);
          if (code === 'tool_version_conflict' || code === 'unknown_tool') {
            toast.error('The server changed its tools while you were reviewing. Review them again.');
            void queryClient.invalidateQueries({ queryKey: mcpConnectionKeys.listFor(scope) });
            onDone();
            return;
          }
          toast.error(mcpConnectionErrorMessage(error, 'Could not save the review. Try again.'));
        },
      }
    );

  if (tools.length === 0) {
    return (
      <Typography level="body-sm" data-testid={`${testId}-empty`} sx={{ color: 'text.secondary' }}>
        This server lists no tools yet. Refresh the tools once it has some.
      </Typography>
    );
  }

  return (
    <Stack gap="12px" data-testid={testId}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        Descriptions come from the server and have not been reviewed by Bike4Mind. Read-only is the server&apos;s own
        claim.
      </Typography>
      <Stack divider={<Divider />} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px' }}>
        {tools.map(tool => {
          const draft = drafts[tool.name]!;
          const readOnly = isReadOnlyMcpConnectionTool(tool);
          const toolTestId = `${testId}-tool-${tool.name}`;
          const approvals = platform && readOnly ? READ_ONLY_APPROVALS : ALL_APPROVALS;
          const approvalShown = approvals.includes(draft.approval) ? draft.approval : 'always_allow';
          return (
            <Box key={tool.name} data-testid={toolTestId} sx={{ px: '12px', py: '10px' }}>
              <Stack direction="row" alignItems="center" gap="8px">
                <Typography level="body-sm" sx={{ fontWeight: 600, minWidth: 0, wordBreak: 'break-word', flex: 1 }}>
                  {tool.title || tool.name}
                </Typography>
                {tool.state === 'pending_review' && (
                  <Chip size="sm" variant="soft" color="warning" data-testid={`${toolTestId}-pending`}>
                    Needs review
                  </Chip>
                )}
                <Chip
                  size="sm"
                  variant="outlined"
                  color={readOnly ? 'neutral' : 'warning'}
                  data-testid={`${toolTestId}-kind`}
                >
                  {readOnly ? 'Read' : 'Write'}
                </Chip>
                <Locked reason={readOnlyReason}>
                  <Switch
                    size="sm"
                    checked={draft.enabled}
                    disabled={!tool.versionHash || !!readOnlyReason}
                    onChange={event => setDraft(tool.name, { enabled: event.target.checked })}
                    slotProps={{
                      input: { 'aria-label': `Enable ${tool.name}`, 'data-testid': `${toolTestId}-switch` },
                    }}
                  />
                </Locked>
              </Stack>
              {tool.description && (
                <Typography level="body-xs" sx={{ mt: '4px', color: 'text.secondary', wordBreak: 'break-word' }}>
                  {tool.description}
                </Typography>
              )}
              <Stack direction="row" alignItems="center" gap="8px" sx={{ mt: '8px' }}>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  Approval
                </Typography>
                <Locked reason={readOnlyReason}>
                  <Select<McpToolApprovalMode>
                    size="sm"
                    value={approvalShown}
                    disabled={!draft.enabled || !!readOnlyReason}
                    onChange={(_, value) => value && setDraft(tool.name, { approval: value })}
                    slotProps={{
                      button: { 'aria-label': `Approval for ${tool.name}`, 'data-testid': `${toolTestId}-approval` },
                    }}
                    sx={{ minWidth: '150px' }}
                  >
                    {approvals.map(mode => (
                      <Option key={mode} value={mode} data-testid={`${toolTestId}-approval-${mode}`}>
                        {APPROVAL_LABELS[mode]}
                      </Option>
                    ))}
                  </Select>
                </Locked>
              </Stack>
              {platform && !readOnly && (
                <Typography
                  level="body-xs"
                  sx={{ mt: '4px', color: 'text.tertiary' }}
                  data-testid={`${toolTestId}-approval-note`}
                >
                  Always allow lets every user who turned this connector on run this tool without being asked.
                </Typography>
              )}
            </Box>
          );
        })}
      </Stack>
      {(connection.toolsDropped ?? 0) > 0 && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }} data-testid={`${testId}-dropped`}>
          {connection.toolsDropped} more tools were left out because their names or size were not accepted.
        </Typography>
      )}
      {unversioned > 0 && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Refresh the tools to review the ones that cannot be switched here.
        </Typography>
      )}
      <Stack direction="row" gap="8px">
        <Locked reason={readOnlyReason}>
          <Button
            size="sm"
            loading={update.isPending}
            disabled={entries.length === 0 || !!readOnlyReason}
            onClick={save}
            data-testid={`${testId}-save-btn`}
          >
            Save review
          </Button>
        </Locked>
        <Button size="sm" variant="plain" color="neutral" onClick={onDone} data-testid={`${testId}-cancel-btn`}>
          Cancel
        </Button>
      </Stack>
    </Stack>
  );
};

export default McpToolReview;
