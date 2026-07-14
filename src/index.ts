/**
 * @absolutejs/metering — per-tenant cost-attribution + budget enforcement for
 * multi-tenant Bun runtimes.
 *
 * Consumes four event shapes:
 *  - `handler` — one per `@absolutejs/sync` sandboxed-mutation call. Structurally
 *    compatible with `HandlerMetricsRecord` from `@absolutejs/sync`, extended
 *    with a `tenant` key so a single meter can serve many tenants.
 *  - `process` — one per `@absolutejs/runtime` lifecycle transition (spawn,
 *    ready, idle-kill, lru-evict, exit). Structurally compatible with that
 *    library's `RuntimeTransitionEvent`.
 *  - `observation` — periodic CPU + RSS snapshot per tenant, emitted by
 *    `@absolutejs/runtime@0.1.0`'s Linux observation pass.
 *  - `ai` — one completed (or stopped) model run with normalized token usage,
 *    agent-loop work, and optional caller-calculated cost in integer micros.
 *
 * v0.1.0 adds: rolling-window budgets (errors-in-last-N-min style breaker
 * decisions), flushable sinks (objects with `flush()` awaited on dispose so
 * batched adapters like Stripe / Influx work cleanly), and `snapshot()` /
 * `restore()` for survival across shard restarts.
 */

export type HandlerMeterEvent = {
  type: "handler";
  /** Tenant id — the bill-payer for this event. */
  tenant: string;
  /** Mutation name (forwarded from sync's `defineMutation`). */
  mutationName?: string;
  /** Wall-clock duration from call entry to result resolution (ms). */
  durationMs: number;
  /** Sandbox CPU time (ms). Sub-millisecond runs round to 0. */
  cpuMs: number;
  /** Peak heap bytes the handler reached during the call. */
  heapBytes?: number;
  /** Bytes the handler returned to its caller (response payload). */
  bytesOut?: number;
  /** `true` on success; `false` if the handler threw. */
  ok: boolean;
  /** Error name on failure (e.g. `TimeoutError`, `MemoryLimitError`). */
  errorName?: string;
  /** When the event happened (`Date.now()`). Filled in by `record` if omitted. */
  at?: number;
};

export type ProcessMeterEventType =
  | "spawn"
  | "ready"
  | "idle-kill"
  | "lru-evict"
  | "exit";

export type ProcessMeterEvent = {
  type: "process";
  /** Tenant id — same key the runtime uses. */
  tenant: string;
  /** Which lifecycle transition this is. */
  transition: ProcessMeterEventType;
  /** Cold-start duration for `spawn`/`ready`; how long the process was alive for `exit`. */
  durationMs?: number;
  /** Approximate RSS (bytes) at the moment of the transition, if known. */
  rssBytes?: number;
  /** Hibernation footprint in GB-seconds added by this transition (computed by the caller for `idle-kill`/`lru-evict`). */
  hibernationGbSeconds?: number;
  /** Process exit code, when applicable. */
  exitCode?: number | null;
  at?: number;
};

/**
 * Periodic CPU + RSS observation, one per running tenant per
 * `observeIntervalMs` (default 30s). Matches `@absolutejs/runtime@0.1.0`'s
 * `RuntimeMetricEvent` of type `'observation'`. `cpuMs` is the cumulative
 * process CPU since spawn (NOT a delta) — the meter computes the delta
 * since the previous observation to charge correctly.
 */
export type ObservationMeterEvent = {
  type: "observation";
  tenant: string;
  /** Cumulative process CPU ms since spawn. */
  cpuMs: number;
  /** Resident set size in bytes at observation time. */
  rssBytes: number;
  at?: number;
};

export type AIMeterEvent = {
  type: "ai";
  tenant: string;
  /** Stable caller id, useful for durable sink idempotency. */
  requestId?: string;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  durationMs: number;
  turns?: number;
  toolCalls?: number;
  /** Caller-calculated monetary cost in millionths of its billing currency. */
  costMicros?: number;
  ok: boolean;
  stopReason?: string;
  at?: number;
};

export type MeterEvent =
  | HandlerMeterEvent
  | ProcessMeterEvent
  | ObservationMeterEvent
  | AIMeterEvent;

