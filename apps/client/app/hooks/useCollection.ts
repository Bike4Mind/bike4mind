import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useWebsocket } from '@/app/contexts/WebsocketContext';
import { useLiveQuery } from 'dexie-react-hooks';
import { dexie } from '../utils/dexie';
import Dexie, { IndexableType } from 'dexie';
import { IDataSubscribeRequestAction, IDataUnsubscribeRequestAction, IMessageDataToClient } from '@bike4mind/common';

// Larger intervals and batch sizes reduce setTimeout violations.
const dexieWriteIntervalMsec = 200; // Doubled from 100ms to reduce frequency
const BATCH_SIZE_NORMAL = 100; // Doubled from 50 to reduce operations
const BATCH_SIZE_DURING_BUSY = 200; // Larger batches when Dexie is busy

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

type QueryBuilderFn<T> = (
  table: Dexie.Table<T, IndexableType>,
  mongoQuery: Record<string, QueryableType>
) => Dexie.Collection<T, IndexableType>;

interface CollectionQueryOptions<T> {
  dexieQueryBuilder: QueryBuilderFn<T>;
  fields: Partial<Record<keyof T, boolean | number>>;
}

export const useCollectionQuery = <T>(
  collectionName: string,
  mongoQuery: Record<string, QueryableType> | null = {},
  options: Partial<CollectionQueryOptions<T> & { isStreaming?: boolean }> = {}
) => {
  const {
    dexieQueryBuilder,
    fields,
    isStreaming = false,
  } = {
    dexieQueryBuilder: convertQuery,
    fields: {},
    isStreaming: false,
    ...options,
  };
  const [isMounted, setIsMounted] = useState<boolean>(false);
  const [isOnline, setIsOnline] = useState<boolean>(false);
  const [subscriptionId] = useState(() => Math.random().toString(36).substring(2, 9));
  const { sendJsonMessage, subscribeToAction, readyState } = useWebsocket();
  const socketReady = readyState === WebSocket.OPEN;
  const haveQuery = !!mongoQuery;
  const hashedQuery = JSON.stringify(mongoQuery);
  const [, startTransition] = useTransition();
  const [unsubscribeFn, setUnsubscribeFn] = useState<() => void>(() => () => {});
  const dexieInsertQueue = useRef<Array<T> | null>(null);
  const handleDexieInsertQueueRef = useRef<(() => void) | null>(null);
  // true after the first successful subscribe; detects reconnects vs. first mounts
  const wasEverOnline = useRef(false);

  // Throttle this collection's writes more aggressively during streaming.
  const isStreamingMode = isStreaming;

  useEffect(() => {
    setIsMounted(true);
    return () => setIsMounted(false);
  }, []);

  const handleDexieInsertQueue = useCallback(() => {
    if (!dexieInsertQueue.current) {
      return;
    }

    if (!dexieInsertQueue.current.length) {
      dexieInsertQueue.current = null;
      return;
    }

    // During streaming, process less frequently.
    const streamingDelay = isStreamingMode ? dexieWriteIntervalMsec * 3 : dexieWriteIntervalMsec;

    // If Dexie's busy, use larger batches and longer delays.
    if (Dexie.currentTransaction) {
      // Use requestIdleCallback if available for better scheduling
      const scheduleCallback = () => {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => handleDexieInsertQueueRef.current?.(), { timeout: streamingDelay });
        } else {
          setTimeout(() => handleDexieInsertQueueRef.current?.(), isStreamingMode ? 100 : 50); // Longer delay during streaming
        }
      };
      scheduleCallback();
      return;
    }

    startTransition(() => {
      const batchSize = isStreamingMode
        ? BATCH_SIZE_DURING_BUSY * 2 // Even larger batches during streaming
        : Dexie.currentTransaction
          ? BATCH_SIZE_DURING_BUSY
          : BATCH_SIZE_NORMAL;
      const inserting = (dexieInsertQueue.current?.splice(0, batchSize) ?? []) as Record<string, IndexableType>[];

      dexie
        .table(collectionName)
        .bulkPut(inserting)
        .then(() => {
          if (dexieInsertQueue.current?.length) {
            // Use requestIdleCallback for better scheduling.
            const scheduleNext = () => {
              if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => handleDexieInsertQueueRef.current?.(), { timeout: streamingDelay });
              } else {
                setTimeout(() => handleDexieInsertQueueRef.current?.(), streamingDelay); // Use streaming-aware delay
              }
            };
            scheduleNext();
          } else {
            dexieInsertQueue.current = null;
          }
        })
        .catch((error: unknown) => {
          console.error('failed to put %d items into %s', inserting.length, collectionName, error);
          // On error, use a longer delay to avoid tight loops.
          if (dexieInsertQueue.current?.length) {
            setTimeout(() => handleDexieInsertQueueRef.current?.(), streamingDelay * 2);
          } else {
            dexieInsertQueue.current = null;
          }
        });
    });
  }, [collectionName, isStreamingMode]);

  useEffect(() => {
    handleDexieInsertQueueRef.current = handleDexieInsertQueue;
  }, [handleDexieInsertQueue]);

  const processActionEvent = useCallback(
    async (data: IMessageDataToClient) => {
      if (data.action !== 'data_update') return;
      if (data.collectionName !== collectionName || data.subscriptionId !== subscriptionId) return;
      if (!dexie.isOpen()) return;
      if (!data.data._id) return;

      switch (data.operationType) {
        case 'insert':
        case 'update':
        case 'replace': {
          const normalizedData = normalizeMongoData(data.data);
          try {
            if (!dexieInsertQueue.current) {
              dexieInsertQueue.current = [];
              // Use requestIdleCallback for initial scheduling.
              const streamingDelay = isStreamingMode ? dexieWriteIntervalMsec * 3 : dexieWriteIntervalMsec;
              if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(handleDexieInsertQueue, { timeout: streamingDelay });
              } else {
                setTimeout(handleDexieInsertQueue, streamingDelay);
              }
            }
            dexieInsertQueue.current.push(normalizedData as T);
            break;
          } catch (error: unknown) {
            console.error(`failed to put ${normalizedData.id} into ${collectionName}: ${error}`);
          }
          break;
        }
        case 'delete': {
          // Defer deletes during streaming.
          const deleteDelay = isStreamingMode ? 500 : 0;
          setTimeout(() => {
            startTransition(() => {
              dexie
                .table(collectionName)
                .delete(data.data.id)
                .catch((error: unknown) => {
                  console.error(`failed to delete ${data.data.id} from ${collectionName}: ${error}`);
                });
            });
          }, deleteDelay);
          break;
        }
        default:
          console.error(`unsupported operationType ${data.operationType}`);
          break;
      }
    },
    [collectionName, handleDexieInsertQueue, subscriptionId, isStreamingMode]
  );

  // Once dexie is mounted, send subscription requests
  useEffect(() => {
    if (!(mongoQuery && socketReady && isMounted && !isOnline)) return;

    // Jitter on reconnects only; first page load subscribes immediately.
    // Without it, 400 users reconnecting after a deploy each burst ~15
    // subscribe_query messages at once, pinning account Lambda concurrency at 500+.
    const delay = wasEverOnline.current ? Math.random() * 2400 : 0;
    const timer = setTimeout(() => {
      wasEverOnline.current = true;
      setIsOnline(true);
      const payload: IDataSubscribeRequestAction = {
        action: 'subscribe_query',
        collectionName,
        query: mongoQuery,
        subscriptionId,
        fields,
      };
      // Dispatch data responses from server into dexie
      const unsubscribeFn = subscribeToAction('data_update', processActionEvent);
      // Send subscription request to backend
      sendJsonMessage(payload);
      setUnsubscribeFn(unsubscribeFn);
    }, delay);
    return () => clearTimeout(timer);
  }, [
    collectionName,
    fields,
    isMounted,
    isOnline,
    mongoQuery,
    processActionEvent,
    sendJsonMessage,
    socketReady,
    subscribeToAction,
    subscriptionId,
  ]);

  // If we drop offline, mark isOnline == false.  This helps us resubscribe again
  // once we go back online.
  useEffect(() => {
    if (isOnline && !socketReady) {
      setIsOnline(false);
    }
  }, [isOnline, socketReady]);

  // If we're subscribed but unmounting, send an unsubscribe request.
  useEffect(() => {
    return () => {
      if (haveQuery && isOnline && !isMounted) {
        setIsOnline(false);
        const payload: IDataUnsubscribeRequestAction = {
          action: 'unsubscribe_query',
          subscriptionId,
        };
        console.debug(`Sending unsubscribe_query for ${collectionName} with payload ${JSON.stringify(payload)}`);
        sendJsonMessage(payload);
        unsubscribeFn();
        setUnsubscribeFn(() => {});
      }
    };
  }, [collectionName, isMounted, isOnline, haveQuery, sendJsonMessage, subscriptionId, unsubscribeFn]);

  return useLiveQuery(() => {
    if (!haveQuery) return [];
    const table = dexie.table<T, IndexableType>(collectionName);
    return dexieQueryBuilder!(table, mongoQuery).toArray();
  }, [collectionName, dexieQueryBuilder, haveQuery, hashedQuery]);
};

