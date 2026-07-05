/**
 * LatticeViewer
 *
 * Displays a Lattice financial pro-forma model.
 * Supports table view, formula view, and chart view.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  Box,
  Stack,
  Typography,
  Tabs,
  Tab,
  TabList,
  TabPanel,
  Chip,
  IconButton,
  Tooltip,
  CircularProgress,
  Input,
  Button,
  Divider,
  Sheet,
} from '@mui/joy';
import { Theme } from '@mui/joy/styles';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import SaveIcon from '@mui/icons-material/Save';
import BugReportIcon from '@mui/icons-material/BugReport';
import ScienceIcon from '@mui/icons-material/Science';
import ChatIcon from '@mui/icons-material/Chat';
import SendIcon from '@mui/icons-material/Send';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { ILatticeModel, LatticeArtifact, PrimitiveValue } from '@bike4mind/common';
import { useLattice } from '@client/app/hooks/useLattice';
import { useLatticeModel, useHydrateLatticeModel, useSetLatticeValue } from '@client/app/hooks/useLatticeApi';
import { useLatticeLocalDev } from '@client/app/hooks/useLatticeLocalDev';
import LatticeTableView from './LatticeTableView';
import LatticeChartView from './LatticeChartView';

// Types

export interface LatticeViewerProps {
  /** The Lattice artifact containing model data */
  artifact: LatticeArtifact;
  /** Whether to show edit controls */
  editable?: boolean;
  /** Callback when model changes */
  onModelChange?: (model: ILatticeModel) => void;
}

type ViewMode = 'table' | 'formulas' | 'chart';

// Component

