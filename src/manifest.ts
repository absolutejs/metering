import {
	defineImplementation,
	defineManifest,
	toolFactory,
} from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { Meter, MeterOptions } from './index';

const tool = toolFactory<Meter>();

/* Serializable subset of MeterOptions: budgets + rollingBudgets. `sinks` is
 * instance-valued → the sink slot; `onBreach` and `clock` are function-valued
 * → wiring concerns, never settings. */
const budgetSchema = Type.Object(
	{
		bytesEgress: Type.Optional(
			Type.Number({
				description:
					'Total bytes the tenant may send back to callers before the breaker trips.',
				minimum: 0,
				title: 'Bytes-egress limit',
			}),
		),
		cpuMs: Type.Optional(
			Type.Number({
				description:
					'Total sandbox CPU milliseconds the tenant may consume before the breaker trips.',
				minimum: 0,
				title: 'Sandbox CPU limit (ms)',
			}),
		),
		errors: Type.Optional(
			Type.Number({
				description:
					'Total failed calls the tenant may accumulate before the breaker trips.',
				minimum: 0,
				title: 'Error limit',
			}),
		),
		hibernationGbSeconds: Type.Optional(
			Type.Number({
				description:
					'Total hibernation footprint (GB-seconds) the tenant may accumulate before the breaker trips.',
				minimum: 0,
				title: 'Hibernation limit (GB-seconds)',
			}),
		),
		processCpuMs: Type.Optional(
			Type.Number({
				description:
					'Total host-process CPU milliseconds (from periodic observations) the tenant may consume before the breaker trips.',
				minimum: 0,
				title: 'Process CPU limit (ms)',
			}),
		),
		requests: Type.Optional(
			Type.Number({
				description:
					'Total calls the tenant may make before the breaker trips.',
				minimum: 0,
				title: 'Request limit',
			}),
		),
	},
	{ title: 'Budget' },
);

const rollingBudgetSchema = Type.Object(
	{
		dimension: Type.Union(
			[
				Type.Literal('requests'),
				Type.Literal('errors'),
				Type.Literal('cpuMs'),
				Type.Literal('bytesEgress'),
			],
			{
				description: 'Which metered quantity this window limits.',
				title: 'Dimension',
			},
		),
		limit: Type.Number({
			description:
				'The breaker trips when the rolling sum in the window reaches this value.',
			exclusiveMinimum: 0,
			title: 'Limit',
		}),
		windowMs: Type.Integer({
			description:
				'Length of the sliding window in milliseconds (e.g. 60000 = last minute).',
			minimum: 1,
			title: 'Window (ms)',
		}),
	},
	{ title: 'Rolling budget' },
);

export const manifest = defineManifest<MeterOptions, Meter>()({
	contract: 1,
	identity: {
		accent: '#8b5cf6',
		category: 'infrastructure',
		description:
			'Per-tenant cost attribution and budget enforcement for multi-tenant runtimes. One meter ingests handler, process-lifecycle, and CPU/RSS-observation events; rolls up requests, errors, CPU-ms, bytes egress, and hibernation GB-seconds per tenant; and trips a circuit breaker when a cumulative or sliding-window budget is exceeded. Snapshot/restore survives shard restarts; flushable sinks feed batched exporters.',
		docsUrl: 'https://github.com/absolutejs/metering',
		name: '@absolutejs/metering',
		tagline: "Track each customer's usage and stop runaway spend.",
	},
	implements: [
		defineImplementation<Record<never, never>>()({
			contract: 'metering/sink',
			factory: 'consoleSink',
			from: '@absolutejs/metering',
			title: 'Server console',
			wiring: {
				code: 'consoleSink',
				imports: [
					{ from: '@absolutejs/metering', names: ['consoleSink'] },
				],
			},
		}),
	],
	settings: Type.Object({
		budgets: Type.Optional(
			Type.Record(Type.String(), budgetSchema, {
				description:
					'Cumulative limits per tenant, keyed by tenant id — use "*" as the default for every tenant. Once a limit is hit, the tenant\'s breaker trips and stays tripped until reset.',
				title: 'Tenant budgets',
			}),
		),
		rollingBudgets: Type.Optional(
			Type.Record(Type.String(), Type.Array(rollingBudgetSchema), {
				description:
					'Sliding-window limits per tenant, keyed by tenant id ("*" = default). The breaker re-closes on its own as old events fall out of the window.',
				title: 'Rolling-window budgets',
			}),
		),
	}),
	slots: {
		sink: {
			configPath: 'sinks',
			contract: 'metering/sink',
			description: 'Where your usage events are exported',
			known: ['@absolutejs/metering#console'],
		},
	},
	tools: {
		budget_status: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				"One tenant's budget position: configured cumulative and rolling budgets, current usage, and whether the circuit breaker is tripped.",
			handler: ({ tenant }, meter) =>
				JSON.stringify({
					budget: meter.budget(tenant),
					rollingBudgets: meter.rollingFor(tenant),
					tripped: meter.tripped(tenant),
					usage: meter.usage(tenant),
				}),
			input: Type.Object({
				tenant: Type.String({ minLength: 1 }),
			}),
		}),
		list_tenants: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'List every tenant id that has recorded usage since the meter started (or since its last restore).',
			handler: (_input, meter) => {
				const tenants = meter.tenants();

				return tenants.length === 0
					? 'no tenants have recorded usage'
					: JSON.stringify(tenants);
			},
			input: Type.Object({}),
		}),
		reset_breaker: tool.runtime({
			annotations: { idempotentHint: true },
			description:
				"Re-close a tripped tenant's circuit breaker so its traffic is allowed again. Usage totals are kept — the breaker re-trips on the next recorded event if a cumulative budget is still exceeded.",
			handler: ({ tenant }, meter) => {
				meter.reset(tenant);

				return `breaker reset for tenant "${tenant}"`;
			},
			input: Type.Object({
				tenant: Type.String({ minLength: 1 }),
			}),
		}),
		tenant_usage: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				"One tenant's usage roll-up: requests, errors, sandbox and process CPU-ms, bytes egress, hibernation GB-seconds, peak heap/RSS, and spawn count.",
			handler: ({ tenant }, meter) => {
				const usage = meter.usage(tenant);

				return usage === null
					? `no usage recorded for tenant "${tenant}"`
					: JSON.stringify(usage);
			},
			input: Type.Object({
				tenant: Type.String({ minLength: 1 }),
			}),
		}),
	},
	wiring: [
		{
			description:
				'Feed it handler/process/observation events with meter.record(...) and gate tenant traffic with meter.allow(tenant). Wire an onBreach callback in code for breach alerts.',
			id: 'default',
			server: {
				code: 'const meter = createMeter({ sinks: [${slot.sink}], ...${settings} });',
				imports: [{ from: '@absolutejs/metering', names: ['createMeter'] }],
				placement: 'module-scope',
			},
			title: 'Create the meter',
		},
	],
});
