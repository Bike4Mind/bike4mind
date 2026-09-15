import { Logger } from '@bike4mind/observability';
import OpenAI from 'openai';
import { KpiMetrics } from './types';
import { ChatModels } from '@bike4mind/common';

export interface InsightsData {
  logs: Array<{
    date: string;
    counterName: string;
    totalValue: number;
  }>;
  metrics: Record<string, KpiMetrics>;
}

export async function generateAIInsights(
  data: InsightsData,
  apiKey: string,
  isWeeklyReport: boolean = false
): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey });

    const systemPrompt = `You are an analytics expert. Analyze this usage data and provide ${isWeeklyReport ? 'exactly two key highlights, two concerns, and two focus areas for next week' : 'exactly two key highlights and two concerns'}, considering:
        1. Focus on metrics that directly impact user engagement and business growth
        2. Distinguish between vanity metrics and actionable insights
        3. Consider the context - e.g., a decrease in "User Logout" might actually be positive
        4. Look for patterns that suggest user adoption or drop-off
        5. Prioritize metrics related to core product features (AI interactions, file management, etc.)

        Format the response exactly this way (no formatting, no extra newlines or spaces):
        Highlights:
        - [First highlight focusing on positive business impact]
        - [Second highlight showing promising user behavior]

        Concerns:
        - [First concern highlighting potential business risk]
        - [Second concern identifying user adoption issues]${
          isWeeklyReport
            ? `

        Next Week's Focus:
        - [First actionable focus area based on current trends]
        - [Second strategic focus area for improvement]`
            : ''
        }`;

    const userPrompt = `Analyze these activity logs and metrics for insights:
        Activity Logs:
        ${data.logs.map(log => `${log.date}: ${log.counterName} = ${log.totalValue}`).join('\n')}

        Metrics by Counter:
        ${Object.entries(data.metrics)
          .map(
            ([counterName, metrics]) =>
              `${counterName}:
            - Weekly Total: ${metrics.weeklyTotal}
            - Last Week Total: ${metrics.lastWeekTotal}
            - Week over Week Change: ${metrics.weekOverWeekChange}%
            - Four Week Average: ${metrics.fourWeekAverage}
            - Four Week Average Change: ${metrics.fourWeekAverageChange}%`
          )
          .join('\n')}`;

    const response = await openai.chat.completions.create({
      model: ChatModels.GPT4o,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
      stream: false,
    });

    const content = response.choices[0]?.message?.content || null;
    if (content) {
      // Return the raw content without any formatting
      return content;
    }
    return null;
  } catch (error) {
    Logger.globalInstance.error('Error generating AI insights:', error);
    return null;
  }
}
