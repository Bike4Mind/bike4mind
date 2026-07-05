/**
 * DocumentDB Compatibility Utilities
 *
 * AWS DocumentDB emulates MongoDB 5.0 and lacks support for:
 * - $facet aggregation stage
 * - $lookup with multiple join conditions in $expr
 * - collation option
 *
 * This module provides compatibility functions to work around these limitations.
 *
 * Note on types: MongoDB aggregation pipeline stages ($match, $lookup, $facet, etc.) and
 * $expr conditions are arbitrary BSON documents whose shape depends on runtime operator
 * combinations, so they're modelled as `Record<string, unknown>` (`AggStage`) - a string-keyed
 * document - rather than `any`. Inspecting an operator key yields `unknown` and is narrowed at
 * the use site.
 *
 * The exported boundary functions keep `any` on their pipeline params/returns by design: callers
 * across the codebase pass inconsistently-typed pipelines (some `mongoose.PipelineStage[]`, some
 * loose document literals) and consume dynamically-shaped `$facet` results, while
 * `model.aggregate()` requires the strict `PipelineStage` union. A non-`any` boundary forces
 * the breakage onto every caller; eliminating it cleanly needs generics/a full pipeline-type DSL
 * threaded through ~90 call sites. Each remaining `any` is annotated inline with this rationale.
 */

import mongoose from 'mongoose';

/** A single aggregation-pipeline stage or $expr condition: an arbitrary BSON document. */
type AggStage = Record<string, unknown>;

/**
 * Feature flag to enable DocumentDB compatibility mode
 * Made dynamic to support runtime environment variable changes (for testing)
 */
export const USE_DOCUMENTDB = () => process.env.USE_DOCUMENTDB_COMPATIBILITY === 'true';

if (USE_DOCUMENTDB()) {
  console.log('[DocumentDB Compatibility] Mode: ENABLED');
}

/**
 * Executes a facet-like query that's compatible with DocumentDB
 * by splitting into multiple queries and combining results.
 *
 * @example
 * ```typescript
 * // Instead of using $facet:
 * const results = await executeFacetCompatible(
 *   User,
 *   [{ $match: { isActive: true } }],
 *   {
 *     totalCount: [{ $count: 'count' }],
 *     users: [{ $skip: 0 }, { $limit: 10 }]
 *   }
 * );
 * ```
 */
export async function executeFacetCompatible<T>(
  // any: boundary - callers pass inconsistently-typed pipelines/facet stages and consume
  // dynamically-shaped $facet results; see module header.
  model: mongoose.Model<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  facetStages: Record<string, any[]>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!USE_DOCUMENTDB()) {
    // Use native $facet for MongoDB 7.x
    return model.aggregate([...pipeline, { $facet: facetStages }]);
  }

  // Execute each facet stage separately and combine results
  const results = await Promise.all(
    Object.entries(facetStages).map(async ([key, stages]) => {
      const result = await model.aggregate([...pipeline, ...stages]);
      return { key, result };
    })
  );

  // Reconstruct facet-like response
  return [
    {
      ...Object.fromEntries(results.map(({ key, result }) => [key, result])),
    },
  ];
}

/**
 * Converts a $lookup with complex $expr conditions to DocumentDB-compatible format
 * by splitting into multiple $match stages within the pipeline.
 *
 * @example
 * ```typescript
 * // Convert complex lookup:
 * const lookup = createCompatibleLookup({
 *   from: 'users',
 *   let: { userId: '$userId' },
 *   conditions: [
 *     { $eq: ['$_id', '$$userId'] },
 *     { $gte: ['$createdAt', startDate] }
 *   ],
 *   as: 'userData'
 * });
 * ```
 */
