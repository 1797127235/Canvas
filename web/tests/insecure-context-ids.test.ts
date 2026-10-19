import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { randomUuid } from "../src/lib/utils";

// 线上站点是明文 http（非安全上下文），`crypto.randomUUID` 在那里是 undefined，调用直接抛异常。
// 助手面板曾经在 addMessage 前调用它，抛错后发送锁没复位，整个面板永久停在「发送中」。
test("frontend sources generate ids without crypto.randomUUID", () => {
    const offenders: string[] = [];
    const walk = (dir: URL) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
            if (entry.isDirectory()) walk(child);
            else if (/\.tsx?$/.test(entry.name) && /crypto\.randomUUID\s*\(/.test(readFileSync(child, "utf8"))) offenders.push(child.pathname);
        }
    };
    walk(new URL("../src/", import.meta.url));
    expect(offenders).toEqual([]);
});

test("randomUuid still works when the secure-context API is missing", () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
        expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
        if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    }
});
