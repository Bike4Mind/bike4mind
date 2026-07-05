import { QueryClient, InfiniteData } from '@tanstack/react-query';
import {
  IDataSubscribeRequestAction,
  IDataUnsubscribeRequestAction,
  IMessageDataToClient,
  PaginatedResponse,
} from '@bike4mind/common';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SubscriptionCallbackFunction } from '../hooks/useCollection';
import { useWebsocket } from '@/app/contexts/WebsocketContext';
import { uniqBy } from 'lodash';

/**
 * This function is used to update the cached data that exists in the react-query cache.
 * It handles updating both infinite queries and regular queries, supporting write and delete operations.
 *
 * @param queryClient - The react-query QueryClient instance
 * @param collectionName - The name of the collection to update (e.g. 'sessions')
 * @param type - The type of operation ('write' or 'delete')
 * @param data - The data object to write or delete, must contain an 'id' field
 * @param options - Configuration options
 * @param options.keysAllowedToCreate - Array of query key paths where new items can be created
 *
 * @example
 * // Update a session in all relevant query caches
 * updateAllQueryData(queryClient, 'sessions', 'write', sessionData, {
 *   keysAllowedToCreate: [['sessions', 'own']]
 * });
 */
export const updateAllQueryData = <
  T extends { id: string; updatedAt?: Date | string | number; lastUpdated?: Date | string | number },
>(
  queryClient: QueryClient,
  collectionName: string,
  type: 'write' | 'delete',
  data: T,
  options: {
    keysAllowedToCreate: Array<string[]>;
  } = { keysAllowedToCreate: [] }
) => {
  const collectionQueryKeys = queryClient
    .getQueryCache()
    .findAll({
      queryKey: [collectionName],
    })
    .map(query => query.queryKey);

  // Immediate sync processing for small operations (<=10 queries) avoids setTimeout
  // violations while staying responsive.
  if (collectionQueryKeys.length <= 10) {
    collectionQueryKeys.forEach(queryKey => {
      updateSingleQueryDataFast(queryClient, queryKey, type, data, options);
    });

    return;
  }

  // For large operations (>10 queries), use async batching to prevent main thread blocking
  updateAllQueryDataAsync(queryClient, collectionName, type, data, options, collectionQueryKeys);
};

/**
 * Async version for large operations (>10 queries): batches work to avoid
 * setTimeout violations and main-thread blocking.
 */
const updateAllQueryDataAsync = <
  T extends { id: string; updatedAt?: Date | string | number; lastUpdated?: Date | string | number },
>(
  queryClient: QueryClient,
  _collectionName: string,
  type: 'write' | 'delete',
  data: T,
  options: {
    keysAllowedToCreate: Array<string[]>;
  },
  collectionQueryKeys: (readonly unknown[])[]
) => {
  // Larger batches for large operations reduce overhead.
  const BATCH_SIZE = 5;
  let currentBatch = 0;

  const processBatch = () => {
    const batchStart = currentBatch * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, collectionQueryKeys.length);
    const batchKeys = collectionQueryKeys.slice(batchStart, batchEnd);

    batchKeys.forEach(queryKey => {
      updateSingleQueryDataFast(queryClient, queryKey, type, data, options);
    });

    currentBatch++;

    if (batchEnd < collectionQueryKeys.length) {
      // Use requestIdleCallback to prevent main thread blocking
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(
          () => processBatch(),
          { timeout: 8 } // 8ms timeout for smooth 120fps compatibility
        );
      } else {
        // Fallback: yield control immediately
        setTimeout(processBatch, 0);
      }
    } else {
      // All batches completed
    }
  };

  processBatch();
};

/**
 * Single query update with minimal overhead: no deep merging or redundant
 * timestamp recalculation.
 */
export const updateSingleQueryDataFast = <
  T extends { id: string; updatedAt?: Date | string | number; lastUpdated?: Date | string | number },
