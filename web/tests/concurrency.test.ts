import { expect, test } from "bun:test";

import { GENERATION_CONCURRENCY, mapWithConcurrency, mapWithConcurrencySettled } from "../src/lib/concurrency";

test("never runs more workers than the limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, index) => index);
    const results = await mapWithConcurrency(items, 3, async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return item * 2;
    });
    expect(peak).toBe(3);
    expect(results).toEqual(items.map((item) => item * 2));
});

test("keeps results in item order even when tasks finish out of order", async () => {
    const results = await mapWithConcurrency([30, 20, 10], 3, async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item));
        return item;
    });
    expect(results).toEqual([30, 20, 10]);
});

test("settled form reports each failure without rejecting the batch", async () => {
    const results = await mapWithConcurrencySettled([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
    });
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
});

test("empty input resolves immediately", async () => {
    expect(await mapWithConcurrency([], GENERATION_CONCURRENCY, async () => 1)).toEqual([]);
});
