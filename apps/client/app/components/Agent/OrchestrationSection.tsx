/**
 * Advanced - Orchestration form section.
 *
 * Promotes a regular chat agent to a ReAct-orchestrated agent. Setting *any* of
 * these fields opts the agent into the orchestration dispatch path (see
 * `hasOrchestrationFields` in `utils/agentOrchestration.ts`) - the executor
 * then runs the iteration loop and surfaces the inline permission card for
 * tools flagged `needs_approval` server-side.
 *
 * Section is collapsed by default so authors writing a simple personality agent
 * never see this complexity. Existing agents without orchestration fields
 * remain on the legacy chat-completion path - zero behavior change.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Card,
  Chip,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Option,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import type { SelectOption } from '@mui/joy/Select';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { B4MLLMToolsList } from '@bike4mind/common';

import { AgentOrchestration, ThoroughnessLevel } from '../../types/agentForm';
import { THOROUGHNESS_OPTIONS, TOOLS_REQUIRING_APPROVAL } from '../../constants/agentForm';
import { isOrchestrationConfigured } from '../../utils/agentFormUtils';
import { TOOL_MAPPING } from '../../utils/toolMapping';
import { useAccessibleModels } from '../../hooks/useAccessibleModels';

interface OrchestrationSectionProps {
  value: AgentOrchestration;
  onChange: (next: AgentOrchestration) => void;
  readOnly?: boolean;
}

/**
 * Tools the user can choose from in the picker. Sourced from the canonical Zod
 * enum so we never drift from the server registry - see
 * `b4m-core/common/src/schemas/llm.ts`.
 *
 * Admin-only tools (blog_*, edit_image, Slack tools) and tools missing from
 * `TOOL_MAPPING` are filtered out: they exist server-side but aren't intended
 * for end-user agent authoring.
 *
 * Edge case (out of scope): an admin who hand-crafted an agent with
 * one of these filtered tools via raw API can still SEE the chip (rendered with
 * the raw id fallback) but cannot re-add it via the picker after removal. A
 * future "Restore" workflow would need a separate picker surface; for now the
 * filter intentionally limits surface area to user-safe tools.
 */
const PICKABLE_TOOLS: string[] = B4MLLMToolsList.filter(t => t in TOOL_MAPPING).sort();

const ITERATION_BOUNDS = { min: 1, max: 100 } as const;