>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  type: 'write' | 'delete',
  data: T,
  options: { keysAllowedToCreate: Array<string[]> }
) => {
  // Fallback-aware timestamp getter (prefers updatedAt, falls back to lastUpdated)
  const getTs = (obj: any): number | null => {
    const v = obj?.updatedAt ?? obj?.lastUpdated;
    return v ? new Date(v).getTime() : null;
  };

  queryClient.setQueryData<InfiniteData<{ data: T[] }, { page: number }> | T[] | T | PaginatedResponse<T>>(
    queryKey,
    currentData => {
      if (!currentData) return;

      const allowCreate = options.keysAllowedToCreate.some(key => isEqualOrSubKey(key, [...queryKey] as string[]));

      // Pre-calculate timestamp once instead of in loops.
      const newUpdatedAt = getTs(data);
      const cacheTime = Date.now();

      if ('pages' in currentData) {
        if (type === 'delete') {
          return {
            pages: currentData.pages.map(page => ({
              ...page,
              data: page.data.filter(item => item.id !== data.id),
            })),
            pageParams: currentData.pageParams,
          };
        } else {
          let itemFound = false;
          const updatedPages = currentData.pages.map(page => {
            const itemIndex = page.data.findIndex(item => item.id === data.id);

            if (itemIndex >= 0) {
              itemFound = true;
              const existingItem = page.data[itemIndex];
              const existingUpdatedAt = getTs(existingItem);

              if (!existingUpdatedAt || !newUpdatedAt || newUpdatedAt >= existingUpdatedAt) {
                const updatedData = [...page.data];
                updatedData[itemIndex] = { ...existingItem, ...data, cachedUpdate: cacheTime } as any;
                return { ...page, data: updatedData };
              }
            }
            return page;
          });

          if (!itemFound && allowCreate) {
            const firstPage = updatedPages[0];
            if (firstPage) {
              updatedPages[0] = {
                ...firstPage,
                data: [{ ...data, cachedUpdate: cacheTime } as any, ...firstPage.data],
              };
            }
          }

          return {
            pages: updatedPages,
            pageParams: currentData.pageParams,
          };
        }
      } else if ('data' in currentData) {
        if (type === 'delete') {
          return {
            data: currentData.data.filter(item => item.id !== data.id),
            meta: currentData.meta,
          };
        } else {
          const itemIndex = currentData.data.findIndex(item => item.id === data.id);
          let updatedData = [...currentData.data];

          if (itemIndex >= 0) {
            const existingItem = currentData.data[itemIndex];
            const existingUpdatedAt = getTs(existingItem);

            if (!existingUpdatedAt || !newUpdatedAt || newUpdatedAt >= existingUpdatedAt) {
              updatedData[itemIndex] = { ...existingItem, ...data, cachedUpdate: cacheTime } as any;
            }
          } else if (allowCreate) {
            updatedData = [{ ...data, cachedUpdate: cacheTime } as any, ...currentData.data];
          }

          return {
            data: updatedData,
            meta: currentData.meta,
          };
        }
      } else if (Array.isArray(currentData)) {
        if (type === 'delete') {
          return currentData.filter(item => item.id !== data.id);
        } else {
          const itemIndex = currentData.findIndex(item => item.id === data.id);
          let updatedData = [...currentData];

          if (itemIndex >= 0) {
            const existingItem = currentData[itemIndex];
            const existingUpdatedAt = getTs(existingItem);

            if (!existingUpdatedAt || !newUpdatedAt || newUpdatedAt >= existingUpdatedAt) {
              updatedData[itemIndex] = { ...existingItem, ...data } as any;
            }
          } else if (allowCreate) {
            updatedData = [data, ...currentData];
          }
          return updatedData;
        }
      } else if ((currentData as any).id === (data as any).id) {
        const existingUpdatedAt = getTs(currentData as any);

        if (!existingUpdatedAt || !newUpdatedAt || newUpdatedAt >= existingUpdatedAt) {
          return { ...(currentData as any), ...(data as any) };
        }
      }

      return currentData;
    }
  );
};

/**
 * Checks if the subKey is a sub-key or equal of the key
 * @param key - The key to check
 * @param subKey - The sub-key to check
 * @returns true if the subKey is a sub-key or equal of the key, false otherwise
 *
 * @example
 * isEqualOrSubKey(['a', 'b'], ['a', 'b', 'c']); // true
 * isEqualOrSubKey(['a', 'b'], ['a', 'b']); // true
 * isEqualOrSubKey(['a', 'b'], ['a', 'c']); // false
 * isEqualOrSubKey(['a', 'b'], ['a']); // false
 */
const isEqualOrSubKey = (key: string[], subKey: string[]) => {
  if (key.length > subKey.length) return false;
  return key.every((k, i) => k === subKey[i]);
};

type IndexableTypePart = string | number | Date | ArrayBuffer | ArrayBufferView | DataView | Array<Array<void>>;
type IndexableTypeArrayReadonly = ReadonlyArray<IndexableTypePart>;
export type IndexableType = IndexableTypePart | IndexableTypeArrayReadonly;
type QueryableType =
  | IndexableType
  | boolean
  | { $ne: IndexableType | boolean }
  | { $eq: IndexableType | boolean }
  | { $gt: IndexableType }
  | { $gte: IndexableType }
  | { $lt: IndexableType }
  | { $lte: IndexableType }
  | { $in: IndexableType[] }
  | { $nin: IndexableType[] }
  | { $exists: boolean }
  | { $regex: string };

