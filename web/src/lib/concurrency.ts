// 批量生成的内存峰值与并发数成正比：每个槽位各自持有自己的参考素材副本，
// 一次发 15 个请求就会同时出现十几份 base64。这里统一限并发。
export const GENERATION_CONCURRENCY = 3;

// 固定数量的 worker 共享一个游标，依次领取下一个下标；返回顺序与 items 一致。
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    if (!items.length) return results;
    let cursor = 0;
    const run = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
    return results;
}

// 需要区分单个失败时用这个，返回值形状与 `Promise.allSettled` 一致。
export function mapWithConcurrencySettled<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
    return mapWithConcurrency(items, limit, async (item, index) => {
        try {
            return { status: "fulfilled", value: await worker(item, index) } as const;
        } catch (reason) {
            return { status: "rejected", reason } as const;
        }
    });
}