export type Usage = {
  /** Total handler calls counted for this tenant. */
  requests: number;
  /** Of those, how many threw. */
  errors: number;
  /** Sum of `cpuMs` across all handler events (sandbox CPU only). */
  cpuMs: number;
  /**
   * Cumulative process CPU ms derived from observation deltas. This is
   * usually >= `cpuMs` because it includes host work outside the sandbox.
   * Source of truth for billing CPU on the host process.
   */
  processCpuMs: number;
  /** Sum of `durationMs` across all handler events (wall-clock, not CPU). */
  durationMs: number;
  /** Sum of `bytesOut` across all handler events. */
  bytesEgress: number;
  /** Sum of `hibernationGbSeconds` across all process events. */
  hibernationGbSeconds: number;
  /** Max `heapBytes` observed across all handler events. */
  heapBytesPeak: number;
  /** Max `rssBytes` observed across all observation events. */
  processRssBytesPeak: number;
  /** Spawn count (process events with `transition === 'spawn'`). */
  spawns: number;
  aiRequests: number;
  aiErrors: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCacheReadInputTokens: number;
  aiCacheWriteInputTokens: number;
  aiDurationMs: number;
  aiTurns: number;
  aiToolCalls: number;
  aiCostMicros: number;
  /** Wall-clock of the most recent event of any kind. */
  lastAt: number;
  /** Wall-clock of the most recent observation event. */
  lastObservationAt: number;
};

const freshUsage = (): Usage => ({
  aiCacheReadInputTokens: 0,
  aiCacheWriteInputTokens: 0,
  aiCostMicros: 0,
  aiDurationMs: 0,
  aiErrors: 0,
  aiInputTokens: 0,
  aiOutputTokens: 0,
  aiRequests: 0,
  aiToolCalls: 0,
  aiTurns: 0,
  bytesEgress: 0,
  cpuMs: 0,
  durationMs: 0,
  errors: 0,
  heapBytesPeak: 0,
  hibernationGbSeconds: 0,
  lastAt: 0,
  lastObservationAt: 0,
  processCpuMs: 0,
  processRssBytesPeak: 0,
  requests: 0,
  spawns: 0,
});

export type Budget = Partial<{
  aiRequests: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCostMicros: number;
  cpuMs: number;
  processCpuMs: number;
  bytesEgress: number;
  requests: number;
  errors: number;
  hibernationGbSeconds: number;
}>;

export type RollingDimension =
  | "requests"
  | "errors"
  | "cpuMs"
  | "bytesEgress"
  | "aiRequests"
  | "aiInputTokens"
  | "aiOutputTokens"
  | "aiCostMicros";

export type RollingBudget = {
  dimension: RollingDimension;
  windowMs: number;
  limit: number;
};

export type BreachReason = {
  tenant: string;
  dimension: keyof Budget | RollingDimension;
  limit: number;
  observed: number;
  at: number;
  /** Set when the breach came from a rolling budget rather than a cumulative one. */
  windowMs?: number;
};

// -----------------------------------------------------------------------------
// Sinks
// -----------------------------------------------------------------------------

export type MeterSinkObject = {
  /** Receive one event. May be sync or async; rejections are logged + swallowed. */
  ingest: (event: MeterEvent) => void | Promise<void>;
  /** Flush any buffered events. Awaited on `dispose()`. */
  flush?: () => Promise<void>;
  /** Release resources. Awaited on `dispose()` after flush. */
  close?: () => Promise<void>;
};

export type MeterSink =
  | ((event: MeterEvent) => void | Promise<void>)
  | MeterSinkObject;

const isSinkObject = (sink: MeterSink): sink is MeterSinkObject =>
  typeof sink === "object" && sink !== null && "ingest" in sink;

const ingestOf = (sink: MeterSink) => (isSinkObject(sink) ? sink.ingest : sink);

