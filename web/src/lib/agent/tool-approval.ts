// 工具执行许可的纯决策层。UI、store 和工具注册都只调这里，保证规则只有一份。
// 规则顺序本身是规格的一部分，改动顺序会改变行为，见 docs/specs/agent-tool-approval.md。
export type ToolRisk = "read" | "write" | "spend";
export type ApprovalMode = "read-only" | "ask" | "auto";
export type ToolPolicy = "always" | "never";

// deny：用户对该工具设为「始终拒绝」；deny-readonly：只读模式拦下的。
// 两种拒绝在提示词里说法不同，所以不合并成一个值。
export type ToolGate = "allow" | "ask" | "deny" | "deny-readonly";

export function resolveToolGate(input: { risk: ToolRisk; mode: ApprovalMode; override?: ToolPolicy; sessionAllowed?: boolean }): ToolGate {
    if (input.override === "never") return "deny";
    if (input.risk === "read") return "allow";
    if (input.mode === "read-only") return "deny-readonly";
    if (input.override === "always") return "allow";
    // 花钱的操作没有「自动」档：最宽只到本次会话放行。
    if (input.risk === "spend") return input.sessionAllowed ? "allow" : "ask";
    if (input.mode === "auto") return "allow";
    return "ask";
}
