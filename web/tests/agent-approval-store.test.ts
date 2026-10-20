import { expect, test } from "bun:test";

import { cancelPendingApprovals, requestApproval, useAgentApprovalStore } from "../src/stores/use-agent-approval-store";

const queue = () => useAgentApprovalStore.getState().queue;

test("a decision settles the promise and removes the card", async () => {
    const settled = requestApproval({ tool: "update_node", risk: "write", summary: "改标题" });
    expect(queue()).toHaveLength(1);

    useAgentApprovalStore.getState().decide(queue()[0].id, "deny");

    expect(await settled).toBe("deny");
    expect(queue()).toHaveLength(0);
});

test("cancelling settles every pending approval instead of leaving it hanging", async () => {
    const first = requestApproval({ tool: "update_node", risk: "write", summary: "a" });
    const second = requestApproval({ tool: "delete_nodes", risk: "write", summary: "b" });

    cancelPendingApprovals();

    expect(await first).toBe("cancel");
    expect(await second).toBe("cancel");
    expect(queue()).toHaveLength(0);
});

test("an aborted signal cancels and detaches without touching other approvals", async () => {
    const controller = new AbortController();
    const aborted = requestApproval({ tool: "update_node", risk: "write", summary: "a" }, controller.signal);
    const kept = requestApproval({ tool: "delete_nodes", risk: "write", summary: "b" });

    controller.abort();

    expect(await aborted).toBe("cancel");
    expect(queue()).toHaveLength(1);
    useAgentApprovalStore.getState().decide(queue()[0].id, "once");
    expect(await kept).toBe("once");
});

test("an already-aborted signal never shows a card", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await requestApproval({ tool: "update_node", risk: "write", summary: "a" }, controller.signal)).toBe("cancel");
    expect(queue()).toHaveLength(0);
});

test("deciding an unknown id is a no-op rather than a crash", () => {
    expect(() => useAgentApprovalStore.getState().decide("missing", "once")).not.toThrow();
    expect(queue()).toHaveLength(0);
});
