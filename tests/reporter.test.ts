import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { workloadMeterElysia } from "../src/elysia";
import {
  createWorkloadMeterReporter,
  type WorkloadMeterWireEvent,
} from "../src/reporter";

type Delivery = { events: WorkloadMeterWireEvent[]; source_id: string };

describe("workload metering reporter", () => {
  test("batches ordered cursor-fenced handler and request events", async () => {
    const deliveries: Delivery[] = [];
    const reporter = createWorkloadMeterReporter({
      batchSize: 2,
      endpoint: "http://host/v1/workloads/project/meter-events",
      fetch: async (_input, init) => {
        deliveries.push(JSON.parse(String(init?.body)) as Delivery);

        return new Response(null, { status: 202 });
      },
      flushIntervalMs: 60_000,
      sourceId: "11111111-1111-4111-8111-111111111111",
      token: "project-scoped-token",
    });
    reporter.handlerMetrics({
      cpuMs: 3,
      durationMs: 5,
      mutationName: "createOrder",
      ok: true,
    });
    reporter.record({
      durationMs: 8,
      kind: "request",
      method: "GET",
      name: "/orders/:id",
      ok: false,
      statusCode: 500,
    });
    await reporter.flush();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.source_id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(deliveries[0]!.events.map((event) => event.cursor)).toEqual([1, 2]);
    expect(deliveries[0]!.events).toMatchObject([
      { cpu_ms: 3, kind: "handler", name: "createOrder", ok: true },
      {
        kind: "request",
        method: "GET",
        name: "/orders/:id",
        ok: false,
        status_code: 500,
      },
    ]);
    await reporter.dispose();
  });

  test("keeps a failed batch for an idempotent retry", async () => {
    const cursors: number[][] = [];
    let attempts = 0;
    const reporter = createWorkloadMeterReporter({
      endpoint: "http://host/v1/workloads/project/meter-events",
      fetch: async (_input, init) => {
        attempts += 1;
        const body = JSON.parse(String(init?.body)) as Delivery;
        cursors.push(body.events.map((event) => event.cursor));
        if (attempts === 1) return new Response(null, { status: 503 });

        return new Response(null, { status: 202 });
      },
      flushIntervalMs: 60_000,
      sourceId: "11111111-1111-4111-8111-111111111111",
      token: "project-scoped-token",
    });
    reporter.record({ durationMs: 1, kind: "request", name: "/", ok: true });
    await expect(reporter.flush()).rejects.toThrow("503");
    await reporter.flush();

    expect(cursors).toEqual([[1], [1]]);
    await reporter.dispose();
  });
});

describe("workload metering Elysia plugin", () => {
  test("reports route templates on success and error paths", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const reporter = {
      dispose: async () => undefined,
      flush: async () => undefined,
      handlerMetrics: () => undefined,
      record: (event: Record<string, unknown>) => recorded.push(event),
    };
    const app = new Elysia()
      .use(workloadMeterElysia({ reporter }))
      .get("/projects/:id", ({ params }) => params.id)
      .get("/failure", () => {
        throw new Error("boom");
      });

    expect(
      (await app.handle(new Request("http://localhost/projects/example")))
        .status,
    ).toBe(200);
    expect(
      (await app.handle(new Request("http://localhost/failure"))).status,
    ).toBe(500);
    await Bun.sleep(0);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      kind: "request",
      method: "GET",
      name: "/projects/:id",
      ok: true,
      statusCode: 200,
    });
    expect(recorded[1]).toMatchObject({
      kind: "request",
      name: "/failure",
      ok: false,
      statusCode: 500,
    });
  });
});