const newVariableId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `var-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const OrchestrationSection: React.FC<OrchestrationSectionProps> = ({ value, onChange, readOnly = false }) => {
  const [expanded, setExpanded] = useState(false);
  const { accessibleTextModels } = useAccessibleModels();

  const hasAnyConfig = isOrchestrationConfigured(value);

  const update = useCallback(
    (patch: Partial<AgentOrchestration>) => {
      onChange({ ...value, ...patch });
    },
    [onChange, value]
  );

  const handleToolsChange = useCallback(
    (field: 'allowedTools' | 'deniedTools') => (_event: React.SyntheticEvent | null, next: string[] | null) => {
      update({ [field]: next ?? [] });
    },
    [update]
  );

  const handleIterationsChange = useCallback(
    (level: keyof AgentOrchestration['maxIterations']) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = parseInt(e.target.value, 10);
      if (Number.isNaN(n)) return;
      const clamped = Math.max(ITERATION_BOUNDS.min, Math.min(ITERATION_BOUNDS.max, n));
      update({ maxIterations: { ...value.maxIterations, [level]: clamped } });
    },
    [update, value.maxIterations]
  );

  const handleThoroughnessChange = useCallback(
    (_event: React.SyntheticEvent | null, next: ThoroughnessLevel | '' | null) => {
      update({ defaultThoroughness: next ?? '' });
    },
    [update]
  );

  const handleAddVariable = useCallback(() => {
    update({
      defaultVariables: [...value.defaultVariables, { id: newVariableId(), key: '', value: '' }],
    });
  }, [update, value.defaultVariables]);

  const handleVariableChange = useCallback(
    (id: string, field: 'key' | 'value') => (e: React.ChangeEvent<HTMLInputElement>) => {
      update({
        defaultVariables: value.defaultVariables.map(entry =>
          entry.id === id ? { ...entry, [field]: e.target.value } : entry
        ),
      });
    },
    [update, value.defaultVariables]
  );

  const handleRemoveVariable = useCallback(
    (id: string) => () => {
      update({ defaultVariables: value.defaultVariables.filter(entry => entry.id !== id) });
    },
    [update, value.defaultVariables]
  );

  const handleAddChip = useCallback(
    (field: 'exclusiveMcpServers' | 'fallbackModels', text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (value[field].includes(trimmed)) return;
      update({ [field]: [...value[field], trimmed] });
    },
    [update, value]
  );

  const handleRemoveChip = useCallback(
    (field: 'exclusiveMcpServers' | 'fallbackModels', entry: string) => () => {
      update({ [field]: value[field].filter(e => e !== entry) });
    },
    [update, value]
  );

  return (
    <Card
      variant="outlined"
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: theme => `1px solid ${theme.palette.border.soft}`,
        borderRadius: '8px',
        p: { xs: 2, sm: 3 },
        gap: 0,
      }}
      data-testid="orchestration-section"
    >
      {/* Header - clickable to toggle */}
      <Box
        component="button"
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        sx={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
        }}
        data-testid="orchestration-section-toggle"
        aria-expanded={expanded}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography level="title-md">Advanced — Orchestration</Typography>
            {hasAnyConfig && (
              <Chip size="sm" variant="soft" color="primary" data-testid="orchestration-section-active-chip">
                ReAct enabled
              </Chip>
            )}
          </Box>
          <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.primary50' }}>
            Promote this agent to ReAct mode — allow / deny specific tools, cap iteration count, and gate high-impact
            actions behind the inline permission card.
          </Typography>
        </Box>
        {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
      </Box>

      {expanded && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 2.5 }}>
          {/* Tool ACLs */}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
            <ToolMultiSelect
              intent="allow"
              label="Allowed tools"
              placeholder="Any tool (no allow-list)"
              helper={
                <>
                  Empty = no allow-list applied. Tools flagged <em>needs approval</em> still surface a permission card
                  the first time they run.
                </>
              }
              testId="orchestration-allowed-tools-select"
              value={value.allowedTools}
              onChange={handleToolsChange('allowedTools')}
              readOnly={readOnly}
              showApprovalBadges
            />
            <ToolMultiSelect
              intent="deny"
              label="Denied tools"
              placeholder="None denied"
              testId="orchestration-denied-tools-select"
              value={value.deniedTools}
              onChange={handleToolsChange('deniedTools')}
              readOnly={readOnly}
            />
          </Box>

          {/* Thoroughness + iteration caps */}
          <FormControl size="sm">
            <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Default thoroughness</FormLabel>
            <Select
              size="sm"
              value={value.defaultThoroughness}
              onChange={handleThoroughnessChange}
              disabled={readOnly}
              indicator={<KeyboardArrowDownIcon />}
              placeholder="Use system default (medium)"
              sx={{
                border: '1px solid',
                borderColor: 'border.input',
                backgroundColor: 'background.panel',
                boxShadow: 'none',
              }}
              data-testid="orchestration-default-thoroughness-select"
            >
              <Option value="">Use system default (medium)</Option>
              {THOROUGHNESS_OPTIONS.map(opt => (
                <Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Option>
              ))}
            </Select>
          </FormControl>

          <Box>
            <FormLabel sx={{ fontWeight: 400, color: 'text.primary50', mb: 1 }}>
              Max iterations per thoroughness
            </FormLabel>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 2 }}>
              {(['quick', 'medium', 'very_thorough'] as const).map(level => (
                <FormControl key={level} size="sm">
                  <FormLabel sx={{ fontWeight: 400, fontSize: 'xs', color: 'text.tertiary' }}>
                    {level.replace('_', ' ')}
                  </FormLabel>
                  <Input
                    size="sm"
                    type="number"
                    slotProps={{ input: { min: ITERATION_BOUNDS.min, max: ITERATION_BOUNDS.max, step: 1 } }}
                    value={value.maxIterations[level]}
                    onChange={handleIterationsChange(level)}
                    readOnly={readOnly}
                    disabled={!hasAnyConfig}
                    {...(!hasAnyConfig && { 'aria-describedby': 'orchestration-iterations-disabled-hint' })}
                    sx={{
                      border: '1px solid',
                      borderColor: 'border.input',
                      backgroundColor: 'background.panel',
                      boxShadow: 'none',
                    }}
                    data-testid={`orchestration-max-iterations-${level}-input`}
                  />
                </FormControl>
              ))}
            </Box>
            {!hasAnyConfig && (
              <Typography
                id="orchestration-iterations-disabled-hint"
                level="body-xs"
                sx={{ mt: 1, color: 'text.tertiary' }}
                data-testid="orchestration-iterations-disabled-hint"
              >
                Configure any orchestration field above to apply iteration caps.
              </Typography>
            )}
          </Box>

          {/* Default variables (key/value editor) */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>Default variables</FormLabel>
              <IconButton
                size="sm"
                variant="soft"
                onClick={handleAddVariable}
                disabled={readOnly}
                data-testid="orchestration-add-variable-btn"
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Box>
            <Stack spacing={1}>
              {value.defaultVariables.length === 0 && (
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  No variables. These flow into prompt templates as substitutable placeholders.
                </Typography>
              )}
              {value.defaultVariables.map(entry => (
                <Box key={entry.id} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Input
                    size="sm"
                    placeholder="key"
                    value={entry.key}
                    onChange={handleVariableChange(entry.id, 'key')}
                    readOnly={readOnly}
                    sx={{ flex: 1, backgroundColor: 'background.panel' }}
                    data-testid={`orchestration-variable-key-${entry.id}`}
                  />
                  <Input
                    size="sm"
                    placeholder="value"
                    value={entry.value}
                    onChange={handleVariableChange(entry.id, 'value')}
                    readOnly={readOnly}
                    sx={{ flex: 2, backgroundColor: 'background.panel' }}
                    data-testid={`orchestration-variable-value-${entry.id}`}
                  />
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={handleRemoveVariable(entry.id)}
                    disabled={readOnly}
                    data-testid={`orchestration-variable-remove-${entry.id}`}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Box>
              ))}
            </Stack>
          </Box>

          {/* MCP servers + fallback models */}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
            <ChipInputField
              label="Exclusive MCP servers"
              helper="Restrict tool calls to these MCP servers only. Empty = all available servers."
              testId="orchestration-mcp-servers"
              values={value.exclusiveMcpServers}
              readOnly={readOnly}
              onAdd={text => handleAddChip('exclusiveMcpServers', text)}
              onRemoveByEntry={entry => handleRemoveChip('exclusiveMcpServers', entry)()}
            />
            <ModelChipPickerField
              label="Fallback models"
              helper="Tried in order if the preferred model is unavailable."
              testId="orchestration-fallback-models"
              values={value.fallbackModels}
              models={accessibleTextModels}
              readOnly={readOnly}
              onAdd={text => handleAddChip('fallbackModels', text)}
              onRemoveByEntry={entry => handleRemoveChip('fallbackModels', entry)()}
            />
          </Box>
        </Box>
      )}
    </Card>
  );
};

// Helpers

interface ToolMultiSelectProps {
  intent: 'allow' | 'deny';
  label: string;
  placeholder: string;
  helper?: React.ReactNode;
  testId: string;
  value: string[];
  onChange: (event: React.SyntheticEvent | null, next: string[] | null) => void;
  readOnly?: boolean;
  /** When true, options that match `TOOLS_REQUIRING_APPROVAL` get a "needs approval"
   *  badge. Only shown on the allow-list - denying a tool already shows it's gated. */
  showApprovalBadges?: boolean;
}

/**
 * Tool multi-select with chip rendering. Used for both Allowed and Denied tool
 * lists - the only differences are the chip color (soft vs danger) and whether
 * we surface `needs approval` badges on the options. Sourced from `PICKABLE_TOOLS`,
 * displayed via `TOOL_MAPPING`.
 */
const ToolMultiSelect: React.FC<ToolMultiSelectProps> = ({
  intent,
  label,
  placeholder,
  helper,
  testId,
  value,
  onChange,
  readOnly,
  showApprovalBadges,
}) => {
  const chipColor = intent === 'deny' ? 'danger' : undefined;
  return (
    <FormControl size="sm">
      <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>{label}</FormLabel>
      <Select
        multiple
        size="sm"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        disabled={readOnly}
        indicator={<KeyboardArrowDownIcon />}
        slotProps={{ listbox: { sx: { maxHeight: 320, overflow: 'auto' } } }}
        renderValue={(selected: SelectOption<string>[] | null) => (
          <Box sx={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {(selected ?? []).map(({ value: v }) => (
              <Chip key={v} size="sm" variant="soft" color={chipColor}>
                {TOOL_MAPPING[v as keyof typeof TOOL_MAPPING]?.displayName ?? v}
              </Chip>
            ))}
          </Box>
        )}
        sx={{
          border: '1px solid',
          borderColor: 'border.input',
          backgroundColor: 'background.panel',
          boxShadow: 'none',
        }}
        data-testid={testId}
      >
        {PICKABLE_TOOLS.map(tool => (
          <Option key={tool} value={tool}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ width: '100%' }}>
              <span>{TOOL_MAPPING[tool as keyof typeof TOOL_MAPPING]?.displayName ?? tool}</span>
              {showApprovalBadges && TOOLS_REQUIRING_APPROVAL.has(tool) && (
                <Chip size="sm" variant="outlined" startDecorator={<LockOutlinedIcon fontSize="small" />}>
                  needs approval
                </Chip>
              )}
            </Stack>
          </Option>
        ))}
      </Select>
      {helper && (
        <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
          {helper}
        </Typography>
      )}
    </FormControl>
  );
};

interface ChipInputFieldProps {
  label: string;
  helper?: string;
  testId: string;
  values: string[];
  readOnly: boolean;
  onAdd: (text: string) => void;
  onRemoveByEntry: (entry: string) => void;
}

/**
 * Free-text chip input - user types a value, presses Enter, chip appears. Used
 * for opaque identifiers (MCP server names) where we don't have a known
 * registry to populate a picker.
 *
 * Both `onKeyDown(Enter)` and `onBlur` call `commit()`. The empty-input guard
 * lives downstream in `handleAddChip` - `commit()` with no text is a no-op, so
 * "type then click away" and "type then press Enter" produce the same result.
 */
const ChipInputField: React.FC<ChipInputFieldProps> = ({
  label,
  helper,
  testId,
  values,
  readOnly,
  onAdd,
  onRemoveByEntry,
}) => {
  const [draft, setDraft] = useState('');

  const commit = useCallback(() => {
    onAdd(draft);
    setDraft('');
  }, [draft, onAdd]);

  return (
    <FormControl size="sm">
      <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>{label}</FormLabel>
      <Input
        size="sm"
        placeholder="Type and press Enter"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        readOnly={readOnly}
        sx={{
          border: '1px solid',
          borderColor: 'border.input',
          backgroundColor: 'background.panel',
          boxShadow: 'none',
        }}
        data-testid={`${testId}-input`}
      />
      {values.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }} data-testid={`${testId}-chips`}>
          {values.map(entry => (
            <Chip
              key={entry}
              size="sm"
              variant="soft"
              endDecorator={
                !readOnly && (
                  <IconButton size="sm" variant="plain" onClick={() => onRemoveByEntry(entry)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                )
              }
            >
              {entry}
            </Chip>
          ))}
        </Box>
      )}
      {helper && (
        <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
          {helper}
        </Typography>
      )}
    </FormControl>
  );
};

interface ModelChipPickerFieldProps {
  label: string;
  helper?: string;
  testId: string;
  values: string[];
  models: Array<{ id: string; name: string }>;
  readOnly: boolean;
  onAdd: (text: string) => void;
  onRemoveByEntry: (entry: string) => void;
}

/**
 * Same shape as `ChipInputField` but with a model dropdown - fallback models
 * have a known registry (the user's accessible models), so a picker is better
 * UX than free-text.
 */
const ModelChipPickerField: React.FC<ModelChipPickerFieldProps> = ({
  label,
  helper,
  testId,
  values,
  models,
  readOnly,
  onAdd,
  onRemoveByEntry,
}) => {
  const [selected, setSelected] = useState<string>('');

  const available = useMemo(() => models.filter(m => !values.includes(m.id)), [models, values]);

  return (
    <FormControl size="sm">
      <FormLabel sx={{ fontWeight: 400, color: 'text.primary50' }}>{label}</FormLabel>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Select
          size="sm"
          value={selected}
          onChange={(_e, v) => setSelected(v ?? '')}
          placeholder="Select a model"
          disabled={readOnly || available.length === 0}
          indicator={<KeyboardArrowDownIcon />}
          sx={{
            flex: 1,
            border: '1px solid',
            borderColor: 'border.input',
            backgroundColor: 'background.panel',
            boxShadow: 'none',
          }}
          data-testid={`${testId}-select`}
        >
          {available.map(m => (
            <Option key={m.id} value={m.id}>
              {m.name}
            </Option>
          ))}
        </Select>
        <IconButton
          size="sm"
          variant="soft"
          onClick={() => {
            if (selected) {
              onAdd(selected);
              setSelected('');
            }
          }}
          disabled={readOnly || !selected}
          data-testid={`${testId}-add-btn`}
        >
          <AddIcon fontSize="small" />
        </IconButton>
      </Box>
      {values.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }} data-testid={`${testId}-chips`}>
          {values.map(entry => {
            const model = models.find(m => m.id === entry);
            return (
              <Chip
                key={entry}
                size="sm"
                variant="soft"
                endDecorator={
                  !readOnly && (
                    <IconButton size="sm" variant="plain" onClick={() => onRemoveByEntry(entry)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  )
                }
              >
                {model?.name ?? entry}
              </Chip>
            );
          })}
        </Box>
      )}
      {helper && (
        <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
          {helper}
        </Typography>
      )}
    </FormControl>
  );
};

export default OrchestrationSection;