const LatticeViewer: React.FC<LatticeViewerProps> = ({ artifact, editable = true, onModelChange }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [isMockMode, setIsMockMode] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatInputRef = useRef<HTMLInputElement>(null);

  // Local dev mode hook for NLP testing
  const {
    isProcessing: isChatProcessing,
    conversationHistory,
    toolResults,
    lastError: chatError,
    sendMessage,
    clearConversation,
    runHydration,
  } = useLatticeLocalDev();

  // Connect to Lattice store for local state
  const {
    model: localModel,
    computedValues,
    isComputing,
    isDirty,
    loadModel,
    setEntityValue: setLocalValue,
    setIsComputing,
    setComputedValues,
  } = useLattice();

  // Extract model ID from artifact content (if persisted to database)
  // Inline artifacts have IDs like "lattice_1234567890_abc" - these are NOT persisted
  // Persisted models have MongoDB ObjectIds (24-character hex strings)
  const modelId = useMemo(() => {
    if (artifact.content && typeof artifact.content === 'string') {
      try {
        const parsed = JSON.parse(artifact.content);
        // Check if it's a persisted model (MongoDB ObjectId format: 24 hex chars)
        if (parsed.id && typeof parsed.id === 'string') {
          const isObjectId = /^[a-f0-9]{24}$/.test(parsed.id);
          // Only return modelId for persisted models - inline artifacts should NOT trigger API fetch
          if (isObjectId) {
            return parsed.id;
          }
        }
      } catch {
        // Not JSON, ignore
      }
    }
    return undefined;
  }, [artifact.content]);

  const { data: apiModel, isLoading: isLoadingFromApi } = useLatticeModel(modelId);
  const hydrateMutation = useHydrateLatticeModel();
  const setValueMutation = useSetLatticeValue();

  // Determine which model to use: API model takes precedence if available
  const model = apiModel || localModel;

  // Load model from artifact content or API (skip if in mock mode)
  useEffect(() => {
    if (isMockMode) {
      // Don't overwrite mock data
      return;
    }

    if (apiModel) {
      // Load API model into local store
      if (!localModel || localModel.id !== apiModel.id) {
        loadModel(apiModel);
      }
    } else if (artifact.content && typeof artifact.content === 'string') {
      // Fallback to artifact content for non-persisted models
      try {
        const modelData = JSON.parse(artifact.content) as ILatticeModel;
        if (!localModel || localModel.id !== modelData.id) {
          loadModel(modelData);
        }
      } catch (error) {
        console.error('Failed to parse Lattice model from artifact:', error);
      }
    }
  }, [artifact.content, apiModel, localModel, loadModel, isMockMode]);

  const handleRecompute = useCallback(async () => {
    if (!model?.id) return;

    setIsComputing(true);
    try {
      const result = await hydrateMutation.mutateAsync({ modelId: model.id });
      if (result.computedValues) {
        setComputedValues(result.computedValues);
      }
    } catch (error) {
      console.error('Failed to hydrate model:', error);
    } finally {
      setIsComputing(false);
    }
  }, [model, hydrateMutation, setIsComputing, setComputedValues]);

  // Handle value change - update local store and optionally sync to API
  const handleValueChange = useCallback(
    async (entityId: string, attributeKey: string, value: PrimitiveValue) => {
      if (!editable) return;

      // Update local store immediately for responsive UI
      setLocalValue(entityId, attributeKey, value);

      // If model is persisted, also save to API
      if (model?.id && modelId) {
        try {
          await setValueMutation.mutateAsync({
            modelId: model.id,
            entityId,
            attributeKey,
            value,
          });
        } catch (error) {
          console.error('Failed to save value to API:', error);
        }
      }

      const currentModel = useLattice.getState().model;
      if (currentModel) {
        onModelChange?.(currentModel);
      }
    },
    [editable, setLocalValue, setValueMutation, model, modelId, onModelChange]
  );

  // Load mock data for development/testing
  const handleLoadMockData = useCallback(() => {
    const now = new Date();

    // Helper to create an entity with proper structure
    const createEntity = (
      id: string,
      name: string,
      values: Array<{ key: string; value: number | string; dataType: 'number' | 'string' | 'currency' }>
    ) => ({
      id,
      name,
      type: 'line_item' as const,
      attributes: values.map(v => ({
        key: v.key,
        value: v.value,
        dataType: v.dataType,
        isComputed: false,
      })),
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });

    // Helper to create a rule
    const createRule = (
      id: string,
      name: string,
      description: string,
      operation: 'SUM' | 'SUBTRACT',
      inputRefs: string[],
      outputEntityId: string
    ) => ({
      id,
      name,
      description,
      type: 'formula' as const,
      definition: {
        operation,
        inputs: inputRefs.map(ref => ({ ref, type: 'attribute' as const })),
        output: {
          targetEntityId: outputEntityId,
          targetAttribute: 'value',
          dataType: 'currency' as const,
        },
      },
      dependencies: [],
      priority: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const mockModel: ILatticeModel = {
      id: 'mock_2026_proforma',
      name: '2026 Pro Forma (Mock)',
      description: 'Sample quarterly income statement with revenue, costs, and profit calculations',
      modelType: 'income_statement',
      userId: 'mock_user',
      data: {
        entities: [
          // Revenue entities
          createEntity('revenue_q1', 'Q1 Revenue', [
            { key: 'value', value: 100000, dataType: 'currency' },
            { key: 'period', value: 'Q1 2026', dataType: 'string' },
            { key: 'category', value: 'Revenue', dataType: 'string' },
          ]),
          createEntity('revenue_q2', 'Q2 Revenue', [
            { key: 'value', value: 125000, dataType: 'currency' },
            { key: 'period', value: 'Q2 2026', dataType: 'string' },
            { key: 'category', value: 'Revenue', dataType: 'string' },
          ]),
          createEntity('revenue_q3', 'Q3 Revenue', [
            { key: 'value', value: 150000, dataType: 'currency' },
            { key: 'period', value: 'Q3 2026', dataType: 'string' },
            { key: 'category', value: 'Revenue', dataType: 'string' },
          ]),
          createEntity('revenue_q4', 'Q4 Revenue', [
            { key: 'value', value: 180000, dataType: 'currency' },
            { key: 'period', value: 'Q4 2026', dataType: 'string' },
            { key: 'category', value: 'Revenue', dataType: 'string' },
          ]),
          // COGS entities
          createEntity('cogs_q1', 'Q1 COGS', [
            { key: 'value', value: 40000, dataType: 'currency' },
            { key: 'period', value: 'Q1 2026', dataType: 'string' },
            { key: 'category', value: 'Cost of Goods Sold', dataType: 'string' },
          ]),
          createEntity('cogs_q2', 'Q2 COGS', [
            { key: 'value', value: 50000, dataType: 'currency' },
            { key: 'period', value: 'Q2 2026', dataType: 'string' },
            { key: 'category', value: 'Cost of Goods Sold', dataType: 'string' },
          ]),
          createEntity('cogs_q3', 'Q3 COGS', [
            { key: 'value', value: 60000, dataType: 'currency' },
            { key: 'period', value: 'Q3 2026', dataType: 'string' },
            { key: 'category', value: 'Cost of Goods Sold', dataType: 'string' },
          ]),
          createEntity('cogs_q4', 'Q4 COGS', [
            { key: 'value', value: 72000, dataType: 'currency' },
            { key: 'period', value: 'Q4 2026', dataType: 'string' },
            { key: 'category', value: 'Cost of Goods Sold', dataType: 'string' },
          ]),
          // Operating expenses
          createEntity('opex_q1', 'Q1 Operating Expenses', [
            { key: 'value', value: 25000, dataType: 'currency' },
            { key: 'period', value: 'Q1 2026', dataType: 'string' },
            { key: 'category', value: 'Operating Expenses', dataType: 'string' },
          ]),
          createEntity('opex_q2', 'Q2 Operating Expenses', [
            { key: 'value', value: 28000, dataType: 'currency' },
            { key: 'period', value: 'Q2 2026', dataType: 'string' },
            { key: 'category', value: 'Operating Expenses', dataType: 'string' },
          ]),
          createEntity('opex_q3', 'Q3 Operating Expenses', [
            { key: 'value', value: 30000, dataType: 'currency' },
            { key: 'period', value: 'Q3 2026', dataType: 'string' },
            { key: 'category', value: 'Operating Expenses', dataType: 'string' },
          ]),
          createEntity('opex_q4', 'Q4 Operating Expenses', [
            { key: 'value', value: 32000, dataType: 'currency' },
            { key: 'period', value: 'Q4 2026', dataType: 'string' },
            { key: 'category', value: 'Operating Expenses', dataType: 'string' },
          ]),
          // Calculated totals
          createEntity('total_revenue', 'Total Revenue', [
            { key: 'value', value: 555000, dataType: 'currency' },
            { key: 'category', value: 'Total', dataType: 'string' },
          ]),
          createEntity('gross_profit', 'Gross Profit', [
            { key: 'value', value: 333000, dataType: 'currency' },
            { key: 'category', value: 'Profit', dataType: 'string' },
          ]),
          createEntity('net_income', 'Net Income', [
            { key: 'value', value: 218000, dataType: 'currency' },
            { key: 'category', value: 'Profit', dataType: 'string' },
          ]),
        ],
        relationships: [
          { id: 'rel1', fromEntityId: 'revenue_q1', toEntityId: 'total_revenue', type: 'derived' },
          { id: 'rel2', fromEntityId: 'revenue_q2', toEntityId: 'total_revenue', type: 'derived' },
          { id: 'rel3', fromEntityId: 'revenue_q3', toEntityId: 'total_revenue', type: 'derived' },
          { id: 'rel4', fromEntityId: 'revenue_q4', toEntityId: 'total_revenue', type: 'derived' },
        ],
      },
      rules: {
        rules: [
          createRule(
            'rule_total_revenue',
            'Calculate Total Revenue',
            'Sum of all quarterly revenue',
            'SUM',
            ['revenue_q1.value', 'revenue_q2.value', 'revenue_q3.value', 'revenue_q4.value'],
            'total_revenue'
          ),
          createRule(
            'rule_gross_profit',
            'Calculate Gross Profit',
            'Total Revenue minus Cost of Goods Sold',
            'SUBTRACT',
            ['total_revenue.value', 'cogs_q1.value', 'cogs_q2.value', 'cogs_q3.value', 'cogs_q4.value'],
            'gross_profit'
          ),
          createRule(
            'rule_net_income',
            'Calculate Net Income',
            'Gross Profit minus Operating Expenses',
            'SUBTRACT',
            ['gross_profit.value', 'opex_q1.value', 'opex_q2.value', 'opex_q3.value', 'opex_q4.value'],
            'net_income'
          ),
        ],
        rulesets: [
          {
            id: 'ruleset_income_statement',
            name: 'Income Statement Calculations',
            description: 'Standard income statement calculation rules',
            ruleIds: ['rule_total_revenue', 'rule_gross_profit', 'rule_net_income'],
          },
        ],
      },
      views: {
        views: [
          {
            id: 'view_default',
            name: 'Default View',
            type: 'table',
            config: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      settings: {
        currency: 'USD',
        fiscalYearStart: '01-01',
        periodGrain: 'quarter',
        defaultDecimalPlaces: 0,
        negativeFormat: 'parentheses',
      },
      scenarios: [],
      operations: [],
      operationIndex: -1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    setIsMockMode(true);
    loadModel(mockModel);
    console.log('🧪 Loaded mock Lattice model:', mockModel);
  }, [loadModel]);

  // Debug handler - copies all diagnostic data to clipboard
  const handleCopyDebugInfo = useCallback(async () => {
    const debugData = {
      timestamp: new Date().toISOString(),
      artifact: {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        contentLength: artifact.content?.length || 0,
        contentPreview: artifact.content?.substring(0, 500) + '...',
        metadata: artifact.metadata,
      },
      modelId,
      isLoadingFromApi,
      apiModel: apiModel
        ? {
            id: apiModel.id,
            name: apiModel.name,
            modelType: apiModel.modelType,
            entityCount: apiModel.data?.entities?.length || 0,
            ruleCount: apiModel.rules?.rules?.length || 0,
            entities: apiModel.data?.entities?.map(e => ({ id: e.id, name: e.name, type: e.type })),
          }
        : null,
      localModel: localModel
        ? {
            id: localModel.id,
            name: localModel.name,
            modelType: localModel.modelType,
            entityCount: localModel.data?.entities?.length || 0,
            ruleCount: localModel.rules?.rules?.length || 0,
            entities: localModel.data?.entities?.map(e => ({ id: e.id, name: e.name, type: e.type })),
          }
        : null,
      activeModel: model
        ? {
            id: model.id,
            name: model.name,
            modelType: model.modelType,
            entityCount: model.data?.entities?.length || 0,
            ruleCount: model.rules?.rules?.length || 0,
            fullData: model.data,
            fullRules: model.rules,
          }
        : null,
      parsedArtifactContent: (() => {
        try {
          return JSON.parse(artifact.content || '{}');
        } catch {
          return { parseError: 'Failed to parse artifact.content' };
        }
      })(),
    };

    const debugString = JSON.stringify(debugData, null, 2);
    await navigator.clipboard.writeText(debugString);
    console.log('🐛 Lattice Debug Info copied to clipboard:', debugData);
    alert('Debug info copied to clipboard! Check console for details.');
  }, [artifact, modelId, isLoadingFromApi, apiModel, localModel, model]);

  const handleChatSubmit = useCallback(async () => {
    if (!chatInput.trim() || isChatProcessing) return;

    const message = chatInput.trim();
    setChatInput('');

    try {
      await sendMessage(message);
    } catch (error) {
      console.error('[Lattice Chat] Error:', error);
    }
  }, [chatInput, isChatProcessing, sendMessage]);

  const handleChatKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleChatSubmit();
      }
    },
    [handleChatSubmit]
  );

  const handleCopyChatHistory = useCallback(async () => {
    const lines: string[] = [];

    lines.push('=== Lattice NLP Chat History ===');
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    if (model) {
      lines.push(`Model: ${model.name} (${model.id})`);
    }
    lines.push('');

    if (conversationHistory.length > 0) {
      lines.push('--- Conversation ---');
      for (const msg of conversationHistory) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        lines.push(`[${role}]: ${msg.content}`);
        lines.push('');
      }
    } else {
      lines.push('(No conversation history)');
      lines.push('');
    }

    if (toolResults.length > 0) {
      lines.push('--- Tool Results ---');
      for (const result of toolResults) {
        const status = result.success ? 'SUCCESS' : 'FAILED';
        lines.push(`[${status}] ${result.toolName}`);
        if (result.message) {
          lines.push(`  Message: ${result.message}`);
        }
      }
      lines.push('');
    }

    if (model) {
      lines.push('--- Model State ---');
      lines.push(`Entities: ${model.data.entities.length}`);
      lines.push(`Rules: ${model.rules.rules.length}`);
      lines.push(`Period Grain: ${model.settings?.periodGrain || 'quarter'}`);
    }

    const text = lines.join('\n');

    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy chat history:', error);
    }
  }, [conversationHistory, toolResults, model]);

  const handleCopyTable = useCallback(async () => {
    if (!model) return;

    const lines: string[] = [];
    lines.push('=== Lattice Table Data ===');
    lines.push(`Model: ${model.name} (${model.id})`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    // Get all unique attribute keys
    const allKeys = new Set<string>();
    model.data.entities.forEach(entity => {
      entity.attributes.forEach(attr => allKeys.add(attr.key));
    });
    const columns = Array.from(allKeys).sort();

    lines.push(['Entity', ...columns].join('\t'));

    for (const entity of model.data.entities) {
      const row = [entity.displayName || entity.name];
      for (const col of columns) {
        const attr = entity.attributes.find(a => a.key === col);
        const rawValue = attr?.value;

        const computedEntry = computedValues?.[entity.id]?.[col];
        const computedValue = computedEntry?.value;

        // Use computed value if available and attribute is computed
        const displayValue =
          attr?.isComputed && computedValue !== undefined
            ? computedValue
            : rawValue !== undefined && rawValue !== null
              ? rawValue
              : '-';

        row.push(String(displayValue));
      }
      lines.push(row.join('\t'));
    }

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy table:', error);
    }
  }, [model, computedValues]);

  const handleCopyFormulas = useCallback(async () => {
    if (!model) return;

    const lines: string[] = [];
    lines.push('=== Lattice Formulas ===');
    lines.push(`Model: ${model.name} (${model.id})`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    const rules = model.rules.rules;
    if (rules.length === 0) {
      lines.push('(No formulas defined)');
    } else {
      for (const rule of rules) {
        lines.push(`--- ${rule.name} ---`);
        lines.push(`Status: ${rule.enabled ? 'Active' : 'Disabled'}`);

        const { definition } = rule;
        if (definition) {
          const operation = definition.operation;
          const inputs = definition.inputs?.map(i => i.ref).join(', ') || '';
          const output = definition.output
            ? `${definition.output.targetEntityId}.${definition.output.targetAttribute}`
            : rule.name;
          lines.push(`Formula: ${output} = ${operation}(${inputs})`);
        }

        if (rule.description) {
          lines.push(`Description: ${rule.description}`);
        }
        lines.push('');
      }
    }

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error('Failed to copy formulas:', error);
    }
  }, [model]);

  const modelMetadata = useMemo(() => {
    if (!model) return null;

    const entityCount = model.data.entities.length;
    const ruleCount = model.rules.rules.length;
    const periodGrain = model.settings?.periodGrain || 'quarter';

    return { entityCount, ruleCount, periodGrain };
  }, [model]);

  if (!model || isLoadingFromApi) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 200,
        }}
      >
        <Stack spacing={2} alignItems="center">
          <CircularProgress size="lg" />
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {isLoadingFromApi ? 'Loading model from server...' : 'Loading Lattice model...'}
          </Typography>
        </Stack>
      </Box>
    );
  }

  const isSaving = setValueMutation.isPending;

  return (
    <Stack
      className="lattice-viewer"
      sx={(theme: Theme) => ({
        height: '100%',
        width: '100%',
        overflow: 'hidden',
      })}
    >
      {/* Header */}
      <Box
        className="lattice-viewer-header"
        sx={(theme: Theme) => ({
          p: 1.5,
          borderBottom: '1px solid',
          borderColor: theme.palette.divider,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
        })}
      >
        {/* Model info */}
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography level="title-md" fontWeight="lg">
            {model.name}
          </Typography>
          <ContextHelpButton helpId="features/lattice" tooltipText="Learn about Lattice" />

          {modelMetadata && (
            <Stack direction="row" spacing={0.5}>
              <Chip size="sm" variant="soft" color="neutral">
                {modelMetadata.entityCount} entities
              </Chip>
              <Chip size="sm" variant="soft" color="primary">
                {modelMetadata.ruleCount} rules
              </Chip>
              <Chip size="sm" variant="outlined" color="neutral">
                {modelMetadata.periodGrain}
              </Chip>
            </Stack>
          )}
        </Stack>

        {/* Actions */}
        <Stack direction="row" spacing={0.5} alignItems="center">
          {/* Save indicator */}
          {(isDirty || isSaving) && (
            <Chip
              size="sm"
              variant="soft"
              color={isSaving ? 'primary' : 'warning'}
              startDecorator={isSaving ? <CircularProgress size="sm" /> : <SaveIcon sx={{ fontSize: 14 }} />}
            >
              {isSaving ? 'Saving...' : 'Unsaved'}
            </Chip>
          )}

          <Tooltip title="Recompute all values">
            <IconButton
              size="sm"
              variant="plain"
              onClick={handleRecompute}
              disabled={hydrateMutation.isPending || isComputing}
            >
              {hydrateMutation.isPending || isComputing ? <CircularProgress size="sm" /> : <RefreshIcon />}
            </IconButton>
          </Tooltip>

          <Tooltip title="Load mock data for testing">
            <IconButton size="sm" variant="plain" color="warning" onClick={handleLoadMockData}>
              <ScienceIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title="Copy debug info to clipboard">
            <IconButton size="sm" variant="plain" color="neutral" onClick={handleCopyDebugInfo}>
              <BugReportIcon />
            </IconButton>
          </Tooltip>

          <Divider orientation="vertical" />

          <Tooltip title={chatOpen ? 'Hide NLP chat' : 'Open NLP chat (Local Dev)'}>
            <IconButton
              size="sm"
              variant={chatOpen ? 'soft' : 'plain'}
              color={chatOpen ? 'primary' : 'neutral'}
              onClick={() => setChatOpen(!chatOpen)}
            >
              <ChatIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      {/* View tabs */}
      <Tabs
        value={viewMode}
        onChange={(_, value) => setViewMode(value as ViewMode)}
        sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <Box
          sx={(theme: Theme) => ({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid',
            borderColor: theme.palette.divider,
            px: 1,
          })}
        >
          <TabList sx={{ '--Tabs-spacing': '0px' }}>
            <Tab value="table" variant="plain">
              <TableChartOutlinedIcon sx={{ mr: 0.5, fontSize: 18 }} />
              Table
            </Tab>
            <Tab value="formulas" variant="plain">
              <FunctionsOutlinedIcon sx={{ mr: 0.5, fontSize: 18 }} />
              Formulas
            </Tab>
            <Tab value="chart" variant="plain">
              <BarChartOutlinedIcon sx={{ mr: 0.5, fontSize: 18 }} />
              Chart
            </Tab>
          </TabList>

          {/* Copy button for current view */}
          {(viewMode === 'table' || viewMode === 'formulas') && (
            <Tooltip title={`Copy ${viewMode} to clipboard`}>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                onClick={viewMode === 'table' ? handleCopyTable : handleCopyFormulas}
                startDecorator={<ContentCopyIcon sx={{ fontSize: 14 }} />}
              >
                Copy
              </Button>
            </Tooltip>
          )}
        </Box>

        {/* Table View */}
        <TabPanel
          value="table"
          sx={{
            flexGrow: 1,
            overflow: 'auto',
            p: 0,
          }}
        >
          <LatticeTableView
            model={model}
            computedValues={computedValues}
            editable={editable}
            onValueChange={handleValueChange}
          />
        </TabPanel>

        {/* Formulas View */}
        <TabPanel
          value="formulas"
          sx={{
            flexGrow: 1,
            overflow: 'auto',
            p: 2,
          }}
        >
          <LatticeFormulaView model={model} />
        </TabPanel>

        {/* Chart View */}
        <TabPanel
          value="chart"
          sx={{
            flexGrow: 1,
            overflow: 'auto',
            p: 2,
          }}
        >
          <LatticeChartView model={model} computedValues={computedValues} />
        </TabPanel>
      </Tabs>

      {/* NLP Chat Panel (Local Dev Mode) */}
      {chatOpen && (
        <Sheet
          variant="outlined"
          sx={(theme: Theme) => ({
            borderTop: '1px solid',
            borderColor: theme.palette.divider,
            p: 1.5,
            maxHeight: 300,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          })}
        >
          {/* Chat Header */}
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Stack direction="row" spacing={1} alignItems="center">
              <ChatIcon sx={{ fontSize: 18, color: 'primary.500' }} />
              <Typography level="title-sm">NLP Chat (Local Dev)</Typography>
              <Chip size="sm" variant="soft" color="warning">
                Experimental
              </Chip>
            </Stack>
            <Stack direction="row" spacing={0.5}>
              <Tooltip title="Copy chat history to clipboard">
                <Button
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={handleCopyChatHistory}
                  startDecorator={<ContentCopyIcon sx={{ fontSize: 14 }} />}
                >
                  Copy
                </Button>
              </Tooltip>
              <Button size="sm" variant="plain" color="neutral" onClick={clearConversation}>
                Clear
              </Button>
              <Button size="sm" variant="plain" color="neutral" onClick={runHydration}>
                Hydrate
              </Button>
              <IconButton size="sm" variant="plain" onClick={() => setChatOpen(false)}>
                <ExpandMoreIcon />
              </IconButton>
            </Stack>
          </Stack>

          {/* Conversation History */}
          <Box
            sx={{
              flexGrow: 1,
              overflow: 'auto',
              minHeight: 80,
              maxHeight: 150,
              px: 1,
            }}
          >
            {conversationHistory.length === 0 ? (
              <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                Try: &quot;Create a 2026 income statement with Revenue and COGS&quot;
              </Typography>
            ) : (
              <Stack spacing={1}>
                {conversationHistory.map((msg, idx) => (
                  <Box
                    key={idx}
                    sx={(theme: Theme) => ({
                      p: 1,
                      borderRadius: 'sm',
                      bgcolor: msg.role === 'user' ? theme.palette.primary.softBg : theme.palette.background.level1,
                      alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                    })}
                  >
                    <Typography level="body-sm">{msg.content}</Typography>
                  </Box>
                ))}
              </Stack>
            )}
          </Box>

          {/* Tool Results */}
          {toolResults.length > 0 && (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ px: 1 }}>
              {toolResults.map((result, idx) => (
                <Chip
                  key={idx}
                  size="sm"
                  variant="soft"
                  color={result.success ? 'success' : 'danger'}
                  startDecorator={
                    result.success ? <CheckCircleIcon sx={{ fontSize: 14 }} /> : <ErrorIcon sx={{ fontSize: 14 }} />
                  }
                >
                  {result.toolName.replace('lattice_', '')}
                </Chip>
              ))}
            </Stack>
          )}

          {/* Error Display */}
          {chatError && (
            <Typography level="body-sm" color="danger" sx={{ px: 1 }}>
              Error: {chatError}
            </Typography>
          )}

          {/* Chat Input */}
          <Stack direction="row" spacing={1}>
            <Input
              ref={chatInputRef}
              size="sm"
              placeholder="Describe what you want to build or modify..."
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              disabled={isChatProcessing}
              sx={{ flexGrow: 1 }}
              endDecorator={
                isChatProcessing ? (
                  <CircularProgress size="sm" />
                ) : (
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="primary"
                    onClick={handleChatSubmit}
                    disabled={!chatInput.trim()}
                  >
                    <SendIcon />
                  </IconButton>
                )
              }
            />
          </Stack>
        </Sheet>
      )}
    </Stack>
  );
};

