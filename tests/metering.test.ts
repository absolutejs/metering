import { describe, expect, test } from "bun:test";
import {
  createMeter,
  type BreachReason,
  type MeterEvent,
  type RollingBudget,
} from "../src";

const tick = () => {
  let t = 1_000_000;
  return () => {
    t += 1;
    return t;
  };
};

const handlerEvent = (
  tenant: string,
  overrides: Partial<MeterEvent> = {},
): MeterEvent =>
  ({
    cpuMs: 1,
    durationMs: 2,
    mutationName: "doThing",
    ok: true,
    tenant,
    type: "handler",
    ...overrides,
  }) as MeterEvent;

const processEvent = (
  tenant: string,
  overrides: Partial<MeterEvent> = {},
): MeterEvent =>
  ({
    tenant,
    transition: "spawn",
    type: "process",
    ...overrides,
  }) as MeterEvent;

describe("createMeter", () => {
  test("rolls up AI usage and cost per tenant", () => {
    const meter = createMeter({ clock: tick() });
    meter.record({
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 20,
      costMicros: 125,
      durationMs: 250,
      inputTokens: 100,
      model: "model",
      ok: true,
      outputTokens: 50,
      provider: "provider",
      tenant: "t1",
      toolCalls: 2,
      turns: 3,
      type: "ai",
    });

    expect(meter.usage("t1")).toMatchObject({
      aiCacheReadInputTokens: 30,
      aiCacheWriteInputTokens: 20,
      aiCostMicros: 125,
      aiDurationMs: 250,
      aiInputTokens: 100,
      aiOutputTokens: 50,
      aiRequests: 1,
      aiToolCalls: 2,
      aiTurns: 3,
    });
  });

  test("AI cost budget trips the circuit breaker", () => {
    const meter = createMeter({ budgets: { t1: { aiCostMicros: 100 } } });
    meter.record({
      costMicros: 100,
      durationMs: 1,
      inputTokens: 1,
      ok: true,
      outputTokens: 1,
      tenant: "t1",
      type: "ai",
    });
    expect(meter.allow("t1")).toBe(false);
  });

  test("rolls up handler events per tenant", () => {
    const meter = createMeter({ clock: tick() });
    meter.record(
      handlerEvent("t1", {
        bytesOut: 100,
        cpuMs: 5,
        durationMs: 10,
        heapBytes: 1000,
      }),
    );
    meter.record(
      handlerEvent("t1", {
        bytesOut: 200,
        cpuMs: 15,
        durationMs: 20,
        heapBytes: 800,
      }),
    );
    meter.record(handlerEvent("t2", { cpuMs: 3, durationMs: 4 }));

    const t1 = meter.usage("t1");
    expect(t1).not.toBeNull();
    expect(t1!.requests).toBe(2);
    expect(t1!.cpuMs).toBe(20);
    expect(t1!.durationMs).toBe(30);
    expect(t1!.bytesEgress).toBe(300);
    expect(t1!.heapBytesPeak).toBe(1000);
    expect(t1!.errors).toBe(0);

    const t2 = meter.usage("t2");
    expect(t2!.requests).toBe(1);
    expect(t2!.cpuMs).toBe(3);
  });

  test("counts errors and never undercounts the bill", () => {
    const meter = createMeter({ clock: tick() });
    meter.record(handlerEvent("t1", { cpuMs: 5, durationMs: 10, ok: true }));
    meter.record(
      handlerEvent("t1", {
        cpuMs: 7,
        durationMs: 12,
        ok: false,
        errorName: "TimeoutError",
      }),
    );

    const usage = meter.usage("t1")!;
    expect(usage.requests).toBe(2);
    expect(usage.errors).toBe(1);
    expect(usage.cpuMs).toBe(12);
    expect(usage.durationMs).toBe(22);
  });

  test("rolls up process events: spawns + hibernation", () => {
    const meter = createMeter({ clock: tick() });
    meter.record(processEvent("t1", { durationMs: 120, transition: "spawn" }));
    meter.record(
      processEvent("t1", {
        hibernationGbSeconds: 0.25,
        transition: "idle-kill",
      }),
    );
    meter.record(
      processEvent("t1", {
        hibernationGbSeconds: 0.5,
        transition: "lru-evict",
      }),
    );

    const usage = meter.usage("t1")!;
    expect(usage.spawns).toBe(1);
    expect(usage.hibernationGbSeconds).toBe(0.75);
    expect(usage.requests).toBe(0);
  });

  test("fans out to sinks; one broken sink does not block the others", () => {
    const seenA: MeterEvent[] = [];
    const seenB: MeterEvent[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        () => {
          throw new Error("boom");
        },
        (event) => {
          seenA.push(event);
        },
        (event) => {
          seenB.push(event);
        },
      ],
    });

    meter.record(handlerEvent("t1", { cpuMs: 5, durationMs: 10 }));
    meter.record(handlerEvent("t2", { cpuMs: 3, durationMs: 4 }));

    expect(seenA).toHaveLength(2);
    expect(seenB).toHaveLength(2);
    expect(seenA[0]!.tenant).toBe("t1");
    expect(seenB[1]!.tenant).toBe("t2");
  });

  test("stamps `at` on the fanned-out event when caller omits it", () => {
    const seen: MeterEvent[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        (event) => {
          seen.push(event);
        },
      ],
    });
    meter.record(handlerEvent("t1", { cpuMs: 1, durationMs: 1 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.at).toBeGreaterThan(0);
  });

  test("budget breach trips circuit; allow() flips; onBreach fires once", () => {
    const breaches: string[] = [];
    const meter = createMeter({
      budgets: { t1: { cpuMs: 10 } },
      clock: tick(),
      onBreach: (b) => {
        breaches.push(`${b.tenant}:${b.dimension}:${b.observed}>=${b.limit}`);
      },
    });

    expect(meter.allow("t1")).toBe(true);
    meter.record(handlerEvent("t1", { cpuMs: 4, durationMs: 5 }));
    expect(meter.allow("t1")).toBe(true);

    meter.record(handlerEvent("t1", { cpuMs: 7, durationMs: 5 }));
    expect(meter.allow("t1")).toBe(false);
    expect(meter.tripped("t1")).toBe(true);
    expect(breaches).toEqual(["t1:cpuMs:11>=10"]);

    // Subsequent events keep accumulating (the bill keeps growing) but onBreach does NOT re-fire.
    meter.record(handlerEvent("t1", { cpuMs: 50, durationMs: 5 }));
    expect(meter.usage("t1")!.cpuMs).toBe(61);
    expect(breaches).toHaveLength(1);
  });

  test("default budget under `*` applies when there is no per-tenant entry", () => {
    const meter = createMeter({
      budgets: { "*": { requests: 2 } },
      clock: tick(),
    });
    meter.record(handlerEvent("newcomer", { cpuMs: 1, durationMs: 1 }));
    expect(meter.allow("newcomer")).toBe(true);
    meter.record(handlerEvent("newcomer", { cpuMs: 1, durationMs: 1 }));
    expect(meter.allow("newcomer")).toBe(false);
  });

  test("reset clears the breaker without dropping accumulated usage", () => {
    const meter = createMeter({
      budgets: { t1: { cpuMs: 5 } },
      clock: tick(),
    });
    meter.record(handlerEvent("t1", { cpuMs: 6, durationMs: 1 }));
    expect(meter.allow("t1")).toBe(false);
    expect(meter.usage("t1")!.cpuMs).toBe(6);

    meter.reset("t1");
    expect(meter.allow("t1")).toBe(true);
    expect(meter.tripped("t1")).toBe(false);
    expect(meter.usage("t1")!.cpuMs).toBe(6);
  });

  test("clear zeros usage AND clears the breaker", () => {
    const meter = createMeter({
      budgets: { t1: { cpuMs: 5 } },
      clock: tick(),
    });
    meter.record(handlerEvent("t1", { cpuMs: 6, durationMs: 1 }));
    expect(meter.tripped("t1")).toBe(true);
    meter.clear("t1");
    expect(meter.usage("t1")).toBeNull();
    expect(meter.tripped("t1")).toBe(false);
  });

  test("tenants() returns every tenant that has been recorded", () => {
    const meter = createMeter({ clock: tick() });
    meter.record(handlerEvent("a", { cpuMs: 1, durationMs: 1 }));
    meter.record(processEvent("b", { transition: "spawn" }));
    expect(new Set(meter.tenants())).toEqual(new Set(["a", "b"]));
  });

  test("budget() returns the active budget for a tenant", () => {
    const meter = createMeter({
      budgets: { "*": { requests: 1000 }, t1: { cpuMs: 99 } },
      clock: tick(),
    });
    expect(meter.budget("t1")).toEqual({ cpuMs: 99 });
    expect(meter.budget("elsewhere")).toEqual({ requests: 1000 });
  });

  test("dispose silences further records", async () => {
    const seen: MeterEvent[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        (event) => {
          seen.push(event);
        },
      ],
    });
    meter.record(handlerEvent("t1", { cpuMs: 1, durationMs: 1 }));
    await meter.dispose();
    meter.record(handlerEvent("t1", { cpuMs: 5, durationMs: 5 }));
    expect(seen).toHaveLength(1);
  });

  test("async sink rejection does not crash the recorder", async () => {
    const meter = createMeter({
      clock: tick(),
      sinks: [() => Promise.reject(new Error("async fail"))],
    });
    meter.record(handlerEvent("t1", { cpuMs: 1, durationMs: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(meter.usage("t1")!.requests).toBe(1);
  });
});

// ─── 0.1.0 surface ───────────────────────────────────────────────────────────

describe("observation events (runtime 0.1.0 shape)", () => {
  test("first observation establishes baseline; subsequent ones charge the delta", () => {
    const clock = tick();
    const meter = createMeter({ clock });
    meter.record({
      at: 1000,
      cpuMs: 100,
      rssBytes: 50_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.usage("t1")!.processCpuMs).toBe(100);

    meter.record({
      at: 2000,
      cpuMs: 250,
      rssBytes: 80_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.usage("t1")!.processCpuMs).toBe(250); // 100 baseline + 150 delta

    meter.record({
      at: 3000,
      cpuMs: 1000,
      rssBytes: 80_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.usage("t1")!.processCpuMs).toBe(1000);
  });

  test("process spawn resets the cumulative-cpu baseline", () => {
    const clock = tick();
    const meter = createMeter({ clock });
    meter.record({
      at: 1000,
      cpuMs: 500,
      rssBytes: 100_000_000,
      tenant: "t1",
      type: "observation",
    });
    meter.record({
      at: 1500,
      cpuMs: 800,
      rssBytes: 100_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.usage("t1")!.processCpuMs).toBe(800);

    // Tenant process exited + new one spawned.
    meter.record({
      at: 2000,
      tenant: "t1",
      transition: "exit",
      type: "process",
    });
    meter.record({
      at: 2100,
      tenant: "t1",
      transition: "spawn",
      type: "process",
    });
    // Fresh observation: 200ms cpu since the new spawn — should add 200, not double-count.
    meter.record({
      at: 2500,
      cpuMs: 200,
      rssBytes: 60_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.usage("t1")!.processCpuMs).toBe(800 + 200);
  });

  test("adoption resets CPU baseline without charging another spawn", () => {
    const meter = createMeter({ clock: tick() });
    meter.record({
      at: 1000,
      tenant: "t1",
      transition: "spawn",
      type: "process",
    });
    meter.record({
      at: 1500,
      cpuMs: 800,
      rssBytes: 100_000_000,
      tenant: "t1",
      type: "observation",
    });
    meter.record({
      at: 2000,
      tenant: "t1",
      transition: "adopt",
      type: "process",
    });
    meter.record({
      at: 2500,
      cpuMs: 1000,
      rssBytes: 100_000_000,
      tenant: "t1",
      type: "observation",
    });

    expect(meter.usage("t1")!.processCpuMs).toBe(1800);
    expect(meter.usage("t1")!.spawns).toBe(1);
  });

  test("processRssBytesPeak tracks the high-water mark", () => {
    const meter = createMeter({ clock: tick() });
    meter.record({
      at: 1,
      cpuMs: 0,
      rssBytes: 100_000_000,
      tenant: "t1",
      type: "observation",
    });
    meter.record({
      at: 2,
      cpuMs: 5,
      rssBytes: 400_000_000,
      tenant: "t1",
      type: "observation",
    });
    meter.record({
      at: 3,
      cpuMs: 10,
      rssBytes: 200_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.usage("t1")!.processRssBytesPeak).toBe(400_000_000);
  });

  test("processCpuMs is a separately-billable cumulative budget dimension", () => {
    const breaches: BreachReason[] = [];
    const meter = createMeter({
      budgets: { t1: { processCpuMs: 1000 } },
      clock: tick(),
      onBreach: (event) => {
        breaches.push(event);
      },
    });
    meter.record({
      at: 1,
      cpuMs: 500,
      rssBytes: 0,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.allow("t1")).toBe(true);
    meter.record({
      at: 2,
      cpuMs: 1500,
      rssBytes: 0,
      tenant: "t1",
      type: "observation",
    });
    expect(meter.allow("t1")).toBe(false);
    expect(breaches[0]!.dimension).toBe("processCpuMs");
  });
});

describe("rolling-window budgets", () => {
  test("trips when rolling sum crosses the limit, re-closes as events fall out", () => {
    let now = 1_000_000;
    const meter = createMeter({
      clock: () => now,
      rollingBudgets: {
        t1: [{ dimension: "errors", limit: 3, windowMs: 1000 }],
      },
    });
    const err = (): MeterEvent => ({
      at: now,
      cpuMs: 1,
      durationMs: 1,
      ok: false,
      tenant: "t1",
      type: "handler",
    });

    meter.record(err());
    meter.record(err());
    expect(meter.allow("t1")).toBe(true);
    expect(meter.rollingSum("t1", "errors", 1000)).toBe(2);

    meter.record(err());
    expect(meter.allow("t1")).toBe(false);
    expect(meter.rollingSum("t1", "errors", 1000)).toBe(3);

    // Advance past the window so old errors fall out — breaker re-closes automatically.
    now += 1100;
    expect(meter.allow("t1")).toBe(true);
    expect(meter.rollingSum("t1", "errors", 1000)).toBe(0);
  });

  test("default wildcard applies when no per-tenant rolling rule exists", () => {
    let now = 1_000_000;
    const meter = createMeter({
      clock: () => now,
      rollingBudgets: {
        "*": [{ dimension: "requests", limit: 2, windowMs: 5000 }],
      },
    });
    const req = (): MeterEvent => ({
      at: now,
      cpuMs: 0,
      durationMs: 0,
      ok: true,
      tenant: "newcomer",
      type: "handler",
    });
    meter.record(req());
    expect(meter.allow("newcomer")).toBe(true);
    meter.record(req());
    expect(meter.allow("newcomer")).toBe(false);
  });

  test("rolling cpuMs aggregates per-handler cpu", () => {
    let now = 1_000_000;
    const meter = createMeter({
      clock: () => now,
      rollingBudgets: {
        t1: [{ dimension: "cpuMs", limit: 500, windowMs: 60_000 }],
      },
    });
    const h = (cpu: number): MeterEvent => ({
      at: now,
      cpuMs: cpu,
      durationMs: cpu,
      ok: true,
      tenant: "t1",
      type: "handler",
    });
    meter.record(h(200));
    meter.record(h(200));
    expect(meter.allow("t1")).toBe(true);
    meter.record(h(150));
    expect(meter.allow("t1")).toBe(false);
    expect(meter.rollingSum("t1", "cpuMs", 60_000)).toBe(550);
  });

  test("rollingFor returns the active rules for a tenant", () => {
    const rules: RollingBudget[] = [
      { dimension: "errors", limit: 5, windowMs: 60_000 },
      { dimension: "requests", limit: 100, windowMs: 60_000 },
    ];
    const meter = createMeter({ clock: tick(), rollingBudgets: { t1: rules } });
    expect(meter.rollingFor("t1")).toEqual(rules);
  });
});

describe("flushable sinks", () => {
  test("object-shaped sink with ingest receives every event", () => {
    const seen: MeterEvent[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        {
          ingest: (event) => {
            seen.push(event);
          },
        },
      ],
    });
    meter.record({
      at: 1,
      cpuMs: 1,
      durationMs: 1,
      ok: true,
      tenant: "t1",
      type: "handler",
    });
    expect(seen).toHaveLength(1);
  });

  test("dispose awaits flush then close in order, per sink", async () => {
    const order: string[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        {
          close: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push("a:close");
          },
          flush: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push("a:flush");
          },
          ingest: () => {},
        },
        {
          close: async () => {
            order.push("b:close");
          },
          flush: async () => {
            order.push("b:flush");
          },
          ingest: () => {},
        },
      ],
    });
    await meter.dispose();
    // All flushes complete before any close starts.
    expect(order).toEqual(["a:flush", "b:flush", "a:close", "b:close"]);
  });

  test("a throwing flush does not stop later sinks from flushing", async () => {
    const closed: string[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        {
          flush: async () => {
            throw new Error("boom");
          },
          ingest: () => {},
        },
        {
          close: async () => {
            closed.push("b");
          },
          flush: async () => {
            closed.push("b-flushed");
          },
          ingest: () => {},
        },
      ],
    });
    await meter.dispose();
    expect(closed).toEqual(["b-flushed", "b"]);
  });

  test("function-shaped sinks still work alongside object-shaped ones", () => {
    const fnSeen: MeterEvent[] = [];
    const objSeen: MeterEvent[] = [];
    const meter = createMeter({
      clock: tick(),
      sinks: [
        (event) => {
          fnSeen.push(event);
        },
        {
          ingest: (event) => {
            objSeen.push(event);
          },
        },
      ],
    });
    meter.record({
      at: 1,
      cpuMs: 1,
      durationMs: 1,
      ok: true,
      tenant: "t1",
      type: "handler",
    });
    expect(fnSeen).toHaveLength(1);
    expect(objSeen).toHaveLength(1);
  });
});