export function createCompatibleLookup(options: {
  from: string;
  let: Record<string, unknown>;
  conditions: AggStage[];
  as: string;
  additionalStages?: AggStage[];
  // any: boundary - returns a $lookup stage fed to model.aggregate() and inspected by callers
  // via `.$lookup`; see module header.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): any {
  const { from, let: letVars, conditions, as, additionalStages = [] } = options;

  if (!USE_DOCUMENTDB()) {
    // MongoDB 7.x: Use $expr with $and for multiple conditions
    return {
      $lookup: {
        from,
        let: letVars,
        pipeline: [
          {
            $match: {
              $expr: conditions.length > 1 ? { $and: conditions } : conditions[0],
            },
          },
          ...additionalStages,
        ],
        as,
      },
    };
  }

  // DocumentDB: Split conditions into separate $match stages
  const pipeline: AggStage[] = [];

  // First condition usually involves the join key with $$variables
  if (conditions.length > 0) {
    pipeline.push({
      $match: {
        $expr: conditions[0],
      },
    });
  }

  // Additional conditions as regular $match stages
  conditions.slice(1).forEach(condition => {
    // Convert $gte, $lte, etc. to regular match syntax when possible
    if (isSimpleDateCondition(condition)) {
      const fieldMatch = extractFieldMatch(condition);
      if (fieldMatch) {
        pipeline.push({ $match: fieldMatch });
      }
    } else {
      pipeline.push({
        $match: {
          $expr: condition,
        },
      });
    }
  });

  pipeline.push(...additionalStages);

  return {
    $lookup: {
      from,
      let: letVars,
      pipeline,
      as,
    },
  };
}

/**
 * Helper to check if a condition is a simple date comparison
 */
function isSimpleDateCondition(condition: AggStage): boolean {
  return (
    !!condition &&
    typeof condition === 'object' &&
    !!(condition.$gte || condition.$lte || condition.$gt || condition.$lt)
  );
}

/**
 * Extract field match from expression condition
 */
function extractFieldMatch(condition: AggStage): AggStage | null {
  // This is a simplified version - extend based on actual usage patterns
  if (Array.isArray(condition.$gte)) {
    const [field, value] = condition.$gte;
    if (typeof field === 'string' && field.startsWith('$')) {
      return { [field.substring(1)]: { $gte: value } };
    }
  }
  // Add more operators as needed
  return null;
}

/**
 * Creates a case-insensitive sort field for DocumentDB compatibility
 * Since DocumentDB doesn't support collation, we use a lowercase field for sorting.
 *
 * @example
 * ```typescript
 * // In your schema:
 * schema.plugin(addLowercaseField, { fields: ['fileName', 'title'] });
 *
 * // Then sort by:
 * .sort({ fileNameLower: 1 })
 * ```
 */
export function addLowercaseField(schema: mongoose.Schema, options: { fields: string[] }): void {
  options.fields.forEach(field => {
    const lowerField = `${field}Lower`;

    schema.add({
      [lowerField]: {
        type: String,
        index: true,
      },
    });
  });

  // Add pre-save hook to populate lowercase fields
  schema.pre(['save', 'findOneAndUpdate', 'updateOne', 'updateMany'], function () {
    // `this` is either the document (save) or the query (update); both expose the
    // fields we touch via a string-keyed view.
    const doc = this as unknown as Record<string, unknown> & {
      _update?: { $set?: Record<string, unknown> } & Record<string, unknown>;
    };

    const data: Record<string, unknown> = doc._update?.$set || doc._update || doc;

    options.fields.forEach(field => {
      const value = data[field];
      // Preserve original behavior: truthy check, then .toLowerCase() (cast, not a
      // string narrow - a non-string value threw before and still throws).
      if (value) {
        const lowerFieldName = `${field}Lower`;
        data[lowerFieldName] = (value as string).toLowerCase();
      }
    });
  });
}

/**
 * Migration helper to add lowercase fields to existing documents
 */
export async function migrateLowercaseFields<T>(
  model: mongoose.Model<T>,
  fields: string[],
  batchSize = 100
): Promise<number> {
  let processed = 0;
  let hasMore = true;

  while (hasMore) {
    const docs = await model
      .find({
        $or: fields.map(field => ({
          [field]: { $exists: true },
          [`${field}Lower`]: { $exists: false },
        })),
      } as mongoose.FilterQuery<T>)
      .limit(batchSize);

    if (docs.length === 0) {
      hasMore = false;
      break;
    }

    const bulkOps = docs.map(doc => {
      const update: Record<string, string> = {};
      const docRecord = doc as unknown as Record<string, unknown>;
      fields.forEach(field => {
        const value = docRecord[field];
        // Preserve original behavior: truthy check + .toLowerCase() via cast.
        if (value) {
          update[`${field}Lower`] = (value as string).toLowerCase();
        }
      });

      return {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: update },
        },
      };
    });

    if (bulkOps.length > 0) {
      // mongoose 8.24 tightened bulkWrite's parameter to AnyBulkWriteOperation<
      // T extends Document ? T : any>[], and the dynamically-keyed `${field}Lower`
      // $set entries aren't statically known on T. Cast to bulkWrite's own
      // parameter type (not `any`) - the op shape is correct at runtime.
      await model.bulkWrite(bulkOps as Parameters<typeof model.bulkWrite>[0]);
      processed += bulkOps.length;
    }
  }

  return processed;
}

