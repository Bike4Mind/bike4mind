import React, { useState, useMemo } from 'react';
import { Box, Card, Stack, Typography, Button, LinearProgress, Grid, Alert } from '@mui/joy';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import dayjs from 'dayjs';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoIcon from '@mui/icons-material/Info';
import { DateFilterComponent } from '../filters/DateFilterComponent';
import { useAnalyticsData } from '@client/app/hooks/useAnalyticsData';

dayjs.extend(isSameOrBefore);

interface DailyReportTabProps {
  rawData: any[];
  loading: boolean;
  onRefresh: () => void;
}

export const DailyReportTab: React.FC<DailyReportTabProps> = ({ loading, onRefresh }) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(5);
  const [dateRange, setDateRange] = useState({
    startDate: dayjs().subtract(7, 'days').format('YYYY-MM-DD'),
    endDate: dayjs().format('YYYY-MM-DD'),
  });

  const analyticsQuery = useAnalyticsData({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    report: true,
  });

  const handleRefresh = () => {
    analyticsQuery.refetch();
    onRefresh?.();
  };

  const reports = useMemo(() => {
    if (!analyticsQuery.data?.reports) return [];
    return analyticsQuery.data.reports.sort((a, b) => dayjs(b.date).diff(dayjs(a.date)));
  }, [analyticsQuery.data]);

  // Pagination
  const totalPages = Math.ceil((reports?.length || 0) / itemsPerPage);
  const currentItems = reports?.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage) || [];

  return (
    <Box>
      <Card variant="outlined" sx={{ mb: 1 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'end' }}>
          <DateFilterComponent
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            onStartDateChange={date => setDateRange(prev => ({ ...prev, startDate: date }))}
            onEndDateChange={date => setDateRange(prev => ({ ...prev, endDate: date }))}
            onRangeSelect={days => {
              setDateRange({
                startDate: dayjs().subtract(days, 'day').format('YYYY-MM-DD'),
                endDate: dayjs().format('YYYY-MM-DD'),
              });
            }}
          />
          <Button
            startDecorator={<RefreshIcon />}
            onClick={handleRefresh}
            disabled={loading || analyticsQuery.isLoading}
            sx={{ height: '100%' }}
          >
            Refresh
          </Button>
        </Stack>
      </Card>

      {loading || analyticsQuery.isLoading ? (
        <LinearProgress />
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
                totalItems={reports?.length || 0}
                pageLimitOptions={[5, 10, 20]}
              />
              <Stack spacing={2}>
                {currentItems.map((item, index) => {
                  const hasNoData = item.report.includes('No activity data found');
                  return (
                    <Card
                      key={item.date}
                      variant="outlined"
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
