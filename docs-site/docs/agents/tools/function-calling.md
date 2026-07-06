---
sidebar_position: 10
title: "Function Calling Tools Manual"
content_type: ["how-to", "reference"]
feature_status: stable
audience: ["developers"]
spiciness: hot
visibility: public
maturity: approved
related_features: ["development"]
tags: ["dev-sided", "api", "typescript", "testing", "ai"]
last_reviewed: 2025-06-30
---

# Function Calling Tools Manual

## Overview

The Bike4Mind (B4M) platform uses a sophisticated function calling tools system that allows LLMs to execute external functions and APIs during conversations. This system provides a clean, modular architecture for extending AI capabilities with real-world integrations.

## Architecture Overview

### Core Components

```
b4m-core/services/src/llm/tools/
├── index.ts                 # Main tool registry and generator
├── base/
│   ├── types.ts            # Core interfaces and types
│   └── constants.ts        # Shared constants
└── implementation/         # Individual tool implementations
    ├── diceroll/
    ├── weather/
    ├── websearch/
    ├── imageGeneration/
    ├── math/
    └── mermaidChart/
```

### Key Interfaces

#### ToolDefinition
Every tool must implement the `ToolDefinition` interface:

```typescript
export interface ToolDefinition {
  name: string;
  implementation: (context: ToolContext) => ICompletionOptionTools;
}
```

#### ToolContext
Provides access to system resources:

```typescript
export interface ToolContext {
  userId: string;
  logger: Logger;
  db: GetEffectiveApiKeyAdapters['db'];
}
```

#### ICompletionOptionTools
The actual tool implementation:

```typescript
export interface ICompletionOptionTools {
  toolFn: <T = unknown>(parameters?: T, apiKey?: string) => Promise<string>;
  toolSchema: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: {
        [key: string]: {
          type: string;
          description: string;
          enum?: string[];
        };
      };
      additionalProperties?: boolean;
      required?: string[];
    };
    strict?: boolean;
  };
}
```

## Tool Registration System

### 1. Define Tool Types

All available tools are defined in `b4m-core/common/src/schemas/llm.ts`:

```typescript
export const b4mLLMTools = z.enum([
  'dice_roll',
  'image_generation',
  'weather_info',
  'web_search',
  'math_evaluate',
  'mermaid_chart',
]);

export type B4MLLMTools = z.infer<typeof b4mLLMTools>;
```

### 2. Tool Registry

Tools are registered in `b4m-core/services/src/llm/tools/index.ts`:

```typescript
const tools = {
  dice_roll: diceRollTool,
  weather_info: weatherTool,
  image_generation: imageGenerationTool,
  web_search: webSearchTool,
  math_evaluate: mathTool,
  mermaid_chart: mermaidChartTool,
} satisfies {
  [key in LlmTools]: ToolDefinition;
};
```

### 3. Tool Generation

The `generateTools` function creates runtime tool instances:

```typescript
export const generateTools = (
  userId: string,
  logger: Logger,
  { db }: GetEffectiveApiKeyAdapters
): Record<string, ICompletionOptionTools> => {
  const context: ToolContext = {
    userId,
    logger,
    db,
  };

  return Object.entries(tools).reduce(
    (acc, [key, tool]) => ({
      ...acc,
      [key]: tool.implementation(context),
    }),
    {} as Record<LlmTools, ICompletionOptionTools>
  );
};
```

## Creating a New Tool

### Step 1: Create Tool Implementation

Create a new directory under `implementation/` with an `index.ts` file:

```typescript
// b4m-core/services/src/llm/tools/implementation/myTool/index.ts

import { ToolDefinition } from '../../base/types';

interface MyToolParams {
  input: string;
  option?: number;
}

const executeMyTool = async (parameters: MyToolParams): Promise<string> => {
  // Validate parameters
  if (!parameters.input) {
    throw new Error('Tool myTool: Missing required parameter "input"');
  }

  // Implement your tool logic here
  const result = `Processed: ${parameters.input}`;
  return result;
};

export const myTool: ToolDefinition = {
  name: 'my_tool',
  implementation: (context) => ({
    toolFn: async (value) => {
      const params = value as MyToolParams;
      context.logger.log('🔧 MyTool: Starting execution', params);
      
      try {
        const result = await executeMyTool(params);
        context.logger.log('✅ MyTool: Execution completed');
        return result;
      } catch (error) {
        context.logger.error('❌ MyTool: Execution failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'my_tool',
      description: 'A description of what this tool does',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'The input string to process',
          },
          option: {
            type: 'number',
            description: 'An optional number parameter',
          },
        },
        required: ['input'],
      },
    },
  }),
};
```

