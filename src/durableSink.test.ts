import { describe, expect, test } from "bun:test";
import { createDurableSink } from "./durableSink";
import type { AIMeterEvent, MeterEvent } from "./index";

const aiEvent = (overrides: Partial<AIMeterEvent> = {}): AIMeterEvent => ({
  durationMs: 10,
  inputTokens: 100,
  ok: true,
  outputTokens: 20,
  tenant: "acme",
  type: "ai",
  ...overrides,
});

const collector = () => {
  const batches: MeterEvent[][] = [];

  return {
    batches,
    events: () => batches.flat(),
    write: (events: MeterEvent[]) => {
      batches.push(events);
    },
  };
};

describe("durable sink", () => {
  test("buffers until the batch size, then writes one batch", async () => {
    const sink = collector();
    const durable = createDurableSink({ batchSize: 3, write: sink.write });
    durable.ingest(aiEvent());
    durable.ingest(aiEvent());
    expect(sink.batches).toHaveLength(0);
    expect(durable.pending()).toBe(2);
    durable.ingest(aiEvent());
    await durable.flush();
    expect(sink.batches).toHaveLength(1);
    expect(sink.events()).toHaveLength(3);
  });

  test("flush writes a partial batch and empties the buffer", async () => {
    const sink = collector();
    const durable = createDurableSink({ batchSize: 100, write: sink.write });
    durable.ingest(aiEvent());
    await durable.flush();
    expect(sink.events()).toHaveLength(1);
    expect(durable.pending()).toBe(0);
  });

  test("flushing an empty buffer writes nothing", async () => {
    const sink = collector();
    const durable = createDurableSink({ write: sink.write });
    await durable.flush();
    expect(sink.batches).toHaveLength(0);
  });

  test("close flushes what is still buffered", async () => {
    const sink = collector();
    const durable = createDurableSink({ batchSize: 100, write: sink.write });
    durable.ingest(aiEvent());
    await durable.close();
    expect(sink.events()).toHaveLength(1);
  });

  test("ages out a small batch without waiting for it to fill", async () => {
    const sink = collector();
    const durable = createDurableSink({
      batchSize: 100,
      flushMs: 5,
      write: sink.write,
    });
    durable.ingest(aiEvent());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sink.events()).toHaveLength(1);
  });
});

describe("idempotency", () => {
  test("the same requestId is never written twice", async () => {
    const sink = collector();
    const durable = createDurableSink({ batchSize: 100, write: sink.write });
    durable.ingest(aiEvent({ requestId: "req-1" }));
    durable.ingest(aiEvent({ requestId: "req-1" }));
    durable.ingest(aiEvent({ requestId: "req-2" }));
    await durable.flush();
    expect(sink.events()).toHaveLength(2);
  });

  test("events without a requestId are all kept", async () => {
    const sink = collector();
    const durable = createDurableSink({ batchSize: 100, write: sink.write });
    durable.ingest(aiEvent());
    durable.ingest(aiEvent());
    await durable.flush();
    expect(sink.events()).toHaveLength(2);
  });

  test("dedup memory is bounded and evicts oldest first", async () => {
    const sink = collector();
    const durable = createDurableSink({
      batchSize: 1000,
      seenLimit: 2,
      write: sink.write,
    });
    durable.ingest(aiEvent({ requestId: "a" }));
    durable.ingest(aiEvent({ requestId: "b" }));
    durable.ingest(aiEvent({ requestId: "c" })); // evicts "a"
    durable.ingest(aiEvent({ requestId: "a" })); // no longer remembered
    await durable.flush();
    expect(sink.events()).toHaveLength(4);
  });
});

describe("failure handling", () => {
  test("a write failure is reported, never thrown at the caller", async () => {
    const failures: MeterEvent[][] = [];
    const durable = createDurableSink({
      batchSize: 1,
      onError: (_error, events) => failures.push(events),
      write: () => {
        throw new Error("database is down");
      },
    });
    expect(() => durable.ingest(aiEvent())).not.toThrow();
    await durable.flush();
    expect(failures).toHaveLength(1);
  });

  test("a failed batch does not block later writes", async () => {
    let attempt = 0;
    const written: MeterEvent[] = [];
    const durable = createDurableSink({
      batchSize: 1,
      onError: () => undefined,
      write: (events) => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
        written.push(...events);
      },
    });
    durable.ingest(aiEvent({ requestId: "one" }));
    await durable.flush();
    durable.ingest(aiEvent({ requestId: "two" }));
    await durable.flush();
    expect(written).toHaveLength(1);
  });

  test("an async rejection is handled the same way", async () => {
    let reported = false;
    const durable = createDurableSink({
      batchSize: 1,
      onError: () => {
        reported = true;
      },
      write: () => Promise.reject(new Error("timeout")),
    });
    durable.ingest(aiEvent());
    await durable.flush();
    expect(reported).toBe(true);
  });
});
