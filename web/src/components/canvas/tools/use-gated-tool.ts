import { useCallback, useRef } from "react";
import { useFrontendTool } from "@copilotkit/react-core/v2";
import type { z } from "zod";

import { resolveToolGate, type ToolRisk } from "@/lib/agent/tool-approval";
import { requestApproval } from "@/stores/use-agent-approval-store";
import { useAgentPermissionStore } from "@/stores/use-agent-permission-store";

type GatedToolOptions<T extends Record<string, unknown>> = {
    name: string;
    description: string;
    // 必填且没有默认值：新工具漏写会在编译期暴露，避免以后的新工具悄悄落到宽松档。
    risk: ToolRisk;
    parameters: z.ZodType<T>;
    handler: (args: T) => unknown;
    // 审批卡片上的一句话人话摘要，不显示原始 JSON。
    summarize?: (args: T) => string;
};

const DENY_REASON = "用户已把这个操作设为禁止，不要重试，也不要换别的工具绕过。";
const READ_ONLY_REASON = "当前是只读模式，用户需要在助手输入框旁切换为「每次询问」或「自动执行」。";

// 所有画布工具的唯一注册入口。执行许可、入参校验、拒绝语义都在这一层收口，
// 工具实现里不再关心这些。见 docs/specs/agent-tool-approval.md。
export function useGatedTool<T extends Record<string, unknown>>(options: GatedToolOptions<T>) {
    const { name, description, risk, parameters, handler, summarize } = options;
    const available = useAgentPermissionStore((state) => state.overrides[name] !== "never");

    // handler / summarize 通常是内联箭头函数，每次渲染都是新引用。走 ref 读取最新值，
    // 让注册用的 run 保持稳定——否则输入框每敲一个字都会重新注册一次工具。
    const latest = useRef({ handler, summarize });
    latest.current = { handler, summarize };

    const run = useCallback(
        async (args: Record<string, unknown>, context: { signal?: AbortSignal }) => {
            // CopilotKit 不校验入参，schema 只发给模型。这里必须自己 parse，
            // 否则 zod 的 refine / 长度限制实际从未执行。
            const parsed = parameters.safeParse(args);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                return { status: "denied", reason: `参数不合法：${issue?.path.join(".") || "参数"} ${issue?.message ?? ""}`.trim() };
            }

            const store = useAgentPermissionStore.getState();
            const gate = resolveToolGate({ risk, mode: store.mode, override: store.overrides[name], sessionAllowed: store.sessionAllow[name] });
            if (gate === "deny") return { status: "denied", reason: DENY_REASON };
            if (gate === "deny-readonly") return { status: "denied", reason: READ_ONLY_REASON };

            if (gate === "ask") {
                const decision = await requestApproval({ tool: name, risk, summary: latest.current.summarize?.(parsed.data) ?? name }, context?.signal);
                if (decision === "cancel") return { status: "cancelled", reason: "用户取消了这次操作，没有执行，也不要当作已完成。" };
                if (decision === "deny") return { status: "denied", reason: "用户拒绝了这次操作，不要重试，先问用户下一步怎么办。" };
                if (decision === "never") {
                    // 写入后 available 变 false，下一轮这个工具就不在工具列表里了。
                    store.setOverride(name, "never");
                    return { status: "denied", reason: "用户已禁用这个操作，以后不要再尝试，也不要换别的工具绕过。" };
                }
                // once 不需要记录，直接往下执行；另外两种是记住选择，后续同类调用不再询问。
                if (decision === "session") store.allowForSession(name);
                else if (decision === "always") store.setOverride(name, "always");
            }

            return latest.current.handler(parsed.data);
        },
        [name, risk, parameters],
    );

    useFrontendTool({ name, description, parameters, handler: run, available }, [run, available]);
}
