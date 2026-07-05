import React, { useCallback, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Chip,
  Card,
  CardContent,
  Stack,
  Divider,
  IconButton,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Tooltip,
} from '@mui/joy';
import { ModelTraining, Thermostat, Token, Speed, Close, Timer, Code, Warning, ContentCopy } from '@mui/icons-material';
import { PromptMeta } from '@bike4mind/common';
import Draggable from 'react-draggable';
import type { DraggableEvent, DraggableData } from 'react-draggable';

const DraggableComponent = Draggable as any;
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import MemoryIcon from '@mui/icons-material/Memory';
import ImageIcon from '@mui/icons-material/Image';
import FunctionsIcon from '@mui/icons-material/Functions';
import FolderIcon from '@mui/icons-material/Folder';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import BarChartIcon from '@mui/icons-material/BarChart';
import BugReportIcon from '@mui/icons-material/BugReport';
import HistoryIcon from '@mui/icons-material/History';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import dayjs from 'dayjs';
import ContextVisualizer from './ContextVisualizer';
import StatusTimeline from './StatusTimeline';
import { toast } from 'sonner';

export const usePromptMetaInspector = create<{
  promptMeta: PromptMeta | null;
  replies: string[] | null;
  setPromptMeta: (promptMeta: PromptMeta | null, replies?: string[] | null) => void;
  position: { x: number; y: number };
  setPosition: (x: number, y: number) => void;
}>(set => ({
  promptMeta: null,
  replies: null,
  setPromptMeta: (promptMeta, replies = null) => set({ promptMeta, replies }),
  position: { x: 0, y: 0 },
  setPosition: (x, y) => set({ position: { x, y } }),
}));

