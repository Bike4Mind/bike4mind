import { dataLakeRepository, withTransaction } from '@bike4mind/database';
import type { dataLakeService } from '@bike4mind/services';

/**
 * The route-side `SerializeLakeClaim`: runs a long manage door's gate and claim in one transaction
 * and touches the gated lake last, so a revoke committing mid-claim collides and the retry re-reads
 * live grants (WRITE-TIME RESIDUAL on `canManageLake`). Never put the door's external step in `claim`.
 */
export const serializeLakeClaim: dataLakeService.SerializeLakeClaim = claim =>
  withTransaction(async () => {
    const result = await claim();
    await dataLakeRepository.touchIfStable(result.lake.id);
    return result;
  });
