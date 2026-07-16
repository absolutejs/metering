# @absolutejs/metering changelog

## 0.4.1 — 2026-07-16

- Keep the optional Elysia peer external in the published plugin artifact.

## 0.4.0 — 2026-07-16

- Add a bounded, batched workload reporter with monotonic source cursors.
- Add an Elysia plugin that reports one terminal event for every request,
  including error paths, without capturing request or response bodies.
- Add a direct `handlerMetrics` adapter for `@absolutejs/sync`.

## 0.3.0 — 2026-07-15

- Add `adopt` and `restored` process lifecycle events. Both reset the
  cumulative CPU observation baseline after a supervisor restart or checkpoint
  restore without incrementing the tenant's real spawn count.

## 0.2.0 — 2026-07-14

- Add first-class `ai` events with normalized input, output, prompt-cache,
  duration, agent-turn, tool-call, stop-reason, and optional integer-micro cost
  fields.
- Add cumulative and rolling AI request, token, and monetary-cost budgets.
- Restore older snapshots safely by filling newly introduced usage counters.

## 0.1.0 — 2026-05-29

Substrate-deepening pass. Backwards-compatible — function-shaped sinks and
the 0.0.1 cumulative-budget shape are unchanged; new surface is additive.

### Added

- **Observation events.** `{ type: 'observation', tenant, cpuMs, rssBytes, at }`
  matches `@absolutejs/runtime@0.1.0`'s periodic Linux observation shape.
  `cpuMs` is treated as CUMULATIVE since spawn — the meter charges the
  delta against the previous observation. A `process` event of
  `transition === 'spawn'` or `'exit'` resets the baseline so a fresh
  process doesn't double-charge.
- **`usage.processCpuMs`** — cumulative process CPU ms, sourced from
  observation deltas. Separate from `usage.cpuMs` (which is sandbox-only
  CPU from handler events). `processCpuMs` is usually >= `cpuMs` because
  it includes host work outside the sandbox. Source of truth for billing
  CPU on the host process.
- **`usage.processRssBytesPeak`** — high-water mark RSS across observations.
- **`usage.lastObservationAt`** — wall-clock of the most recent observation.
- **`processCpuMs` budget dimension** — cap on cumulative host-process CPU.
- **Rolling-window budgets.** New `rollingBudgets: Record<string, RollingBudget[]>`
  config. Each rule = `{ dimension: 'requests' | 'errors' | 'cpuMs' | 'bytesEgress', windowMs, limit }`.
  A tenant trips when the rolling sum of matching events in the last
  `windowMs` reaches `limit`. **The breaker re-closes automatically** as
  events fall out of the window — no `reset()` needed. Cumulative budgets
  still stick until `reset()`. Both kinds can be set on the same tenant;
  `allow()` returns false if any rule trips.
- **`meter.rollingSum(tenant, dimension, windowMs)`** — surface the
  current rolling-window total. Useful for "you have N requests left in
  this window" customer-visible quota displays.
- **`meter.rollingFor(tenant)`** — return active rolling rules.
- **Flushable sinks.** `MeterSink` accepts either the 0.0.1 function shape
  OR a `{ ingest, flush?, close? }` object. On `meter.dispose()`, every
  sink's `flush()` is awaited (in parallel across sinks, serial between
  flush + close), THEN every sink's `close()`. A throwing flush is logged
  - swallowed; later sinks still flush.
- **`meter.snapshot()` + `meter.restore(snapshot)`.** Serializable
  point-in-time state. After a shard restart, restore lets the meter
  resume per-tenant counters (the bill doesn't reset to zero). Snapshot
  includes usage, tripped state, rolling-window state, and the last
  observation cpuMs baseline so the next observation charges a sane delta.
- **`BreachReason.windowMs`** — set when the breach came from a rolling
  rule, so onBreach handlers can tell cumulative from rolling.

### Changed (non-breaking)

- `consoleSink` now prints observation events too.
- `tripped(tenant)` re-evaluates rolling rules — calling it can untrip a
  tenant whose rolling window has drained. (`reset()` is still the way to
  untrip a cumulative breach early.)

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
