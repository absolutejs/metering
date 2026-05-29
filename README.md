# @absolutejs/metering

Per-tenant cost-attribution + budget enforcement for multi-tenant Bun runtimes.

Built for PaaS providers that run many small Bun apps under one host. Consumes
`handlerMetrics` from [`@absolutejs/sync`](https://github.com/absolutejs/sync)
and lifecycle events from [`@absolutejs/runtime`](https://github.com/absolutejs/runtime),
rolls them up per tenant, and trips a circuit breaker the moment any per-tenant
budget dimension is exceeded. The library SB-6 layer between the runtime and
the billing / observability pipeline downstream.

```ts
import { createMeter, consoleSink } from '@absolutejs/metering';

const meter = createMeter({
  sinks: [consoleSink, influxSink],
  budgets: {
    '*': { cpuMs: 60_000, requests: 10_000 }, // free-tier default
    'acme-prod': { cpuMs: 600_000, requests: 1_000_000 }, // paid override
  },
  onBreach: ({ tenant, dimension, observed, limit }) => {
    suspendAtRouter(tenant, { dimension, observed, limit });
  },
});

// Wire it into a sync engine: sync handlerMetrics records → meter.record(...)
syncEngine.handlerMetrics = (record) => {
  meter.record({
    type: 'handler',
    tenant: currentTenantId(),
    mutationName: record.mutationName,
    durationMs: record.durationMs,
    cpuMs: record.cpuMs,
    heapBytes: record.heapBytes,
    ok: record.ok,
    errorName: record.errorName,
  });
};

// And a runtime: spawn/idle-kill/exit transitions → meter.record(...)
runtime.options.onTransition = (event) => {
  meter.record({
    type: 'process',
    tenant: event.key,
    transition: event.type,
    durationMs: event.durationMs,
  });
};

// And @absolutejs/runtime@0.1.0's Linux observation events:
runtime.options.onMetrics = (event) => {
  if (event.type === 'observation') {
    meter.record({
      type: 'observation',
      tenant: event.key,
      cpuMs: event.cpuMs,
      rssBytes: event.rssBytes,
      at: event.at,
    });
  }
};

// In your request handler, gate on the meter:
if (!meter.allow(tenantId)) return new Response('Quota exceeded', { status: 429 });
```

## Surface (0.1.0)

| API | Purpose |
|---|---|
| `createMeter(options)` | Factory. Returns a `Meter`. |
| `meter.record(event)` | Accept one `MeterEvent` — `handler`, `process`, or `observation`. Updates the rollup, fans out to sinks, may trip the breaker. |
| `meter.allow(tenant)` | Pre-flight gate. Returns `false` if any cumulative budget tripped, any rolling-window rule is currently over, or `reset()` hasn't been called after a sticky cumulative trip. |
| `meter.usage(tenant)` | Snapshot of the rollup: `cpuMs`, `processCpuMs`, `bytesEgress`, `hibernationGbSeconds`, `processRssBytesPeak`, etc. |
| `meter.rollingSum(tenant, dimension, windowMs)` | Current rolling-window total for `(tenant, dimension, window)`. For customer-facing "you have N requests left in this window" displays. |
| `meter.rollingFor(tenant)` | Active rolling rules. |
| `meter.reset(tenant)` | Clear a cumulative-trip breaker without zeroing accumulated usage. Rolling-window trips auto-clear as events drain. |
| `meter.clear(tenant)` | Zero accumulated usage AND clear the breaker. |
| `meter.tenants()` | Every tenant seen so far. |
| `meter.budget(tenant)` | Active cumulative budget. |
| `meter.tripped(tenant)` | Re-evaluates rolling rules; calling it can untrip a tenant whose window has drained. |
| `meter.snapshot()` / `restore(snap)` | Serializable point-in-time state. Survive shard restarts; the bill doesn't reset to zero. |
| `meter.dispose()` | Await every sink's `flush?`, then `close?`. |

### Sinks

A `MeterSink` is either a function `(event) => void | Promise<void>` or an object
`{ ingest, flush?, close? }`. Sinks are fanned out in order. **A throw or
rejection from one sink does not stop later sinks** — the meter is on the
billing critical path. The error is logged to stderr; the recorder keeps going.

On `dispose()`, every object-shaped sink's `flush()` is awaited (serial across
sinks), then every `close()` is awaited. A throwing flush is logged + swallowed;
later sinks still flush. This is what batched adapters (Stripe, Influx, ClickHouse)
need to not drop the last few events on shutdown.

Bundled: `consoleSink`. Adapters for Influx / Prometheus / Stripe ship later as
sibling packages.

### Cumulative budgets

`budgets['*']` is the default; per-tenant entries override it. Any dimension
hitting its limit trips the breaker; `onBreach` fires **once per trip** (call
`reset()` to re-arm). Subsequent events still accumulate — the bill keeps
growing even after the gate is closed, which matches how real billing works.

Dimensions: `cpuMs`, `processCpuMs`, `bytesEgress`, `requests`, `errors`, `hibernationGbSeconds`.

### Rolling-window budgets

```ts
createMeter({
  rollingBudgets: {
    '*': [
      { dimension: 'errors',   windowMs: 5  * 60_000, limit: 50 },     // 50 errors / 5 min trips the breaker
      { dimension: 'requests', windowMs: 1  * 60_000, limit: 1_000 },  // 1k req / min rate cap
    ],
    'acme-prod': [
      { dimension: 'cpuMs', windowMs: 60_000, limit: 50_000 },          // 50s sandbox CPU / minute
    ],
  },
});
```

A rolling-window rule trips when the rolling sum reaches `limit`. **It re-closes
automatically** as events drain out of the window — no `reset()` needed. That's
the difference from a cumulative budget, which sticks until `reset()`. Both
kinds can be set on the same tenant; `allow()` is `false` if any rule trips.

### Observation accounting

`@absolutejs/runtime@0.1.0` emits `{ type: 'observation', cpuMs, rssBytes }` on
a configurable interval. The meter treats `cpuMs` as CUMULATIVE since spawn and
charges the delta since the previous observation. A `process` event of
`transition === 'spawn'` or `'exit'` resets the baseline so a fresh process
doesn't double-charge.

### Hibernation accounting

`@absolutejs/runtime` emits `idle-kill` / `lru-evict` transitions; the metering
caller is responsible for computing the GB-seconds the tenant racks up while
hibernated and passing it as `hibernationGbSeconds` on the `process` event.
The meter sums the values it sees — it does not infer them.

### Snapshot + restore

```ts
const json = JSON.stringify(meter.snapshot());
await persistToDisk('/var/lib/meter/state.json', json);

// On shard restart:
const restored = createMeter({ ... same config ... });
restored.restore(JSON.parse(await readFromDisk('/var/lib/meter/state.json')));
```

The snapshot captures every tenant's usage, tripped state, rolling-window state,
and the last observation cpuMs baseline so the next observation charges a
sensible delta instead of jumping to the cumulative-since-process-start value.

## Architectural role

- **`@absolutejs/sync`** — emits `handlerMetrics` records on every sandboxed mutation.
- **`@absolutejs/runtime`** — emits lifecycle events on every spawn / idle-kill / exit.
- **`@absolutejs/metering`** — *this library*. Rolls those up per tenant + gates them.
- **`@absolutejs/router`** (planned) — consumes `meter.allow()` to refuse traffic for over-quota tenants at the edge.

## License

BSL 1.1 with a named carveout for the hosted multi-tenant metering / cost-attribution / per-tenant billing category (Stripe Metered Billing, Orb, Metronome, Lago, Amberflo, Cloudflare Workers billing, Convex usage dashboards, Vercel usage dashboards). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
