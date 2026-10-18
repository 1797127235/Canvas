import type { Message } from "@ag-ui/client";

export type SaveThread = (threadId: string, version: number, messages: Message[]) => Promise<{ version: number; title: string }>;
export type LoadThread = (threadId: string) => Promise<{ version: number; messages: Message[]; title?: string }>;
type AmbiguousWrite = { previous: string; attempted: string };

export function createSessionSaveQueue(save: SaveThread, onSaved: (threadId: string, result: { version: number; title: string }) => void, load: LoadThread) {
    const versions = new Map<string, number>();
    const savedSnapshots = new Map<string, string>();
    const pending = new Map<string, Promise<void>>();
    const ambiguous = new Map<string, AmbiguousWrite>();
    const blocked = new Set<string>();
    const snapshotOf = (messages: Message[]) => JSON.stringify(messages, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    const markSaved = (threadId: string, version: number, messages: Message[]) => {
        versions.set(threadId, version);
        savedSnapshots.set(threadId, snapshotOf(messages));
        ambiguous.delete(threadId);
        blocked.delete(threadId);
    };
    const recover = async (threadId: string) => {
        const write = ambiguous.get(threadId);
        if (!write) return;
        const remote = await load(threadId);
        const remoteSnapshot = snapshotOf(remote.messages);
        if (remoteSnapshot === write.attempted || remoteSnapshot === write.previous) {
            markSaved(threadId, remote.version, remote.messages);
            onSaved(threadId, { version: remote.version, title: remote.title ?? "" });
            return;
        }
        blocked.add(threadId);
        throw new Error("对话发生冲突，本地消息已保留，请重新确认会话");
    };

    return {
        suspend(threadId: string) { blocked.add(threadId); },
        version(threadId: string) {
            const version = versions.get(threadId);
            if (version === undefined) throw new Error("会话版本尚未初始化");
            return version;
        },
        markSaved,
        isDirty(threadId: string, messages: Message[]) { return savedSnapshots.get(threadId) !== snapshotOf(messages); },
        flush(threadId: string, messages: Message[]) {
            const snapshot = snapshotOf(messages);
            const frozen = structuredClone(messages);
            const task = Promise.resolve(pending.get(threadId)).then(async () => {
                if (ambiguous.has(threadId)) await recover(threadId);
                if (blocked.has(threadId)) throw new Error("会话版本待确认，本地消息已保留，请重试发送");
                if (savedSnapshots.get(threadId) === snapshot) return;
                const version = versions.get(threadId);
                if (version === undefined) throw new Error("会话版本尚未初始化");
                const previous = savedSnapshots.get(threadId) ?? "[]";
                try {
                    const result = await save(threadId, version, frozen);
                    markSaved(threadId, result.version, frozen);
                    onSaved(threadId, result);
                } catch (error) {
                    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
                    if (!status || status === 429 || status >= 500) ambiguous.set(threadId, { previous, attempted: snapshot });
                    throw error;
                }
            }).finally(() => { if (pending.get(threadId) === task) pending.delete(threadId); });
            pending.set(threadId, task);
            return task;
        },
    };
}
