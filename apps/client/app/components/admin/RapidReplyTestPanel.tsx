import React, { useState } from 'react';
import { Alert, Box, Button, FormControl, FormHelperText, FormLabel, Option, Select, Stack, Textarea } from '@mui/joy';
import type { ModelInfo } from '@bike4mind/common';
import { useTestConfiguration } from '@client/app/hooks/data/rapidReplyMutations';
import { getErrorMessage } from '@client/app/utils/error';
import {
  AdminPageHeader,
  DataTable,
  Fact,
  SectionCard,
  SettingsSection,
  StatStrip,
  StatTile,
  StatusChip,
  type DataColumn,
} from './shared';

/** The response of POST /api/admin/rapid-reply/test; every block is absent on an early return. */
export interface RapidReplyTestResult {
  success: boolean;
  message?: string;
  error?: string;
  testResults?: {
    enabled?: boolean;
    reason?: string;
    configuration?: {
      mainModel?: string;
      rapidModel?: string;
      maxTokens?: number;
      responseStyle?: string;
      systemPrompt?: string;
      maxLatency?: number;
    };
    performance?: {
      ttfvt?: number;
      latency?: number;
      responseLength?: number;
      maxConfiguredLatency?: number;
      estimatedCost?: number;
      tokensUsed?: number;
      latencyCheck?: { passed: boolean; message: string };
    };
    rapidReplyTest?: {
      success?: boolean;
      testInput?: string;
      response?: string;
      error?: string;
      responseLength?: number;
      responseWordCount?: number;
    };
    prompts?: {
      total?: number;
      active?: number;
      applicable?: { id: string; name: string; domains?: string[] }[];
    };
    settings?: {
      globalEnabled?: boolean;
      allowedUserTags?: string[];
      transitionMode?: string;
      showIndicator?: boolean;
      fallbackBehavior?: string;
    };
  };
  recommendations?: string[];
}

type TestHistoryEntry = {
  id: string;
  timestamp: string;
  modelId: string;
  testInput: string;
  success: boolean;
};

const QUICK_TEST_MESSAGES = [
  'Hello, how are you?',
  'Explain photosynthesis in simple terms',
  'Write a short poem about technology',
  'What is the capital of France?',
  'Help me debug this code: function test() { return "hello"; }',
];

const MAX_HISTORY = 10;

const yesNo = (value: boolean | undefined) =>
  value === undefined ? undefined : <StatusChip tone="neutral" label={value ? 'Yes' : 'No'} />;

const withMs = (value: number | undefined) => (value === undefined ? undefined : `${value.toLocaleString()} ms`);

const historyColumns: DataColumn<TestHistoryEntry>[] = [
  { id: 'model', label: 'Model', render: row => row.modelId },
  { id: 'ranAt', label: 'Ran at', render: row => new Date(row.timestamp).toLocaleTimeString() },
  {
    id: 'result',
    label: 'Result',
    width: '7rem',
    render: row => <StatusChip tone={row.success ? 'good' : 'bad'} label={row.success ? 'Passed' : 'Failed'} />,
  },
];

