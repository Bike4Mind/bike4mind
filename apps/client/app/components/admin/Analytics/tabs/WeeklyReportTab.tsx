import React, { useState, useCallback } from 'react';
import { Box, Card, Stack, Typography, Button, LinearProgress, Grid, Alert } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoIcon from '@mui/icons-material/Info';
import { useWeeklyReports, WeeklyReport } from '@client/app/hooks/useWeeklyReports';
import { WeekPicker, WeekRange } from '../filters/WeekPicker';
import { AnalyticsErrorCard } from '../AnalyticsErrorCard';

interface WeeklyReportTabProps {
  rawData: any[];
  loading: boolean;
  error?: unknown;
  onRefresh: () => void;
}

export const WeeklyReportTab: React.FC<WeeklyReportTabProps> = ({ loading, error, onRefresh }) => {
  const [selectedWeeks, setSelectedWeeks] = useState<WeekRange[]>([]);

  const { data: reports, isLoading, refetch, error: reportsError } = useWeeklyReports(selectedWeeks);

  const handleRefresh = useCallback(() => {
    refetch();
    onRefresh();
  }, [refetch, onRefresh]);

  return (
    <Box>
      <Card variant="outlined" sx={{ p: 1, maxHeight: '50vh', overflow: 'auto', mb: 1 }}>
        <WeekPicker selectedWeeks={selectedWeeks} onWeekSelect={setSelectedWeeks} maxWeeks={4} />
      </Card>

      {loading || isLoading ? (
        <LinearProgress />
      ) : error || reportsError ? (
        <AnalyticsErrorCard
          error={error || reportsError}
          onRetry={handleRefresh}
          title="Could not load weekly reports"
          testId="weekly-report-error"
        />
      ) : (
        <>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Alert variant="soft" color="neutral" startDecorator={<InfoIcon />} sx={{ flex: 1 }}>
              Select one or more weeks to view reports. You can select up to 4 weeks at a time.
            </Alert>
            <Button
              size="sm"
              startDecorator={<RefreshIcon />}
              onClick={handleRefresh}
              disabled={loading || isLoading}
              sx={{ ml: 2 }}
            >
              Refresh
            </Button>
          </Stack>

          <Stack spacing={2}>
            {reports?.map((item: WeeklyReport, index: number) => {
              if (!item || !item.startDate || !item.endDate) {
                return null;
              }

              const hasError = item.error || !item.report;
              return (
                <Card
                  key={`${item.startDate}-${item.endDate}`}
                  variant="outlined"
                  sx={{ mb: 2, bgcolor: index % 2 ? 'background.level1' : 'background.level2' }}
                >
                  <Grid container spacing={2}>
                    <Grid xs={12}>
                      <Typography level="h3" color={hasError ? 'danger' : 'primary'}>
                        Week of {item.startDate} to {item.endDate}
                      </Typography>
                    </Grid>
                    <Grid xs={12}>
                      {hasError ? (
                        <Alert color="danger" sx={{ mt: 1 }}>
                          {item.error || 'Error generating report'}
                        </Alert>
                      ) : (
                        <Typography
                          component="pre"
                          sx={{
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'monospace',
                            fontSize: '0.875rem',
                            my: 2,
                            overflowX: 'auto',
                          }}
                        >
                          {item.report}
                        </Typography>
                      )}
                    </Grid>
                  </Grid>
                </Card>
              );
            })}
            {(!reports || reports.length === 0) && selectedWeeks.length > 0 && (
              <Card variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
                <Typography level="body-lg">No reports available for the selected weeks</Typography>
              </Card>
            )}
            {selectedWeeks.length === 0 && (
              <Card variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
                <Typography level="body-lg">Select one or more weeks to view reports</Typography>
              </Card>
            )}
          </Stack>
        </>
      )}
    </Box>
  );
};