const PromptMetaInspector = () => {
  const [position, setPosition] = usePromptMetaInspector(useShallow(state => [state.position, state.setPosition]));
  const promptMeta = usePromptMetaInspector(state => state.promptMeta);
  const replies = usePromptMetaInspector(state => state.replies);
  const setPromptMeta = usePromptMetaInspector(state => state.setPromptMeta);
  const closeMetaInspector = useCallback(() => setPromptMeta(null), [setPromptMeta]);
  const totalActualTokens =
    (promptMeta?.tokenUsage?.actualInputTokens || 0) + (promptMeta?.tokenUsage?.actualOutputTokens || 0);

  const [activeTab, setActiveTab] = useState<string>('details');

  // Fix for findDOMNode deprecation warning
  const nodeRef = useRef(null);

  // Copy reply to clipboard (text only)
  const handleCopyReply = () => {
    if (replies && replies.length > 0) {
      const replyText = typeof replies[0] === 'string' ? replies[0] : JSON.stringify(replies[0]);
      navigator.clipboard.writeText(replyText);
      toast.success('Reply text copied to clipboard!');
    }
  };

  // Copy reply metadata JSON to clipboard
  const handleCopyReplyJSON = () => {
    if (replies && replies.length > 0) {
      navigator.clipboard.writeText(JSON.stringify(replies, null, 2));
      toast.success('Reply JSON copied to clipboard!');
    }
  };

  // Copy debug JSON to clipboard
  const handleCopyDebug = () => {
    if (promptMeta) {
      navigator.clipboard.writeText(JSON.stringify(promptMeta, null, 2));
      toast.success('Debug data copied to clipboard!');
    }
  };

  // Copy debug data as markdown for AI analysis
  const handleCopyMarkdown = () => {
    if (!promptMeta) return;

    const generatedAtRaw = (promptMeta as any).generatedAt || (promptMeta as any).createdAt;
    const generatedDisplay = generatedAtRaw
      ? `${dayjs(generatedAtRaw).format('YYYY-MM-DD HH:mm:ss')} (${generatedAtRaw})`
      : `${dayjs().format('YYYY-MM-DD HH:mm:ss')} (report copy time — server did not stamp generatedAt)`;

    const markdown = `# AI Request Debug Report

**Generated:** ${generatedDisplay}

## Model Configuration
- **Model**: ${promptMeta.model?.name || 'N/A'}
- **Temperature**: ${promptMeta.model?.parameters?.temperature ?? 'N/A'}
- **Top P**: ${promptMeta.model?.parameters?.topP ?? 'N/A'}
- **Max Tokens**: ${promptMeta.model?.parameters?.maxTokens ?? 'N/A'}

## Tools Configuration
- **Tools Sent to Model**: ${(promptMeta as any).tools?.length > 0 ? (promptMeta as any).tools.map((t: any) => t.toolSchema?.name || t.name || 'unknown').join(', ') : 'NONE (empty array)'}
- **Tools Count**: ${(promptMeta as any).tools?.length ?? 0}
- **Function Calls Made**: ${promptMeta.functionCalls?.length ?? 0}

## Token Usage
- **Input Tokens**: ${promptMeta.tokenUsage?.inputTokens ?? 'N/A'} (actual: ${promptMeta.tokenUsage?.actualInputTokens ?? 'N/A'})
- **Output Tokens**: ${promptMeta.tokenUsage?.outputTokens ?? 'N/A'} (actual: ${promptMeta.tokenUsage?.actualOutputTokens ?? 'N/A'})
- **Total**: ${promptMeta.tokenUsage?.totalTokens ?? 'N/A'} (actual: ${(promptMeta.tokenUsage?.actualInputTokens || 0) + (promptMeta.tokenUsage?.actualOutputTokens || 0)})

## Performance
- **Total Response Time**: ${promptMeta.performance?.totalResponseTime ?? 'N/A'} ms
- **Context Retrieval**: ${promptMeta.performance?.contextRetrievalTime ?? 'N/A'} ms
- **Model Inference**: ${promptMeta.performance?.modelInferenceTime ?? 'N/A'} ms
- **First Token**: ${promptMeta.performance?.firstTokenTime ?? 'N/A'} ms

## Context
- **Prompt**: ${promptMeta.prompt?.substring(0, 200) ?? 'N/A'}${(promptMeta.prompt?.length || 0) > 200 ? '...' : ''}
- **Message History Length**: ${promptMeta.context?.messageHistoryLength ?? 'N/A'}
- **Total Message Count**: ${promptMeta.context?.totalMessageCount ?? 'N/A'}
- **Attached Files**: ${promptMeta.context?.attachedFiles?.length ?? 0}
- **Knowledge Base Entries**: ${promptMeta.context?.knowledgeBaseEntries?.length ?? 0}

## Session
- **Session ID**: ${(promptMeta.session?.id as string) || 'N/A'}
- **User ID**: ${promptMeta.session?.userId || 'N/A'}
- **Quest ID**: ${(promptMeta.questId as string) || 'N/A'}

## Issues
${(promptMeta as any).tools?.length === 0 ? '⚠️ **CRITICAL**: Tools array is empty - no tools were sent to the model!' : ''}
${promptMeta.functionCalls?.length === 0 && (promptMeta as any).tools?.length > 0 ? '⚠️ **WARNING**: Tools were sent but none were called by the model' : ''}
${promptMeta.warnings?.length ? promptMeta.warnings.map((w: string) => `⚠️ ${w}`).join('\n') : ''}
${promptMeta.promptErrors?.length ? promptMeta.promptErrors.map((e: string) => `❌ ${e}`).join('\n') : ''}
`;

    navigator.clipboard.writeText(markdown);
    toast.success('Debug markdown copied to clipboard!');
  };

  if (!promptMeta) return null;

  return (
    <DraggableComponent
      nodeRef={nodeRef}
      handle=".drag-handle"
      position={position}
      onDrag={(e: DraggableEvent, data: DraggableData) => setPosition(data.x, data.y)}
      onStop={(e: DraggableEvent, data: DraggableData) => setPosition(data.x, data.y)}
      bounds="parent"
    >
      <Card
        ref={nodeRef}
        variant="solid"
        sx={theme => ({
          position: 'absolute',
          top: 0,
          backgroundColor: theme.palette.background.panel,
          zIndex: 1000000,
          maxWidth: 800,
          width: '100%',
        })}
      >
        <CardContent>
          <Stack direction="row" spacing={2} justifyContent="space-between" alignItems="center">
            <Box
              className="drag-handle"
              sx={{
                display: 'flex',
                justifyContent: 'center',
                cursor: 'grab',
                '&:active': { cursor: 'grabbing' },
                mb: 2,
              }}
            >
              <DragIndicatorIcon />
            </Box>

            <Typography id="prompt-meta-title" level="body-sm" startDecorator={<ModelTraining />}>
              Prompt Metadata
            </Typography>

            <IconButton onClick={closeMetaInspector}>
              <Close />
            </IconButton>
          </Stack>

          <Divider sx={{ my: 2, borderColor: 'gray' }} />

          {/* Tabs for different views */}
          <Tabs
            value={activeTab}
            onChange={(event, newValue) => setActiveTab(newValue as string)}
            sx={{ bgcolor: 'transparent' }}
          >
            <TabList>
              <Tab value="details">
                <Code sx={{ mr: 1 }} />
                Details
              </Tab>
              <Tab value="context">
                <BarChartIcon sx={{ mr: 1 }} />
                Context
              </Tab>
              <Tab value="status">
                <HistoryIcon sx={{ mr: 1 }} />
                Status Log
              </Tab>
              <Tab value="reply">
                <QuestionAnswerIcon sx={{ mr: 1 }} />
                Reply
              </Tab>
              <Tab value="debug">
                <BugReportIcon sx={{ mr: 1 }} />
                Debug
              </Tab>
            </TabList>

            {/* Tab Panel for Details */}
            <TabPanel value="details" sx={{ p: 0 }}>
              <Stack direction="row" spacing={1} sx={{ mb: 2, justifyContent: 'flex-end' }}>
                <Tooltip title="Copy details as Markdown">
                  <IconButton size="sm" variant="soft" color="success" onClick={handleCopyMarkdown}>
                    <ContentCopy />
                    MD
                  </IconButton>
                </Tooltip>
              </Stack>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  flexWrap: 'wrap',
                  gap: 2,
                }}
              >
                {/* Left Column */}
                <Box>
                  {/* Model Information */}
                  <Box>
                    <Typography level="body-sm" startDecorator={<Code />}>
                      Model Information
                    </Typography>
                    <Chip size="md" variant="soft" color="primary">
                      {promptMeta.model?.name || 'N/A'}
                    </Chip>
                    <Stack direction="row" spacing={1} flexWrap="wrap" mt={1}>
                      <Chip size="sm" variant="soft" color="neutral" startDecorator={<Thermostat />}>
                        Temp: {promptMeta.model?.parameters?.temperature ?? 'N/A'}
                      </Chip>
                      <Chip size="sm" variant="soft" color="neutral" startDecorator={<Token />}>
                        Top P: {promptMeta.model?.parameters?.topP ?? 'N/A'}
                      </Chip>
                      <Chip size="sm" variant="soft" color="neutral" startDecorator={<Token />}>
                        Max Tokens: {promptMeta.model?.parameters?.maxTokens ?? 'N/A'}
                      </Chip>
                    </Stack>
                  </Box>

                  {/* Token Usage */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<Token />}>
                      Token Usage (Computed/Actual)
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      <Chip size="sm" variant="soft" color="success">
                        Input: {promptMeta.tokenUsage?.inputTokens ?? 'N/A'}/
                        {promptMeta.tokenUsage?.actualInputTokens ?? 'N/A'}
                      </Chip>
                      <Chip size="sm" variant="soft" color="success">
                        Output: {promptMeta.tokenUsage?.outputTokens ?? 'N/A'}/
                        {promptMeta.tokenUsage?.actualOutputTokens ?? 'N/A'}
                      </Chip>
                      <Chip size="sm" variant="soft" color="success">
                        Total: {promptMeta.tokenUsage?.totalTokens ?? 'N/A'}/
                        {totalActualTokens ? totalActualTokens : 'N/A'}
                      </Chip>
                    </Stack>
                  </Box>

                  {/* Performance */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<Speed />}>
                      Performance
                    </Typography>
                    <Stack spacing={1}>
                      <Chip size="sm" variant="soft" color="warning" startDecorator={<Timer />}>
                        Total Response Time: {promptMeta.performance?.totalResponseTime ?? 'N/A'} ms
                      </Chip>
                      <Chip size="sm" variant="soft" color="warning" startDecorator={<Timer />}>
                        Context Retrieval Time: {promptMeta.performance?.contextRetrievalTime ?? 'N/A'} ms
                      </Chip>
                      <Chip size="sm" variant="soft" color="warning" startDecorator={<Timer />}>
                        Model Inference Time: {promptMeta.performance?.modelInferenceTime ?? 'N/A'} ms
                      </Chip>
                    </Stack>
                  </Box>

                  {/* Session Information */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<AccountCircleIcon />}>
                      Session Information
                    </Typography>
                    <Stack spacing={1}>
                      <Chip variant="soft">Session ID: {(promptMeta.session?.id as string) || 'N/A'}</Chip>
                      <Chip variant="soft" color="primary">
                        User ID: {promptMeta.session?.userId || 'N/A'}
                      </Chip>
                      <Chip variant="soft" color="neutral" startDecorator={<Timer />}>
                        Generated:{' '}
                        {(promptMeta as any).generatedAt || (promptMeta as any).createdAt
                          ? dayjs((promptMeta as any).generatedAt || (promptMeta as any).createdAt).format(
                              'YYYY-MM-DD HH:mm:ss'
                            )
                          : 'N/A'}
                      </Chip>
                      <Chip variant="soft" color="neutral" startDecorator={<Timer />}>
                        Updated:{' '}
                        {(promptMeta as any).updatedAt
                          ? dayjs((promptMeta as any).updatedAt).format('YYYY-MM-DD HH:mm:ss')
                          : 'N/A'}
                      </Chip>
                    </Stack>
                  </Box>

                  {/* Warnings */}
                  {promptMeta.warnings && promptMeta.warnings.length > 0 && (
                    <Box sx={{ mt: 2 }}>
                      <Typography level="body-sm" startDecorator={<Warning color="warning" />}>
                        Warnings
                      </Typography>
                      <Stack spacing={1}>
                        {promptMeta.warnings.map((warning, index) => (
                          <Chip key={index} variant="soft" color="warning">
                            {warning}
                          </Chip>
                        ))}
                      </Stack>
                    </Box>
                  )}

                  {/* Errors */}
                  {promptMeta.promptErrors && promptMeta.promptErrors.length > 0 && (
                    <Box sx={{ mt: 2 }}>
                      <Typography level="body-sm" startDecorator={<Warning color="error" />}>
                        Errors
                      </Typography>
                      <Stack spacing={1}>
                        {promptMeta.promptErrors.map((error, index) => (
                          <Chip key={index} variant="soft" color="danger">
                            {error}
                          </Chip>
                        ))}
                      </Stack>
                    </Box>
                  )}
                </Box>

                {/* Right Column */}
                <Box>
                  {/* Context Information */}
                  <Box>
                    <Typography level="body-sm" startDecorator={<MemoryIcon />}>
                      Context Information
                    </Typography>
                    <Stack spacing={1}>
                      <Typography level="body-sm">Prompt:</Typography>
                      <Box
                        sx={{
                          height: '100px',
                          maxHeight: '100px',
                          maxWidth: '100%',
                          overflow: 'auto',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'wrap',
                          padding: 1,
                          borderRadius: 1,
                        }}
                      >
                        <Typography level="body-xs">{promptMeta.prompt?.slice(0, 1000) ?? 'N/A'}</Typography>
                      </Box>
                      <Stack direction="column" spacing={1} flexWrap="wrap">
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          <Typography level="body-xs">Prompt and Reply History:</Typography>
                          <Chip size="sm" variant="soft" color="primary">
                            {promptMeta.context?.totalMessageCount ?? 'N/A'}
                          </Chip>
                        </Stack>
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          <Typography level="body-xs">Total Prompt Messages:</Typography>
                          <Chip size="sm" variant="soft" color="primary">
                            {promptMeta.context?.messageHistoryLength ?? 'N/A'}
                          </Chip>
                        </Stack>
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          <Typography level="body-xs">History Settings:</Typography>
                          <Chip size="sm" variant="soft" color="primary">
                            {promptMeta.context?.requestedHistoryCount === 14
                              ? 'All'
                              : (promptMeta.context?.requestedHistoryCount ?? 'N/A')}
                          </Chip>
                        </Stack>
                      </Stack>
                    </Stack>
                  </Box>

                  {/* System Prompt Sources */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<MemoryIcon />}>
                      System Prompt Sources
                    </Typography>
                    <Stack spacing={1}>
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        <Typography level="body-xs">Total System Prompts:</Typography>
                        <Chip size="sm" variant="soft" color="warning">
                          {promptMeta.context?.totalSystemPromptCount ?? 'N/A'}
                        </Chip>
                        {promptMeta.context?.duplicateSystemPromptCount &&
                          promptMeta.context.duplicateSystemPromptCount > 0 && (
                            <Chip size="sm" variant="soft" color="danger">
                              {promptMeta.context.duplicateSystemPromptCount} duplicates!
                            </Chip>
                          )}
                      </Stack>
                      {promptMeta.context?.systemPromptSources && promptMeta.context.systemPromptSources.length > 0 && (
                        <Box>
                          <Typography level="body-xs">Sources:</Typography>
                          {promptMeta.context.systemPromptSources.map((source, index) => (
                            <Stack key={index} direction="row" spacing={1} sx={{ mb: 0.5 }}>
                              <Chip
                                size="sm"
                                variant="solid"
                                color={
                                  source.source === 'admin'
                                    ? 'danger'
                                    : source.source === 'project'
                                      ? 'warning'
                                      : source.source === 'user'
                                        ? 'primary'
                                        : source.source === 'session'
                                          ? 'success'
                                          : 'neutral'
                                }
                              >
                                {source.source}
                              </Chip>
                              <Typography level="body-xs">
                                {source.fileName || source.fileId}
                                {source.priority && ` (Priority: ${source.priority})`}
                              </Typography>
                            </Stack>
                          ))}
                        </Box>
                      )}
                    </Stack>
                  </Box>

                  {/* Quest and Prompt IDs */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<QuestionAnswerIcon />}>
                      IDs
                    </Typography>
                    <Stack spacing={1}>
                      <Chip size="sm" variant="soft">
                        Quest ID: {(promptMeta.questId as string) || 'N/A'}
                      </Chip>
                      {promptMeta.replyIds && promptMeta.replyIds.length > 0 && (
                        <Box>
                          <Typography level="body-sm">Reply IDs:</Typography>
                          <Stack direction="row" spacing={1} flexWrap="wrap">
                            {promptMeta.replyIds && promptMeta.replyIds.length > 0 ? (
                              promptMeta.replyIds.map((id, index) => (
                                <Chip key={index} size="sm" variant="soft">
                                  {id as string}
                                </Chip>
                              ))
                            ) : (
                              <Chip size="sm" variant="soft">
                                N/A
                              </Chip>
                            )}
                          </Stack>
                        </Box>
                      )}
                    </Stack>
                  </Box>

                  {/* Generated Image References */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<ImageIcon />}>
                      Generated Images
                    </Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {promptMeta.generatedImageReferences && promptMeta.generatedImageReferences.length > 0 ? (
                        promptMeta.generatedImageReferences.map((ref, index) => (
                          <Chip key={index} size="sm" variant="soft" color="success">
                            {ref}
                          </Chip>
                        ))
                      ) : (
                        <Chip size="sm" variant="soft" color="success">
                          N/A
                        </Chip>
                      )}
                    </Stack>
                  </Box>

                  {/* Knowledge Base Entries */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm">Knowledge Base Entries:</Typography>
                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      {promptMeta.context?.knowledgeBaseEntries &&
                      promptMeta.context?.knowledgeBaseEntries.length > 0 ? (
                        promptMeta.context?.knowledgeBaseEntries?.map((entry, index) => (
                          <Chip key={index} size="sm" variant="soft" color="primary" startDecorator={<FolderIcon />}>
                            {entry}
                          </Chip>
                        ))
                      ) : (
                        <Chip size="sm" variant="soft" color="primary">
                          N/A
                        </Chip>
                      )}
                    </Stack>
                  </Box>

                  {/* Attached Files */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<AttachFileIcon />}>
                      Attached Files
                    </Typography>
                    <Stack spacing={1}>
                      {promptMeta.context?.attachedFiles && promptMeta.context?.attachedFiles.length > 0 ? (
                        promptMeta.context.attachedFiles.map((file, index) => (
                          <Chip key={index} size="sm" variant="soft" color="primary">
                            {file.name || 'Unnamed File'}
                          </Chip>
                        ))
                      ) : (
                        <Chip size="sm" variant="soft" color="primary">
                          N/A
                        </Chip>
                      )}
                    </Stack>
                  </Box>

                  {/* Tools Configuration */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<FunctionsIcon />}>
                      Tools Configuration
                    </Typography>
                    <Stack spacing={1}>
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        <Typography level="body-xs">Tools Sent to Model:</Typography>
                        <Chip
                          size="sm"
                          variant="soft"
                          color={(promptMeta as any).tools?.length > 0 ? 'success' : 'danger'}
                        >
                          {(promptMeta as any).tools?.length ?? 0} tools
                        </Chip>
                      </Stack>
                      {(promptMeta as any).tools && (promptMeta as any).tools.length > 0 ? (
                        <Box>
                          <Typography level="body-xs">Available Tools:</Typography>
                          <Stack direction="row" spacing={1} flexWrap="wrap">
                            {(promptMeta as any).tools.map((tool: any, index: number) => (
                              <Chip key={index} size="sm" variant="soft" color="primary">
                                {tool.toolSchema?.name || tool.name || 'unknown'}
                              </Chip>
                            ))}
                          </Stack>
                        </Box>
                      ) : (
                        <Chip size="sm" variant="soft" color="danger">
                          ⚠️ No tools sent (empty array)
                        </Chip>
                      )}
                    </Stack>
                  </Box>

                  {/* Function Calls */}
                  <Box sx={{ mt: 2 }}>
                    <Typography level="body-sm" startDecorator={<FunctionsIcon />}>
                      Function Calls (Tools Used)
                    </Typography>
                    {promptMeta.functionCalls && promptMeta.functionCalls.length > 0 ? (
                      promptMeta.functionCalls.map((funcCall, index) => (
                        <Box key={index} sx={{ mb: 1 }}>
                          <Typography level="body-sm">Name: {funcCall.name || 'N/A'}</Typography>
                          <Typography level="body-sm">Parameters:</Typography>
                          <Stack direction="row" spacing={1} flexWrap="wrap">
                            {funcCall.parameters
                              ? Object.entries(funcCall.parameters).map(([key, value], idx) => (
                                  <Chip key={idx} size="sm" variant="soft" color="secondary">
                                    {key}: {typeof value === 'object' && value !== null ? JSON.stringify(value) : value}
                                  </Chip>
                                ))
                              : 'N/A'}
                          </Stack>
                          <Typography level="body-sm">Return Value: {funcCall.returnValue || 'N/A'}</Typography>
                        </Box>
                      ))
                    ) : (
                      <Chip size="sm" variant="soft" color="neutral">
                        No tools called
                      </Chip>
                    )}
                  </Box>
                </Box>
              </Box>
            </TabPanel>

            {/* Tab Panel for Context Usage */}
            <TabPanel value="context" sx={{ p: 0 }}>
              <ContextVisualizer promptMeta={promptMeta} />
            </TabPanel>

            {/* Tab Panel for Status Log */}
            <TabPanel value="status" sx={{ p: 0 }}>
              {promptMeta.statusLog && promptMeta.statusLog.length > 0 ? (
                <StatusTimeline statusLog={promptMeta.statusLog} />
              ) : (
                <Box sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                    No status log entries
                  </Typography>
                </Box>
              )}
            </TabPanel>

            {/* Tab Panel for Reply Data */}
            <TabPanel value="reply" sx={{ p: 0 }}>
              {replies && replies.length > 0 ? (
                <Tabs defaultValue={0} sx={{ bgcolor: 'transparent' }}>
                  <TabList>
                    <Tab value={0}>
                      <QuestionAnswerIcon sx={{ mr: 1, fontSize: '1rem' }} />
                      Text View
                    </Tab>
                    <Tab value={1}>
                      <Code sx={{ mr: 1, fontSize: '1rem' }} />
                      JSON View
                    </Tab>
                  </TabList>

                  {/* Text View */}
                  <TabPanel value={0} sx={{ p: 0, mt: 2 }}>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                        Reply {replies.length > 1 ? '(first of ' + replies.length + ')' : ''}
                      </Typography>
                      <IconButton size="sm" variant="soft" color="primary" onClick={handleCopyReply}>
                        <ContentCopy />
                      </IconButton>
                    </Stack>
                    <Box
                      sx={{
                        height: '500px',
                        overflow: 'auto',
                        backgroundColor: 'background.level1',
                        padding: 2,
                        borderRadius: 1,
                        fontFamily: 'monospace',
                        fontSize: '12px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                        {typeof replies[0] === 'string' ? replies[0] : JSON.stringify(replies[0], null, 2)}
                      </Typography>
                    </Box>
                  </TabPanel>

                  {/* JSON View */}
                  <TabPanel value={1} sx={{ p: 0, mt: 2 }}>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                        Raw Reply Array ({replies.length} {replies.length === 1 ? 'reply' : 'replies'})
                      </Typography>
                      <IconButton size="sm" variant="soft" color="primary" onClick={handleCopyReplyJSON}>
                        <ContentCopy />
                      </IconButton>
                    </Stack>
                    <Box
                      sx={{
                        height: '500px',
                        overflow: 'auto',
                        backgroundColor: 'background.level1',
                        padding: 2,
                        borderRadius: 1,
                        fontFamily: 'monospace',
                        fontSize: '12px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                        {JSON.stringify(replies, null, 2)}
                      </Typography>
                    </Box>
                  </TabPanel>
                </Tabs>
              ) : (
                <Box sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                    No reply data available
                  </Typography>
                </Box>
              )}
            </TabPanel>

            {/* Tab Panel for Debug Data */}
            <TabPanel value="debug" sx={{ p: 0 }}>
              <Stack direction="row" spacing={1} sx={{ mb: 2, justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  Prompt Metadata JSON
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Tooltip title="Copy as Markdown for AI debugging">
                    <IconButton size="sm" variant="soft" color="success" onClick={handleCopyMarkdown}>
                      <ContentCopy />
                      MD
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Copy as JSON">
                    <IconButton size="sm" variant="soft" color="primary" onClick={handleCopyDebug}>
                      <ContentCopy />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
              <Box
                sx={{
                  height: '500px',
                  overflow: 'auto',
                  backgroundColor: 'background.level1',
                  padding: 2,
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                  {JSON.stringify(promptMeta, null, 2)}
                </Typography>
              </Box>
            </TabPanel>
          </Tabs>
        </CardContent>
      </Card>
    </DraggableComponent>
  );
};

export default PromptMetaInspector;
