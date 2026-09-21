import { FC } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import { isAxiosError } from 'axios';
import type { ContextBreakdown } from '@bike4mind/services';
import TokenDistributionBar, { type TokenDistribution } from '@client/app/components/common/TokenDistributionBar';
import { useQuestContextBreakdown } from '@client/app/hooks/data/quests';

interface ContextBreakdownModalProps {
  questId: string;
  open: boolean;
  onClose: () => void;
}

const format = (value: number | null | undefined) => (value == null ? '-' : value.toLocaleString());

// The assembler's own system-prompt total, not the itemized sum: this is what the input was
// actually billed as, and the layer rows (categories.systemPrompt) do not always add up to it.
const billedSystemPrompt = (categories: ContextBreakdown['categories']): number =>
  categories.systemPromptBilled || categories.systemPrompt;

const toDistribution = (categories: ContextBreakdown['categories']): TokenDistribution => ({
  systemPrompts: billedSystemPrompt(categories),
  conversationHistory: categories.conversationHistory,
  mementos: categories.memory,
  fabFiles: categories.attachedFiles,
  urlContent: categories.urlContent,
  toolSchemas: categories.toolDefinitions,
  userPrompt: categories.userMessage,
  // Omitted when null so an unknown lake volume stays absent from the bar rather than reading as a
  // zero-token segment.
  ...(categories.lakeRetrieval !== null ? { lakeRetrieval: categories.lakeRetrieval } : {}),
});