const TestResults: React.FC<{ result: RapidReplyTestResult }> = ({ result }) => {
  const { configuration, performance, rapidReplyTest, settings, prompts } = result.testResults ?? {};
  return (
    <Stack sx={{ gap: 2 }} data-testid="rapid-reply-test-results">
      <Alert color={result.success ? 'success' : 'warning'} data-testid="rapid-reply-test-summary">
        {result.message || result.error}
      </Alert>

      {performance && (
        <StatStrip aria-label="Test result">
          <StatTile label="Rapid reply latency" value={withMs(performance.latency) ?? '-'} />
          <StatTile label="TTFVT" value={withMs(performance.ttfvt) ?? '-'} />
          <StatTile label="Response length" value={performance.responseLength ?? 0} comparison="characters" />
        </StatStrip>
      )}

      {performance && (
        <SectionCard
          title="Performance"
          action={
            performance.latencyCheck && (
              <StatusChip
                tone={performance.latencyCheck.passed ? 'good' : 'bad'}
                label={performance.latencyCheck.passed ? 'Within limit' : 'Over limit'}
              />
            )
          }
        >
          <Fact label="Latency limit">{withMs(performance.maxConfiguredLatency)}</Fact>
          <Fact label="Latency check">{performance.latencyCheck?.message}</Fact>
          <Fact label="Tokens used">{performance.tokensUsed?.toLocaleString()}</Fact>
          <Fact label="Estimated cost">
            {performance.estimatedCost === undefined ? undefined : `$${performance.estimatedCost.toFixed(4)}`}
          </Fact>
        </SectionCard>
      )}

      {rapidReplyTest && (
        <SectionCard title="Rapid reply response" body="custom">
          <Stack sx={{ gap: 1.5, p: 2 }}>
            {rapidReplyTest.error && (
              <Alert color="danger" size="sm">
                {rapidReplyTest.error}
              </Alert>
            )}
            {rapidReplyTest.response && (
              <Box
                component="pre"
                data-testid="rapid-reply-test-response"
                sx={{
                  m: 0,
                  p: 1.5,
                  maxHeight: 200,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  color: 'admin.ink',
                  bgcolor: 'admin.surfaceSubtle',
                  border: '1px solid',
                  borderColor: 'admin.border',
                  borderRadius: 'sm',
                }}
              >
                {rapidReplyTest.response}
              </Box>
            )}
            <Box
              component="dl"
              sx={{
                m: 0,
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 40%) 1fr',
                columnGap: 1.5,
                rowGap: 1.25,
                fontSize: 14,
                '& dt': { color: 'admin.inkMuted' },
                '& dd': { m: 0, minWidth: 0, overflowWrap: 'anywhere', color: 'admin.ink' },
              }}
            >
              <Fact label="Test input">{rapidReplyTest.testInput}</Fact>
              <Fact label="Length">
                {rapidReplyTest.responseLength === undefined
                  ? undefined
                  : `${rapidReplyTest.responseLength.toLocaleString()} characters, ${(rapidReplyTest.responseWordCount ?? 0).toLocaleString()} words`}
              </Fact>
            </Box>
          </Stack>
        </SectionCard>
      )}

      {configuration && (
        <SectionCard title="Configuration">
          <Fact label="Main model">{configuration.mainModel}</Fact>
          <Fact label="Rapid model">{configuration.rapidModel}</Fact>
          <Fact label="Max tokens">{configuration.maxTokens}</Fact>
          <Fact label="Response style">{configuration.responseStyle}</Fact>
          <Fact label="Timeout">{withMs(configuration.maxLatency)}</Fact>
          <Fact label="System prompt">{configuration.systemPrompt}</Fact>
        </SectionCard>
      )}

      {settings && (
        <SectionCard title="Current settings">
          <Fact label="Enabled globally">{yesNo(settings.globalEnabled)}</Fact>
          <Fact label="Transition mode">{settings.transitionMode}</Fact>
          <Fact label="Show indicator">{yesNo(settings.showIndicator)}</Fact>
          <Fact label="Fallback behavior">{settings.fallbackBehavior}</Fact>
          <Fact label="Allowed user tags">{settings.allowedUserTags?.join(', ')}</Fact>
        </SectionCard>
      )}

      {prompts && (
        <SectionCard title="Prompts">
          <Fact label="Total">{prompts.total}</Fact>
          <Fact label="Active">{prompts.active}</Fact>
          {prompts.applicable?.map(prompt => (
            <Fact key={prompt.id} label={prompt.name}>
              {prompt.domains?.length ? prompt.domains.join(', ') : 'No domains'}
            </Fact>
          ))}
        </SectionCard>
      )}

      {result.recommendations && result.recommendations.length > 0 && (
        <SectionCard title="Recommendations" body="custom">
          <Box
            component="ul"
            data-testid="rapid-reply-test-recommendations"
            sx={{ m: 0, py: 1.75, pl: 4.5, pr: 2, fontSize: 14, color: 'admin.ink', '& li + li': { mt: 0.75 } }}
          >
            {result.recommendations.map(recommendation => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </Box>
        </SectionCard>
      )}
    </Stack>
  );
};

/** The Test view of the rapid reply page: run a test against one main model and read the result. */
export const RapidReplyTestPanel: React.FC<{ models: ModelInfo[] }> = ({ models }) => {
  const testConfiguration = useTestConfiguration();
  const [testModelId, setTestModelId] = useState('');
  const [testInput, setTestInput] = useState('Test message for rapid reply');
  const [history, setHistory] = useState<TestHistoryEntry[]>([]);
  const result = testConfiguration.data as RapidReplyTestResult | undefined;

  const runTest = async () => {
    if (!testModelId) return;
    try {
      const response = (await testConfiguration.mutateAsync({
        mainModelId: testModelId,
        testInput,
      })) as RapidReplyTestResult;
      setHistory(previous => [
        {
          id: `${Date.now()}`,
          timestamp: new Date().toISOString(),
          modelId: testModelId,
          testInput,
          success: response.success,
        },
        ...previous.slice(0, MAX_HISTORY - 1),
      ]);
    } catch {
      // The failure renders from testConfiguration.error below.
    }
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
        alignItems: 'start',
      }}
    >
      <Stack sx={{ gap: 2, minWidth: 0 }}>
        <SettingsSection component="section" sx={{ mb: 0 }} data-testid="rapid-reply-test-form">
          <Stack sx={{ gap: 2 }}>
            <FormControl>
              <FormLabel>Main model</FormLabel>
              <Select
                value={testModelId || null}
                onChange={(_, value) => setTestModelId(value ?? '')}
                placeholder="Pick a main model"
                data-testid="rapid-reply-test-model-select"
              >
                {models.map(model => (
                  <Option key={model.id} value={model.id}>
                    {model.name}
                  </Option>
                ))}
              </Select>
              <FormHelperText>The test runs through the mapping for this model.</FormHelperText>
            </FormControl>

            <FormControl>
              <FormLabel>Test message</FormLabel>
              <Textarea
                value={testInput}
                onChange={event => setTestInput(event.target.value)}
                minRows={3}
                placeholder="Enter a test message"
                data-testid="rapid-reply-test-input"
              />
            </FormControl>

            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }} aria-label="Sample messages">
              {QUICK_TEST_MESSAGES.map(message => (
                <Button
                  key={message}
                  size="sm"
                  variant="outlined"
                  onClick={() => setTestInput(message)}
                  title={message}
                  sx={{ maxWidth: '100%' }}
                >
                  <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {message.length > 30 ? `${message.substring(0, 30)}...` : message}
                  </Box>
                </Button>
              ))}
            </Stack>

            {testConfiguration.error && (
              <Alert color="danger" data-testid="rapid-reply-test-error">
                The test did not run: {getErrorMessage(testConfiguration.error)}
              </Alert>
            )}

            <Stack direction="row" sx={{ gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {!testModelId && (
                <FormHelperText sx={{ m: 0, mr: 'auto', alignSelf: 'center' }}>
                  Pick a main model to run a test.
                </FormHelperText>
              )}
              <Button
                onClick={() => void runTest()}
                loading={testConfiguration.isPending}
                disabled={!testModelId}
                data-testid="rapid-reply-run-test-btn"
              >
                Run test
              </Button>
            </Stack>
          </Stack>
        </SettingsSection>

        {history.length > 0 && (
          <Stack sx={{ gap: 2 }}>
            <AdminPageHeader
              level="section"
              title="Recent tests"
              actions={
                <Button
                  size="sm"
                  variant="plain"
                  onClick={() => setHistory([])}
                  data-testid="rapid-reply-clear-history-btn"
                >
                  Clear
                </Button>
              }
            />
            <DataTable
              rows={history}
              columns={historyColumns}
              getRowId={row => row.id}
              label="Recent rapid reply tests"
              onRetry={() => undefined}
              onRowActivate={row => {
                setTestModelId(row.modelId);
                setTestInput(row.testInput);
              }}
              pagination={false}
              minWidth="24rem"
              maxHeight="none"
              testId="rapid-reply-test-history-table"
            />
          </Stack>
        )}
      </Stack>

      <Box sx={{ minWidth: 0 }}>{result && <TestResults result={result} />}</Box>
    </Box>
  );
};
