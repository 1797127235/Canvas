import { expect, test } from "bun:test";

import { resolveToolGate, type ApprovalMode, type ToolPolicy, type ToolRisk } from "../src/lib/agent/tool-approval";

const MODES: ApprovalMode[] = ["read-only", "ask", "auto"];
const RISKS: ToolRisk[] = ["read", "write", "spend"];

test("read tools never ask, unless the user forbade them", () => {
    for (const mode of MODES) expect(resolveToolGate({ risk: "read", mode })).toBe("allow");
    expect(resolveToolGate({ risk: "read", mode: "auto", override: "never" })).toBe("deny");
});

test("read-only mode blocks writes and spending even when the tool is whitelisted", () => {
    for (const risk of ["write", "spend"] as ToolRisk[]) {
        expect(resolveToolGate({ risk, mode: "read-only" })).toBe("deny-readonly");
        expect(resolveToolGate({ risk, mode: "read-only", override: "always" })).toBe("deny-readonly");
        expect(resolveToolGate({ risk, mode: "read-only", override: "never" })).toBe("deny");
    }
});

test("ask mode asks for writes and spending", () => {
    for (const risk of ["write", "spend"] as ToolRisk[]) expect(resolveToolGate({ risk, mode: "ask" })).toBe("ask");
});

test("auto mode runs writes directly but still asks before spending", () => {
    expect(resolveToolGate({ risk: "write", mode: "auto" })).toBe("allow");
    expect(resolveToolGate({ risk: "spend", mode: "auto" })).toBe("ask");
});

test("spending only skips the prompt through a session-scoped allowance", () => {
    expect(resolveToolGate({ risk: "spend", mode: "ask", sessionAllowed: true })).toBe("allow");
    expect(resolveToolGate({ risk: "spend", mode: "auto", sessionAllowed: true })).toBe("allow");
    expect(resolveToolGate({ risk: "spend", mode: "read-only", sessionAllowed: true })).toBe("deny-readonly");
});

test("an always override skips the prompt and a never override wins over everything", () => {
    for (const risk of RISKS) expect(resolveToolGate({ risk, mode: "ask", override: "always" })).toBe("allow");
    for (const risk of RISKS) expect(resolveToolGate({ risk, mode: "auto", override: "never" })).toBe("deny");
});

test("no combination of mode, risk and policy leaves a gap", () => {
    const policies: Array<ToolPolicy | undefined> = [undefined, "always", "never"];
    const gates = new Set<string>();
    for (const mode of MODES)
        for (const risk of RISKS)
            for (const override of policies)
                for (const sessionAllowed of [false, true]) {
                    gates.add(resolveToolGate({ risk, mode, override, sessionAllowed }));
                }
    expect([...gates].sort()).toEqual(["allow", "ask", "deny", "deny-readonly"]);
});
