import type { MeterEvent, MeterSinkObject } from "./index";

// A meter is only half a billing story: budgets and rolling windows keep a
// tenant honest in-process, but the moment the process restarts, everything
// it counted is gone. Persisting is what turns metering into an audit trail
// you can invoice from — and every host that has needed it so far has written
// the same batching/flush/idempotency loop by hand.
//
// The store stays the host's business (Postgres, ClickHouse, S3). This owns
// the part that is identical everywhere: buffer, flush on size or age, never
// throw into the caller, and never write the same event twice.

export type DurableSinkWriter = (events: MeterEvent[]) => Promise<void> | void;

export type DurableSinkOptions = {
  /** Flush once this many events are buffered. */
  batchSize?: number;
  /** Flush this long after the first event in a batch, even if still small. */
  flushMs?: number;
  /** Called when a write throws. The events are dropped after this — decide
   *  here whether to log, alert, or spool them somewhere. Never rethrows into
   *  the metered call path: losing a meter write must not fail a request. */
  onError?: (error: unknown, events: MeterEvent[]) => void;
  /** How many recent `requestId`s to remember for de-duplication. Retries and
   *  at-least-once queues replay events; a ledger must not double-count. */
  seenLimit?: number;
  write: DurableSinkWriter;
};

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 2000;
const DEFAULT_SEEN_LIMIT = 5000;

export type DurableSink = MeterSinkObject & {
  /** Always present here (the base type leaves them optional). */
  close: () => Promise<void>;
  flush: () => Promise<void>;
  /** Events buffered but not yet written — useful in tests and shutdown logs. */
  pending: () => number;
};

/** Persist meter events in batches, exactly once per `requestId`. */
export const createDurableSink = (options: DurableSinkOptions): DurableSink => {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    flushMs = DEFAULT_FLUSH_MS,
    onError,
    seenLimit = DEFAULT_SEEN_LIMIT,
    write,
  } = options;
  let buffer: MeterEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Insertion-ordered, so the oldest id is the first key when trimming.
  const seen = new Set<string>();

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = async () => {
    clearTimer();
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      await write(batch);
    } catch (error) {
      onError?.(error, batch);
    }
  };

  const remember = (event: MeterEvent) => {
    const id = "requestId" in event ? event.requestId : undefined;
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > seenLimit) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  };

  return {
    close: async () => {
      await flush();
    },
    flush,
    ingest: (event) => {
      if (!remember(event)) return;
      buffer.push(event);
      if (buffer.length >= batchSize) {
        void flush();
        return;
      }
      // Age out a small batch so a quiet tenant's events are not stranded.
      timer ??= setTimeout(() => void flush(), flushMs);
    },
    pending: () => buffer.length,
  };
};
