import { describe, expect, test } from 'bun:test';
import { createMeter, type MeterEvent } from '../src';

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
): MeterEvent => ({
	cpuMs: 1,
	durationMs: 2,
	mutationName: 'doThing',
	ok: true,
	tenant,
	type: 'handler',
	...overrides,
} as MeterEvent);

const processEvent = (
	tenant: string,
	overrides: Partial<MeterEvent> = {},
): MeterEvent => ({
	tenant,
	transition: 'spawn',
	type: 'process',
	...overrides,
} as MeterEvent);

describe('createMeter', () => {
	test('rolls up handler events per tenant', () => {
		const meter = createMeter({ clock: tick() });
		meter.record(handlerEvent('t1', { bytesOut: 100, cpuMs: 5, durationMs: 10, heapBytes: 1000 }));
		meter.record(handlerEvent('t1', { bytesOut: 200, cpuMs: 15, durationMs: 20, heapBytes: 800 }));
		meter.record(handlerEvent('t2', { cpuMs: 3, durationMs: 4 }));

		const t1 = meter.usage('t1');
		expect(t1).not.toBeNull();
		expect(t1!.requests).toBe(2);
		expect(t1!.cpuMs).toBe(20);
		expect(t1!.durationMs).toBe(30);
		expect(t1!.bytesEgress).toBe(300);
		expect(t1!.heapBytesPeak).toBe(1000);
		expect(t1!.errors).toBe(0);

		const t2 = meter.usage('t2');
		expect(t2!.requests).toBe(1);
		expect(t2!.cpuMs).toBe(3);
	});

	test('counts errors and never undercounts the bill', () => {
		const meter = createMeter({ clock: tick() });
		meter.record(handlerEvent('t1', { cpuMs: 5, durationMs: 10, ok: true }));
		meter.record(handlerEvent('t1', { cpuMs: 7, durationMs: 12, ok: false, errorName: 'TimeoutError' }));

		const usage = meter.usage('t1')!;
		expect(usage.requests).toBe(2);
		expect(usage.errors).toBe(1);
		expect(usage.cpuMs).toBe(12);
		expect(usage.durationMs).toBe(22);
	});

	test('rolls up process events: spawns + hibernation', () => {
		const meter = createMeter({ clock: tick() });
		meter.record(processEvent('t1', { durationMs: 120, transition: 'spawn' }));
		meter.record(processEvent('t1', { hibernationGbSeconds: 0.25, transition: 'idle-kill' }));
		meter.record(processEvent('t1', { hibernationGbSeconds: 0.5, transition: 'lru-evict' }));

		const usage = meter.usage('t1')!;
		expect(usage.spawns).toBe(1);
		expect(usage.hibernationGbSeconds).toBe(0.75);
		expect(usage.requests).toBe(0);
	});

	test('fans out to sinks; one broken sink does not block the others', () => {
		const seenA: MeterEvent[] = [];
		const seenB: MeterEvent[] = [];
		const meter = createMeter({
			clock: tick(),
			sinks: [
				() => {
					throw new Error('boom');
				},
				(event) => {
					seenA.push(event);
				},
				(event) => {
					seenB.push(event);
				},
			],
		});

		meter.record(handlerEvent('t1', { cpuMs: 5, durationMs: 10 }));
		meter.record(handlerEvent('t2', { cpuMs: 3, durationMs: 4 }));

		expect(seenA).toHaveLength(2);
		expect(seenB).toHaveLength(2);
		expect(seenA[0]!.tenant).toBe('t1');
		expect(seenB[1]!.tenant).toBe('t2');
	});

	test('stamps `at` on the fanned-out event when caller omits it', () => {
		const seen: MeterEvent[] = [];
		const meter = createMeter({
			clock: tick(),
			sinks: [(event) => { seen.push(event); }],
		});
		meter.record(handlerEvent('t1', { cpuMs: 1, durationMs: 1 }));

		expect(seen).toHaveLength(1);
		expect(seen[0]!.at).toBeGreaterThan(0);
	});

	test('budget breach trips circuit; allow() flips; onBreach fires once', () => {
		const breaches: string[] = [];
		const meter = createMeter({
			budgets: { t1: { cpuMs: 10 } },
			clock: tick(),
			onBreach: (b) => {
				breaches.push(`${b.tenant}:${b.dimension}:${b.observed}>=${b.limit}`);
			},
		});

		expect(meter.allow('t1')).toBe(true);
		meter.record(handlerEvent('t1', { cpuMs: 4, durationMs: 5 }));
		expect(meter.allow('t1')).toBe(true);

		meter.record(handlerEvent('t1', { cpuMs: 7, durationMs: 5 }));
		expect(meter.allow('t1')).toBe(false);
		expect(meter.tripped('t1')).toBe(true);
		expect(breaches).toEqual(['t1:cpuMs:11>=10']);

		// Subsequent events keep accumulating (the bill keeps growing) but onBreach does NOT re-fire.
		meter.record(handlerEvent('t1', { cpuMs: 50, durationMs: 5 }));
		expect(meter.usage('t1')!.cpuMs).toBe(61);
		expect(breaches).toHaveLength(1);
	});

	test('default budget under `*` applies when there is no per-tenant entry', () => {
		const meter = createMeter({
			budgets: { '*': { requests: 2 } },
			clock: tick(),
		});
		meter.record(handlerEvent('newcomer', { cpuMs: 1, durationMs: 1 }));
		expect(meter.allow('newcomer')).toBe(true);
		meter.record(handlerEvent('newcomer', { cpuMs: 1, durationMs: 1 }));
		expect(meter.allow('newcomer')).toBe(false);
	});

	test('reset clears the breaker without dropping accumulated usage', () => {
		const meter = createMeter({
			budgets: { t1: { cpuMs: 5 } },
			clock: tick(),
		});
		meter.record(handlerEvent('t1', { cpuMs: 6, durationMs: 1 }));
		expect(meter.allow('t1')).toBe(false);
		expect(meter.usage('t1')!.cpuMs).toBe(6);

		meter.reset('t1');
		expect(meter.allow('t1')).toBe(true);
		expect(meter.tripped('t1')).toBe(false);
		expect(meter.usage('t1')!.cpuMs).toBe(6);
	});

	test('clear zeros usage AND clears the breaker', () => {
		const meter = createMeter({
			budgets: { t1: { cpuMs: 5 } },
			clock: tick(),
		});
		meter.record(handlerEvent('t1', { cpuMs: 6, durationMs: 1 }));
		expect(meter.tripped('t1')).toBe(true);
		meter.clear('t1');
		expect(meter.usage('t1')).toBeNull();
		expect(meter.tripped('t1')).toBe(false);
	});

	test('tenants() returns every tenant that has been recorded', () => {
		const meter = createMeter({ clock: tick() });
		meter.record(handlerEvent('a', { cpuMs: 1, durationMs: 1 }));
		meter.record(processEvent('b', { transition: 'spawn' }));
		expect(new Set(meter.tenants())).toEqual(new Set(['a', 'b']));
	});

	test('budget() returns the active budget for a tenant', () => {
		const meter = createMeter({
			budgets: { '*': { requests: 1000 }, t1: { cpuMs: 99 } },
			clock: tick(),
		});
		expect(meter.budget('t1')).toEqual({ cpuMs: 99 });
		expect(meter.budget('elsewhere')).toEqual({ requests: 1000 });
	});

	test('dispose silences further records', async () => {
		const seen: MeterEvent[] = [];
		const meter = createMeter({
			clock: tick(),
			sinks: [(event) => { seen.push(event); }],
		});
		meter.record(handlerEvent('t1', { cpuMs: 1, durationMs: 1 }));
		await meter.dispose();
		meter.record(handlerEvent('t1', { cpuMs: 5, durationMs: 5 }));
		expect(seen).toHaveLength(1);
	});

	test('async sink rejection does not crash the recorder', async () => {
		const meter = createMeter({
			clock: tick(),
			sinks: [() => Promise.reject(new Error('async fail'))],
		});
		meter.record(handlerEvent('t1', { cpuMs: 1, durationMs: 1 }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(meter.usage('t1')!.requests).toBe(1);
	});
});