/**
 * Recursively serialize a value with object keys sorted, so two distinct-but-equal
 * objects collapse to the same string. Arrays stay order-sensitive (ordered data).
 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  // Dates/RegExps are objects with no own enumerable keys, so the generic object
  // branch would collapse them to `{}` - making two different logical queries (e.g.
  // `$gt: Date('2020')` vs `$gt: Date('2021')`) share a key and silently miss a
  // re-subscribe. QueryableType permits Date, so serialize them by value.
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (value instanceof RegExp) return `RegExp(${value.source}/${value.flags})`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
};

/**
 * Produce a stable string key for a subscription's mongo query.
 *
 * Callers frequently pass a fresh inline object (e.g. `{ isChunk: false }`) on every
 * render. Depending on that object's identity in the subscribe effect tears down and
 * re-creates the websocket subscription on each render (`unsubscribe_query` +
 * `subscribe_query` churn while idle). Keying the effect off this stable serialization
 * instead means the effect only re-runs when the *logical* query actually changes.
 *
 * `null` (meaning "do not subscribe") is kept distinct from `{}` (match-all).
 */
export const stableSubscriptionKey = (mongoQuery: Record<string, QueryableType> | null): string =>
  mongoQuery === null ? 'null' : stableStringify(mongoQuery);

/**
 * Custom hook to subscribe to a MongoDB collection using a WebSocket connection.
 * It listens for data updates and triggers a callback function when data changes occur.
 *
 * @param collectionName - The name of the MongoDB collection to subscribe to
 * @param mongoQuery - The MongoDB query to filter the subscription data
 * @param callbackFn - Optional callback function to handle data updates
 * @param options - Optional configuration options
 * @param options.fetchInitialData - Boolean indicating whether to fetch initial data upon subscription
 *
 * @returns void
 *
 * @example
 * useSubscribeCollection('users', { age: { $gt: 18 } }, (operationType, data) => {
 *   console.log(`Operation: ${operationType}`, data);
 * }, { fetchInitialData: true });
 */
export const useSubscribeCollection = <T>(
  collectionName: string,
  mongoQuery: Record<string, QueryableType> | null = {},
  callbackFn?: SubscriptionCallbackFunction<T>,
  options?: {
    fetchInitialData?: boolean;
    fields?: Partial<Record<keyof T, boolean | number>>;
  }
) => {
  const [subscriptionId] = useState(() => Math.random().toString(36).substring(2, 9));
  const { sendJsonMessage, subscribeToAction, readyState } = useWebsocket();
  const socketReady = readyState === WebSocket.OPEN;
  const isSubscribed = useRef(false);
  const subscriptionTimer = useRef<NodeJS.Timeout | null>(null);
  // true after the first successful subscribe - used to detect reconnects vs. first mounts
  const wasEverSubscribed = useRef(false);

  // Stabilize the subscription against callers that pass a fresh inline `mongoQuery`
  // object every render. The effect keys off `mongoQueryKey` (a stable serialization)
  // instead of the object identity, and reads the latest object via a ref - so an
  // unchanged logical query never triggers unsubscribe/re-subscribe churn.
  const mongoQueryKey = stableSubscriptionKey(mongoQuery);
  const mongoQueryRef = useRef(mongoQuery);
  // Keep the ref in sync with the latest query without touching it during render.
  // Declared before the subscribe effect so it runs first - the subscribe effect
  // reads the up-to-date query from the ref while keying off mongoQueryKey.
  useEffect(() => {
    mongoQueryRef.current = mongoQuery;
  }, [mongoQuery]);

  const processActionEvent = useCallback(
    async (data: IMessageDataToClient) => {
      if (!isSubscribed.current) return;
      if (data.action !== 'data_update') return;
      if (data.collectionName !== collectionName || data.subscriptionId !== subscriptionId) return;
      if (!data.data._id) return;

      try {
        switch (data.operationType) {
          case 'insert':
          case 'update':
          case 'replace': {
            try {
              if (callbackFn) callbackFn(data.operationType, data.data as T);
              break;
            } catch (error: unknown) {
              console.error(`failed to put ${data.data.id} into ${collectionName}: ${error}`);
            }
            break;
          }
          case 'delete':
            if (callbackFn) callbackFn(data.operationType, data.data as T);
            break;
          default:
            console.error(`unsupported operationType ${data.operationType}`);
            break;
        }
      } catch (e) {
        console.error('Subscription Collection: Failed to Process Action Event', e);
      }
    },
    [collectionName, subscriptionId, callbackFn]
  );

  // Create a subscription when mongodb query is provided and socket is ready
  useEffect(() => {
    let unsubscribeFn: (() => void) | undefined;

    const subscribe = () => {
      const mongoQuery = mongoQueryRef.current;
      if (mongoQuery && socketReady) {
        const payload: IDataSubscribeRequestAction = {
          action: 'subscribe_query',
          collectionName,
          query: mongoQuery,
          subscriptionId,
          fields: {},
          fetchInitialData: options?.fetchInitialData ?? true,
        };
        unsubscribeFn = subscribeToAction('data_update', processActionEvent);
        sendJsonMessage(payload);
        isSubscribed.current = true;
        wasEverSubscribed.current = true;
      }
    };

    const unsubscribe = () => {
      if (isSubscribed.current) {
        const payload: IDataUnsubscribeRequestAction = {
          action: 'unsubscribe_query',
          subscriptionId,
        };
        sendJsonMessage(payload);
        if (unsubscribeFn) {
          unsubscribeFn();
          unsubscribeFn = undefined;
        }
        isSubscribed.current = false;
      }
    };

    if (subscriptionTimer.current) {
      clearTimeout(subscriptionTimer.current);
    }

    // Debounce (100ms always) + jitter on reconnects only.
    // First page load subscribes near-instantly; on reconnect, spread sends across 2.5s
    // so 400 users don't burst 15 subscribe_query messages each in the same 100ms window.
    const jitter = wasEverSubscribed.current ? Math.random() * 2400 : 0;
    subscriptionTimer.current = setTimeout(() => {
      subscribe();
    }, 100 + jitter);

    return () => {
      if (subscriptionTimer.current) {
        clearTimeout(subscriptionTimer.current);
      }
      unsubscribe();
    };
    // mongoQueryKey (stable serialization) replaces mongoQuery (object identity) so an
    // unchanged logical query does not re-run this effect. The latest query object is
    // read from mongoQueryRef inside subscribe().
  }, [
    collectionName,
    mongoQueryKey,
    processActionEvent,
    sendJsonMessage,
    socketReady,
    subscribeToAction,
    subscriptionId,
    options?.fetchInitialData,
  ]);
};