// Formula view sub-component

interface LatticeFormulaViewProps {
  model: ILatticeModel;
}

const LatticeFormulaView: React.FC<LatticeFormulaViewProps> = ({ model }) => {
  const rules = model.rules.rules;

  if (rules.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 100,
        }}
      >
        <Typography level="body-lg" sx={{ color: 'text.tertiary' }}>
          No formulas defined yet. Add rules using natural language.
        </Typography>
      </Box>
    );
  }

  return (
    <Stack spacing={1.5}>
      {rules.map(rule => {
        const formulaDisplay = buildFormulaDisplay(rule);

        return (
          <Box
            key={rule.id}
            sx={(theme: Theme) => ({
              p: 1.5,
              borderRadius: 'sm',
              bgcolor: theme.palette.background.level1,
              border: '1px solid',
              borderColor: theme.palette.divider,
            })}
          >
            <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
              <Typography level="title-sm" fontWeight="lg">
                {rule.name}
              </Typography>
              <Chip size="sm" variant="soft" color={rule.enabled ? 'success' : 'neutral'}>
                {rule.enabled ? 'Active' : 'Disabled'}
              </Chip>
            </Stack>

            <Typography
              level="body-sm"
              fontFamily="monospace"
              sx={(theme: Theme) => ({
                bgcolor: theme.palette.background.level2,
                p: 1,
                borderRadius: 'xs',
              })}
            >
              {formulaDisplay}
            </Typography>

            {rule.description && (
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
                {rule.description}
              </Typography>
            )}
          </Box>
        );
      })}
    </Stack>
  );
};

/**
 * Build a human-readable formula string from a rule definition
 */
function buildFormulaDisplay(rule: ILatticeModel['rules']['rules'][0]): string {
  const { definition } = rule;
  if (!definition) return rule.name;

  const operation = definition.operation;
  const inputs = definition.inputs?.map(i => i.ref).join(', ') || '';
  const output = definition.output
    ? `${definition.output.targetEntityId}.${definition.output.targetAttribute}`
    : rule.name;

  return `${output} = ${operation}(${inputs})`;
}

export default LatticeViewer;
