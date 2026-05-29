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

// In your request handler, gate on the meter:
if (!meter.allow(tenantId)) return new Response('Quota exceeded', { status: 429 });
```

## v0.0.1 surface

| API | Purpose |
|---|---|
| `createMeter(options)` | Factory. Returns a `Meter`. |
| `meter.record(event)` | Accept one `MeterEvent` — `handler` or `process`. Updates the rollup, fans out to sinks, may trip the breaker. |
| `meter.allow(tenant)` | Pre-flight gate. Returns `false` if the tenant's breaker has tripped. |
| `meter.usage(tenant)` | Snapshot of the rollup: `cpuMs`, `bytesEgress`, `hibernationGbSeconds`, etc. |
| `meter.reset(tenant)` | Clear the breaker without zeroing accumulated usage. |
| `meter.clear(tenant)` | Zero accumulated usage AND clear the breaker. |
| `meter.tenants()` | Every tenant seen so far. |
| `meter.budget(tenant)` | Active budget (per-tenant override → `'*'` default → `{}`). |
| `meter.tripped(tenant)` | Has the breaker tripped? |
| `meter.dispose()` | Stop accepting records; release resources. |

### Sinks

A `MeterSink` is `(event: MeterEvent) => void | Promise<void>`. Sinks are fanned out
in order. **A throw or rejection from one sink does not stop later sinks** — the
meter is on the billing critical path, and one broken adapter must not take the
others down with it. The error is logged to stderr; the recorder keeps going.

Bundled: `consoleSink`. Adapters for Influx / Prometheus / Stripe ship later.

### Budgets

`budgets['*']` is the default; per-tenant entries override it. Any dimension
hitting its limit trips the breaker; `onBreach` fires **once per trip** (call
`reset()` to re-arm). Subsequent events still accumulate — the bill keeps
growing even after the gate is closed, which matches how real billing works.

Dimensions: `cpuMs`, `bytesEgress`, `requests`, `errors`, `hibernationGbSeconds`.

### Hibernation accounting

`@absolutejs/runtime` emits `idle-kill` / `lru-evict` transitions; the metering
caller is responsible for computing the GB-seconds the tenant racks up while
hibernated and passing it as `hibernationGbSeconds` on the `process` event.
The meter sums the values it sees — it does not infer them.

## Architectural role

- **`@absolutejs/sync`** — emits `handlerMetrics` records on every sandboxed mutation.
- **`@absolutejs/runtime`** — emits lifecycle events on every spawn / idle-kill / exit.
- **`@absolutejs/metering`** — *this library*. Rolls those up per tenant + gates them.
- **`@absolutejs/router`** (planned) — consumes `meter.allow()` to refuse traffic for over-quota tenants at the edge.

## License

BSL 1.1 with a named carveout for the hosted multi-tenant metering / cost-attribution / per-tenant billing category (Stripe Metered Billing, Orb, Metronome, Lago, Amberflo, Cloudflare Workers billing, Convex usage dashboards, Vercel usage dashboards). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
