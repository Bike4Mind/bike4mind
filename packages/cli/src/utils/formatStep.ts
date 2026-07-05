import type { AgentStep } from '@bike4mind/agents';

const MAX_INPUT_LENGTH = 500;

/**
 * Formatter function to truncate toolInput for action steps and observation content.
 * Used to keep step metadata concise for display in the CLI.
 */
export const formatStep = (step: AgentStep): AgentStep => {
  // Format action steps: truncate toolInput
  if (step.type === 'action' && step.metadata?.toolInput) {
    // Parse JSON string if needed
    let parsedInput = step.metadata.toolInput;
    if (typeof parsedInput === 'string') {
      try {
        parsedInput = JSON.parse(parsedInput);
      } catch {
        // Not a JSON string, keep as is
      }
    }

    // Special handling for edit_local_file: only include path
    if (step.metadata.toolName === 'edit_local_file') {
      const pathOnly =
        typeof parsedInput === 'object' && parsedInput !== null && 'path' in parsedInput
          ? { path: (parsedInput as any).path }
          : parsedInput;
      return {
        ...step,
        metadata: {
          ...step.metadata,
          toolInput: pathOnly,
        },
      };
    }

    // Special handling for write_todos: only show count
    if (step.metadata.toolName === 'write_todos') {
      const todos =
        typeof parsedInput === 'object' && parsedInput !== null && 'todos' in parsedInput
          ? (parsedInput as { todos: unknown[] }).todos
          : null;
      const count = Array.isArray(todos) ? todos.length : 0;
      return {
        ...step,
        metadata: {
          ...step.metadata,
          toolInput: `${count} todo${count !== 1 ? 's' : ''}`,
        },
      };
    }

    // General truncation for other tools
    const inputStr = typeof parsedInput === 'string' ? parsedInput : JSON.stringify(parsedInput);
    if (inputStr.length > MAX_INPUT_LENGTH) {
      const truncatedInput =
        inputStr.slice(0, MAX_INPUT_LENGTH) + `... (${inputStr.length - MAX_INPUT_LENGTH} more chars)`;
      return {
        ...step,
        metadata: {
          ...step.metadata,
          toolInput: truncatedInput,
        },
      };
    }
  }

  if (step.type === 'observation' && step.content) {
    // Format observation steps: show line count for file_read
    if (step.metadata?.toolName === 'file_read') {
      const lineCount = step.content.split('\n').length;
      return {
        ...step,
        content: `Read ${lineCount} line${lineCount !== 1 ? 's' : ''}`,
      };
    }

    // Format observation steps: show only file count for grep_search
    if (step.metadata?.toolName === 'grep_search') {
      // Extract the "Found X file(s)" part from the first line
      const match = step.content.match(/^Found (\d+) file\(s\)/);
      if (match) {
        const count = parseInt(match[1], 10);
        return {
          ...step,
          content: `Found ${count} file${count !== 1 ? 's' : ''}`,
        };
      }
    }

    // Format observation steps: show only file count for glob_files
    if (step.metadata?.toolName === 'glob_files') {
      // Extract the "Found X file(s)" part from the first line
      const match = step.content.match(/^Found (\d+) file\(s\)/);
      if (match) {
        const count = parseInt(match[1], 10);
        return {
          ...step,
          content: `Found ${count} file${count !== 1 ? 's' : ''}`,
        };
      }
    }
  }

  return step;
};
