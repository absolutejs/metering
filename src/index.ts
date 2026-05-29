/**
 * @absolutejs/metering — per-tenant cost-attribution + budget enforcement for
 * multi-tenant Bun runtimes.
 *
 * Consumes two event shapes:
 *  - `handler` — one per `@absolutejs/sync` sandboxed-mutation call. Structurally
 *    compatible with `HandlerMetricsRecord` from `@absolutejs/sync`, extended
 *    with a `tenant` key so a single meter can serve many tenants.
 *  - `process` — one per `@absolutejs/runtime` lifecycle transition (spawn,
 *    ready, idle-kill, lru-evict, exit). Structurally compatible with that
 *    library's `RuntimeTransitionEvent`.
 *
 * v0.0.1 is intentionally pure in-memory: rollups, sinks, budgets, breaker.
 * Influx/Prometheus/Stripe sinks ship in later versions; their shape is the
 * `MeterSink` interface here.
 */

export type HandlerMeterEvent = {
	type: 'handler';
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
	| 'spawn'
	| 'ready'
	| 'idle-kill'
	| 'lru-evict'
	| 'exit';

export type ProcessMeterEvent = {
	type: 'process';
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

export type MeterEvent = HandlerMeterEvent | ProcessMeterEvent;

export type Usage = {
	/** Total handler calls counted for this tenant. */
	requests: number;
	/** Of those, how many threw. */
	errors: number;
	/** Sum of `cpuMs` across all handler events. */
	cpuMs: number;
	/** Sum of `durationMs` across all handler events (wall-clock, not CPU). */
	durationMs: number;
	/** Sum of `bytesOut` across all handler events. */
	bytesEgress: number;
	/** Sum of `hibernationGbSeconds` across all process events. */
	hibernationGbSeconds: number;
	/** Max `heapBytes` observed across all handler events. */
	heapBytesPeak: number;
	/** Spawn count (process events with `transition === 'spawn'`). */
	spawns: number;
	/** Wall-clock of the most recent event. */
	lastAt: number;
};

const freshUsage = (): Usage => ({
	bytesEgress: 0,
	cpuMs: 0,
	durationMs: 0,
	errors: 0,
	heapBytesPeak: 0,
	hibernationGbSeconds: 0,
	lastAt: 0,
	requests: 0,
	spawns: 0,
});

export type Budget = Partial<{
	cpuMs: number;
	bytesEgress: number;
	requests: number;
	errors: number;
	hibernationGbSeconds: number;
}>;

export type BreachReason = {
	tenant: string;
	dimension: keyof Budget;
	limit: number;
	observed: number;
	at: number;
};

export type MeterSink = (event: MeterEvent) => void | Promise<void>;

export const consoleSink: MeterSink = (event) => {
	if (event.type === 'handler') {
		console.log(
			`[meter] ${event.tenant} handler ${event.mutationName ?? '(anon)'} ${event.ok ? 'ok' : 'err'} cpu=${event.cpuMs}ms wall=${event.durationMs}ms`,
		);
		return;
	}
	console.log(
		`[meter] ${event.tenant} process ${event.transition}${event.durationMs !== undefined ? ` dur=${event.durationMs}ms` : ''}`,
	);
};

export type Clock = () => number;

export type MeterOptions = {
	/**
	 * Fan-out targets for every recorded event. Sinks are called in order;
	 * a throw / rejection from one sink does NOT stop later sinks (the meter
	 * is on the critical path for billing, so one broken adapter cannot take
	 * the others down with it).
	 */
	sinks?: MeterSink[];
	/**
	 * Per-tenant budgets. Looked up by tenant id with `'*'` as the fallback
	 * default. A tenant trips its breaker the first time any dimension's
	 * observed value reaches or exceeds the limit. `onBreach` fires once
	 * per trip; subsequent events still accumulate (the bill keeps growing),
	 * `allow()` keeps returning `false` until `reset()` is called.
	 */
	budgets?: Record<string, Budget>;
	/**
	 * Fired the first time a tenant's usage crosses ANY budget dimension.
	 * Use this to publish a side-channel notification, throttle the tenant
	 * at the router, or auto-suspend until ops review.
	 */
	onBreach?: (breach: BreachReason) => void | Promise<void>;
	/** Override `Date.now` for tests. */
	clock?: Clock;
};

export type Meter = {
	/** Accept one event. Updates the rollup, fans out to sinks, may trip a breaker. */
	record: (event: MeterEvent) => void;
	/** Pre-flight gate: returns `false` if the tenant's breaker has tripped. */
	allow: (tenant: string) => boolean;
	/** Clear a breaker trip. Accumulated usage is NOT zeroed — call `clear()` for that. */
	reset: (tenant: string) => void;
	/** Zero all accumulated usage + clear the breaker for a tenant. */
	clear: (tenant: string) => void;
	/** Snapshot of a tenant's rollup. Returns `null` if nothing has been recorded. */
	usage: (tenant: string) => Usage | null;
	/** Iterate all tenants the meter has seen. */
	tenants: () => string[];
	/** Active budget for a tenant (per-tenant override, else default `'*'`, else empty). */
	budget: (tenant: string) => Budget;
	/** Has this tenant's breaker tripped? */
	tripped: (tenant: string) => boolean;
	/** Stop the meter and release resources. Future sinks with `flush()` are awaited here. */
	dispose: () => Promise<void>;
};

export const createMeter = (options: MeterOptions = {}): Meter => {
	const clock: Clock = options.clock ?? Date.now;
	const sinks = options.sinks ?? [];
	const budgets = options.budgets ?? {};
	const onBreach = options.onBreach;

	const usageMap = new Map<string, Usage>();
	const trippedSet = new Set<string>();
	let disposed = false;

	const budgetFor = (tenant: string): Budget => budgets[tenant] ?? budgets['*'] ?? {};

	const fanOut = (event: MeterEvent) => {
		for (const sink of sinks) {
			try {
				const ret = sink(event);
				if (ret && typeof (ret as Promise<void>).then === 'function') {
					(ret as Promise<void>).catch((error) => {
						console.error('[meter] async sink rejected:', error);
					});
				}
			} catch (error) {
				console.error('[meter] sink threw:', error);
			}
		}
	};

	const checkBreach = (tenant: string, usage: Usage, at: number) => {
		if (trippedSet.has(tenant)) return;
		const budget = budgetFor(tenant);
		const checks: ReadonlyArray<readonly [keyof Budget, number, number | undefined]> = [
			['cpuMs', usage.cpuMs, budget.cpuMs],
			['bytesEgress', usage.bytesEgress, budget.bytesEgress],
			['requests', usage.requests, budget.requests],
			['errors', usage.errors, budget.errors],
			['hibernationGbSeconds', usage.hibernationGbSeconds, budget.hibernationGbSeconds],
		];
		for (const [dimension, observed, limit] of checks) {
			if (limit !== undefined && observed >= limit) {
				trippedSet.add(tenant);
				if (onBreach) {
					try {
						const ret = onBreach({ at, dimension, limit, observed, tenant });
						if (ret && typeof (ret as Promise<void>).then === 'function') {
							(ret as Promise<void>).catch((error) => {
								console.error('[meter] async onBreach rejected:', error);
							});
						}
					} catch (error) {
						console.error('[meter] onBreach threw:', error);
					}
				}
				return;
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

	const record: Meter['record'] = (event) => {
		if (disposed) return;
		const at = event.at ?? clock();
		const usage = ensureUsage(event.tenant);
		usage.lastAt = at;
		if (event.type === 'handler') {
			usage.requests += 1;
			if (!event.ok) usage.errors += 1;
			usage.cpuMs += event.cpuMs;
			usage.durationMs += event.durationMs;
			if (event.bytesOut !== undefined) usage.bytesEgress += event.bytesOut;
			if (event.heapBytes !== undefined && event.heapBytes > usage.heapBytesPeak) {
				usage.heapBytesPeak = event.heapBytes;
			}
		} else {
			if (event.transition === 'spawn') usage.spawns += 1;
			if (event.hibernationGbSeconds !== undefined) {
				usage.hibernationGbSeconds += event.hibernationGbSeconds;
			}
		}
		fanOut({ ...event, at });
		checkBreach(event.tenant, usage, at);
	};

	return {
		allow: (tenant) => !trippedSet.has(tenant),
		budget: budgetFor,
		clear: (tenant) => {
			usageMap.delete(tenant);
			trippedSet.delete(tenant);
		},
		dispose: async () => {
			disposed = true;
			usageMap.clear();
			trippedSet.clear();
		},
		record,
		reset: (tenant) => {
			trippedSet.delete(tenant);
		},
		tenants: () => Array.from(usageMap.keys()),
		tripped: (tenant) => trippedSet.has(tenant),
		usage: (tenant) => {
			const found = usageMap.get(tenant);
			return found ? { ...found } : null;
		},
	};
};