const CategoryTable: FC<{ breakdown: ContextBreakdown }> = ({ breakdown }) => {
  const { categories, window: contextWindow } = breakdown;
  const rows: Array<[string, number | null]> = [
    ['System prompts', billedSystemPrompt(categories)],
    ['Lake retrieval', categories.lakeRetrieval],
    ['Tool definitions', categories.toolDefinitions],
    ['Attached files', categories.attachedFiles],
    ['Conversation history', categories.conversationHistory],
    ['Memory', categories.memory],
    ['URL content', categories.urlContent],
    ['Your message', categories.userMessage],
    ['Free space', contextWindow.freeSpace],
  ];
  const total = contextWindow.contextWindow;

  return (
    <Table size="sm" data-testid="context-breakdown-categories-table">
      <thead>
        <tr>
          <th>Category</th>
          <th style={{ width: 120 }}>Tokens</th>
          <th style={{ width: 90 }}>Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{format(value)}</td>
            <td>{total && value != null ? `${((value / total) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
};

const LayerTable: FC<{ layers: ContextBreakdown['layers'] }> = ({ layers }) => (
  <Box sx={{ overflowX: 'auto' }}>
    <Table size="sm" data-testid="context-breakdown-layers-table" sx={{ minWidth: 520 }}>
      <thead>
        <tr>
          <th>Layer</th>
          <th style={{ width: 110 }}>Origin</th>
          <th style={{ width: 100 }}>Tokens</th>
          <th style={{ width: 130 }}>Delivered</th>
        </tr>
      </thead>
      <tbody>
        {layers.map((layer, index) => (
          <tr key={`${layer.name}-${index}`} style={layer.wasIncluded ? undefined : { opacity: 0.6 }}>
            <td>{layer.name}</td>
            <td>{layer.source}</td>
            <td>{format(layer.tokenCount)}</td>
            <td>{layer.wasIncluded ? 'yes' : `no (${layer.exclusionReason ?? 'unknown'})`}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  </Box>
);

const ToolTable: FC<{ tools: ContextBreakdown['tools'] }> = ({ tools }) => (
  <Box sx={{ overflowX: 'auto' }}>
    <Table size="sm" data-testid="context-breakdown-tools-table" sx={{ minWidth: 480 }}>
      <thead>
        <tr>
          <th>Tool</th>
          <th style={{ width: 90 }}>Calls</th>
          <th style={{ width: 90 }}>Failed</th>
          <th style={{ width: 110 }}>Time</th>
        </tr>
      </thead>
      <tbody>
        {tools.map(tool => (
          <tr key={tool.name}>
            <td>
              {tool.name}
              {tool.offered ? '' : ' (not offered)'}
            </td>
            <td>{format(tool.invocations)}</td>
            <td>{format(tool.failures)}</td>
            <td>{tool.durationMs == null ? '-' : `${tool.durationMs.toLocaleString()} ms`}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  </Box>
);

const RetrievalSummary: FC<{ retrieval: NonNullable<ContextBreakdown['retrieval']> }> = ({ retrieval }) => (
  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }} data-testid="context-breakdown-retrieval">
    <Chip size="sm">{retrieval.attempted ? 'retrieval ran' : 'retrieval not run'}</Chip>
    {retrieval.outcome && <Chip size="sm">outcome: {retrieval.outcome}</Chip>}
    {retrieval.mode && <Chip size="sm">mode: {retrieval.mode}</Chip>}
    {retrieval.injected && (
      <Chip size="sm">
        injected: {retrieval.injected.chunks.toLocaleString()} chunks / {retrieval.injected.chars.toLocaleString()}{' '}
        chars
      </Chip>
    )}
    {retrieval.dataLakeTags?.length > 0 && <Chip size="sm">lakes: {retrieval.dataLakeTags.join(', ')}</Chip>}
  </Stack>
);

const Breakdown: FC<{ breakdown: ContextBreakdown }> = ({ breakdown }) => (
  <Stack spacing={2}>
    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
      <Chip size="sm" data-testid="context-breakdown-model-chip">
        {breakdown.model.id ?? 'unknown model'}
      </Chip>
      <Chip size="sm">window: {format(breakdown.window.contextWindow)}</Chip>
      <Chip size="sm">input: {format(breakdown.window.inputTokens)}</Chip>
      <Chip size="sm">output: {format(breakdown.window.outputTokens)}</Chip>
      <Chip size="sm">reserved for reply: {format(breakdown.window.maxOutputTokens)}</Chip>
      {breakdown.promptFingerprint && <Chip size="sm">prompt {breakdown.promptFingerprint}</Chip>}
    </Stack>

    <TokenDistributionBar tokensBySource={toDistribution(breakdown.categories)} />

    <CategoryTable breakdown={breakdown} />

    <Box>
      <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
        System prompt layers, in delivery order
      </Typography>
      {breakdown.layers.length > 0 &&
        billedSystemPrompt(breakdown.categories) !== breakdown.categories.systemPrompt && (
          <Typography level="body-xs" sx={{ mb: 1 }} data-testid="context-breakdown-system-prompt-reconciliation">
            Included layers sum to {format(breakdown.categories.systemPrompt)}; the model was billed for{' '}
            {format(billedSystemPrompt(breakdown.categories))} system-prompt tokens.
          </Typography>
        )}
      {breakdown.layers.length > 0 ? (
        <LayerTable layers={breakdown.layers} />
      ) : (
        <Typography level="body-xs">This turn recorded no per-layer detail.</Typography>
      )}
    </Box>

    <Box>
      <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
        Tools
      </Typography>
      {breakdown.tools.length > 0 ? (
        <ToolTable tools={breakdown.tools} />
      ) : (
        <Typography level="body-xs">No tools were offered on this turn.</Typography>
      )}
    </Box>

    <Box>
      <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
        Retrieval
      </Typography>
      {breakdown.retrieval ? (
        <RetrievalSummary retrieval={breakdown.retrieval} />
      ) : (
        <Typography level="body-xs">No retrieval was recorded for this turn.</Typography>
      )}
    </Box>

    <Box>
      <Typography level="body-sm" fontWeight="md" sx={{ mb: 1 }}>
        Cache
      </Typography>
      <Typography level="body-xs" data-testid="context-breakdown-cache">
        read {format(breakdown.cache.readTokens)} / written {format(breakdown.cache.writeTokens)} (
        {(breakdown.cache.hitRate * 100).toFixed(0)}% read
        {breakdown.cache.settledBasis ? `, ${breakdown.cache.settledBasis} basis` : ''})
      </Typography>
    </Box>
  </Stack>
);

/**
 * The reader's own /context view for one of their turns: which system-prompt layers, tools, files
 * and history filled the window, and what was left. Fetches only while open.
 */
const ContextBreakdownModal: FC<ContextBreakdownModalProps> = ({ questId, open, onClose }) => {
  const { data, isLoading, error } = useQuestContextBreakdown(questId, open);
  const serverErrorMessage = isAxiosError(error) ? error.response?.data?.error : undefined;

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxWidth: 780, width: '100%', maxHeight: '85vh', overflowY: 'auto' }}>
        <ModalClose data-testid="context-breakdown-close-btn" />
        <Typography level="h4">Context</Typography>
        <Divider sx={{ my: 1 }} />
        {isLoading && <CircularProgress size="sm" data-testid="context-breakdown-loading" />}
        {error && (
          <Alert color="danger" data-testid="context-breakdown-error">
            {serverErrorMessage || 'Could not load the context breakdown for this message.'}
          </Alert>
        )}
        {data && <Breakdown breakdown={data} />}
      </ModalDialog>
    </Modal>
  );
};

export default ContextBreakdownModal;
