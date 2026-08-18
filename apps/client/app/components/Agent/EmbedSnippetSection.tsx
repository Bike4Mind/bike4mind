import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Chip,
  FormLabel,
  IconButton,
  Input,
  Option,
  Select,
  Textarea,
  ToggleButtonGroup,
  Button,
  Tooltip,
  Typography,
} from '@mui/joy';
import CodeIcon from '@mui/icons-material/Code';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { getAgentEmbedKeys, type AgentEmbedKey } from '@client/app/utils/agentsAPICalls';
import { isModellessAgent, ModellessAgentAlert } from '@client/app/components/common/ModellessAgentWarning';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';
import {
  buildIframeSnippet,
  buildScriptSnippet,
  EMBED_KEY_PLACEHOLDER,
  type EmbedSnippetParams,
} from '@client/app/utils/embedSnippet';

export interface EmbedSnippetSectionProps {
  agentId: string;
  /** Used for the iframe snippet's accessible title. */
  agentName?: string;
  /** Live form value; '' or unset means the agent is on the system default model. */
  preferredModel?: string;
  testIdPrefix?: string;
}

type SnippetFormat = 'script' | 'iframe';

/**
 * Copy-paste embed code for an agent's existing embed keys. Read-only over
 * keys: raw secrets are shown once at mint time and are not recoverable, so
 * the snippet carries a placeholder unless the user pastes their key here -
 * the paste stays in local state and is never sent anywhere.
 */
export function EmbedSnippetSection({
  agentId,
  agentName,
  preferredModel,
  testIdPrefix = 'agent-embed-snippet',
}: EmbedSnippetSectionProps) {
  // null = loading; 'error' = fetch failed (distinct from an empty list so a
  // transient failure reads as "couldn't load" not "no keys exist").
  const [keys, setKeys] = useState<AgentEmbedKey[] | null | 'error'>(null);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [format, setFormat] = useState<SnippetFormat>('script');
  const [pastedKey, setPastedKey] = useState('');

  useEffect(() => {
    let active = true;
    getAgentEmbedKeys(agentId)
      .then(list => {
        if (!active) return;
        setKeys(list);
        setSelectedKeyId(prev => prev ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (active) setKeys('error');
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  const keyList = Array.isArray(keys) ? keys : [];
  const selectedKey = keyList.find(k => k.id === selectedKeyId) ?? null;

  const snippet = useMemo(() => {
    if (!selectedKey) return '';
    const params: EmbedSnippetParams = {
      baseUrl: window.location.origin,
      embedKey: pastedKey.trim() || EMBED_KEY_PLACEHOLDER,
      title: agentName,
    };
    return format === 'script' ? buildScriptSnippet(params) : buildIframeSnippet(params);
  }, [selectedKey, format, pastedKey, agentName]);

  const copySnippet = () => copyTextWithToast(snippet, 'Embed code copied to clipboard!');

  if (keys === null) return null;

  return (
    <Box data-testid={`${testIdPrefix}-section`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <CodeIcon fontSize="small" />
        <FormLabel sx={{ mb: 0 }}>Embed on your site</FormLabel>
      </Box>
      {isModellessAgent({ preferredModel }) && <ModellessAgentAlert testId={`${testIdPrefix}-model-warning`} />}
      {keys === 'error' ? (
        <Typography level="body-sm" color="danger" sx={{ opacity: 0.85 }} data-testid={`${testIdPrefix}-error`}>
          Couldn&apos;t load embed keys for this agent. Please refresh to try again.
        </Typography>
      ) : keys.length === 0 ? (
        <Typography level="body-sm" sx={{ opacity: 0.75 }} data-testid={`${testIdPrefix}-empty`}>
          No embed keys are provisioned for this agent yet. Embed keys are minted by an organization administrator; once
          one exists, the copy-paste embed code appears here.
        </Typography>
      ) : (
        <>
          <Typography level="body-xs" sx={{ opacity: 0.75, mb: 1 }}>
            The widget only loads on the origins allow-listed on the key. Raw keys are shown once at mint time - paste
            yours below to complete the snippet, or copy it with the placeholder.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1 }}>
            <Select
              size="sm"
              value={selectedKeyId}
              onChange={(_e, value) => setSelectedKeyId(value)}
              sx={{ minWidth: 220 }}
              data-testid={`${testIdPrefix}-key-select`}
            >
              {keys.map(key => (
                <Option key={key.id} value={key.id}>
                  {key.name} ({key.keyPrefix})
                </Option>
              ))}
            </Select>
            <ToggleButtonGroup
              size="sm"
              value={format}
              onChange={(_e, value) => value && setFormat(value as SnippetFormat)}
            >
              <Button value="script" data-testid={`${testIdPrefix}-format-script`}>
                Script tag
              </Button>
              <Button value="iframe" data-testid={`${testIdPrefix}-format-iframe`}>
                Iframe
              </Button>
            </ToggleButtonGroup>
          </Box>
          {selectedKey && selectedKey.allowedOrigins.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
              {selectedKey.allowedOrigins.map(origin => (
                <Chip key={origin} size="sm" variant="soft">
                  {origin}
                </Chip>
              ))}
            </Box>
          )}
          <Input
            size="sm"
            placeholder="b4m_... (optional - stays in your browser)"
            value={pastedKey}
            onChange={e => setPastedKey(e.target.value)}
            sx={{ mb: 1, maxWidth: 420 }}
            slotProps={{ input: { 'data-testid': `${testIdPrefix}-key-input` } }}
          />
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <Textarea
              size="sm"
              value={snippet}
              readOnly
              minRows={2}
              sx={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}
              slotProps={{ textarea: { 'data-testid': `${testIdPrefix}-snippet` } }}
            />
            <Tooltip title="Copy embed code">
              <IconButton size="sm" onClick={copySnippet} data-testid={`${testIdPrefix}-copy`}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        </>
      )}
    </Box>
  );
}

export default EmbedSnippetSection;
