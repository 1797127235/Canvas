import { expect, test } from "bun:test";

import { publishAuthEvent, subscribeAuthEvents } from "../src/lib/auth-tab-sync";

test("broadcasts only auth events, ignores unknown messages and unsubscribes", async () => {
    const peer = new BroadcastChannel("infinite-canvas-auth");
    const received = new Promise<unknown>((resolve) => peer.addEventListener("message", (event) => resolve(event.data), { once: true }));
    publishAuthEvent("logout");
    expect(await received).toEqual({ type: "logout" });
    const seen: string[] = [];
    let receive!: () => void;
    const delivered = new Promise<void>((resolve) => { receive = resolve; });
    const unsubscribe = subscribeAuthEvents((type) => { seen.push(type); receive(); });
    peer.postMessage({ type: "unknown" });
    peer.postMessage({ type: "login" });
    await delivered;
    expect(seen).toEqual(["login"]);
    unsubscribe();
    peer.postMessage({ type: "logout" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["login"]);
    peer.close();
});
