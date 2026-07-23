import React, { useState, useMemo, useEffect } from 'react';
import {
  Box,
  Card,
  Stack,
  Typography,
  FormControl,
  Select,
  Option,
  CircularProgress,
  Alert,
  IconButton,
  Table,
  Sheet,
  Divider,
  Chip,
  Tooltip,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import InsightsIcon from '@mui/icons-material/Insights';
import PieChartIcon from '@mui/icons-material/PieChart';
import { ResponsiveLine } from '@nivo/line';
import { ResponsivePie } from '@nivo/pie';

// Type assertions for Nivo components
const ResponsiveLineChart = ResponsiveLine as any;
import { useGetCreditTransactions } from '@client/app/hooks/data/credits';
import { useUser } from '@client/app/contexts/UserContext';
import dayjs from 'dayjs';
import { useTheme } from '@mui/joy/styles';
import { useTranslation } from 'react-i18next';
import { getModels } from '@client/app/utils/llm';
import { ModelInfo, usdToCredits } from '@bike4mind/common';
import SectionContainer from './SectionContainer';
import { TYPE } from './settingsStyles';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { FieldTooltip, FIELD_TOOLTIPS } from '@client/app/components/help';

const TIME_PERIODS = {
  WEEK: '7d',
  MONTH: '30d',
  QUARTER: '90d',
  HALF_YEAR: '180d',
};

const CreditAnalyticsTabContent: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { currentUser } = useUser();
  const [timePeriod, setTimePeriod] = useState(TIME_PERIODS.MONTH);
  const [viewMode, setViewMode] = useState<'credits_added' | 'usage' | 'all_types'>('usage');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);

  const {
    data: transactions,
    isLoading,
    isError,
    refetch,
  } = useGetCreditTransactions({
    days: parseInt(timePeriod, 10),
  });

  // Fetch model pricing on mount. The parent gates mount on the Usage tab being active,
  // so on-mount == on-tab-open.
  useEffect(() => {
    const fetchModels = async () => {
      setIsLoadingModels(true);
      setModelLoadError(null);
      try {
        const modelsData = await getModels();
        setModels(modelsData);
      } catch (error) {
        console.error('Failed to fetch models:', error);
        setModelLoadError('Failed to load model pricing information');
      } finally {
        setIsLoadingModels(false);
      }
    };

    fetchModels();
  }, []);

  // Process transactions for the chart
  const { chartData, usageByModel, burnRate, usageTrend, daysRemaining } = useMemo(() => {
    if (!transactions || transactions.length === 0) {
      return {
        chartData: [],
        usageByModel: {},
        burnRate: 0,
        usageTrend: 'stable',
        daysRemaining: null,
      };
    }

    // Calculate the date range based on selected time period (for filling gaps)
    const endDate = dayjs();
    const startDate = endDate.subtract(parseInt(timePeriod, 10), 'day');

    // Transactions are already filtered by the API, just sort them
    const sortedTransactions = [...transactions].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Separate transactions by type.
    // When adding a new transaction type: add filtering here, include in allDeductTransactions,
    // add to daily data processing, and add a tooltip label in getTooltipLabel().
    const purchaseTransactions = sortedTransactions.filter(t => t.type === 'purchase');
    const subscriptionTransactions = sortedTransactions.filter(t => t.type === 'subscription');
    const genericAddTransactions = sortedTransactions.filter(t => t.type === 'generic_add');
    const genericDeductTransactions = sortedTransactions.filter(t => t.type === 'generic_deduct');
    const textUsageTransactions = sortedTransactions.filter(t => t.type === 'text_generation_usage');
    const completionApiUsageTransactions = sortedTransactions.filter(t => t.type === 'completion_api_usage');
    const imageUsageTransactions = sortedTransactions.filter(t => t.type === 'image_generation_usage');
    const imageEditUsageTransactions = sortedTransactions.filter(t => t.type === 'image_edit_usage');
    const voiceUsageTransactions = sortedTransactions.filter(t => t.type === 'realtime_voice_usage');
    const toolUsageTransactions = sortedTransactions.filter(t => t.type === 'tool_usage');
    const speechToTextUsageTransactions = sortedTransactions.filter(t => t.type === 'speech_to_text_usage');
    const textToSpeechUsageTransactions = sortedTransactions.filter(t => t.type === 'text_to_speech_usage');
    const soundEffectsUsageTransactions = sortedTransactions.filter(t => t.type === 'sound_effects_usage');

    // Combined deduct transactions for burn rate calculation
    const allDeductTransactions = [
      ...genericDeductTransactions,
      ...textUsageTransactions,
      ...completionApiUsageTransactions,
      ...imageUsageTransactions,
      ...imageEditUsageTransactions,
      ...voiceUsageTransactions,
      ...toolUsageTransactions,
      ...speechToTextUsageTransactions,
      ...textToSpeechUsageTransactions,
      ...soundEffectsUsageTransactions,
    ];

    // Calculate burn rate (average daily usage)
    let burnRate = 0;
    let usageTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    let daysRemaining: number | null = null;

    if (allDeductTransactions.length > 0) {
      // Total credits used (as positive numbers)
      const totalUsage = allDeductTransactions.reduce((sum, t) => sum + Math.abs(t.credits), 0);

      const daysDiff = Math.max(1, endDate.diff(startDate, 'day'));
      burnRate = totalUsage / daysDiff;

      // Calculate trend by comparing first half to second half of the period
      if (daysDiff >= 6) {
        // Only calculate trend if we have at least 6 days of data
        const midPoint = startDate.add(Math.floor(daysDiff / 2), 'day');

        const firstHalfTransactions = allDeductTransactions.filter(t => dayjs(t.createdAt).isBefore(midPoint));

        const secondHalfTransactions = allDeductTransactions.filter(
          t => dayjs(t.createdAt).isAfter(midPoint) || dayjs(t.createdAt).isSame(midPoint, 'day')
        );

        const firstHalfUsage = firstHalfTransactions.reduce((sum, t) => sum + Math.abs(t.credits), 0);
        const secondHalfUsage = secondHalfTransactions.reduce((sum, t) => sum + Math.abs(t.credits), 0);

        // Calculate daily rates for each half
        const firstHalfDays = Math.max(1, midPoint.diff(startDate, 'day'));
        const secondHalfDays = Math.max(1, endDate.diff(midPoint, 'day'));

        const firstHalfRate = firstHalfUsage / firstHalfDays;
        const secondHalfRate = secondHalfUsage / secondHalfDays;

        // Determine trend with 10% threshold for meaningful change
        const changePercent = ((secondHalfRate - firstHalfRate) / firstHalfRate) * 100;

        if (changePercent > 10) {
          usageTrend = 'increasing';
        } else if (changePercent < -10) {
          usageTrend = 'decreasing';
        }
      }

      // Calculate estimated days remaining based on current balance and burn rate
      if (burnRate > 0 && currentUser?.currentCredits) {
        daysRemaining = Math.floor(currentUser.currentCredits / burnRate);
      }
    }

    // Track model usage if available in metadata
    const modelUsageMap: Record<string, number> = {};

    allDeductTransactions.forEach(transaction => {
      let modelName = 'Unknown';

      // Check metadata first
      if (transaction.metadata?.modelName) {
        modelName = transaction.metadata.modelName;
      } else if ('model' in transaction) {
        // Type-safe check for model property on usage transactions
        modelName = (transaction as { model?: string }).model || 'Unknown';
      }

      if (!modelUsageMap[modelName]) {
        modelUsageMap[modelName] = 0;
      }
      modelUsageMap[modelName] += Math.abs(transaction.credits);
    });

    // Aggregate transactions by day for each type
    const purchaseDailyData = new Map<string, { x: string; y: number }>();
    const subscriptionDailyData = new Map<string, { x: string; y: number }>();
    const genericAddDailyData = new Map<string, { x: string; y: number }>();
    const genericDeductDailyData = new Map<string, { x: string; y: number }>();
    const textUsageDailyData = new Map<string, { x: string; y: number }>();
    const completionApiUsageDailyData = new Map<string, { x: string; y: number }>();
    const imageUsageDailyData = new Map<string, { x: string; y: number }>();
    const imageEditUsageDailyData = new Map<string, { x: string; y: number }>();
    const voiceUsageDailyData = new Map<string, { x: string; y: number }>();
    const toolUsageDailyData = new Map<string, { x: string; y: number }>();
    const speechToTextUsageDailyData = new Map<string, { x: string; y: number }>();
    const textToSpeechUsageDailyData = new Map<string, { x: string; y: number }>();
    const soundEffectsUsageDailyData = new Map<string, { x: string; y: number }>();
    const creditsAddedDailyData = new Map<string, { x: string; y: number }>(); // Combined purchases, subscriptions, and generic adds
    const allUsageDailyData = new Map<string, { x: string; y: number }>(); // Combined all usage types including generic deducts

    const processTransactionType = (
      transactions: typeof sortedTransactions,
      dailyDataMap: Map<string, { x: string; y: number }>
    ) => {
      transactions.forEach(transaction => {
        const day = dayjs(transaction.createdAt).format('YYYY-MM-DD');

        if (!dailyDataMap.has(day)) {
          dailyDataMap.set(day, { x: day, y: 0 });
        }

        const dailyData = dailyDataMap.get(day);
        if (dailyData) dailyData.y += Math.abs(transaction.credits);
      });
    };

    // Process each transaction type
    processTransactionType(purchaseTransactions, purchaseDailyData);
    processTransactionType(subscriptionTransactions, subscriptionDailyData);
    processTransactionType(genericAddTransactions, genericAddDailyData);
    processTransactionType(genericDeductTransactions, genericDeductDailyData);
    processTransactionType(textUsageTransactions, textUsageDailyData);
    processTransactionType(completionApiUsageTransactions, completionApiUsageDailyData);
    processTransactionType(imageUsageTransactions, imageUsageDailyData);
    processTransactionType(imageEditUsageTransactions, imageEditUsageDailyData);
    processTransactionType(voiceUsageTransactions, voiceUsageDailyData);
    processTransactionType(toolUsageTransactions, toolUsageDailyData);
    processTransactionType(speechToTextUsageTransactions, speechToTextUsageDailyData);
    processTransactionType(textToSpeechUsageTransactions, textToSpeechUsageDailyData);
    processTransactionType(soundEffectsUsageTransactions, soundEffectsUsageDailyData);

    // Create combined credits added (purchases + subscriptions + generic adds)
    [...purchaseTransactions, ...subscriptionTransactions, ...genericAddTransactions].forEach(transaction => {
      const day = dayjs(transaction.createdAt).format('YYYY-MM-DD');
      if (!creditsAddedDailyData.has(day)) {
        creditsAddedDailyData.set(day, { x: day, y: 0 });
      }
      const creditsData = creditsAddedDailyData.get(day);
      if (creditsData) creditsData.y += transaction.credits;
    });

    // Create combined usage (all usage types including generic deducts)
    [
      ...genericDeductTransactions,
      ...textUsageTransactions,
      ...completionApiUsageTransactions,
      ...imageUsageTransactions,
      ...imageEditUsageTransactions,
      ...voiceUsageTransactions,
      ...toolUsageTransactions,
      ...speechToTextUsageTransactions,
      ...textToSpeechUsageTransactions,
      ...soundEffectsUsageTransactions,
    ].forEach(transaction => {
      const day = dayjs(transaction.createdAt).format('YYYY-MM-DD');
      if (!allUsageDailyData.has(day)) {
        allUsageDailyData.set(day, { x: day, y: 0 });
      }
      const usageData = allUsageDailyData.get(day);
      if (usageData) usageData.y += Math.abs(transaction.credits);
    });

    // Fill in missing days with zero values for all data sets
    let currentDate = startDate;
    while (currentDate.isBefore(endDate) || currentDate.isSame(endDate, 'day')) {
      const day = currentDate.format('YYYY-MM-DD');

      [
        purchaseDailyData,
        subscriptionDailyData,
        genericAddDailyData,
        genericDeductDailyData,
        textUsageDailyData,
        completionApiUsageDailyData,
        imageUsageDailyData,
        imageEditUsageDailyData,
        voiceUsageDailyData,
        toolUsageDailyData,
        speechToTextUsageDailyData,
        textToSpeechUsageDailyData,
        soundEffectsUsageDailyData,
        creditsAddedDailyData,
        allUsageDailyData,
      ].forEach(dataMap => {
        if (!dataMap.has(day)) {
          dataMap.set(day, { x: day, y: 0 });
        }
      });

      currentDate = currentDate.add(1, 'day');
    }

    // Convert to array and sort by date
    const sortDataPoints = (dataMap: Map<string, { x: string; y: number }>) =>
      Array.from(dataMap.values()).sort((a, b) => new Date(a.x).getTime() - new Date(b.x).getTime());

    const purchaseDataPoints = sortDataPoints(purchaseDailyData);
    const subscriptionDataPoints = sortDataPoints(subscriptionDailyData);
    const genericAddDataPoints = sortDataPoints(genericAddDailyData);
    const genericDeductDataPoints = sortDataPoints(genericDeductDailyData);
    const textUsageDataPoints = sortDataPoints(textUsageDailyData);
    const completionApiUsageDataPoints = sortDataPoints(completionApiUsageDailyData);
    const imageUsageDataPoints = sortDataPoints(imageUsageDailyData);
    const imageEditUsageDataPoints = sortDataPoints(imageEditUsageDailyData);
    const voiceUsageDataPoints = sortDataPoints(voiceUsageDailyData);
    const toolUsageDataPoints = sortDataPoints(toolUsageDailyData);
    const speechToTextUsageDataPoints = sortDataPoints(speechToTextUsageDailyData);
    const textToSpeechUsageDataPoints = sortDataPoints(textToSpeechUsageDailyData);
    const soundEffectsUsageDataPoints = sortDataPoints(soundEffectsUsageDailyData);
    const creditsAddedDataPoints = sortDataPoints(creditsAddedDailyData);
    const allUsageDataPoints = sortDataPoints(allUsageDailyData);

    // Prepare chart data based on selected view mode
    let dataToReturn: Array<{ id: string; data: Array<{ x: string; y: number }>; color: string }> = [];

    if (viewMode === 'credits_added') {
      dataToReturn = [
        {
          id: 'credits_added',
          data: creditsAddedDataPoints,
          color: theme.palette.success[500],
        },
      ];
    } else if (viewMode === 'usage') {
      dataToReturn = [
        {
          id: 'usage',
          // Brand-accent line for the default Credit Usage view; soft area fill from areaOpacity below.
          data: allUsageDataPoints,
          color: theme.palette.primary[500],
        },
      ];
    } else if (viewMode === 'all_types') {
      // Show all transaction types as separate lines
      const lines = [];

      if (purchaseDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'purchases',
          data: purchaseDataPoints,
          color: theme.palette.success[600],
        });
      }

      if (subscriptionDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'subscriptions',
          data: subscriptionDataPoints,
          color: theme.palette.success[400],
        });
      }

      if (genericAddDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'generic_add',
          data: genericAddDataPoints,
          color: theme.palette.success[300],
        });
      }

      if (genericDeductDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'generic_deduct',
          data: genericDeductDataPoints,
          color: theme.palette.danger[300],
        });
      }

      if (textUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'text_usage',
          data: textUsageDataPoints,
          color: theme.palette.danger[500],
        });
      }

      if (completionApiUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'completion_api_usage',
          data: completionApiUsageDataPoints,
          color: theme.palette.danger[600],
        });
      }

      if (imageUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'image_usage',
          data: imageUsageDataPoints,
          color: theme.palette.warning[500],
        });
      }

      if (imageEditUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'image_edit_usage',
          data: imageEditUsageDataPoints,
          color: theme.palette.warning[600],
        });
      }

      if (voiceUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'voice_usage',
          data: voiceUsageDataPoints,
          color: theme.palette.primary[600],
        });
      }

      if (toolUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'tool_usage',
          data: toolUsageDataPoints,
          color: theme.palette.neutral[600],
        });
      }

      if (speechToTextUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'speech_to_text_usage',
          data: speechToTextUsageDataPoints,
          color: theme.palette.primary[400],
        });
      }

      if (textToSpeechUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'text_to_speech_usage',
          data: textToSpeechUsageDataPoints,
          color: theme.palette.primary[300],
        });
      }

      if (soundEffectsUsageDataPoints.some(p => p.y > 0)) {
        lines.push({
          id: 'sound_effects_usage',
          data: soundEffectsUsageDataPoints,
          color: theme.palette.warning[400],
        });
      }

      dataToReturn = lines;
    }

    return {
      chartData: dataToReturn,
      usageByModel: modelUsageMap,
      burnRate,
      usageTrend,
      daysRemaining,
    };
  }, [transactions, timePeriod, viewMode, theme.palette, currentUser]);

  // Tooltip text for days remaining, adjusted based on selected time period
  const daysTooltipText = useMemo(() => {
    const selectedDays = parseInt(timePeriod, 10);
    if (Number.isFinite(selectedDays)) {
      return `Based on your usage pattern from the last ${selectedDays} days`;
    }
    return 'Based on your recent usage pattern';
  }, [timePeriod]);

  // Calculate tick interval based on time period to avoid overcrowding
  const tickInterval = useMemo(() => {
    const selectedDays = parseInt(timePeriod, 10);
    if (selectedDays <= 7) {
      return 'every 1 day'; // Show every day for week view
    } else if (selectedDays <= 30) {
      return 'every 7 days'; // Show every week for month view
    } else if (selectedDays <= 90) {
      return 'every 14 days'; // Show every 2 weeks for quarter view
    } else {
      return 'every 30 days'; // Show every month for half-year view
    }
  }, [timePeriod]);

  // Calculate point size based on time period to avoid overcrowding
  const pointSize = useMemo(() => {
    const selectedDays = parseInt(timePeriod, 10);
    if (selectedDays <= 7) {
      return 8; // Full size for week view
    } else if (selectedDays <= 30) {
      return 4; // Smaller for month view
    } else {
      return 0; // Hide points for 90+ days
    }
  }, [timePeriod]);

  // Chart theme based on Joy UI colors
  const chartTheme = {
    axis: {
      ticks: {
        text: {
          fill: theme.palette.text.tertiary,
        },
      },
      legend: {
        text: {
          fill: theme.palette.text.primary,
        },
      },
    },
    grid: {
      line: {
        stroke: theme.palette.divider,
      },
    },
    tooltip: {
      container: {
        background: theme.palette.background.surface,
        color: theme.palette.text.primary,
        boxShadow: theme.shadow.md,
        borderRadius: theme.radius.md,
      },
    },
    crosshair: {
      line: {
        stroke: theme.palette.primary.solidBg,
        strokeWidth: 1,
        strokeOpacity: 0.5,
      },
    },
  };

  // Group models by type
  const { textModels, imageModels } = useMemo(() => {
    const text: ModelInfo[] = [];
    const image: ModelInfo[] = [];

    models.forEach(model => {
      if (model.type === 'text') {
        text.push(model);
      } else if (model.type === 'image') {
        image.push(model);
      }
    });

    // Sort by name within each category
    return {
      textModels: text.sort((a, b) => a.name.localeCompare(b.name)),
      imageModels: image.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [models]);

  const calculateModelCost = (model: ModelInfo): { inputCost: string; outputCost: string } => {
    // Most models use the pricing for 1000 tokens as a standard measure
    const defaultKeys = Object.keys(model.pricing || {}).map(Number);
    // Use the first pricing tier, or 0 if none available
    const firstKey = defaultKeys.length > 0 ? defaultKeys[0] : 0;

    if (!model.pricing || !model.pricing[firstKey]) {
      return { inputCost: 'N/A', outputCost: 'N/A' };
    }

    // Calculate credits based on model type. Uses the shared billing conversion
    // (usdToCredits) so displayed prices can't drift from what's charged.
    const calculateCredits = (usdCost: number): string => {
      if (model.type === 'image') {
        // Image models: pricing stored in ten-thousandths of a dollar
        // E.g., a value of 550 means $0.055
        return usdToCredits(usdCost * 0.0001).toLocaleString();
      } else {
        // Text models: pricing stored per token; display credits per 1K tokens
        return usdToCredits(usdCost * 1000).toLocaleString();
      }
    };

    return {
      inputCost: calculateCredits(model.pricing[firstKey].input),
      outputCost: calculateCredits(model.pricing[firstKey].output),
    };
  };

  const renderPriceTier = (model: ModelInfo): React.JSX.Element => {
    // Determine pricing tier based on average cost (similar to getModelPriceTier in ModelSelection.tsx)
    const defaultKeys = Object.keys(model.pricing || {}).map(Number);
    const firstKey = defaultKeys.length > 0 ? defaultKeys[0] : 0;

    if (!model.pricing || !model.pricing[firstKey]) {
      return (
        <Chip color="neutral" size="sm">
          -
        </Chip>
      );
    }

    const avgCost = (model.pricing[firstKey].input + model.pricing[firstKey].output) / 2;

    if (model.type === 'text') {
      if (avgCost >= 5 / 1000000) {
        return (
          <Chip color="danger" size="sm">
            $$$
          </Chip>
        );
      } else if (avgCost >= 0.5 / 1000000) {
        return (
          <Chip color="warning" size="sm">
            $$
          </Chip>
        );
      }
      return (
        <Chip color="success" size="sm">
          $
        </Chip>
      );
    } else {
      if (avgCost >= 0.05) {
        return (
          <Chip color="danger" size="sm">
            $$$
          </Chip>
        );
      } else if (avgCost >= 0.02) {
        return (
          <Chip color="warning" size="sm">
            $$
          </Chip>
        );
      }
      return (
        <Chip color="success" size="sm">
          $
        </Chip>
      );
    }
  };

  // Format model usage data for pie chart
  const pieChartData = useMemo(() => {
    return Object.entries(usageByModel).map(([key, value]) => ({
      id: key,
      label: key,
      value: value,
    }));
  }, [usageByModel]);

  return (
    <SectionContainer>
      <Stack className="credit-analytics-stack" spacing={3}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between" flexWrap="wrap">
          {/* Summary items - the credit-wheel stat band (page signature) */}
          <Box sx={{ flex: { xs: '1 1 100%', md: '1 1 auto' } }}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, auto)' },
                alignItems: 'flex-start',
                columnGap: { xs: 3, sm: '40px' },
                rowGap: 2,
              }}
            >
              {/* Item 1: Current credits balance */}
              <Box sx={{ flex: '0 0 auto' }}>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  <Typography level={TYPE.body} sx={{ color: 'text.primary', opacity: 0.5 }}>
                    Credits Balance
                  </Typography>
                  <FieldTooltip
                    ariaLabel="Help: Credits Balance"
                    content={FIELD_TOOLTIPS.credits}
                    data-testid="field-tooltip-credits-balance"
                  />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: '4px' }}>
                  <Bike4MindIcon size="20" />
                  <Typography level={TYPE.statValue} sx={{ color: 'text.primary' }}>
                    {currentUser?.currentCredits?.toLocaleString() || 0}
                  </Typography>
                </Box>
              </Box>

              {/* Item 2: Daily burn rate with trend */}
              <Box sx={{ flex: '0 0 auto' }}>
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  <Typography level={TYPE.body} sx={{ color: 'text.primary', opacity: 0.5 }}>
                    Daily Burn Rate
                  </Typography>
                  <FieldTooltip
                    ariaLabel="Help: Daily Burn Rate"
                    content={FIELD_TOOLTIPS.burnRate}
                    data-testid="field-tooltip-burn-rate"
                  />
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: '4px' }}>
                  <Bike4MindIcon size="20" />
                  <Typography level={TYPE.statValue} sx={{ color: 'text.primary' }}>
                    {Math.max(0, Math.round(burnRate)).toLocaleString()}
                  </Typography>
                  {usageTrend !== 'stable' && (
                    <Box
                      component="span"
                      sx={{
                        display: 'inline-flex',
                        color: usageTrend === 'increasing' ? theme.palette.danger[500] : theme.palette.success[500],
                      }}
                    >
                      {usageTrend === 'increasing' ? (
                        <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              d="M12 20V4M12 4L5 11M12 4L19 11"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </Box>
                      ) : (
                        <Box component="span" sx={{ display: 'flex', alignItems: 'center' }}>
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              d="M12 4V20M12 20L5 13M12 20L19 13"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </Box>
                      )}
                    </Box>
                  )}
                </Box>
              </Box>

              {/* Item 3: Estimated days remaining */}
              <Box sx={{ flex: '0 0 auto' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Typography level={TYPE.body} sx={{ color: 'text.primary', opacity: 0.5 }}>
                    Days remaining
                  </Typography>
                  <FieldTooltip content={daysTooltipText} ariaLabel="Help: Days remaining" iconSize={16} />
                </Box>
                <Typography level={TYPE.statValue} sx={{ color: 'text.primary', mt: '4px' }}>
                  {daysRemaining !== null ? daysRemaining : 'N/A'}
                </Typography>
              </Box>
            </Box>
          </Box>

          {/* Controls (right) */}
          <Stack
            className="credit-analytics-controls-inner-stack"
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{
              flex: { xs: '1 1 100%', md: '1 1 320px' },
              justifyContent: { sm: 'flex-end' },
              alignItems: { xs: 'stretch', sm: 'center' },
              flexWrap: 'wrap',
              pt: { xs: 3, md: 0 },
            }}
          >
            <FormControl
              className="credit-analytics-time-period-select"
              size="sm"
              sx={{ flex: { sm: '1 1 150px' }, width: { xs: '100%', sm: 'auto' }, minWidth: { sm: 140 } }}
            >
              <Select
                className="credit-analytics-time-period-select-input"
                value={timePeriod}
                onChange={(_, value) => value && setTimePeriod(value as string)}
                size="sm"
                sx={{
                  bgcolor: theme => (theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body),
                  boxShadow: 'none',
                  color: 'text.primary',
                }}
                slotProps={{
                  listbox: {
                    sx: (theme: any) => ({
                      boxShadow: 'none',
                      bgcolor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
                    }),
                  },
                }}
              >
                <Option className="credit-analytics-time-option" value={TIME_PERIODS.WEEK}>
                  {t('time.last_7_days')}
                </Option>
                <Option className="credit-analytics-time-option" value={TIME_PERIODS.MONTH}>
                  {t('time.last_30_days')}
                </Option>
                <Option className="credit-analytics-time-option" value={TIME_PERIODS.QUARTER}>
                  {t('time.last_90_days')}
                </Option>
                <Option className="credit-analytics-time-option" value={TIME_PERIODS.HALF_YEAR}>
                  {t('time.last_180_days')}
                </Option>
              </Select>
            </FormControl>

            <FormControl
              size="sm"
              sx={{ flex: { sm: '1 1 150px' }, width: { xs: '100%', sm: 'auto' }, minWidth: { sm: 140 } }}
            >
              <Select
                value={viewMode}
                onChange={(_, v) => v && setViewMode(v as typeof viewMode)}
                size="sm"
                sx={{
                  bgcolor: theme => (theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body),
                  boxShadow: 'none',
                  color: 'text.primary',
                }}
                slotProps={{
                  listbox: {
                    sx: (theme: any) => ({
                      boxShadow: 'none',
                      bgcolor: theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
                    }),
                  },
                }}
              >
                <Option value="usage">{t('profile.show_usage')}</Option>
                <Option value="credits_added">Credits Added</Option>
                <Option value="all_types">All Types</Option>
              </Select>
            </FormControl>

            <Tooltip title="Refresh">
              <IconButton
                className="credit-analytics-refresh-button"
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => refetch()}
                sx={{
                  bgcolor: theme => (theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body),
                  boxShadow: 'none',
                  flexShrink: 0,
                  alignSelf: { xs: 'flex-start', sm: 'auto' },
                }}
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        <Card className="credit-analytics-chart-card" variant="outlined" sx={{ p: 2, height: 400 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <InsightsIcon sx={{ mr: 1 }} />
            <Typography level="title-md">{t('credits.usage')}</Typography>
          </Stack>
          {isLoading ? (
            <Box
              className="credit-analytics-loading-container"
              sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}
            >
              <CircularProgress className="credit-analytics-loading-spinner" />
            </Box>
          ) : isError ? (
            <Box className="credit-analytics-error-container" sx={{ p: 2 }}>
              <Alert className="credit-analytics-error-alert" color="danger">
                {t('errors.failed_to_load_data')}
              </Alert>
            </Box>
          ) : transactions && transactions.length > 0 ? (
            <ResponsiveLineChart
              data={chartData}
              theme={chartTheme}
              margin={{ top: 20, right: 30, bottom: 80, left: 60 }}
              xScale={{
                type: 'time',
                format: '%Y-%m-%d',
                useUTC: false,
                precision: 'day',
              }}
              yScale={{
                type: 'linear',
                min: 'auto',
                max: 'auto',
              }}
              xFormat="time:%Y-%m-%d"
              yFormat=">-,.0f"
              axisLeft={{
                legend:
                  viewMode === 'usage'
                    ? t('credits.credits_used')
                    : viewMode === 'credits_added'
                      ? 'Credits Added'
                      : t('credits.credits'),
                legendOffset: -45,
                legendPosition: 'middle',
              }}
              axisBottom={{
                format: '%b %d',
                tickValues: tickInterval,
                legend: t('common.date'),
                legendOffset: 32,
                legendPosition: 'middle',
              }}
              pointSize={pointSize}
              pointColor={theme.palette.background.surface}
              pointBorderWidth={pointSize > 0 ? 2 : 0}
              pointBorderColor={{ from: 'serieColor' }}
              enablePointLabel={false}
              enableArea={true}
              areaOpacity={0.15}
              useMesh={true}
              enableGridX={false}
              enableSlices="x"
              curve="monotoneX"
              colors={chartData.map(d => d.color || theme.palette.primary[500])}
              tooltip={({ point }: { point: any }) => {
                // When adding a new transaction type, add a case here for friendly display name
                const getTooltipLabel = (seriesId: string) => {
                  switch (seriesId) {
                    case 'purchases':
                      return 'Purchases';
                    case 'subscriptions':
                      return 'Subscriptions';
                    case 'generic_add':
                      return 'Generic Credits Added';
                    case 'generic_deduct':
                      return 'Generic Credits Deducted';
                    case 'text_usage':
                      return 'Text Generation';
                    case 'completion_api_usage':
                      return 'Completion API Usage';
                    case 'image_usage':
                      return 'Image Generation';
                    case 'image_edit_usage':
                      return 'Image Editing';
                    case 'voice_usage':
                      return 'Voice Usage';
                    case 'tool_usage':
                      return 'Tool Usage';
                    case 'speech_to_text_usage':
                      return 'Speech to Text';
                    case 'text_to_speech_usage':
                      return 'Text to Speech';
                    case 'sound_effects_usage':
                      return 'Sound Effects';
                    case 'usage':
                      return t('credits.credits_used');
                    case 'credits_added':
                      return 'Credits Added';
                    default:
                      return t('credits.credits');
                  }
                };

                return (
                  <Box
                    sx={{
                      p: 1,
                      bgcolor: 'background.surface',
                      borderRadius: 'sm',
                      boxShadow: 'sm',
                      border: '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    <Typography level="body-xs">
                      <strong>{dayjs(point.data.x).format('MMM D, YYYY')}</strong>
                    </Typography>
                    <Typography level="body-xs">
                      {getTooltipLabel(point.serieId)}: <strong>{point.data.y.toLocaleString()}</strong>{' '}
                      {t('credits.credits')}
                    </Typography>
                  </Box>
                );
              }}
            />
          ) : (
            <Box
              className="credit-analytics-empty-container"
              sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}
            >
              <Typography className="credit-analytics-empty-message" level="body-lg" color="neutral">
                {t('credits.no_transactions')}
              </Typography>
            </Box>
          )}
        </Card>

        {viewMode === 'usage' && Object.keys(usageByModel).length > 0 && (
          <Card variant="outlined" sx={{ p: 2, height: 420 }}>
            <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
              <PieChartIcon sx={{ mr: 1 }} />
              <Typography level="title-md">{t('credits.usage_by_model')}</Typography>
            </Stack>

            <Box sx={{ height: 340 }}>
              <ResponsivePie
                data={pieChartData}
                margin={{ top: 20, right: 80, bottom: 40, left: 80 }}
                innerRadius={0.5}
                padAngle={0.7}
                cornerRadius={3}
                activeOuterRadiusOffset={8}
                borderWidth={1}
                borderColor={{ from: 'color', modifiers: [['darker', 0.2]] }}
                arcLinkLabelsSkipAngle={10}
                arcLinkLabelsTextColor={theme.palette.text.primary}
                arcLinkLabelsThickness={2}
                arcLinkLabelsColor={{ from: 'color' }}
                arcLabelsSkipAngle={10}
                arcLabelsTextColor={{ from: 'color', modifiers: [['darker', 2]] }}
                theme={chartTheme}
                // @ts-ignore - The type definition for PieTooltipProps doesn't match with the actual API
                tooltip={({ datum }) => {
                  // Type assertion to handle the typing issue
                  const label = String(datum.label);
                  const value = Number(datum.value);
                  const percentage = ((value / pieChartData.reduce((sum, item) => sum + item.value, 0)) * 100).toFixed(
                    1
                  );

                  return (
                    <Box
                      sx={{
                        p: 1,
                        bgcolor: 'background.surface',
                        borderRadius: 'sm',
                        boxShadow: 'sm',
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <Typography level="body-xs">
                        <strong>{label}</strong>: {value.toLocaleString()} {t('credits.credits')} ({percentage}%)
                      </Typography>
                    </Box>
                  );
                }}
              />
            </Box>
          </Card>
        )}

        {/* Removed bottom current balance card (duplicated at top) */}
      </Stack>

      {/* Model Pricing - promoted from an inner sub-tab to a bottom section.
          Both tables render side by side (responsive) rather than behind a toggle. */}
      <Divider sx={{ my: 4 }}>
        <Typography level="title-md">{t('credits.model_pricing')}</Typography>
      </Divider>

      {isLoadingModels ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : modelLoadError ? (
        <Alert color="danger" sx={{ mb: 2 }}>
          {modelLoadError}
        </Alert>
      ) : (
        <Box
          className="credit-analytics-pricing-grid"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <Card variant="outlined" sx={{ p: 2 }}>
            <Box
              className="credit-analytics-pricing-container"
              sx={{ p: 0, display: 'flex', flexDirection: 'column', gap: '8px', mb: '24px' }}
            >
              <Typography
                className="credit-analytics-pricing-subtitle"
                level="body-sm"
                sx={{ fontSize: '14px', fontWeight: 600, color: theme => theme.palette.primary[500] }}
              >
                {t('credits.pricing_per_1k_tokens')}
              </Typography>
              <Typography level="body-xs" sx={{ fontSize: '13px', color: theme => `${theme.palette.text.primary}80` }}>
                Note: Prices are approximate and may vary based on model parameters. Price tiers: $ (lowest), $$
                (medium), $$$ (premium).
              </Typography>
            </Box>

            <Sheet className="credit-analytics-model-sheet" sx={{ maxHeight: '400px', overflow: 'auto' }}>
              <Table
                className="credit-analytics-model-table"
                stickyHeader
                stripe="odd"
                sx={{
                  minWidth: 480,
                  '& thead th': {
                    fontSize: '14px',
                    whiteSpace: 'nowrap',
                    color: theme => `${theme.palette.text.primary}80`,
                    backgroundColor: theme =>
                      theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
                  },
                  '& tbody td': {
                    p: '12px',
                  },
                  '& tbody td, & tbody td *': {
                    color: 'text.primary',
                  },
                  '& tbody tr:nth-of-type(odd)': {
                    backgroundColor: theme =>
                      theme.palette.mode === 'light' ? 'rgba(0, 0, 0, 0.02)' : 'rgba(255, 255, 255, 0.04)',
                  },
                }}
              >
                <thead>
                  <tr>
                    <th style={{ width: '40%' }}>{t('credits.model_name')}</th>
                    <th style={{ width: '20%' }}>{t('credits.price_tier')}</th>
                    <th style={{ width: '20%' }}>{t('credits.input_cost')}</th>
                    <th style={{ width: '20%' }}>{t('credits.output_cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {textModels.length > 0 ? (
                    textModels.map(model => {
                      const { inputCost, outputCost } = calculateModelCost(model);
                      return (
                        <tr key={model.id}>
                          <td>
                            <Typography level="body-sm" fontWeight="md">
                              {model.name}
                            </Typography>
                            {model.description && (
                              <Typography
                                level="body-xs"
                                sx={{
                                  whiteSpace: 'normal',
                                  wordBreak: 'break-word',
                                  overflowWrap: 'anywhere',
                                  opacity: 0.5,
                                }}
                              >
                                {model.description}
                              </Typography>
                            )}
                          </td>
                          <td>{renderPriceTier(model)}</td>
                          <td>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <Bike4MindIcon size="14" />
                              <Typography level="body-sm">{inputCost}</Typography>
                            </Box>
                          </td>
                          <td>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <Bike4MindIcon size="14" />
                              <Typography level="body-sm">{outputCost}</Typography>
                            </Box>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={4}>
                        <Box sx={{ py: 2, textAlign: 'center' }}>
                          <Typography level="body-sm" color="neutral">
                            {t('credits.no_models_available')}
                          </Typography>
                        </Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Card>

          <Card variant="outlined" sx={{ p: 2 }}>
            <Box
              className="credit-analytics-image-models-header"
              sx={{ p: 0, display: 'flex', flexDirection: 'column', gap: '8px', mb: '24px' }}
            >
              <Typography
                level="body-sm"
                sx={{ fontSize: '14px', fontWeight: 600, color: theme => theme.palette.primary[500] }}
              >
                {t('credits.pricing_per_generation')}
              </Typography>
              <Typography level="body-xs" sx={{ fontSize: '13px', color: theme => `${theme.palette.text.primary}80` }}>
                Note: Prices are approximate and may vary based on model parameters. Price tiers: $ (lowest), $$
                (medium), $$$ (premium).
              </Typography>
            </Box>

            <Sheet className="credit-analytics-image-models-sheet" sx={{ maxHeight: '400px', overflow: 'auto' }}>
              <Table
                className="credit-analytics-image-models-table"
                stickyHeader
                stripe="odd"
                sx={{
                  minWidth: 420,
                  '& thead th': {
                    fontSize: '14px',
                    whiteSpace: 'nowrap',
                    color: theme => `${theme.palette.text.primary}80`,
                    backgroundColor: theme =>
                      theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body,
                  },
                  '& tbody td': {
                    p: '12px',
                  },
                  '& tbody td, & tbody td *': {
                    color: 'text.primary',
                  },
                  '& tbody tr:nth-of-type(odd)': {
                    backgroundColor: theme =>
                      theme.palette.mode === 'light' ? 'rgba(0, 0, 0, 0.03)' : 'rgba(255, 255, 255, 0.04)',
                  },
                }}
              >
                <thead>
                  <tr>
                    <th style={{ width: '50%' }}>{t('credits.model_name')}</th>
                    <th style={{ width: '20%' }}>{t('credits.price_tier')}</th>
                    <th style={{ width: '30%' }}>{t('credits.generation_cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {imageModels.length > 0 ? (
                    imageModels.map(model => {
                      const { inputCost } = calculateModelCost(model);
                      return (
                        <tr key={model.id}>
                          <td>
                            <Typography level="body-sm" fontWeight="md">
                              {model.name}
                            </Typography>
                            {model.description && (
                              <Typography
                                level="body-xs"
                                sx={{
                                  whiteSpace: 'normal',
                                  wordBreak: 'break-word',
                                  overflowWrap: 'anywhere',
                                  opacity: 0.5,
                                }}
                              >
                                {model.description}
                              </Typography>
                            )}
                          </td>
                          <td>{renderPriceTier(model)}</td>
                          <td>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <Bike4MindIcon size="14" />
                              <Typography level="body-sm">{inputCost}</Typography>
                            </Box>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={3}>
                        <Box sx={{ py: 2, textAlign: 'center' }}>
                          <Typography level="body-sm" color="neutral">
                            {t('credits.no_models_available')}
                          </Typography>
                        </Box>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Sheet>
          </Card>
        </Box>
      )}
    </SectionContainer>
  );
};

export default CreditAnalyticsTabContent;
