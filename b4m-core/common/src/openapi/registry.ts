import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

// Adds `.openapi()` to the shared Zod instance. Must run before any `.openapi()`
// call anywhere in the spec build, so every openapi/* module imports the registry
// from here rather than constructing its own - guaranteeing this ran first.
extendZodWithOpenApi(z);

/**
 * The single OpenAPIRegistry for the public API spec. Schemas, security schemes,
 * and operations all register against this one instance; `generate.ts` reads its
 * definitions to emit openapi.json. One registry means no duplicate component
 * definitions and no separate definition file that can drift from the schemas.
 */
export const registry = new OpenAPIRegistry();
