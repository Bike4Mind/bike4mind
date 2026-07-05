import { extensionFromMimeType } from '@bike4mind/common';
import dayjs from 'dayjs';
import type { EventMetric, CurationMetadata } from '../types';

export interface ChartData {
  // Legacy fields for OverviewTab compatibility
  timeSeriesData: {
    date: string;
    count: number;
    events?: EventMetric[];
  }[];
  categoryBreakdown: {
    category: string;
    count: number;
    percentage: number;
  }[];
  topEvents: {
    eventName: string;
    count: number;
    category: string;
  }[];
  curationBreakdown?: {
    fileType: string;
    count: number;
    curationType?: {
      transcript: number;
      executive_summary: number;
    };
    exportFormat?: {
      markdown: number;
      txt: number;
      html: number;
    };
  }[];

  // New fields
  eventTrends: { date: string; count: number }[];
  categoryDistribution: { name: string; value: number }[];
  userActivity: { name: string; value: number }[];
  slackMetrics?: {
    eventsByType: Record<string, number>;
    exportFormats: { json: number; csv: number; markdown: number };
    exportStatus: { success: number; failed: number };
    agentDistribution: Record<string, number>;
    intentDistribution: Record<string, number>;
  };
}

export function processChartData(metrics: EventMetric[]): ChartData {
  // Filter out any malformed metrics
  const safeMetrics = metrics.filter(m => m && m.timestamp);

  // 1. Event Trends (Group by date) - Using simple string date for new charts
  const trendsMap = new Map<string, number>();
  // Also build map for legacy timeSeriesData
  const dateMap = new Map<string, EventMetric[]>();

  safeMetrics.forEach(metric => {
    // New format
    const dateStr = new Date(metric.timestamp).toLocaleDateString();
    trendsMap.set(dateStr, (trendsMap.get(dateStr) || 0) + 1);

    // Legacy format
    const dateIso = dayjs(metric.timestamp).format('YYYY-MM-DD');
    if (!dateMap.has(dateIso)) {
      dateMap.set(dateIso, []);
    }
    dateMap.get(dateIso)!.push(metric);
  });

  // Sort by date (New)
  const eventTrends = Array.from(trendsMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Sort by date (Legacy)
  const timeSeriesData = Array.from(dateMap.entries())
    .map(([date, events]) => ({
      date,
      count: events.length,
      events,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 2. Category Distribution
  const categoryMap = new Map<string, number>();
  safeMetrics.forEach(metric => {
    const category = metric.eventCategory || 'Other';
    categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
  });

  // New format
  const categoryDistribution = Array.from(categoryMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Legacy format
  const totalEvents = safeMetrics.length;
  const categoryBreakdown = Array.from(categoryMap.entries())
    .map(([category, count]) => ({
      category,
      count,
      percentage: totalEvents > 0 ? (count / totalEvents) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // 3. Top Active Users & Top Events
  const userMap = new Map<string, number>();
  const eventMap = new Map<string, { count: number; category: string }>();

  safeMetrics.forEach(metric => {
    // Users
    const userName = metric.user?.userName || 'Unknown User';
    userMap.set(userName, (userMap.get(userName) || 0) + 1);

    // Top Events (Legacy)
    const existing = eventMap.get(metric.eventName);
    if (existing) {
      existing.count += 1;
    } else {
      eventMap.set(metric.eventName, { count: 1, category: metric.eventCategory });
    }
  });

  const userActivity = Array.from(userMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10); // Top 10 users

  const topEvents = Array.from(eventMap.entries())
    .map(([eventName, data]) => ({
      eventName,
      count: data.count,
      category: data.category,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // 4. Curation Breakdown (Legacy)
  const curationMetrics = safeMetrics.filter(
    m => m.metadata && (m.metadata.mimeType || m.metadata.fileExtension || m.metadata.curationType)
  );

  let curationBreakdown: ChartData['curationBreakdown'] = undefined;

  if (curationMetrics.length > 0) {
    const fileTypeMap = new Map<
      string,
      {
        count: number;
        curationType: { transcript: number; executive_summary: number };
        exportFormat: { markdown: number; txt: number; html: number };
      }
    >();

    curationMetrics.forEach(metric => {
      const metadata = metric.metadata as CurationMetadata;
      // Determine file type
      let fileType = 'Unknown';
      if (metadata.fileExtension) {
        fileType = metadata.fileExtension.toUpperCase();
      } else if (metadata.mimeType) {
        // Map the MIME type to its real extension (e.g. the Excel spreadsheetml
        // type to "xlsx" rather than the bogus "sheet" a naive split produces).
        // Fall back to the subtype for MIME types not in the lookup.
        const ext = extensionFromMimeType(metadata.mimeType) ?? metadata.mimeType.split('/').pop() ?? 'Unknown';
        fileType = ext.toUpperCase();
      } else if (metadata.exportFormat) {
        fileType = metadata.exportFormat.toUpperCase();
      }

      if (!fileTypeMap.has(fileType)) {
        fileTypeMap.set(fileType, {
          count: 0,
          curationType: { transcript: 0, executive_summary: 0 },
          exportFormat: { markdown: 0, txt: 0, html: 0 },
        });
      }

      const data = fileTypeMap.get(fileType)!;
      data.count += 1;

      if (metadata.curationType) {
        if (metadata.curationType === 'transcript') {
          data.curationType.transcript += 1;
        } else if (metadata.curationType === 'executive_summary') {
          data.curationType.executive_summary += 1;
        }
      }

      if (metadata.exportFormat) {
        if (metadata.exportFormat === 'markdown') {
          data.exportFormat.markdown += 1;
        } else if (metadata.exportFormat === 'txt') {
          data.exportFormat.txt += 1;
        } else if (metadata.exportFormat === 'html') {
          data.exportFormat.html += 1;
        }
      }
    });

    curationBreakdown = Array.from(fileTypeMap.entries())
      .map(([fileType, data]) => ({
        fileType,
        count: data.count,
        curationType: data.curationType,
        exportFormat: data.exportFormat,
      }))
      .sort((a, b) => b.count - a.count);
  }

  // 5. Slack Metrics (New)
  const slackEvents = safeMetrics.filter(m => m.eventCategory === 'Slack');
  let slackMetrics: ChartData['slackMetrics'] = undefined;

  if (slackEvents.length > 0) {
    const eventsByType: Record<string, number> = {};
    const exportFormats = { json: 0, csv: 0, markdown: 0 };
    const exportStatus = { success: 0, failed: 0 };
    const agentDistribution: Record<string, number> = {};
    const intentDistribution: Record<string, number> = {};

    slackEvents.forEach(event => {
      // Count by type
      eventsByType[event.eventName] = (eventsByType[event.eventName] || 0) + 1;

      // Analyze exports
      if (event.eventName === 'Slack Channel Export Started') {
        const format = event.metadata?.format as 'json' | 'csv' | 'markdown';
        if (format && exportFormats[format] !== undefined) {
          exportFormats[format]++;
        }
      }

      if (event.eventName === 'Slack Channel Export Completed') {
        exportStatus.success++;
      } else if (event.eventName === 'Slack Channel Export Failed') {
        exportStatus.failed++;
      }

      // Analyze Commands (Agent & Intent) - Handling events from @bike4mind/common
      if (
        event.eventName === 'Slack Command Processed' || // Legacy/Admin
        event.eventName === 'Slack Command Received' || // Common: Received
        event.eventName === 'Slack Command Completed' // Common: Completed
      ) {
        if (event.metadata?.agentName) {
          const agent = event.metadata.agentName;
          agentDistribution[agent] = (agentDistribution[agent] || 0) + 1;
        }
        if (event.metadata?.intent) {
          const intent = event.metadata.intent;
          intentDistribution[intent] = (intentDistribution[intent] || 0) + 1;
        }
      }
    });

    slackMetrics = {
      eventsByType,
      exportFormats,
      exportStatus,
      agentDistribution,
      intentDistribution,
    };
  }

  return {
    // Legacy fields
    timeSeriesData,
    categoryBreakdown,
    topEvents,
    curationBreakdown,
    // New fields
    eventTrends,
    categoryDistribution,
    userActivity,
    slackMetrics,
  };
}
