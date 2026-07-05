import { Logger } from '@bike4mind/observability';
import { Anthropic } from '@anthropic-ai/sdk';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ModelBackend } from '@bike4mind/common';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { KpiMetrics } from './types';

export interface AgnosticInsightsData {
  logs: Array<{
    date: string;
    counterName: string;
    totalValue: number;
  }>;
  metrics: Record<string, KpiMetrics>;
}

export async function generateAgnosticAiInsights(
  data: AgnosticInsightsData,
  apiKey: string,
  provider: ModelBackend,
  model: string,
  isWeeklyReport: boolean = false
): Promise<string | null> {
  try {
    const systemPrompt = `You are an analytics expert. Analyze this usage data and provide ${
      isWeeklyReport
        ? 'exactly two key highlights, two concerns, and two focus areas for next week'
        : 'exactly two key highlights and two concerns'
    }, considering:
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

    let content: string | null = null;

    switch (provider) {
      case ModelBackend.OpenAI: {
        const openai = new OpenAI({ apiKey });
        const response = await openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 500,
          stream: false,
        });
        content = response.choices[0]?.message?.content || null;
        break;
      }

      case ModelBackend.Anthropic: {
        const anthropic = new Anthropic({ apiKey });
        const response = await anthropic.messages.create({
          model,
          max_tokens: 500,
          temperature: 0.7,
          messages: [
            {
              role: 'user',
              content: `${systemPrompt}\n\n${userPrompt}`,
            },
          ],
        });
        content = response.content[0]?.type === 'text' ? response.content[0].text : null;
        break;
      }

      case ModelBackend.Bedrock: {
        const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

        let requestBody: any;
        if (model.includes('anthropic')) {
          requestBody = {
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 500,
            temperature: 0.7,
            messages: [
              {
                role: 'user',
                content: `${systemPrompt}\n\n${userPrompt}`,
              },
            ],
          };
        } else if (model.includes('amazon.titan')) {
          requestBody = {
            inputText: `${systemPrompt}\n\n${userPrompt}`,
            textGenerationConfig: {
              maxTokenCount: 500,
              temperature: 0.7,
            },
          };
        }

        const command = new InvokeModelCommand({
          modelId: model,
          body: JSON.stringify(requestBody),
        });

        const response = await bedrock.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));

        if (model.includes('anthropic')) {
          content = responseBody.content[0]?.text || null;
        } else if (model.includes('amazon.titan')) {
          content = responseBody.results[0]?.outputText || null;
        }
        break;
      }

      case ModelBackend.Gemini: {
        const genAI = new GoogleGenAI({ apiKey });
        const result = await genAI.models.generateContent({
          model,
          contents: `${systemPrompt}\n\n${userPrompt}`,
        });
        content = result.text ?? null;
        break;
      }

      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    return content;
  } catch (error) {
    Logger.globalInstance.error('Error generating AI insights:', error);
    return null;
  }
}
