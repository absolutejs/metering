const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_PENDING = 1_000;

export type WorkloadMeterInput = {
  at?: number;
  bytesOut?: number;
  cpuMs?: number;
  durationMs: number;
  errorName?: string;
  heapBytes?: number;
  kind: "handler" | "request";
  method?: string;
  name: string;
  ok: boolean;
  statusCode?: number;
};

export type WorkloadMeterWireEvent = {
  bytes_out?: number;
  cpu_ms: number;
  cursor: number;
  duration_ms: number;
  error_name?: string;
  event_at: string;
  heap_bytes?: number;
  kind: "handler" | "request";
  method?: string;
  name: string;
  ok: boolean;
  status_code?: number;
};

export type WorkloadMeterReporter = {
  dispose: () => Promise<void>;
  flush: () => Promise<void>;
  handlerMetrics: (record: {
    bytesOut?: number;
    cpuMs: number;
    durationMs: number;
    errorName?: string;
    heapBytes?: number;
    mutationName?: string;
    ok: boolean;
  }) => void;
  record: (event: WorkloadMeterInput) => void;
};

export type WorkloadMeterReporterOptions = {
  batchSize?: number;
  endpoint: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  flushIntervalMs?: number;
  maxPending?: number;
  onError?: (error: unknown) => void;
  sourceId: string;
  token: string;
};

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  label: string,
) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0)
    throw new Error(`${label} must be a positive integer`);

  return resolved;
};

const finiteNonNegative = (value: number | undefined, fallback = 0) => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0)
    throw new Error("Workload meter values must be finite and non-negative");

  return resolved;
};

export const createWorkloadMeterReporter = (
  options: WorkloadMeterReporterOptions,
): WorkloadMeterReporter => {
  const endpoint = new URL(options.endpoint).toString();
  if (!options.token) throw new Error("Workload meter token is required");
  if (!options.sourceId)
    throw new Error("Workload meter source id is required");
  const batchSize = positiveInteger(
    options.batchSize,
    DEFAULT_BATCH_SIZE,
    "batchSize",
  );
  const maxPending = positiveInteger(
    options.maxPending,
    DEFAULT_MAX_PENDING,
    "maxPending",
  );
  const flushIntervalMs = positiveInteger(
    options.flushIntervalMs,
    DEFAULT_FLUSH_INTERVAL_MS,
    "flushIntervalMs",
  );
  if (batchSize > maxPending)
    throw new Error("batchSize cannot exceed maxPending");
  const request = options.fetch ?? fetch;
  const pending: WorkloadMeterWireEvent[] = [];
  let cursor = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  const handleError = (error: unknown) => options.onError?.(error);

  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(handleError);
    }, flushIntervalMs);
    timer.unref?.();
  };
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        while (pending.length > 0) {
          const events = pending.slice(0, batchSize);
          const response = await request(endpoint, {
            body: JSON.stringify({ events, source_id: options.sourceId }),
            headers: {
              authorization: `Bearer ${options.token}`,
              "content-type": "application/json",
            },
            method: "POST",
          });
          if (!response.ok)
            throw new Error(
              `Workload meter delivery failed (${response.status})`,
            );
          pending.splice(0, events.length);
        }
      });
    await queue;
  };
  const record = (input: WorkloadMeterInput) => {
    if (disposed) return;
    if (pending.length >= maxPending)
      throw new Error("Workload meter pending-event limit reached");
    cursor += 1;
    pending.push({
      ...(input.bytesOut === undefined
        ? {}
        : { bytes_out: finiteNonNegative(input.bytesOut) }),
      cpu_ms: finiteNonNegative(input.cpuMs),
      cursor,
      duration_ms: finiteNonNegative(input.durationMs),
      ...(input.errorName ? { error_name: input.errorName } : {}),
      event_at: new Date(input.at ?? Date.now()).toISOString(),
      ...(input.heapBytes === undefined
        ? {}
        : { heap_bytes: finiteNonNegative(input.heapBytes) }),
      kind: input.kind,
      ...(input.method ? { method: input.method } : {}),
      name: input.name,
      ok: input.ok,
      ...(input.statusCode === undefined
        ? {}
        : { status_code: input.statusCode }),
    });
    if (pending.length >= batchSize) void flush().catch(handleError);
    else schedule();
  };

  return {
    dispose: async () => {
      disposed = true;
      await flush();
    },
    flush,
    handlerMetrics: (record_) =>
      record({
        bytesOut: record_.bytesOut,
        cpuMs: record_.cpuMs,
        durationMs: record_.durationMs,
        errorName: record_.errorName,
        heapBytes: record_.heapBytes,
        kind: "handler",
        name: record_.mutationName ?? "anonymous",
        ok: record_.ok,
      }),
    record,
  };
};