export const consoleSink: MeterSink = (event) => {
  if (event.type === "ai") {
    console.log(
      `[meter] ${event.tenant} ai ${event.provider ?? "(provider)"}/${event.model ?? "(model)"} ${event.ok ? "ok" : "err"} input=${event.inputTokens} output=${event.outputTokens} cost=${event.costMicros ?? 0}µ`,
    );
    return;
  }
  if (event.type === "handler") {
    console.log(
      `[meter] ${event.tenant} handler ${event.mutationName ?? "(anon)"} ${event.ok ? "ok" : "err"} cpu=${event.cpuMs}ms wall=${event.durationMs}ms`,
    );
    return;
  }
  if (event.type === "observation") {
    console.log(
      `[meter] ${event.tenant} observe cpu=${event.cpuMs}ms rss=${event.rssBytes}B`,
    );
    return;
  }
  console.log(
    `[meter] ${event.tenant} process ${event.transition}${event.durationMs !== undefined ? ` dur=${event.durationMs}ms` : ""}`,
  );
};

// -----------------------------------------------------------------------------
// Rolling-window state
// -----------------------------------------------------------------------------

type RollingEntry = { at: number; delta: number };

type RollingState = {
  /** Events sorted ascending by `at`. Old entries are evicted lazily. */
  entries: RollingEntry[];
  /** Running sum of entries' deltas. Always equals `entries.reduce((a, e) => a + e.delta, 0)`. */
  sum: number;
};

const evictExpired = (
  state: RollingState,
  now: number,
  windowMs: number,
): number => {
  const cutoff = now - windowMs;
  let evicted = 0;
  while (state.entries.length > 0 && state.entries[0]!.at < cutoff) {
    state.sum -= state.entries.shift()!.delta;
    evicted += 1;
  }
  return evicted;
};

// -----------------------------------------------------------------------------
// Clock + options
// -----------------------------------------------------------------------------

export type Clock = () => number;

export type MeterOptions = {
  sinks?: MeterSink[];
  /**
   * Per-tenant budgets keyed by tenant id (or `'*'` for the default).
   * Budget dimensions are cumulative — once exceeded, the breaker trips
   * and stays tripped until `reset()`. For sliding-window enforcement,
   * use `rollingBudgets`.
   */
  budgets?: Record<string, Budget>;
  /**
   * Per-tenant sliding-window budgets. Each rule has a `dimension`,
   * `windowMs`, and `limit`. A tenant trips when the rolling sum of
   * matching events in the last `windowMs` reaches `limit`. Reset
   * happens automatically as older events fall out of the window —
   * you don't need to call `reset()` for rolling-window trips (the
   * breaker re-closes on its own).
   */
  rollingBudgets?: Record<string, RollingBudget[]>;
  onBreach?: (breach: BreachReason) => void | Promise<void>;
  clock?: Clock;
};

// -----------------------------------------------------------------------------
// Snapshot / restore
// -----------------------------------------------------------------------------

export type MeterSnapshot = {
  version: 1;
  at: number;
  tenants: Array<{
    tenant: string;
    usage: Usage;
    tripped: boolean;
    rolling: Array<{
      dimension: RollingDimension;
      windowMs: number;
      limit: number;
      entries: RollingEntry[];
    }>;
    lastProcessCpuMs: number;
  }>;
};

// -----------------------------------------------------------------------------
// Meter
// -----------------------------------------------------------------------------

export type Meter = {
  record: (event: MeterEvent) => void;
  allow: (tenant: string) => boolean;
  reset: (tenant: string) => void;
  clear: (tenant: string) => void;
  usage: (tenant: string) => Usage | null;
  tenants: () => string[];
  budget: (tenant: string) => Budget;
  rollingFor: (tenant: string) => RollingBudget[];
  tripped: (tenant: string) => boolean;
  /**
   * Return current rolling-sum for a `(tenant, dimension, windowMs)` triple.
   * Returns `0` when no events match. Useful for surfacing "you have N
   * requests left in this window" to the customer.
   */
  rollingSum: (
    tenant: string,
    dimension: RollingDimension,
    windowMs: number,
  ) => number;
  /** Serializable point-in-time state. Pass to `restore()` after a shard restart. */
  snapshot: () => MeterSnapshot;
  /** Load a previously-captured snapshot. Replaces all current state. */
  restore: (snapshot: MeterSnapshot) => void;
  /** Tear down. Awaits every sink's `flush?` then `close?` in order. */
  dispose: () => Promise<void>;
};

