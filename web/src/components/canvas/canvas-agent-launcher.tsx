import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/client";
import { CopilotKitProvider, UseAgentUpdate, useAgent, useAgentContext, useCopilotKit, useFrontendTool } from "@copilotkit/react-core/v2";
import { ArrowUp, Loader2, MessageSquarePlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { buildAssetsContext, buildCanvasContext } from "@/lib/canvas/canvas-agent-context";
import { applyGraphInput, type AgentGraphResult, type ApplyGraphInput } from "@/lib/canvas/canvas-agent-graph";
import { cn } from "@/lib/utils";
import { fetchAgentThread, resetAgentThread, saveAgentThread } from "@/services/api/agent";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

// 画布助手的浮动面板。整个模块由 project.tsx 懒加载：
// CopilotKit 的 Provider 会牵进 markdown 渲染、代码高亮等一大堆东西，
// 不该让没用过助手的用户在打开画布时就下载它们。
export type CanvasAgentProps = {
    projectId: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    onClose: () => void;
    onApplyGraph: (input: ApplyGraphInput) => AgentGraphResult;
};

export default function CanvasAgentPanel(props: CanvasAgentProps) {
    const userId = useUserStore((state) => state.user?.id);
    const headers = useMemo(() => (userId ? { "X-Account-Id": userId } : {}), [userId]);
    return (
        // 换账号时整个 Provider 重挂载：否则上一个账号的会话、工具和运行态会串到下一个账号。
        <CopilotKitProvider key={userId} runtimeUrl={`${window.location.origin}/api/copilotkit`} credentials="same-origin" headers={headers} properties={{ projectId: props.projectId }}>
            <AgentChat {...props} />
        </CopilotKitProvider>
    );
}

function AgentChat({ projectId, nodes, connections, selectedNodeIds, onClose, onApplyGraph }: CanvasAgentProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const assets = useAssetStore((state) => state.assets);
    const { agent, isReady } = useAgent({ agentId: "default", updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged], throttleMs: 60 });
    const { copilotkit } = useCopilotKit();
    const [draft, setDraft] = useState("");
    const [error, setError] = useState("");
    const [threadReady, setThreadReady] = useState(false);
    const versionRef = useRef(0);
    const savedCountRef = useRef(-1);
    const listRef = useRef<HTMLDivElement>(null);

    const canvasContext = useMemo(() => buildCanvasContext(nodes, connections, selectedNodeIds), [connections, nodes, selectedNodeIds]);
    const assetsContext = useMemo(() => buildAssetsContext(assets), [assets]);
    useAgentContext(canvasContext);
    useAgentContext(assetsContext);

    // 工具在浏览器执行：模型只决定「加什么节点、什么关系」，坐标与 id 由 buildAgentGraph 算。
    const applyGraph = useCallback((args: unknown) => onApplyGraph(applyGraphInput.parse(args)), [onApplyGraph]);
    useFrontendTool(
        {
            name: "apply_graph",
            description: "在当前画布上一次性创建一组节点和它们之间的连线。一次提交会作为一个整体进入撤销历史。不要用来修改已有节点。",
            parameters: applyGraphInput,
            handler: async (args) => applyGraph(args),
        },
        [applyGraph],
    );

    // 会话由服务端签发：先取到 threadId 才能 run，服务端据此校验「这个对话属于这个画布」。
    useEffect(() => {
        const controller = new AbortController();
        setThreadReady(false);
        void (async () => {
            try {
                const thread = await fetchAgentThread(projectId, controller.signal);
                if (controller.signal.aborted) return;
                versionRef.current = thread.version;
                agent.threadId = thread.threadId;
                agent.setMessages(thread.messages);
                savedCountRef.current = thread.messages.length;
                setThreadReady(true);
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("canvas.agent.threadFailed"));
            }
        })();
        return () => controller.abort();
    }, [agent, projectId, t]);

    // 每轮结束后落库。按消息条数去重，避免流式渲染过程中反复写库。
    useEffect(() => {
        if (!threadReady || agent.isRunning || agent.messages.length === savedCountRef.current) return;
        const messages = agent.messages;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const result = await saveAgentThread(projectId, versionRef.current, messages);
                    versionRef.current = result.version;
                    savedCountRef.current = messages.length;
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : t("canvas.agent.saveFailed"));
                }
            })();
        }, 400);
        return () => clearTimeout(timer);
    }, [agent.isRunning, agent.messages, projectId, threadReady, t]);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [agent.messages]);

    const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || agent.isRunning || !threadReady) return;
        setDraft("");
        setError("");
        agent.addMessage({ id: `user-${Date.now()}`, role: "user", content: text } as Message);
        try {
            await copilotkit.runAgent({ agent });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.runFailed"));
        }
    }, [agent, copilotkit, draft, t, threadReady]);

    const startNewThread = useCallback(async () => {
        try {
            const thread = await resetAgentThread(projectId);
            versionRef.current = thread.version;
            savedCountRef.current = 0;
            agent.threadId = thread.threadId;
            agent.setMessages([]);
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.newThreadFailed"));
        }
    }, [agent, projectId, t]);

    const messages = agent.messages.filter((message) => message.role === "user" || message.role === "assistant");

    return (
        <div className="pointer-events-auto flex h-[min(560px,72vh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border shadow-xl" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                <span className="text-sm font-semibold">{t("canvas.agent.title")}</span>
                <span className="text-[11px] opacity-45">{isReady && threadReady ? t("canvas.agent.ready") : t("canvas.agent.connecting")}</span>
                <button type="button" onClick={() => void startNewThread()} className="ml-auto grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" title={t("canvas.agent.newThread")} aria-label={t("canvas.agent.newThread")}>
                    <MessageSquarePlus className="size-4" />
                </button>
                <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("common.close")}>
                    <X className="size-4" />
                </button>
            </div>

            <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
                {messages.length ? (
                    messages.map((message) => <MessageRow key={message.id} message={message} theme={theme} />)
                ) : (
                    <div className="pt-10 text-center text-xs leading-relaxed opacity-40">{t("canvas.agent.empty")}</div>
                )}
                {agent.isRunning ? (
                    <div className="flex items-center gap-1.5 text-xs opacity-50">
                        <Loader2 className="size-3 animate-spin" />
                        {t("canvas.agent.thinking")}
                    </div>
                ) : null}
            </div>

            {error ? <div className="px-3 pb-1 text-[11px] leading-snug text-red-500">{error}</div> : null}

            <div className="border-t px-2.5 py-2" style={{ borderColor: theme.toolbar.border }}>
                <div className="flex items-end gap-1.5">
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        rows={1}
                        disabled={!threadReady}
                        placeholder={t("canvas.agent.placeholder")}
                        className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:opacity-35 disabled:opacity-50"
                    />
                    <button
                        type="button"
                        onClick={() => void send()}
                        disabled={!draft.trim() || agent.isRunning || !threadReady}
                        className="mb-0.5 grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/10"
                        aria-label={t("canvas.agent.send")}
                    >
                        <ArrowUp className="size-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}