### Step 2: Add to Tool Registry

1. **Update the schema** in `b4m-core/common/src/schemas/llm.ts`:

```typescript
export const b4mLLMTools = z.enum([
  'dice_roll',
  'image_generation',
  'weather_info',
  'web_search',
  'math_evaluate',
  'mermaid_chart',
  'my_tool', // Add your new tool
]);
```

2. **Import and register** in `b4m-core/services/src/llm/tools/index.ts`:

```typescript
import { myTool } from './implementation/myTool';

const tools = {
  dice_roll: diceRollTool,
  weather_info: weatherTool,
  image_generation: imageGenerationTool,
  web_search: webSearchTool,
  math_evaluate: mathTool,
  mermaid_chart: mermaidChartTool,
  my_tool: myTool, // Add your tool here
} satisfies {
  [key in LlmTools]: ToolDefinition;
};
```

### Step 3: Add UI Integration

Add your tool to the `ToolsSection` component in `apps/client/app/components/Session/AISettings/ToolsSection.tsx`:

```tsx
// Add appropriate icon import
import { Build as MyToolIcon } from '@mui/icons-material';

// Add the tool toggle in the grid
<Grid xs={12}>
  <ToolContainer>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}>
      <MyToolIcon sx={{ color: 'neutral.300', fontSize: '1.25rem', flexShrink: 0 }} />
      <Typography level="body-sm" noWrap>
        My Tool
      </Typography>
    </Box>
    <SquareSlideToggle
      onChange={() => handleToggleTool('my_tool')}
      checked={tools.includes('my_tool')}
    />
  </ToolContainer>
</Grid>
```

## Tool Implementation Patterns

### 1. Simple Tools (No External APIs)

Example: Dice Roll Tool

```typescript
const diceRoll = async (parameters?: DiceRollParams): Promise<string> => {
  if (!parameters?.sides || !parameters?.times) {
    throw new Error('Tool dice roll: Missing required parameters');
  }

  return sum(times(parameters.times, () => random(1, parameters.sides))).toString();
};
```

### 2. API-Dependent Tools

Example: Web Search Tool

```typescript
async function performWebSearch(adapters: GetEffectiveApiKeyAdapters, params: WebSearchParams): Promise<string> {
  const apiKey = await getSerperKey(adapters);
  
  if (!apiKey) {
    console.error('❌ WebSearch Tool: No API key configured');
    return '';
  }

  // Make API call
  const response = await fetch(url.toString(), {
    method: 'GET',
    signal: controller.signal,
  });

  // Process and return results
  return formattedResults;
}
```

### 3. Service-Based Tools

Example: Image Generation Tool

```typescript
export const imageGenerationTool: ToolDefinition = {
  name: 'image_generation',
  implementation: context => ({
    toolFn: async val => {
      const { prompt, model = ImageModels.FLUX_PRO } = val as ImageGenerateParams;

      const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.openai }, { db: context.db });
      const service = new OpenAIImageService(apiKey!, context.logger);
      
      const images = await service.generate(prompt, options);
      return images.map((image, i) => `[image${i}](${image})`).join('\n');
    },
    // ... schema definition
  }),
};
```

## Best Practices

### 1. Error Handling

- Always validate input parameters
- Provide meaningful error messages
- Use try-catch blocks for external API calls
- Log errors with context using the provided logger

```typescript
toolFn: async (value) => {
  const params = value as MyToolParams;
  
  if (!params.requiredField) {
    throw new Error('Tool myTool: Missing required parameter "requiredField"');
  }

  try {
    const result = await externalApiCall(params);
    return result;
  } catch (error) {
    context.logger.error('❌ MyTool: API call failed', error);
    throw new Error(`MyTool failed: ${error.message}`);
  }
}
```

### 2. Parameter Validation

- Define clear TypeScript interfaces for parameters
- Use required arrays in the schema
- Provide helpful descriptions

```typescript
interface ToolParams {
  required_param: string;
  optional_param?: number;
}

// In schema:
parameters: {
  type: 'object',
  properties: {
    required_param: {
      type: 'string',
      description: 'Clear description of what this parameter does',
    },
    optional_param: {
      type: 'number',
      description: 'Optional parameter with default behavior explained',
    },
  },
  required: ['required_param'],
}
```

