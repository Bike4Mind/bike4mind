import type { DataLakeConfig } from '@bike4mind/common';
import { z } from 'zod';

const lakeIdSchema = z.string().min(1);

/** A supplied id may narrow the server-resolved set, including to nothing. */
export function narrowAccessibleLakes(lakes: DataLakeConfig[], rawLakeIds: unknown): DataLakeConfig[] {
  if (rawLakeIds === undefined) return lakes;
  const requested = Array.isArray(rawLakeIds) ? rawLakeIds : [rawLakeIds];
  const wanted = new Set(
    requested.flatMap(id => {
      const parsed = lakeIdSchema.safeParse(id);
      return parsed.success ? [parsed.data] : [];
    })
  );
  return lakes.filter(lake => wanted.has(lake.id));
}
