import React from 'react';
import { Modal, ModalDialog, ModalClose, Typography, Stack, Box } from '@mui/joy';

interface MetricsInfoModalProps {
  open: boolean;
  onClose: () => void;
  hasStreamingData: boolean;
}

export const MetricsInfoModal: React.FC<MetricsInfoModalProps> = ({ open, onClose, hasStreamingData }) => {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog size="lg" sx={{ maxWidth: '800px', maxHeight: '90vh', overflow: 'auto' }}>
        <ModalClose />
        <Typography level="h4" sx={{ mb: 2 }}>
          📊 Performance Metrics Explained
        </Typography>

        <Stack spacing={3}>
          {/* Core Timing Section */}
          <Box>
            <Typography level="title-md" sx={{ mb: 1, color: 'primary.500' }}>
              ⏱️ Core Timing Metrics
            </Typography>
            <Stack spacing={2}>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Total Response Time
                </Typography>
                <Typography level="body-sm">
                  Complete end-to-end time from request to response completion. Includes all processing phases.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Context Retrieval
                </Typography>
                <Typography level="body-sm">
                  Time spent gathering context data: message history, feature processing, file attachments, and system
                  prompts before sending to the AI model.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Model Inference
                </Typography>
                <Typography level="body-sm">
                  Time the AI model takes to process the request and generate the complete response. This is the actual
                  &quot;thinking&quot; time.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Time to First Token (TTFVT)
                </Typography>
                <Typography level="body-sm">
                  Critical UX metric: How long until the user sees the first content from the AI. Lower is better for
                  perceived responsiveness. This is measured server-side from when processing starts.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Client First Token Time
                </Typography>
                <Typography level="body-sm">
                  End-to-end UX metric: Complete time from when the user sends their prompt until they see the first
                  token rendered in their browser. Includes network latency (both directions), server processing time,
                  and client rendering time. This is the true user-experienced latency.
                </Typography>
              </Box>
            </Stack>
          </Box>

          {/* Streaming Performance Section */}
          {hasStreamingData && (
            <Box>
              <Typography level="title-md" sx={{ mb: 1, color: 'primary.500' }}>
                🔄 Streaming Performance
              </Typography>
              <Stack spacing={2}>
                <Box>
                  <Typography level="title-sm" fontWeight="bold">
                    Chunk Count
                  </Typography>
                  <Typography level="body-sm">
                    Number of streaming chunks received. More chunks usually mean more responsive real-time updates to
                    the user.
                  </Typography>
                </Box>
                <Box>
                  <Typography level="title-sm" fontWeight="bold">
                    Total Stream Time
                  </Typography>
                  <Typography level="body-sm">
                    Duration from first to last streaming chunk. Should match Model Inference time closely.
                  </Typography>
                </Box>
                <Box>
                  <Typography level="title-sm" fontWeight="bold">
                    Characters/Second
                  </Typography>
                  <Typography level="body-sm">
                    Streaming throughput rate. Higher values mean faster content delivery to users. Varies by model and
                    complexity.
                  </Typography>
                </Box>
              </Stack>
            </Box>
          )}

          {/* Feature Execution Section */}
          <Box>
            <Typography level="title-md" sx={{ mb: 1, color: 'primary.500' }}>
              🔧 Feature Execution Times
            </Typography>
            <Stack spacing={2}>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Ability Setup
                </Typography>
                <Typography level="body-sm">
                  Time to initialize user permissions and capabilities. Usually very fast (&lt;10ms).
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Essential Data Fetch
                </Typography>
                <Typography level="body-sm">
                  Time to retrieve API keys, model configurations, and admin settings. May involve database queries.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Model Setup
                </Typography>
                <Typography level="body-sm">
                  Time to configure the selected AI model and validate parameters. Usually very fast.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  History Loading
                </Typography>
                <Typography level="body-sm">
                  Time to load conversation history and context. Can be slower with long conversations or complex
                  context.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Artifact Processing
                </Typography>
                <Typography level="body-sm">
                  Time to process any generated artifacts (code, files, etc.) after AI response. 0ms when no artifacts.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  On Complete Features
                </Typography>
                <Typography level="body-sm">
                  Time for post-processing features like session naming, notifications, etc. Runs after main response.
                </Typography>
              </Box>
            </Stack>
          </Box>

          {/* Database Operations Section */}
          <Box>
            <Typography level="title-md" sx={{ mb: 1, color: 'primary.500' }}>
              💾 Database Operations
            </Typography>
            <Stack spacing={2}>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Initial Quest Save
                </Typography>
                <Typography level="body-sm">
                  Time to create the initial request record in database. Usually 30-50ms.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Final Quest Save
                </Typography>
                <Typography level="body-sm">
                  Time to save the complete response and performance data to database. Includes all metadata.
                </Typography>
              </Box>
              <Box>
                <Typography level="title-sm" fontWeight="bold">
                  Organization Update
                </Typography>
                <Typography level="body-sm">
                  Time for any organization-level updates (usage tracking, quotas, etc.). Usually 30-40ms.
                </Typography>
              </Box>
            </Stack>
          </Box>

          {/* Performance Tips */}
          <Box sx={{ p: 2, bgcolor: 'background.level2', borderRadius: 'sm' }}>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              💡 Performance Insights
            </Typography>
            <Stack spacing={1}>
              <Typography level="body-sm">
                • <strong>TTFVT under 3s:</strong> Excellent user experience
              </Typography>
              {hasStreamingData && (
                <Typography level="body-sm">
                  • <strong>High chars/sec:</strong> Responsive streaming, good for real-time feel
                </Typography>
              )}
              <Typography level="body-sm">
                • <strong>History Loading &gt; 2s:</strong> Consider conversation pruning
              </Typography>
              <Typography level="body-sm">
                • <strong>Context Retrieval &gt; 3s:</strong> May indicate data source bottlenecks
              </Typography>
            </Stack>
          </Box>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};
