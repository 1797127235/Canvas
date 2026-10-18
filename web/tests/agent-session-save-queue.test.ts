import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";

import { createSessionSaveQueue } from "../src/lib/agent/session-save-queue";

const message = (content: string) => [{ id: "user-1", role: "user", content }] as Message[];

describe("session save queue", () => {
    test("serializes saves and uses the returned version for the next snapshot", async () => {
        const calls: Array<{ version: number; messages: Message[] }> = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const queue = createSessionSaveQueue(async (_threadId, version, messages) => {
            calls.push({ version, messages });
            if (calls.length === 1) await gate;
            return { version: version + 1, title: "title" };
        }, () => undefined, async () => ({ version: 0, messages: [] }));
        queue.markSaved("thread", 0, []);

        const first = queue.flush("thread", message("one"));
        const second = queue.flush("thread", message("two"));
        await Promise.resolve();
        expect(calls).toHaveLength(1);
        release();
        await Promise.all([first, second]);
        expect(calls.map((call) => call.version)).toEqual([0, 1]);
        expect(calls.map((call) => call.messages[0].content)).toEqual(["one", "two"]);
    });

    test("serializes three concurrent snapshots, including waiters on the same save", async () => {
        const versions: number[] = [];
        const queue = createSessionSaveQueue(async (_id, version) => {
            versions.push(version);
            await new Promise((resolve) => setTimeout(resolve, 2));
            return { version: version + 1, title: "t" };
        }, () => undefined, async () => ({ version: 0, messages: [] }));
        queue.markSaved("t", 0, []);
        await Promise.all([queue.flush("t", message("1")), queue.flush("t", message("2")), queue.flush("t", message("3"))]);
        expect(versions).toEqual([0, 1, 2]);
    });

    test("keeps failed snapshots dirty and allows retry", async () => {
        let attempts = 0;
        const queue = createSessionSaveQueue(async (_threadId, version) => {
            attempts++;
            if (attempts === 1) throw new Error("temporary failure");
            return { version: version + 1, title: "title" };
        }, () => undefined, async () => ({ version: 0, messages: [] }));
        queue.markSaved("thread", 0, []);

        await expect(queue.flush("thread", message("unsaved"))).rejects.toThrow("temporary failure");
        expect(queue.isDirty("thread", message("unsaved"))).toBe(true);
        await queue.flush("thread", message("unsaved"));
        expect(queue.isDirty("thread", message("unsaved"))).toBe(false);
        expect(attempts).toBe(2);
    });

    test("recovers a committed save whose response was lost before saving newer content", async () => {
        let version = 0; let stored: Message[] = []; let writes = 0;
        const queue = createSessionSaveQueue(async (_id, expected, messages) => {
            expect(expected).toBe(version); stored = structuredClone(messages); version++; writes++;
            if (writes === 1) throw new TypeError("lost response");
            return { version, title: "t" };
        }, () => undefined, async () => ({ version, messages: stored }));
        queue.markSaved("t", 0, []);
        await expect(queue.flush("t", message("first"))).rejects.toThrow("lost response");
        await Promise.all([queue.flush("t", message("second")), queue.flush("t", message("third"))]);
        expect(version).toBe(3); expect(stored[0].content).toBe("third");
    });

    test("ambiguous save recovery rejects different remote content", async () => {
        let writes = 0;
        const queue = createSessionSaveQueue(async () => { writes++; throw new TypeError("lost response"); }, () => undefined, async () => ({ version: 2, messages: message("another tab") }));
        queue.markSaved("t", 0, []);
        await expect(queue.flush("t", message("local"))).rejects.toThrow();
        await expect(queue.flush("t", message("local"))).rejects.toThrow("冲突");
        expect(writes).toBe(1);
    });

    test("detects changed content even when the message count is unchanged", () => {
        const queue = createSessionSaveQueue(async () => ({ version: 1, title: "title" }), () => undefined, async () => ({ version: 0, messages: [] }));
        queue.markSaved("thread", 1, message("before"));
        expect(queue.isDirty("thread", message("after"))).toBe(true);
    });
});
