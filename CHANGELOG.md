# @absolutejs/metering changelog

## 0.0.1 — 2026-05-29

Initial release.

- `createMeter({ sinks, budgets, onBreach, clock })` factory.
- Records `handler` events (from `@absolutejs/sync` handlerMetrics-shaped) and
  `process` events (from `@absolutejs/runtime` spawn / idle-kill / exit).
- Per-tenant rollup: `cpuMs`, `bytesEgress`, `hibernationGbSeconds`, plus
  derived `requests` count and `errors` count.
- Pluggable sinks (default `consoleSink`); fan-out on every record.
- Per-tenant budgets with circuit breaker — `meter.allow(key)` returns `false`
  once any budget dimension is exceeded; `onBreach` fires once per trip;
  `meter.reset(key)` clears the trip without dropping accumulated usage.
- `meter.usage(key)` returns the rollup snapshot; `meter.dispose()` flushes
  any flushable sinks.
- Pure in-memory v0.0.1 — persistence + Influx/Prometheus/Stripe adapters
  ship in later versions.