/**
 * Applies DocumentDB-compatible sorting based on field configuration
 */
export function getCompatibleSort(
  sortField: string,
  direction: 1 | -1,
  model?: mongoose.Model<unknown>
): { sort: Record<string, 1 | -1>; collation?: { locale: string; strength: number } } {
  if (!USE_DOCUMENTDB()) {
    // Use collation for case-insensitive sorting in MongoDB
    return {
      sort: { [sortField]: direction },
      collation: { locale: 'en', strength: 2 },
    };
  }

  // Check if there's a lowercase equivalent field for sorting
  if (model && model.schema && model.schema.paths[`${sortField}Lower`]) {
    return {
      sort: { [`${sortField}Lower`]: direction },
    };
  }

  // Fall back to basic sorting
  return {
    sort: { [sortField]: direction },
  };
}

/**
 * Helper function to convert an aggregation pipeline for DocumentDB compatibility
 */
// any: boundary - accepts/returns pipelines that callers feed straight to model.aggregate()
// (strict PipelineStage union) while building them as loose documents; see module header.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertPipelineForDocumentDB(pipeline: any[]): any[] {
  if (!USE_DOCUMENTDB()) {
    return pipeline;
  }

  return pipeline
    .map((stage: AggStage) => {
      if (stage.$lookup) {
        return convertLookupForDocumentDB(stage);
      }

      if (stage.$facet) {
        // This should be handled by executeFacetCompatible instead
        console.warn('Found $facet in pipeline. Consider using executeFacetCompatible instead.');
        return stage;
      }

      return stage;
    })
    .flat(); // flat() in case lookup conversion created multiple stages
}

/**
 * Converts $expr conditions to multiple $match stages
 */
function convertExprMatch(expr: AggStage, letVars: AggStage = {}): AggStage[] {
  // Handle $and expressions
  if (Array.isArray(expr.$and)) {
    const stages: AggStage[] = [];

    for (const condition of expr.$and) {
      const convertedStage = convertSingleExprCondition(condition, letVars);
      if (convertedStage) {
        stages.push(convertedStage);
      }
    }

    return stages;
  }

  // Handle single condition
  const convertedStage = convertSingleExprCondition(expr, letVars);
  return convertedStage ? [convertedStage] : [];
}

/**
 * Converts a single $expr condition to a $match stage
 */
