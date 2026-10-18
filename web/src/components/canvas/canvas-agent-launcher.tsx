import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/client";
import { CopilotKitProvider, UseAgentUpdate, useAgent, useAgentContext, useCopilotKit } from "@copilotkit/react-core/v2";
import { ArrowUp, Loader2, MessageSquarePlus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { buildAssetsContext, buildCanvasContext } from "@/lib/canvas/canvas-agent-context";
import { createSessionSaveQueue } from "@/lib/agent/session-save-queue";
import { bindSessionPersistence } from "@/lib/agent/session-run";
import { applyGraphInput, type AgentGraphResult, type ApplyGraphInput } from "@/lib/canvas/canvas-agent-graph";
import { useApplyGraphTool } from "@/components/canvas/tools/use-apply-graph-tool";
import { cn } from "@/lib/utils";
import { createAgentThread, deleteAgentThread, fetchAgentThread, fetchAgentThreads, saveAgentThread, AgentThreadApiError, type AgentThread } from "@/services/api/agent";
import { fetchServerModels, type PublicModel } from "@/services/api/catalog";
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
        <CopilotKitProvider key={`${userId}:${props.projectId}`} runtimeUrl={`${window.location.origin}/api/copilotkit`} credentials="same-origin" headers={headers} properties={{ projectId: props.projectId }}>
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
    const [threads, setThreads] = useState<AgentThread[]>([]);
    const [activeThreadId, setActiveThreadId] = useState("");
    const [textModels, setTextModels] = useState<PublicModel[]>([]);
    const [selectedModelId, setSelectedModelId] = useState("");
    const [modelError, setModelError] = useState("");
    const [modelsReady, setModelsReady] = useState(false);
    const switchingRef = useRef(false);
    const sendingRef = useRef(false);
    const overflowMessagesRef = useRef(new Map<string, Message[]>());
    const syncingRef = useRef(false);
    const [sending, setSending] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const busy = sending || syncing || agent.isRunning;
    const saveQueueRef = useRef<ReturnType<typeof createSessionSaveQueue> | null>(null);
    if (!saveQueueRef.current) {
        saveQueueRef.current = createSessionSaveQueue(
            (threadId, version, messages) => saveAgentThread(projectId, threadId, version, messages),
            (threadId, result) => setThreads((current) => current.map((thread) => thread.threadId === threadId ? { ...thread, ...(result.title ? { title: result.title } : {}), version: result.version } : thread)),
            async (threadId) => { const thread = await fetchAgentThread(projectId, threadId); return thread; },
        );
    }
    const saveQueue = saveQueueRef.current;
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let active = true;
        void fetchServerModels().then((models) => {
            if (!active) return;
            const available = models.filter((model) => model.capability === "text");
            setTextModels(available);
            setSelectedModelId((current) => available.some((model) => model.id === current) ? current : available[0]?.id ?? "");
            setModelsReady(true);
        }).catch((cause) => { if (active) setModelError(cause instanceof Error ? cause.message : "文本模型读取失败"); });
        return () => { active = false; };
    }, []);

    useEffect(() => bindSessionPersistence(agent, {
        queue: saveQueue,
        load: (threadId) => fetchAgentThread(projectId, threadId),
        onBusy: (value) => { syncingRef.current = value; setSyncing(value); },
        isActive: () => !switchingRef.current,
    }), [agent, projectId, saveQueue]);

    const canvasContext = useMemo(() => buildCanvasContext(nodes, connections, selectedNodeIds), [connections, nodes, selectedNodeIds]);
    const assetsContext = useMemo(() => buildAssetsContext(assets), [assets]);
    useAgentContext(canvasContext);
    useAgentContext(assetsContext);

    // 工具在浏览器执行：模型只决定「加什么节点、什么关系」，坐标与 id 由 buildAgentGraph 算。
    useApplyGraphTool(onApplyGraph);

    // 会话由服务端签发：先取到 threadId 才能 run，服务端据此校验「这个对话属于这个画布」。
    useEffect(() => {
        const controller = new AbortController();
        setThreadReady(false);
        void (async () => {
            try {
                const listed = await fetchAgentThreads(projectId, controller.signal);
                if (controller.signal.aborted) return;
                const thread = listed[0];
                setThreads(listed);
                setActiveThreadId(thread.threadId);
                saveQueue.markSaved(thread.threadId, thread.version, thread.messages);
                agent.threadId = thread.threadId;
                agent.setMessages(thread.messages);
                setThreadReady(true);
            } catch (cause) {
                if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("canvas.agent.threadFailed"));
            }
        })();
        return () => controller.abort();
    }, [agent, projectId, saveQueue, t]);

    // 保存完整内容快照；旧 effect 取消后不能再创建重试定时器。
    useEffect(() => {
        if (!threadReady || busy || !activeThreadId || !saveQueue.isDirty(activeThreadId, agent.messages)) return;
        let cancelled = false;
        let retryDelay = 800;
        let timer: ReturnType<typeof setTimeout>;
        const snapshot = structuredClone(agent.messages);
        const persist = async () => {
            if (cancelled || sendingRef.current || syncingRef.current || switchingRef.current) return;
            try {
                await saveQueue.flush(activeThreadId, snapshot);
            } catch (cause) {
                if (cancelled) return;
                setError(cause instanceof Error ? cause.message : t("canvas.agent.saveFailed"));
                if (!(cause instanceof TypeError) && !(cause instanceof AgentThreadApiError && cause.retryable)) return;
                timer = setTimeout(() => { void persist(); }, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 8000);
            }
        };
        timer = setTimeout(() => { void persist(); }, 400);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [activeThreadId, agent.messages, busy, saveQueue, threadReady, t]);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [agent.messages]);

    const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || !modelsReady || !selectedModelId || agent.isRunning || !threadReady || sendingRef.current || syncingRef.current || switchingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        setDraft("");
        setError("");
        const userMessage = { id: crypto.randomUUID(), role: "user", content: text } as Message;
        agent.addMessage(userMessage);
        try {
            await copilotkit.runAgent({ agent, forwardedProps: { modelId: selectedModelId } });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.runFailed"));
        } finally {
            sendingRef.current = false;
            setSending(false);
        }
    }, [agent, copilotkit, draft, modelsReady, selectedModelId, t, threadReady]);

    const switchThread = useCallback(async (threadId: string) => {
        if (!threadId || threadId === activeThreadId || agent.isRunning || sendingRef.current || syncingRef.current || switchingRef.current) return;
        switchingRef.current = true;
        setThreadReady(false);
        try {
            if (activeThreadId && saveQueue.isDirty(activeThreadId, agent.messages)) {
                try {
                    await saveQueue.flush(activeThreadId, agent.messages);
                } catch (cause) {
                    if (!(cause instanceof AgentThreadApiError) || cause.status !== 413) throw cause;
                    overflowMessagesRef.current.set(activeThreadId, structuredClone(agent.messages));
                }
            }
            const thread = await fetchAgentThread(projectId, threadId);
            saveQueue.markSaved(thread.threadId, thread.version, thread.messages);
            setActiveThreadId(thread.threadId);
            agent.threadId = thread.threadId;
            agent.setMessages(overflowMessagesRef.current.get(threadId) ?? thread.messages);
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.threadFailed"));
        } finally {
            switchingRef.current = false;
            setThreadReady(true);
        }
    }, [activeThreadId, agent, projectId, saveQueue, t]);

    const startNewThread = useCallback(async () => {
        if (agent.isRunning || sendingRef.current || syncingRef.current || switchingRef.current) return;
        switchingRef.current = true;
        setThreadReady(false);
        let retainedOverflow = false;
        try {
            if (activeThreadId) {
                try {
                    await saveQueue.flush(activeThreadId, agent.messages);
                } catch (cause) {
                    if (!(cause instanceof AgentThreadApiError) || cause.status !== 413) throw cause;
                    overflowMessagesRef.current.set(activeThreadId, structuredClone(agent.messages));
                    retainedOverflow = true;
                }
            }
            const thread = await createAgentThread(projectId);
            setThreads((current) => [thread, ...current]);
            setActiveThreadId(thread.threadId);
            saveQueue.markSaved(thread.threadId, thread.version, []);
            agent.threadId = thread.threadId;
            agent.setMessages([]);
            setError(retainedOverflow ? "已新建会话；上一会话的未保存消息暂存于本页面，刷新前请先复制保留。" : "");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.newThreadFailed"));
        } finally {
            switchingRef.current = false;
            setThreadReady(true);
        }
    }, [activeThreadId, agent, projectId, saveQueue, t]);

    const removeThread = useCallback(async () => {
        if (!activeThreadId || agent.isRunning || threads.length < 1 || sendingRef.current || syncingRef.current || switchingRef.current) return;
        switchingRef.current = true;
        setThreadReady(false);
        try {
            await saveQueue.flush(activeThreadId, agent.messages);
            const remaining = threads.filter((thread) => thread.threadId !== activeThreadId);
            const next = remaining.length ? await fetchAgentThread(projectId, remaining[0].threadId) : await createAgentThread(projectId);
            await deleteAgentThread(projectId, activeThreadId);
            setThreads(remaining.length ? remaining : [next]);
            setActiveThreadId(next.threadId);
            saveQueue.markSaved(next.threadId, next.version, next.messages);
            agent.threadId = next.threadId;
            agent.setMessages(next.messages);
            setError("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.deleteFailed"));
        } finally {
            switchingRef.current = false;
            setThreadReady(true);
        }
    }, [activeThreadId, agent, projectId, saveQueue, t, threads]);

    const close = useCallback(async () => {
        if (agent.isRunning || sendingRef.current || syncingRef.current || switchingRef.current) return;
        switchingRef.current = true;
        setThreadReady(false);
        try {
            if (activeThreadId) await saveQueue.flush(activeThreadId, agent.messages);
            onClose();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.saveFailed"));
        } finally {
            switchingRef.current = false;
            setThreadReady(true);
        }
    }, [activeThreadId, agent, onClose, saveQueue, t]);

    const messages = agent.messages.filter((message) => message.role === "user" || message.role === "assistant");

    return (
        <div className="pointer-events-auto flex h-[min(560px,72vh)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border shadow-xl" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
            <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: theme.toolbar.border }}>
                <span className="text-sm font-semibold">{t("canvas.agent.title")}</span>
                <span className="text-[11px] opacity-45">{isReady && threadReady ? t("canvas.agent.ready") : t("canvas.agent.connecting")}</span>
                <select value={activeThreadId} onChange={(event) => void switchThread(event.target.value)} disabled={!threadReady || busy} className="ml-auto min-w-0 max-w-28 truncate bg-transparent text-xs outline-none">
                    {threads.map((thread) => <option key={thread.threadId} value={thread.threadId}>{thread.title}</option>)}
                </select>
                <button type="button" onClick={() => void startNewThread()} disabled={!threadReady || busy} className="grid size-7 shrink-0 place-items-center rounded-md opacity-55 transition hover:bg-black/5 hover:opacity-100 disabled:opacity-25 dark:hover:bg-white/10" title={t("canvas.agent.newThread")} aria-label={t("canvas.agent.newThread")}>
                    <MessageSquarePlus className="size-4" />
                </button>
                <button type="button" onClick={() => void removeThread()} disabled={!threadReady || busy} className="grid size-7 shrink-0 place-items-center rounded-md opacity-55 transition hover:bg-black/5 hover:text-red-500 hover:opacity-100 disabled:opacity-25 dark:hover:bg-white/10" title={t("canvas.agent.deleteThread")} aria-label={t("canvas.agent.deleteThread")}>
                    <Trash2 className="size-4" />
                </button>
                <button type="button" onClick={() => void close()} disabled={!threadReady || busy} className="grid size-7 place-items-center rounded-md opacity-55 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" aria-label={t("common.close")}>
                    <X className="size-4" />
                </button>
            </div>
            <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: theme.toolbar.border }}>
                <span className="text-[11px] opacity-50">模型</span>
                <select value={selectedModelId} onChange={(event) => setSelectedModelId(event.target.value)} disabled={busy || !textModels.length} aria-label="选择助手模型" className="min-w-0 flex-1 truncate bg-transparent text-xs outline-none disabled:opacity-50">
                    {textModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
                {modelError ? <span className="max-w-36 truncate text-[10px] text-red-500" title={modelError}>{modelError}</span> : null}
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
                        disabled={!draft.trim() || busy || !threadReady || !modelsReady || !selectedModelId}
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
