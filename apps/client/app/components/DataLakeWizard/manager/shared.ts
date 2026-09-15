import { submittedTagPrefix } from '@bike4mind/common';
import { useGetDataLakes } from '@client/app/hooks/data/dataLakes';

export type ManagerLake = NonNullable<ReturnType<typeof useGetDataLakes>['data']>[number];

/** The lake's prefix in the form its tags carry, via the same helper the wizard's request-rule
 *  mirror uses so trimming and colon-appending cannot drift between the two surfaces.
 *  The `|| ':'` keeps an unusable (empty) prefix matching NOTHING: submittedTagPrefix returns ''
 *  there, and every tag startsWith(''), which would pull the whole knowledge base into one
 *  lake's tree and empty its Uncategorized bucket. */
export const normalizePrefix = (fileTagPrefix: string) => submittedTagPrefix(fileTagPrefix) || ':';

/** The prefix's namespace segments, e.g. 'books' -> ['books']. Lake navigation seeds the
 *  path past these so clicking a lake lands directly on its categories. */
export const prefixSegments = (fileTagPrefix: string) => fileTagPrefix.replace(/:+$/, '').split(':').filter(Boolean);
