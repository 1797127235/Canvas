import { beforeEach, expect, test } from "bun:test";

// bun 没有 window.localStorage，zustand persist 默认的 createJSONStorage(() => window.localStorage)
// 会失败并刷警告。先装内存实现再动态 import store，否则 ESM 的 import 提升会让 store 在 stub 之前初始化。
const memory = new Map<string, string>();
const localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
};
Object.assign(globalThis, { window: { localStorage }, localStorage });

const { useAgentPermissionStore } = await import("../src/stores/use-agent-permission-store");

// 工具的 available 直接由 overrides 推导，这里把「以后都拒绝」的存储语义锁住：
// 写入 never 后该工具必须从模型工具列表消失，且重置能恢复。
const available = (tool: string) => useAgentPermissionStore.getState().overrides[tool] !== "never";

beforeEach(() => useAgentPermissionStore.getState().reset());

test("permanently denying a tool hides it from the agent", () => {
    expect(available("delete_nodes")).toBe(true);

    useAgentPermissionStore.getState().setOverride("delete_nodes", "never");

    expect(useAgentPermissionStore.getState().overrides.delete_nodes).toBe("never");
    expect(available("delete_nodes")).toBe(false);
    // 只影响这一个工具，其他工具照常可用。
    expect(available("update_node")).toBe(true);
});

test("always-allow and deny are independent per tool", () => {
    const store = useAgentPermissionStore.getState();
    store.setOverride("update_node", "always");
    store.setOverride("delete_nodes", "never");

    expect(available("update_node")).toBe(true);
    expect(available("delete_nodes")).toBe(false);
});

test("reset clears permanent overrides and restores the default mode", () => {
    const store = useAgentPermissionStore.getState();
    store.setMode("auto");
    store.setOverride("delete_nodes", "never");

    store.reset();

    expect(useAgentPermissionStore.getState().mode).toBe("ask");
    expect(available("delete_nodes")).toBe(true);
});

test("a session allowance is not a permanent override", () => {
    useAgentPermissionStore.getState().allowForSession("delete_nodes");

    expect(useAgentPermissionStore.getState().sessionAllow.delete_nodes).toBe(true);
    // 本次会话放行不改变工具可见性，只让 spend 类跳过询问。
    expect(available("delete_nodes")).toBe(true);
    expect(useAgentPermissionStore.getState().overrides.delete_nodes).toBeUndefined();
});