export const createMeter = (options: MeterOptions = {}): Meter => {
  const clock: Clock = options.clock ?? Date.now;
  const sinks = options.sinks ?? [];
  const budgets = options.budgets ?? {};
  const rollingBudgets = options.rollingBudgets ?? {};
  const onBreach = options.onBreach;

  const usageMap = new Map<string, Usage>();
  const trippedSet = new Set<string>();
  /** Per-tenant per-rule rolling state. Key = `${tenant}|${dimension}|${windowMs}`. */
  const rollingState = new Map<string, RollingState>();
  /** Per-tenant last-seen cumulative process cpuMs, for computing observation deltas. */
  const lastProcessCpu = new Map<string, number>();
  let disposed = false;

  const budgetFor = (tenant: string): Budget =>
    budgets[tenant] ?? budgets["*"] ?? {};
  const rollingFor = (tenant: string): RollingBudget[] =>
    rollingBudgets[tenant] ?? rollingBudgets["*"] ?? [];

  const rollingKey = (
    tenant: string,
    dimension: RollingDimension,
    windowMs: number,
  ) => `${tenant}|${dimension}|${windowMs}`;

  const ensureRolling = (
    tenant: string,
    dimension: RollingDimension,
    windowMs: number,
  ): RollingState => {
    const key = rollingKey(tenant, dimension, windowMs);
    const found = rollingState.get(key);
    if (found) return found;
    const fresh: RollingState = { entries: [], sum: 0 };
    rollingState.set(key, fresh);
    return fresh;
  };

  const fireBreach = (breach: BreachReason) => {
    if (!onBreach) return;
    try {
      const ret = onBreach(breach);
      if (ret && typeof (ret as Promise<void>).then === "function") {
        (ret as Promise<void>).catch((error) => {
          console.error("[meter] async onBreach rejected:", error);
        });
      }
    } catch (error) {
      console.error("[meter] onBreach threw:", error);
    }
  };

  const fanOut = (event: MeterEvent) => {
    for (const sink of sinks) {
      const ingest = ingestOf(sink);
      try {
        const ret = ingest(event);
        if (ret && typeof (ret as Promise<void>).then === "function") {
          (ret as Promise<void>).catch((error) => {
            console.error("[meter] async sink rejected:", error);
          });
        }
      } catch (error) {
        console.error("[meter] sink threw:", error);
      }
    }
  };

  const checkCumulativeBreach = (tenant: string, usage: Usage, at: number) => {
    if (trippedSet.has(tenant)) return;
    const budget = budgetFor(tenant);
    const checks: ReadonlyArray<
      readonly [keyof Budget, number, number | undefined]
    > = [
      ["aiRequests", usage.aiRequests, budget.aiRequests],
      ["aiInputTokens", usage.aiInputTokens, budget.aiInputTokens],
      ["aiOutputTokens", usage.aiOutputTokens, budget.aiOutputTokens],
      ["aiCostMicros", usage.aiCostMicros, budget.aiCostMicros],
      ["cpuMs", usage.cpuMs, budget.cpuMs],
      ["processCpuMs", usage.processCpuMs, budget.processCpuMs],
      ["bytesEgress", usage.bytesEgress, budget.bytesEgress],
      ["requests", usage.requests, budget.requests],
      ["errors", usage.errors, budget.errors],
      [
        "hibernationGbSeconds",
        usage.hibernationGbSeconds,
        budget.hibernationGbSeconds,
      ],
    ];
    for (const [dimension, observed, limit] of checks) {
      if (limit !== undefined && observed >= limit) {
        trippedSet.add(tenant);
        fireBreach({ at, dimension, limit, observed, tenant });
        return;
      }
    }
  };

  const recordRolling = (
    tenant: string,
    dimension: RollingDimension,
    delta: number,
    at: number,
  ) => {
    if (delta <= 0) return;
    const rules = rollingFor(tenant).filter(
      (rule) => rule.dimension === dimension,
    );
    for (const rule of rules) {
      const state = ensureRolling(tenant, dimension, rule.windowMs);
      state.entries.push({ at, delta });
      state.sum += delta;
      evictExpired(state, at, rule.windowMs);
      if (state.sum >= rule.limit && !trippedSet.has(tenant)) {
        trippedSet.add(tenant);
        fireBreach({
          at,
          dimension,
          limit: rule.limit,
          observed: state.sum,
          tenant,
          windowMs: rule.windowMs,
        });
      }
    }
  };

  const ensureUsage = (tenant: string): Usage => {
    const existing = usageMap.get(tenant);
    if (existing) return existing;
    const fresh = freshUsage();
    usageMap.set(tenant, fresh);
    return fresh;
  };

  const record: Meter["record"] = (event) => {
    if (disposed) return;
    const at = event.at ?? clock();
    const usage = ensureUsage(event.tenant);
    usage.lastAt = at;

    if (event.type === "handler") {
      usage.requests += 1;
      recordRolling(event.tenant, "requests", 1, at);
      if (!event.ok) {
        usage.errors += 1;
        recordRolling(event.tenant, "errors", 1, at);
      }
      usage.cpuMs += event.cpuMs;
      recordRolling(event.tenant, "cpuMs", event.cpuMs, at);
      usage.durationMs += event.durationMs;
      if (event.bytesOut !== undefined) {
        usage.bytesEgress += event.bytesOut;
        recordRolling(event.tenant, "bytesEgress", event.bytesOut, at);
      }
      if (
        event.heapBytes !== undefined &&
        event.heapBytes > usage.heapBytesPeak
      ) {
        usage.heapBytesPeak = event.heapBytes;
      }
    } else if (event.type === "ai") {
      usage.aiRequests += 1;
      recordRolling(event.tenant, "aiRequests", 1, at);
      if (!event.ok) usage.aiErrors += 1;
      usage.aiInputTokens += event.inputTokens;
      usage.aiOutputTokens += event.outputTokens;
      usage.aiCacheReadInputTokens += event.cacheReadInputTokens ?? 0;
      usage.aiCacheWriteInputTokens += event.cacheWriteInputTokens ?? 0;
      usage.aiDurationMs += event.durationMs;
      usage.aiTurns += event.turns ?? 0;
      usage.aiToolCalls += event.toolCalls ?? 0;
      usage.aiCostMicros += event.costMicros ?? 0;
      recordRolling(event.tenant, "aiInputTokens", event.inputTokens, at);
      recordRolling(event.tenant, "aiOutputTokens", event.outputTokens, at);
      recordRolling(event.tenant, "aiCostMicros", event.costMicros ?? 0, at);
    } else if (event.type === "observation") {
      // observation.cpuMs is CUMULATIVE since spawn. Charge the delta since
      // the last observation; ignore on first sight (we don't know the start).
      const prior = lastProcessCpu.get(event.tenant);
      if (prior !== undefined && event.cpuMs >= prior) {
        usage.processCpuMs += event.cpuMs - prior;
      } else if (prior === undefined) {
        // Establish a baseline without charging — the runtime emits the first
        // observation some interval after spawn, so any earlier CPU is sunk.
        usage.processCpuMs += event.cpuMs;
      }
      lastProcessCpu.set(event.tenant, event.cpuMs);
      if (event.rssBytes > usage.processRssBytesPeak) {
        usage.processRssBytesPeak = event.rssBytes;
      }
      usage.lastObservationAt = at;
    } else {
      // process event
      if (event.transition === "spawn") {
        usage.spawns += 1;
        // A new process resets the cumulative-cpu baseline.
        lastProcessCpu.delete(event.tenant);
      }
      if (event.transition === "exit") {
        // Clear baseline so the next spawn's first observation is treated as a baseline, not a delta.
        lastProcessCpu.delete(event.tenant);
      }
      if (event.hibernationGbSeconds !== undefined) {
        usage.hibernationGbSeconds += event.hibernationGbSeconds;
      }
    }

    fanOut({ ...event, at });
    checkCumulativeBreach(event.tenant, usage, at);
  };

  const rollingSum: Meter["rollingSum"] = (tenant, dimension, windowMs) => {
    const state = rollingState.get(rollingKey(tenant, dimension, windowMs));
    if (!state) return 0;
    evictExpired(state, clock(), windowMs);
    return state.sum;
  };

  const isStillTripped = (tenant: string): boolean => {
    if (!trippedSet.has(tenant)) return false;
    // If the trip came from a rolling rule that has since drained, re-close.
    const cumulativeBudget = budgetFor(tenant);
    const usage = usageMap.get(tenant);
    if (usage) {
      const cumulative: ReadonlyArray<readonly [number, number | undefined]> = [
        [usage.aiRequests, cumulativeBudget.aiRequests],
        [usage.aiInputTokens, cumulativeBudget.aiInputTokens],
        [usage.aiOutputTokens, cumulativeBudget.aiOutputTokens],
        [usage.aiCostMicros, cumulativeBudget.aiCostMicros],
        [usage.cpuMs, cumulativeBudget.cpuMs],
        [usage.processCpuMs, cumulativeBudget.processCpuMs],
        [usage.bytesEgress, cumulativeBudget.bytesEgress],
        [usage.requests, cumulativeBudget.requests],
        [usage.errors, cumulativeBudget.errors],
        [usage.hibernationGbSeconds, cumulativeBudget.hibernationGbSeconds],
      ];
      for (const [observed, limit] of cumulative) {
        if (limit !== undefined && observed >= limit) return true;
      }
    }
    const now = clock();
    for (const rule of rollingFor(tenant)) {
      const state = rollingState.get(
        rollingKey(tenant, rule.dimension, rule.windowMs),
      );
      if (!state) continue;
      evictExpired(state, now, rule.windowMs);
      if (state.sum >= rule.limit) return true;
    }
    // No remaining trip cause — re-close the breaker.
    trippedSet.delete(tenant);
    return false;
  };

  return {
    allow: (tenant) => !isStillTripped(tenant),
    budget: budgetFor,
    clear: (tenant) => {
      usageMap.delete(tenant);
      trippedSet.delete(tenant);
      lastProcessCpu.delete(tenant);
      for (const key of Array.from(rollingState.keys())) {
        if (key.startsWith(`${tenant}|`)) rollingState.delete(key);
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // Flush every sink that supports it, then close.
      for (const sink of sinks) {
        if (!isSinkObject(sink)) continue;
        if (sink.flush) {
          try {
            await sink.flush();
          } catch (error) {
            console.error("[meter] sink.flush rejected:", error);
          }
        }
      }
      for (const sink of sinks) {
        if (!isSinkObject(sink)) continue;
        if (sink.close) {
          try {
            await sink.close();
          } catch (error) {
            console.error("[meter] sink.close rejected:", error);
          }
        }
      }
      usageMap.clear();
      trippedSet.clear();
      rollingState.clear();
      lastProcessCpu.clear();
    },
    record,
    reset: (tenant) => {
      trippedSet.delete(tenant);
    },
    rollingFor,
    rollingSum,
    snapshot: () => {
      const now = clock();
      const tenants: MeterSnapshot["tenants"] = [];
      for (const [tenant, usage] of usageMap) {
        const rolling: MeterSnapshot["tenants"][number]["rolling"] = [];
        for (const rule of rollingFor(tenant)) {
          const state = rollingState.get(
            rollingKey(tenant, rule.dimension, rule.windowMs),
          );
          if (!state) continue;
          rolling.push({
            dimension: rule.dimension,
            entries: state.entries.map((entry) => ({ ...entry })),
            limit: rule.limit,
            windowMs: rule.windowMs,
          });
        }
        tenants.push({
          lastProcessCpuMs: lastProcessCpu.get(tenant) ?? 0,
          rolling,
          tenant,
          tripped: trippedSet.has(tenant),
          usage: { ...usage },
        });
      }
      return { at: now, tenants, version: 1 };
    },
    restore: (snapshot) => {
      usageMap.clear();
      trippedSet.clear();
      rollingState.clear();
      lastProcessCpu.clear();
      for (const entry of snapshot.tenants) {
        usageMap.set(entry.tenant, { ...freshUsage(), ...entry.usage });
        if (entry.tripped) trippedSet.add(entry.tenant);
        lastProcessCpu.set(entry.tenant, entry.lastProcessCpuMs);
        for (const rule of entry.rolling) {
          const state: RollingState = {
            entries: rule.entries.map((event) => ({ ...event })),
            sum: rule.entries.reduce((a, event) => a + event.delta, 0),
          };
          rollingState.set(
            rollingKey(entry.tenant, rule.dimension, rule.windowMs),
            state,
          );
        }
      }
    },
    tenants: () => Array.from(usageMap.keys()),
    tripped: (tenant) => isStillTripped(tenant),
    usage: (tenant) => {
      const found = usageMap.get(tenant);
      return found ? { ...found } : null;
    },
  };
};