describe("snapshot + restore", () => {
  test("snapshot serializes; a fresh meter restored from it picks up where the old one left off", () => {
    let now = 1_000_000;
    const meter = createMeter({
      budgets: { t1: { requests: 10 } },
      clock: () => now,
      rollingBudgets: {
        t1: [{ dimension: "errors", limit: 5, windowMs: 60_000 }],
      },
    });
    meter.record({
      at: now,
      cpuMs: 5,
      durationMs: 10,
      ok: true,
      tenant: "t1",
      type: "handler",
    });
    meter.record({
      at: now,
      cpuMs: 7,
      durationMs: 12,
      ok: false,
      tenant: "t1",
      type: "handler",
    });
    meter.record({
      at: now,
      cpuMs: 200,
      rssBytes: 100_000_000,
      tenant: "t1",
      type: "observation",
    });

    const snap = meter.snapshot();
    expect(snap.version).toBe(1);

    const json = JSON.parse(JSON.stringify(snap));
    const next = createMeter({
      budgets: { t1: { requests: 10 } },
      clock: () => now,
      rollingBudgets: {
        t1: [{ dimension: "errors", limit: 5, windowMs: 60_000 }],
      },
    });
    next.restore(json);

    const u = next.usage("t1")!;
    expect(u.requests).toBe(2);
    expect(u.errors).toBe(1);
    expect(u.cpuMs).toBe(12);
    expect(u.processCpuMs).toBe(200);
    // Rolling state survives too.
    expect(next.rollingSum("t1", "errors", 60_000)).toBe(1);

    // And subsequent observations charge a delta from where we left off.
    next.record({
      at: now + 100,
      cpuMs: 500,
      rssBytes: 110_000_000,
      tenant: "t1",
      type: "observation",
    });
    expect(next.usage("t1")!.processCpuMs).toBe(500);
  });

  test("restore replaces all current state", () => {
    const meter = createMeter({ clock: tick() });
    meter.record({
      at: 1,
      cpuMs: 1,
      durationMs: 1,
      ok: true,
      tenant: "old-tenant",
      type: "handler",
    });
    expect(meter.tenants()).toContain("old-tenant");

    meter.restore({ at: 0, tenants: [], version: 1 });
    expect(meter.tenants()).toEqual([]);
    expect(meter.usage("old-tenant")).toBeNull();
  });
});

describe("breaker re-closes on rolling-budget drain", () => {
  test("a cumulative trip stays tripped; a rolling-only trip auto-clears", () => {
    let now = 1_000_000;
    const meter = createMeter({
      budgets: { cumtenant: { requests: 2 } },
      clock: () => now,
      rollingBudgets: {
        rollingtenant: [{ dimension: "requests", limit: 2, windowMs: 1000 }],
      },
    });
    const req = (tenant: string): MeterEvent => ({
      at: now,
      cpuMs: 0,
      durationMs: 0,
      ok: true,
      tenant,
      type: "handler",
    });

    // Cumulative tenant: trips and stays tripped.
    meter.record(req("cumtenant"));
    meter.record(req("cumtenant"));
    expect(meter.allow("cumtenant")).toBe(false);
    now += 5000;
    expect(meter.allow("cumtenant")).toBe(false);

    // Rolling tenant: trips and re-closes once window drains.
    meter.record(req("rollingtenant"));
    now += 10;
    meter.record(req("rollingtenant"));
    expect(meter.allow("rollingtenant")).toBe(false);
    now += 2000;
    expect(meter.allow("rollingtenant")).toBe(true);
  });
});
