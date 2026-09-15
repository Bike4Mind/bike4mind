/**
 * Example Bike4Mind CLI plugin. The default export is a factory receiving a
 * PluginContext ({ logger }) and returning a feature module. Plugins cannot
 * import @bike4mind/* packages (they are bundled into the CLI), so tool
 * objects are written out structurally: { toolFn, toolSchema }.
 */
export default ctx => ({
  name: 'example',
  description: 'Example plugin that says hello',

  getTools: () => [
    {
      toolFn: async ({ name }) => `Hello, ${name ?? 'world'}! (from b4m-plugin-example)`,
      toolSchema: {
        name: 'example_hello',
        description: 'Return a greeting from the example plugin',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Who to greet' },
          },
        },
      },
    },
  ],

  getSystemPromptSection: () =>
    'The example plugin is installed. Use the example_hello tool when the user asks for a plugin greeting.',

  getCommands: () => [
    {
      name: 'example',
      description: 'Print a greeting from the example plugin',
      execute: () => {
        console.log('Hello from b4m-plugin-example!');
      },
    },
  ],

  dispose: () => {
    ctx.logger.debug('example plugin disposed');
  },
});