export const setOptimisticQueryData = async <T extends { id: string }>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  data: T
) => {
  queryClient.setQueryData<InfiniteData<{ data: T[] }, { page: number }>>(queryKey, currentData => {
    if (!currentData) {
      return {
        pages: [{ data: [data], hasMore: false }],
        pageParams: [{ page: 1 }],
      };
    }

    if ('pages' in currentData) {
      let itemFound = false;
      const updatedPages = currentData.pages.map(page => {
        const itemIndex = page.data.findIndex(item => item.id === data.id);
        itemFound = itemIndex >= 0;
        return page;
      });

      if (!itemFound) {
        const firstPage = updatedPages[0];
        if (firstPage) {
          updatedPages[0] = {
            ...firstPage,
            data: [{ ...data }, ...firstPage.data],
          };
        }
      } else {
        // Expected idempotent path: the optimistic quest was already seeded (e.g. /opti
        // pre-seeds it before the send to avoid a blank flash). Leave it in place.
        console.debug('[optimistic] quest already present — leaving in place');
      }

      return {
        pages: updatedPages,
        pageParams: currentData.pageParams,
      };
    }
  });
};

// Replace optimistic temp data with the real data (including the new id).
export const replaceQueryData = async <
  T extends { id: string; updatedAt?: Date | string | number; lastUpdated?: Date | string | number },
>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  replaceId: string,
  data: T | undefined
) => {
  // Guard against undefined data - can happen if API returns early (e.g., session/quest not found)
  if (!data) return;

  queryClient.setQueryData<InfiniteData<{ data: T[] }, { page: number }>>(queryKey, currentData => {
    if (!currentData) return;

    if ('pages' in currentData) {
      const updatedPages = currentData.pages.map(page => {
        const itemIndex = page.data.findIndex(item => item.id === replaceId);

        if (itemIndex >= 0) {
          const existing = page.data.find(item => item.id === replaceId);
          const updatedData = [...page.data];
          updatedData[itemIndex] = { ...existing, ...data, id: data.id }; // Make sure id is changed
          return { ...page, data: uniqBy(updatedData, 'id') };
        }
        return page;
      });

      return {
        pages: updatedPages,
        pageParams: currentData.pageParams,
      };
    }
  });
};
