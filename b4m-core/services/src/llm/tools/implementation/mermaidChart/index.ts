import { ToolDefinition } from '../../base/types';

interface MermaidChartParams {
  definition: string;
  type?:
    | 'flowchart'
    | 'sequenceDiagram'
    | 'classDiagram'
    | 'stateDiagram'
    | 'entityRelationshipDiagram'
    | 'gantt'
    | 'pie'
    | 'mindmap';
  title?: string;
  description?: string;
}

export const mermaidChartTool: ToolDefinition = {
  name: 'mermaid_chart',
  implementation: () => ({
    toolFn: async value => {
      const params = value as MermaidChartParams;
      const title = params.title || 'Mermaid Chart';
      const identifier = `mermaid-${Date.now()}`;

      // Return artifact syntax directly so handleToolResultStreaming streams it immediately
      // (same pattern as recharts - avoids the JSON-in-tool-result rendering gap)
      return `<artifact identifier="${identifier}" type="application/vnd.ant.mermaid" title="${title}">
${params.definition}
</artifact>`;
    },
    toolSchema: {
      name: 'mermaid_chart',
      description: 'Generate a Mermaid chart definition for various diagram types (flowchart, sequence, class, etc)',
      parameters: {
        type: 'object',
        properties: {
          definition: {
            type: 'string',
            description: 'The Mermaid chart definition in valid Mermaid syntax',
          },
          type: {
            type: 'string',
            description: 'The type of Mermaid chart to generate',
            enum: [
              'flowchart',
              'sequenceDiagram',
              'classDiagram',
              'stateDiagram',
              'entityRelationshipDiagram',
              'gantt',
              'pie',
              'mindmap',
            ],
          },
          title: {
            type: 'string',
            description: 'Optional title for the chart',
          },
          description: {
            type: 'string',
            description: 'Optional description of what the chart represents',
          },
        },
        required: ['definition'],
      },
    },
  }),
};
