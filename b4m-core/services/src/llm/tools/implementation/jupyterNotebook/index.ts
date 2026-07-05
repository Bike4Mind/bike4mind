/**
 * Jupyter Notebook Generation Tool
 *
 * Generates Jupyter notebooks (.ipynb) from natural language analysis descriptions.
 * The generated notebook can then be executed via Keep commands on the user's local machine.
 */

import { ToolDefinition } from '../../base/types';
import {
  NotebookDocument,
  createEmptyNotebook,
  addCodeCell,
  addMarkdownCell,
  serializeNotebook,
} from './notebookStructure';

export interface GenerateNotebookParams {
  /** Detailed description of the analysis to perform */
  analysisDescription: string;
  /** Description of the data source (file path, URL, or inline data) */
  dataSource?: string;
  /** Preferred output format for results */
  outputFormat?: 'table' | 'chart' | 'both';
  /** Jupyter kernel to use (default: python3) */
  kernelName?: string;
  /** Optional title for the notebook */
  title?: string;
}

/**
 * System prompt for notebook generation
 */
const NOTEBOOK_GENERATION_PROMPT = `You are an expert data scientist generating a Jupyter notebook.

Create a well-structured notebook that:
1. Starts with a markdown cell explaining the analysis objective
2. Includes necessary imports in the first code cell
3. Loads and explores the data
4. Performs the requested analysis
5. Visualizes results where appropriate
6. Ends with a summary markdown cell

Guidelines:
- Use pandas for data manipulation
- Use matplotlib/seaborn for basic visualizations
- Use plotly for interactive charts if requested
- Include comments explaining key steps
- Handle potential errors gracefully
- Print intermediate results for debugging

Return the notebook content as a JSON object with this structure:
{
  "title": "Notebook title",
  "cells": [
    { "type": "markdown", "content": "# Title\\n\\nDescription..." },
    { "type": "code", "content": "import pandas as pd\\nimport numpy as np" },
    ...
  ]
}`;

interface NotebookGenerationResponse {
  title: string;
  cells: Array<{
    type: 'markdown' | 'code';
    content: string;
  }>;
}

/**
 * Parse the LLM response and extract notebook structure
 */
function parseNotebookResponse(response: string): NotebookGenerationResponse {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse notebook structure from LLM response');
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.cells || !Array.isArray(parsed.cells)) {
      throw new Error('Invalid notebook structure: missing cells array');
    }
    return parsed as NotebookGenerationResponse;
  } catch (e) {
    throw new Error(`Failed to parse notebook JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Build a notebook from the parsed response
 */
function buildNotebook(
  response: NotebookGenerationResponse,
  kernelName: string,
  metadata?: { questId?: string; sessionId?: string; analysisDescription?: string }
): NotebookDocument {
  const notebook = createEmptyNotebook(kernelName);

  // Add B4M metadata
  notebook.metadata.title = response.title;
  notebook.metadata.b4m_metadata = {
    generatedAt: new Date().toISOString(),
    ...metadata,
  };

  for (const cell of response.cells) {
    if (cell.type === 'markdown') {
      addMarkdownCell(notebook, cell.content);
    } else if (cell.type === 'code') {
      addCodeCell(notebook, cell.content);
    }
  }

  return notebook;
}

export const jupyterNotebookTool: ToolDefinition = {
  name: 'generate_jupyter_notebook',
  implementation: context => ({
    toolFn: async value => {
      const params = value as GenerateNotebookParams;
      const { analysisDescription, dataSource, outputFormat, kernelName, title } = params;

      if (!analysisDescription) {
        throw new Error('analysisDescription is required');
      }

      const userPrompt = `Generate a Jupyter notebook for the following analysis:

**Analysis Description:** ${analysisDescription}
${dataSource ? `**Data Source:** ${dataSource}` : ''}
${outputFormat ? `**Output Format:** ${outputFormat}` : ''}
${title ? `**Notebook Title:** ${title}` : ''}

Please generate a complete, well-structured notebook that performs this analysis.`;

      context.logger.info('[JupyterNotebook] Generating notebook structure via LLM...');

      // Collect the response from the LLM using the streaming callback pattern
      let responseText = '';
      await context.llm.complete(
        context.model ?? 'gpt-4',
        [
          { role: 'system', content: NOTEBOOK_GENERATION_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        { maxTokens: 4000, temperature: 0.7 },
        async texts => {
          responseText = texts.filter(t => t !== null && t !== undefined).join('');
        }
      );

      if (!responseText) {
        throw new Error('LLM returned empty response');
      }

      const parsedResponse = parseNotebookResponse(responseText);
      const notebook = buildNotebook(parsedResponse, kernelName || 'python3', {
        analysisDescription,
      });

      context.logger.info(`[JupyterNotebook] Generated notebook with ${notebook.cells.length} cells`);

      return serializeNotebook(notebook);
    },
    toolSchema: {
      name: 'generate_jupyter_notebook',
      description: `Generate a Jupyter notebook for data analysis. The notebook will be created with Python code cells that can be executed locally via the Keep command system. Use this tool when the user wants to perform data analysis, create visualizations, or work with datasets.`,
      parameters: {
        type: 'object',
        properties: {
          analysisDescription: {
            type: 'string',
            description:
              'Detailed description of the analysis to perform. Be specific about what calculations, visualizations, or insights are needed.',
          },
          dataSource: {
            type: 'string',
            description:
              'Description of the data source. Can be a file path (e.g., "~/data/sales.csv"), URL, or description of inline data.',
          },
          outputFormat: {
            type: 'string',
            enum: ['table', 'chart', 'both'],
            description:
              'Preferred output format for results. "table" for tabular data, "chart" for visualizations, "both" for both.',
          },
          kernelName: {
            type: 'string',
            description:
              'Jupyter kernel to use. Defaults to "python3". Other options depend on what kernels are installed locally.',
          },
          title: {
            type: 'string',
            description: 'Optional title for the notebook.',
          },
        },
        required: ['analysisDescription'],
      },
    },
  }),
};

// Re-export notebook structure utilities
export * from './notebookStructure';