export type SubscriptionCallbackFunction<T> = (type: string, data: T) => void;

// Converts a MongoDB-style query object (keys like $eq, $gt) into a Dexie
// fluent-API query (built with Dexie's chainable API, resolved via .toArray()).
const convertQuery = <T>(
  table: Dexie.Table<T, IndexableType>,
  mongoQuery: Record<string, QueryableType>
): Dexie.Collection<T, IndexableType> => {
  if (Object.keys(mongoQuery).length > 1) {
    throw new Error('Only one query is supported');
  }

  if (Object.keys(mongoQuery).length === 0) {
    return table.toCollection();
  }

  const [key, value] = Object.entries(mongoQuery)[0];
  if (key.startsWith('$')) {
    throw new Error('Unsupported query');
  }

  if (value === null || typeof value !== 'object') {
    const normalizedValue = typeof value !== 'boolean' ? value : value ? 1 : 0;
    return table.where(key).equals(normalizedValue as IndexableType);
  }

  const [operator, operand] = Object.entries(value)[0];
  const normalizedOperand = typeof operand !== 'boolean' ? operand : operand ? 1 : 0;
  switch (operator) {
    case '$eq':
      return table.where(key).equals(normalizedOperand);
    case '$gt':
      return table.where(key).above(normalizedOperand);
    case '$gte':
      return table.where(key).aboveOrEqual(normalizedOperand);
    case '$lt':
      return table.where(key).below(normalizedOperand);
    case '$lte':
      return table.where(key).belowOrEqual(normalizedOperand);
    case '$ne':
      return table.where(key).notEqual(normalizedOperand);
    case '$in':
      return table.where(key).anyOf(normalizedOperand);
    case '$nin':
      return table.where(key).noneOf(normalizedOperand);
    case '$exists':
      return table.where(key).notEqual(Math.random().toString(36).substring(2, 9));
    case '$regex':
      return table.where(key).startsWith(normalizedOperand);
    default:
      throw new Error(`Unsupported operator ${operator}`);
  }
};

// Normalize booleans to 1/0, since Dexie doesn't support boolean values.
// May be deeply nested.
export const normalizeMongoData = (obj: Record<string, unknown>): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      if (typeof value === 'boolean') {
        return [key, value ? 1 : 0];
      } else if (value === null || typeof value !== 'object') {
        return [key, value];
      } else if (Array.isArray(value)) {
        return [
          key,
          value.map(v => {
            if (typeof v === 'boolean') {
              return v ? 1 : 0;
            } else if (v === null || typeof v !== 'object') {
              return v;
            } else {
              return normalizeMongoData(v as Record<string, unknown>);
            }
          }),
        ];
      } else {
        return [key, normalizeMongoData(value as Record<string, unknown>)];
      }
    })
  );
};