function convertSingleExprCondition(condition: AggStage, letVars: AggStage = {}): AggStage | null {
  // Handle $toObjectId expressions first (before general $eq handling)
  if (condition.$eq && Array.isArray(condition.$eq) && condition.$eq.length === 2) {
    const [field, valueExpr] = condition.$eq;

    if (typeof valueExpr === 'object' && valueExpr.$toObjectId) {
      const objectIdExpr = valueExpr.$toObjectId;

      if (
        typeof field === 'string' &&
        field.startsWith('$') &&
        typeof objectIdExpr === 'string' &&
        objectIdExpr.startsWith('$$')
      ) {
        // This is a pattern like: { $eq: ['$_id', { $toObjectId: '$$userId' }] }
        // Keep as $expr since DocumentDB needs to handle $toObjectId
        return {
          $match: {
            $expr: condition,
          },
        };
      }
    }
  }

  // Handle regular $eq conditions
  if (condition.$eq && Array.isArray(condition.$eq) && condition.$eq.length === 2) {
    const [field, value] = condition.$eq;

    // Handle variable references ($$variable)
    if (typeof field === 'string' && field.startsWith('$') && !field.startsWith('$$')) {
      const fieldName = field.substring(1);

      if (typeof value === 'string' && value.startsWith('$$')) {
        // This is a field-to-variable comparison: { $eq: ['$field', '$$variable'] }
        return {
          $match: {
            $expr: { $eq: [field, value] },
          },
        };
      } else if (typeof value !== 'object') {
        // This is a field-to-literal comparison: { $eq: ['$field', 'literal'] }
        // Only for primitive values, not objects
        return {
          $match: {
            [fieldName]: value,
          },
        };
      }
    }
  }

  // Handle $gte and $lte conditions for date ranges
  const rangeOperand = condition.$gte || condition.$lte;
  if (Array.isArray(rangeOperand)) {
    const operator = condition.$gte ? '$gte' : '$lte';
    const [field, value] = rangeOperand;

    if (typeof field === 'string' && field.startsWith('$') && !field.startsWith('$$')) {
      const fieldName = field.substring(1);

      // For date ranges, use simple $match instead of $expr
      return {
        $match: {
          [fieldName]: {
            [operator]: value,
          },
        },
      };
    }
  }

  // For complex conditions that can't be simplified, keep as $expr
  return {
    $match: {
      $expr: condition,
    },
  };
}

/**
 * Converts a $lookup with complex $expr conditions to DocumentDB-compatible format
 *
 * Transforms this pattern:
 * {
 *   $lookup: {
 *     from: 'collection',
 *     let: { var: '$field' },
 *     pipeline: [{
 *       $match: {
 *         $expr: {
 *           $and: [
 *             { $eq: ['$field', '$$var'] },
 *             { $gte: ['$date', dateValue] },
 *             { $lte: ['$date', dateValue2] }
 *           ]
 *         }
 *       }
 *     }],
 *     as: 'result'
 *   }
 * }
 *
 * Into multiple $match stages that DocumentDB can handle
 */
// any: boundary - a $lookup stage in/out, fed to/from model.aggregate() (strict PipelineStage
// union) and inspected by callers via `.$lookup`; see module header.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertLookupForDocumentDB(lookupStage: any): any {
  if (!USE_DOCUMENTDB()) {
    return lookupStage;
  }

  const lookup = lookupStage.$lookup as AggStage;
  const { from, let: letVars, pipeline, as, localField, foreignField } = lookup;

  // Handle simple localField/foreignField lookups (these work in DocumentDB)
  if (localField && foreignField) {
    return lookupStage;
  }

  // Handle pipeline-based lookups with $expr conditions
  if (Array.isArray(pipeline) && pipeline.length > 0) {
    const convertedPipeline = (pipeline as AggStage[]).map(stage => {
      const match = stage.$match as AggStage | undefined;
      if (match && match.$expr) {
        return convertExprMatch(match.$expr as AggStage, letVars as AggStage);
      }
      return stage;
    });

    return {
      $lookup: {
        from,
        let: letVars,
        pipeline: convertedPipeline.flat(), // flat() in case we created multiple stages
        as,
      },
    };
  }

  return lookupStage;
}