### 3. Logging

- Use structured logging with consistent prefixes
- Log both success and failure cases
- Include relevant context

```typescript
context.logger.log('🔧 MyTool: Starting execution', { userId: context.userId, params });
context.logger.log('✅ MyTool: Execution completed successfully');
context.logger.error('❌ MyTool: Execution failed', error);
```

### 4. API Key Management

- Use the `getEffectiveApiKey` function for retrieving API keys
- Handle cases where API keys are not configured
- Support different API key types

```typescript
const apiKey = await getEffectiveApiKey(
  context.userId, 
  { type: ApiKeyType.openai }, 
  { db: context.db }
);

if (!apiKey) {
  throw new Error('API key not configured for this service');
}
```

## Integration with LLM Backends

Tools are automatically integrated with all supported LLM backends:

### OpenAI Backend
```typescript
formatTools(tools: ICompletionOptionTools[] = []) {
  return tools.map(tool => ({
    type: 'function' as const,
    function: tool.toolSchema,
  }));
}
```

### Anthropic Backend
```typescript
formatTools(tools: ICompletionOptionTools[] = []) {
  return tools.map(tool => {
    const { parameters, ...rest } = tool.toolSchema;
    return {
      ...rest,
      input_schema: parameters,
    };
  });
}
```

### Gemini Backend
```typescript
tools: [{
  functionDeclarations: options.tools!.map(tool => ({
    name: tool.toolSchema.name,
    description: tool.toolSchema.description,
    parameters: pick(tool.toolSchema.parameters, 'type', 'properties', 'required'),
  })),
}]
```

## MCP (Model Context Protocol) Support

The system also supports MCP tools through the `generateMcpTools` function:

```typescript
export const generateMcpTools = async (
  mcpData: Awaited<ReturnType<IChatCompletionServiceOptions['getMcpClient']>>
): Promise<Array<{ name: string } & ICompletionOptionTools>> => {
  const tools = await mcpData.getTools();

  return tools.map(item => {
    const { name, ...rest } = item;
    return {
      name,
      toolFn: async (args: any) => {
        const toolResult = await mcpData.callTool(name, args);
        return toolResult.content as string;
      },
      toolSchema: {
        name,
        description: rest.description || '',
        parameters: rest.input_schema as ICompletionOptionTools['toolSchema']['parameters'],
      },
    };
  });
};
```

## Testing Your Tools

### 1. Unit Testing

Create tests for your tool logic:

```typescript
describe('MyTool', () => {
  test('should process input correctly', async () => {
    const context = createMockContext();
    const tool = myTool.implementation(context);
    
    const result = await tool.toolFn({ input: 'test' });
    expect(result).toBe('Processed: test');
  });

  test('should throw error for missing input', async () => {
    const context = createMockContext();
    const tool = myTool.implementation(context);
    
    await expect(tool.toolFn({})).rejects.toThrow('Missing required parameter');
  });
});
```

### 2. Integration Testing

Test the tool through the LLM API:

1. Enable your tool in the UI
2. Send a message that should trigger the tool
3. Verify the tool is called and returns expected results

## Troubleshooting

### Common Issues

1. **Tool not appearing in UI**: Check that it's added to both the schema and ToolsSection component
2. **Tool not being called**: Verify the tool description is clear and the LLM understands when to use it
3. **Parameter validation errors**: Ensure the schema matches your parameter interface
4. **API key errors**: Check that the correct API key type is configured and accessible

### Debugging

- Enable detailed logging in the tool implementation
- Check browser console for client-side errors
- Monitor server logs for tool execution details
- Use the network tab to inspect API calls

## Security Considerations

1. **Input Validation**: Always validate and sanitize tool parameters
2. **API Key Protection**: Never log API keys or include them in error messages
3. **Rate Limiting**: Implement appropriate rate limiting for external API calls
4. **Error Information**: Be careful not to expose sensitive information in error messages

## Performance Considerations

1. **Async Operations**: Use proper async/await patterns
2. **Timeouts**: Implement timeouts for external API calls
3. **Caching**: Consider caching results for expensive operations
4. **Resource Management**: Clean up resources properly (close connections, etc.)

This manual provides a comprehensive guide to understanding and extending the B4M function calling tools system. Follow these patterns and best practices to create robust, maintainable tools that enhance the AI experience. 