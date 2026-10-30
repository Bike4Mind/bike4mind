import React, { useState } from 'react';
import { Box, Card, Stack, Typography, Button, LinearProgress, Grid, Alert } from '@mui/joy';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoIcon from '@mui/icons-material/Info';
import { DateFilterComponent } from '../filters/DateFilterComponent';
import { useDailyReports } from '@client/app/hooks/useAnalyticsData';
import { AnalyticsErrorCard } from '../AnalyticsErrorCard';
import { DEFAULT_PRESET_DAYS, getPresetRange, type DateRange } from '../dateRange';

/** Owns its date range: the shared store belongs to User Activity, so changing dates here never touches it. */
export const DailyReportTab: React.FC = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(5);
  const [dateRange, setDateRange] = useState<DateRange>(() => getPresetRange(DEFAULT_PRESET_DAYS));

  const dailyReportsQuery = useDailyReports(dateRange);
  const reports = dailyReportsQuery.data ?? [];

  const handleDateRangeChange = (range: DateRange) => {
    setDateRange(range);
    setCurrentPage(1);
  };

  // Pagination
  const totalPages = Math.ceil(reports.length / itemsPerPage);
  const currentItems = reports.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  return (
    <Box>
      <Card variant="outlined" sx={{ mb: 1 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'end' }}>
          <DateFilterComponent value={dateRange} onChange={handleDateRangeChange} />
          <Button
            startDecorator={<RefreshIcon />}
            onClick={() => dailyReportsQuery.refetch()}
            disabled={dailyReportsQuery.isFetching}
            data-testid="daily-report-refresh-btn"
            sx={{ height: '100%' }}
          >
            Refresh
          </Button>
        </Stack>
      </Card>

      {dailyReportsQuery.isLoading ? (
        <LinearProgress />
      ) : dailyReportsQuery.error ? (
        <AnalyticsErrorCard
          error={dailyReportsQuery.error}
          onRetry={() => dailyReportsQuery.refetch()}
          title="Could not load daily reports"
          testId="daily-report-error"
        />
      ) : (
        <>
          <Alert variant="soft" color="neutral" startDecorator={<InfoIcon />}>
            Reports are shown for all dates in the selected range. Dates without activity will be marked accordingly.
          </Alert>

          {reports.length === 0 ? (
            <Card variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
              <Typography level="body-lg">No reports available for the selected date range</Typography>
            </Card>
          ) : (
            <>
              <SharedPaginationControls
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setCurrentPage}
                itemsPerPage={itemsPerPage}
                onItemsPerPageChange={size => {
                  setItemsPerPage(size);
                  setCurrentPage(1);
                }}
                totalItems={reports.length}
                pageLimitOptions={[5, 10, 20]}
              />
              <Stack spacing={2}>
                {currentItems.map((item, index) => {
                  if (item.error) {
                    return (
                      <AnalyticsErrorCard
                        key={item.date}
                        error={new Error(item.error)}
                        onRetry={() => dailyReportsQuery.refetch()}
                        title={`Could not generate the report for ${item.date}`}
                        testId={`daily-report-error-${item.date}`}
                      />
                    );
                  }
                  const hasNoData = item.report.includes('No activity data found');
                  return (
                    <Card
                      key={item.date}
                      variant="outlined"
                      data-testid="daily-report-card"
                      sx={{
                        mb: 2,
                        bgcolor: hasNoData
                          ? 'background.level1'
                          : index % 2
                            ? 'background.level1'
                            : 'background.level2',
                        opacity: hasNoData ? 0.8 : 1,
                      }}
                    >
                      <Grid container spacing={2}>
                        <Grid xs={12}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography level="h3" color={hasNoData ? 'neutral' : 'primary'}>
                              Report for {item.date}
                            </Typography>
                            {hasNoData && (
                              <Typography level="body-sm" color="neutral">
                                (No Activity)
                              </Typography>
                            )}
                          </Stack>
                        </Grid>
                        <Grid xs={12}>
                          <Typography
                            component="pre"
                            sx={{
                              whiteSpace: 'pre-wrap',
                              fontFamily: 'monospace',
                              fontSize: '0.875rem',
                              my: 2,
                              overflowX: 'auto',
                              color: hasNoData ? 'neutral.500' : 'inherit',
                            }}
                          >
                            {item.report}
                          </Typography>
                        </Grid>
                      </Grid>
                    </Card>
                  );
                })}
              </Stack>
            </>
          )}
        </>
      )}
    </Box>
  );
};