function MessageRow({ message, theme }: { message: Message; theme: CanvasTheme }) {
    if (message.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-sm leading-relaxed" style={{ background: theme.toolbar.activeBg }}>
                    {textOf(message)}
                </div>
            </div>
        );
    }
    const toolCalls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
    return (
        <div className="space-y-1.5">
            {textOf(message) ? (
                <div className="break-words text-sm leading-relaxed opacity-90 [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-2 [&_pre]:overflow-x-auto [&_ul]:list-disc">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{textOf(message)}</ReactMarkdown>
                </div>
            ) : null}
            {toolCalls.map((call) => (
                <div key={call.id} className={cn("rounded-lg border px-2 py-1.5 text-[11px] leading-snug opacity-70")} style={{ borderColor: theme.node.stroke }}>
                    {toolLabel(call.function.name, call.function.arguments)}
                </div>
            ))}
        </div>
    );
}

function toolLabel(name: string, args: string) {
    if (name !== "apply_graph") return name;
    try {
        const parsed = applyGraphInput.safeParse(JSON.parse(args));
        if (!parsed.success) return "正在搭建画布…";
        const { nodes, connections } = parsed.data;
        return `搭建 ${nodes.length} 个节点${connections?.length ? `、${connections.length} 条连线` : ""}`;
    } catch {
        return "正在搭建画布…";
    }
}

function textOf(message: Message) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text")
        .map((part) => part.text)
        .join("");
}
