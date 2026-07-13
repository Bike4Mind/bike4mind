import type { ModelInfo } from './models';
import type { IModelPrice, ModelPriceUnit } from './types/entities/ModelPriceTypes';

/**
 * The catalog row in force for a model and unit at a given time: newest
 * effectiveFrom <= at AMONG ROWS OF THAT UNIT. Units are independent price
 * streams - a newer per_minute row must never shadow the in-force per_token
 * row (that would silently revert token billing to the adapter literal).
 * Rows are append-only, so this is the whole time-travel story (see
 * ModelPriceTypes).
 */
export function resolveModelPriceRow(
  rows: IModelPrice[],
  modelId: string,
  unit: ModelPriceUnit,
  at: Date
): IModelPrice | undefined {
  let inForce: IModelPrice | undefined;
  for (const row of rows) {
    if (row.modelId !== modelId || row.unit !== unit) continue;
    if (row.effectiveFrom.getTime() > at.getTime()) continue;
    if (!inForce || row.effectiveFrom.getTime() > inForce.effectiveFrom.getTime()) inForce = row;
  }
  return inForce;
}

/**
 * Overlay catalog prices onto assembled ModelInfo. Only per_token rows apply
 * here (they feed getTextModelCost via ModelInfo.pricing); per_minute and
 * per_image rows are consumed by their own settlement paths. A model with no
 * per_token row in force keeps its adapter literal - the fallback that keeps
 * zero-config self-host deployments working.
 */
export function applyModelPriceCatalog(models: ModelInfo[], rows: IModelPrice[], at: Date = new Date()): ModelInfo[] {
  if (rows.length === 0) return models;
  return models.map(model => {
    if (model.type !== 'text') return model;
    const row = resolveModelPriceRow(rows, model.id, 'per_token', at);
    if (!row) return model;
    const pricing: ModelInfo['pricing'] = {};
    for (const [threshold, tier] of Object.entries(row.pricing)) {
      pricing[Number(threshold)] = tier;
    }
    return { ...model, pricing };
  });
}
