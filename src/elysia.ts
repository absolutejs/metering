import { Elysia } from "elysia";
import type { WorkloadMeterReporter } from "./reporter";

type MeterContext = {
  path?: string;
  request: Request;
  route?: string;
  set?: { status?: number | string };
};

export type WorkloadMeterElysiaOptions = {
  exclude?: (context: MeterContext) => boolean | Promise<boolean>;
  reporter: WorkloadMeterReporter;
};

const statusCode = (value: number | string | undefined) => {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(value ?? "200", 10);

  return Number.isFinite(parsed) ? parsed : 200;
};

export const workloadMeterElysia = (options: WorkloadMeterElysiaOptions) => {
  const starts = new WeakMap<Request, number>();

  return new Elysia({ name: "@absolutejs/metering/elysia" })
    .onRequest(async (context) => {
      if (options.exclude && (await options.exclude(context))) return;
      starts.set(context.request, performance.now());
    })
    .onAfterResponse((context) => {
      const startedAt = starts.get(context.request);
      if (startedAt === undefined) return;
      starts.delete(context.request);
      const status = statusCode(context.set?.status);
      const url = new URL(context.request.url);
      options.reporter.record({
        durationMs: performance.now() - startedAt,
        kind: "request",
        method: context.request.method,
        name: context.route ?? context.path ?? url.pathname,
        ok: status < 500,
        statusCode: status,
      });
    })
    .as("global");
};
