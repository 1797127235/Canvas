import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/client";
import { CopilotKitProvider, UseAgentUpdate, useAgent, useAgentContext, useCopilotKit } from "@copilotkit/react-core/v2";
import { Dropdown, type MenuProps } from "antd";
import { ArrowUp, Check, ChevronDown, Eye, Loader2, MessageSquarePlus, Plus, RotateCw, ShieldQuestion, Trash2, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { buildAssetsContext, buildCanvasContext } from "@/lib/canvas/canvas-agent-context";
import { AGENT_ATTACHMENT_LIMIT, AGENT_ATTACHMENT_MAX_BYTES, buildUserMessageContent, buildUserMessageMetadata, readMessageAttachments, rejectAttachment, type AgentAttachment } from "@/lib/agent/attachments";
import { previewUrlFor } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { createSessionSaveQueue } from "@/lib/agent/session-save-queue";
import { bindSessionPersistence } from "@/lib/agent/session-run";
import { applyGraphInput, type AgentGraphResult, type ApplyGraphInput } from "@/lib/canvas/canvas-agent-graph";
import { CanvasPromptLibrary } from "@/components/canvas/canvas-prompt-library";
import { CanvasGenerationPreference } from "@/components/canvas/canvas-generation-preference";
import { useApplyGraphTool } from "@/components/canvas/tools/use-apply-graph-tool";
import { useCanvasTools, type CanvasToolResult, type UpdateCanvasNodeInput } from "@/components/canvas/tools/use-canvas-tools";
import type { ApprovalMode } from "@/lib/agent/tool-approval";
import { cancelPendingApprovals, useAgentApprovalStore, type ApprovalDecision, type PendingApproval } from "@/stores/use-agent-approval-store";
import { useAgentPermissionStore } from "@/stores/use-agent-permission-store";
import { cn, randomUuid } from "@/lib/utils";
import { createAgentThread, deleteAgentThread, fetchAgentThread, fetchAgentThreads, saveAgentThread, AgentThreadApiError, type AgentThread } from "@/services/api/agent";
import { fetchServerModels, type PublicModel } from "@/services/api/catalog";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

// 画布助手的浮动面板。整个模块由 project.tsx 懒加载：
// CopilotKit 的 Provider 会牵进 markdown 渲染、代码高亮等一大堆东西，
// 不该让没用过助手的用户在打开画布时就下载它们。
// 空态灵感胶囊分两批轮换，「换一批」只在本地切换，不额外请求模板库。
const IDEA_SETS = [
    ["巨物奇幻电影", "东方巨物幻想", "复古胶片 POV 漫游", "咖啡馆胶片人像"],
    ["赛博夜景街拍", "水墨山水长卷", "产品棚拍封面", "复古油画肖像"],
];

// 三档执行权限的图标。花钱类工具不受模式影响，永远走询问，见 tool-approval.ts。
const MODE_ICON = { "read-only": Eye, ask: ShieldQuestion, auto: Zap };

export type CanvasAgentProps = {
    projectId: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: Set<string>;
    onClose: () => void;
    onApplyGraph: (input: ApplyGraphInput) => AgentGraphResult;
    onUpdateNode: (input: UpdateCanvasNodeInput) => CanvasToolResult;
    onDeleteNodes: (ids: string[]) => string[];
    onConnectNodes: (fromNodeId: string, toNodeId: string) => CanvasToolResult;
    onDisconnectNodes: (fromNodeId: string, toNodeId: string) => CanvasToolResult;
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

function AgentChat({ projectId, nodes, connections, selectedNodeIds, onClose, onApplyGraph, onUpdateNode, onDeleteNodes, onConnectNodes, onDisconnectNodes }: CanvasAgentProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const assets = useAssetStore((state) => state.assets);
    const { agent } = useAgent({ agentId: "default", updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged], throttleMs: 60 });
    const { copilotkit } = useCopilotKit();
    const userName = useUserStore((state) => state.user?.email.split("@")[0]) || "创作者";
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    const [uploading, setUploading] = useState(0);
    const fileRef = useRef<HTMLInputElement>(null);
    const [ideaPage, setIdeaPage] = useState(0);
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
    const mode = useAgentPermissionStore((state) => state.mode);
    const setMode = useAgentPermissionStore((state) => state.setMode);
    const resetPermissions = useAgentPermissionStore((state) => state.reset);
    const approvals = useAgentApprovalStore((state) => state.queue);
    const decideApproval = useAgentApprovalStore((state) => state.decide);
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

    // 面板卸载时把挂起的审批全部按取消收尾：handler 不返回，run 会一直等在那里。
    useEffect(() => cancelPendingApprovals, []);

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
    useCanvasTools({ nodes, connections, onUpdateNode, onDeleteNodes, onConnectNodes, onDisconnectNodes });

    // 工具在浏览器执行，直接操作当前画布状态。
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

    const removeAttachment = useCallback((storageKey: string) => {
        setAttachments((current) => current.filter((attachment) => attachment.storageKey !== storageKey));
    }, []);

    // 选中即上传：发送时只带身份，不等上传把整条消息卡住。
    const addAttachments = useCallback(async (files: FileList | null) => {
        if (!files?.length) return;
        setError("");
        const accepted: File[] = [];
        let count = attachments.length;
        for (const file of Array.from(files)) {
            const rejection = rejectAttachment(file, count);
            if (rejection === "count") {
                setError(t("canvas.agent.attachLimit", { count: AGENT_ATTACHMENT_LIMIT }));
                break;
            }
            if (rejection === "type") {
                setError(t("canvas.agent.attachType"));
                continue;
            }
            if (rejection === "size") {
                setError(t("canvas.agent.attachTooLarge", { size: AGENT_ATTACHMENT_MAX_BYTES / 1024 / 1024 }));
                continue;
            }
            accepted.push(file);
            count += 1;
        }
        await Promise.all(
            accepted.map(async (file) => {
                setUploading((value) => value + 1);
                try {
                    const uploaded = await uploadMediaFile(file, "agent");
                    // 助手只在账号模式下可用，本地存储的身份服务端读不到，别让用户以为传上去了。
                    if (!uploaded.storageKey.startsWith("remote:")) {
                        setError(t("canvas.agent.loginRequired"));
                        return;
                    }
                    setAttachments((current) => (current.length >= AGENT_ATTACHMENT_LIMIT ? current : [...current, { storageKey: uploaded.storageKey, name: file.name, mimeType: uploaded.mimeType, bytes: uploaded.bytes }]));
                } catch (cause) {
                    setError(cause instanceof Error ? cause.message : t("canvas.agent.attachFailed"));
                } finally {
                    setUploading((value) => value - 1);
                }
            }),
        );
    }, [attachments.length, t]);

    const send = useCallback(async () => {
        const text = draft.trim();
        if ((!text && !attachments.length) || uploading > 0 || !modelsReady || !selectedModelId || agent.isRunning || !threadReady || sendingRef.current || syncingRef.current || switchingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        try {
            // http 页面里 crypto.randomUUID 不存在（仅安全上下文暴露），这里必须用 crypto.getRandomValues 的实现。
            // addMessage 之前不能清空草稿：抛错时原文要留在输入框，不能让用户白打一段。
            const metadata = buildUserMessageMetadata(attachments);
            const userMessage = { id: randomUuid(), role: "user", content: buildUserMessageContent(text, attachments), ...(metadata ? { metadata } : {}) } as Message;
            agent.addMessage(userMessage);
            setDraft("");
            setAttachments([]);
            setError("");
            await copilotkit.runAgent({ agent, forwardedProps: { modelId: selectedModelId } });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t("canvas.agent.runFailed"));
        } finally {
            // 发送锁必须在 finally 里放掉：任何抛错都不能让面板永久停在「发送中」。
            sendingRef.current = false;
            setSending(false);
        }
    }, [agent, attachments, copilotkit, draft, modelsReady, selectedModelId, t, threadReady, uploading]);

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

    const suggestions = IDEA_SETS[ideaPage % IDEA_SETS.length];
    const messages = agent.messages.filter((message) => message.role === "user" || message.role === "assistant");
    const activeTitle = threads.find((thread) => thread.threadId === activeThreadId)?.title || t("canvas.agent.newChat");
    const activeModelName = textModels.find((model) => model.id === selectedModelId)?.name;
    const threadMenuItems: MenuProps["items"] = [
        ...threads.map((thread) => ({
            key: thread.threadId,
            icon: thread.threadId === activeThreadId ? <Check className="size-4" /> : <span className="size-4" />,
            label: <span className="block max-w-56 truncate">{thread.title}</span>,
        })),
        { type: "divider" },
        { key: "new", icon: <MessageSquarePlus className="size-4" />, label: t("canvas.agent.newThread"), disabled: !threadReady || busy },
        { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.agent.deleteThread"), disabled: !threadReady || busy },
    ];
    const onThreadMenuClick: MenuProps["onClick"] = ({ key }) => {
        if (key === "new") void startNewThread();
        else if (key === "delete") void removeThread();
        else void switchThread(key);
    };
    const modelMenuItems: MenuProps["items"] = textModels.map((model) => ({ key: model.id, label: model.name, disabled: busy }));
    const selectModel: MenuProps["onClick"] = ({ key }) => {
        if (textModels.some((model) => model.id === key)) setSelectedModelId(key);
    };
    const modeMenuItems: MenuProps["items"] = [
        { key: "read-only", icon: <Eye className="size-4" />, label: t("canvas.agent.modeReadOnly") },
        { key: "ask", icon: <ShieldQuestion className="size-4" />, label: t("canvas.agent.modeAsk") },
        { key: "auto", icon: <Zap className="size-4" />, label: t("canvas.agent.modeAuto") },
        { type: "divider" },
        { key: "reset", label: t("canvas.agent.permissionReset") },
    ];
    const selectMode: MenuProps["onClick"] = ({ key }) => {
        if (key === "reset") resetPermissions();
        else if (key === "read-only" || key === "ask" || key === "auto") setMode(key as ApprovalMode);
    };
    const ModeIcon = MODE_ICON[mode];

    return (
        <div className="pointer-events-auto flex h-full w-full flex-col overflow-hidden" style={{ background: theme.toolbar.panel, color: theme.node.text }}>
            <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                <Dropdown trigger={["click"]} placement="bottomLeft" menu={{ items: threadMenuItems, onClick: onThreadMenuClick }}>
                    <button type="button" className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium transition hover:bg-black/5 dark:hover:bg-white/10" aria-label={t("canvas.agent.threads")} title={t("canvas.agent.threads")}>
                        <span className="truncate">{activeTitle}</span>
                        <ChevronDown className="size-4 shrink-0 opacity-55" />
                    </button>
                </Dropdown>
                <button type="button" onClick={() => void close()} disabled={!threadReady || busy} className="grid size-8 shrink-0 place-items-center rounded-lg transition hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10" aria-label={t("common.close")}>
                    <X className="size-[18px]" />
                </button>
            </div>

            {/* 消息列表：空态居中展示问候、标题与灵感胶囊 */}
            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                {messages.length ? (
                    messages.map((message) => <MessageRow key={message.id} message={message} theme={theme} />)
                ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-5 pb-16">
                        <div className="space-y-2 text-center">
                            <div className="text-sm opacity-55">{t("canvas.agent.greeting", { name: userName })}</div>
                            <h2 className="text-[26px] font-medium leading-tight">{t("canvas.agent.greetingTitle")}</h2>
                        </div>
                        <div className="flex max-w-[330px] flex-wrap items-center justify-center gap-2">
                            {suggestions.map((suggestion) => (
                                <button key={suggestion} type="button" onClick={() => setDraft(suggestion)} className="rounded-full border px-3.5 py-2 text-xs transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.toolbar.border }}>
                                    {suggestion}
                                </button>
                            ))}
                        </div>
                        <button type="button" onClick={() => setIdeaPage((page) => page + 1)} className="flex items-center gap-1.5 text-xs opacity-55 transition hover:opacity-100">
                            <RotateCw className="size-3.5" />
                            {t("canvas.agent.ideas")}
                        </button>
                    </div>
                )}
                {agent.isRunning ? (
                    <div className="flex items-center gap-1.5 text-sm opacity-50">
                        <Loader2 className="size-3.5 animate-spin" />
                        {t("canvas.agent.thinking")}
                    </div>
                ) : null}
            </div>

            {/* 底部输入卡片：输入框与工具栏同处一张卡片，替代原来的两块布局 */}
            <div className="shrink-0 px-3 pb-3">
                {approvals.length ? <ApprovalCard item={approvals[0]} pending={approvals.length - 1} onDecide={decideApproval} theme={theme} /> : null}
                {error ? <div className="mb-1.5 px-1 text-xs leading-snug text-red-500">{error}</div> : null}
                <div className="rounded-[22px] border p-2" style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}>
                    <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { void addAttachments(event.target.files); event.target.value = ""; }} />
                    {attachments.length ? (
                        <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
                            {attachments.map((attachment) => {
                                const preview = previewUrlFor(attachment.storageKey);
                                return (
                                    <div key={attachment.storageKey} className="relative size-12 overflow-hidden rounded-lg border" style={{ borderColor: theme.toolbar.border }}>
                                        {preview ? <img src={preview} alt={attachment.name} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-[10px] opacity-50">{t("canvas.agent.attachImage")}</div>}
                                        <button type="button" onClick={() => removeAttachment(attachment.storageKey)} className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white transition hover:bg-black/80" aria-label={t("canvas.agent.attachRemove")} title={t("canvas.agent.attachRemove")}>
                                            <X className="size-2.5" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}
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
                        className="block max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1.5 text-sm leading-6 outline-none placeholder:opacity-45 disabled:opacity-50"
                    />
                    <div className="flex items-center justify-between gap-1">
                        <div className="flex min-w-0 items-center gap-0.5">
                            <button type="button" onClick={() => fileRef.current?.click()} disabled={!threadReady || busy || uploading > 0 || attachments.length >= AGENT_ATTACHMENT_LIMIT} className="grid size-8 shrink-0 place-items-center rounded-full transition hover:bg-black/10 disabled:opacity-30 dark:hover:bg-white/10" aria-label={t("canvas.agent.attach")} title={t("canvas.agent.attach")}>
                                {uploading ? <Loader2 className="size-[18px] animate-spin" /> : <Plus className="size-[18px]" />}
                            </button>
                            <Dropdown trigger={["click"]} placement="bottomLeft" disabled={!textModels.length} menu={{ items: modelMenuItems, selectedKeys: [selectedModelId], onClick: selectModel }}>
                                <button type="button" disabled={!textModels.length} className="flex min-w-0 items-center gap-1 rounded-full px-2 py-1.5 text-xs font-medium transition hover:bg-black/10 disabled:opacity-40 dark:hover:bg-white/10" aria-label={t("canvas.agent.model")} title={t("canvas.agent.model")}>
                                    <span className="max-w-32 truncate">{activeModelName ?? t("canvas.agent.model")}</span>
                                    <ChevronDown className="size-3.5 shrink-0 opacity-55" />
                                </button>
                            </Dropdown>
                            <CanvasPromptLibrary onSelect={(prompt) => setDraft(prompt)} />
                            <CanvasGenerationPreference />
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: modeMenuItems, selectedKeys: [mode], onClick: selectMode }}>
                                <button type="button" className="flex items-center gap-1 rounded-full px-2 py-1.5 text-xs font-medium transition hover:bg-black/10 dark:hover:bg-white/10" aria-label={t("canvas.agent.mode")} title={t("canvas.agent.modeHint")}>
                                    <ModeIcon className="size-3.5 shrink-0 opacity-70" />
                                    <span className="max-w-20 truncate">{t(mode === "read-only" ? "canvas.agent.modeReadOnly" : mode === "auto" ? "canvas.agent.modeAuto" : "canvas.agent.modeAsk")}</span>
                                </button>
                            </Dropdown>
                            <button
                                type="button"
                                onClick={() => void send()}
                                disabled={(!draft.trim() && !attachments.length) || uploading > 0 || busy || !threadReady || !modelsReady || !selectedModelId}
                                className="grid size-9 shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-30"
                                style={{ background: theme.node.text, color: theme.canvas.background }}
                                aria-label={t("canvas.agent.send")}
                            >
                                <ArrowUp className="size-[18px]" />
                            </button>
                        </div>
                    </div>
                </div>
                {modelError ? <div className="mt-1.5 px-1 text-[10px] text-red-500">{modelError}</div> : null}
            </div>
        </div>
    );
}

function MessageRow({ message, theme }: { message: Message; theme: CanvasTheme }) {
    if (message.role === "user") {
        const text = textOf(message);
        const attachments = readMessageAttachments(message);
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] space-y-1.5">
                    {text ? (
                        <div className="whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-sm leading-relaxed" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}>
                            {text}
                        </div>
                    ) : null}
                    {attachments.length ? (
                        <div className="flex flex-wrap justify-end gap-1.5">
                            {attachments.map((attachment) => {
                                const preview = previewUrlFor(attachment.storageKey);
                                return preview ? <img key={attachment.storageKey} src={preview} alt={attachment.name} className="size-24 rounded-xl object-cover" /> : null;
                            })}
                        </div>
                    ) : null}
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

// 工具执行前的审批卡片。面板是自绘消息列表，不经过 CopilotChat，
// 所以 useHumanInTheLoop 的 render 不会显示，审批 UI 只能自己做。
function ApprovalCard({ item, pending, onDecide, theme }: { item: PendingApproval; pending: number; onDecide: (id: string, decision: ApprovalDecision) => void; theme: CanvasTheme }) {
    const { t } = useTranslation();
    // 花钱的工具不提供「始终允许」：最宽只到本次会话放行，避免永久自动扣费。
    const secondary: { decision: ApprovalDecision; label: string } = item.risk === "spend"
        ? { decision: "session", label: t("canvas.agent.approvalSession") }
        : { decision: "always", label: t("canvas.agent.approvalAlways") };
    // 拒绝分两种：点主体只拒这一次，下拉里才能永久禁用。
    // 永久拒绝会把这个工具从模型工具列表移除（available: false），所以只能藏在二级菜单。
    const denyMenu: MenuProps = {
        items: [{ key: "never", label: t("canvas.agent.approvalNever") }],
        onClick: ({ key }) => onDecide(item.id, key as ApprovalDecision),
    };
    return (
        <div className="mb-1.5 rounded-[18px] border px-3 py-2.5" style={{ background: theme.node.panel, borderColor: theme.toolbar.border }}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
                <ShieldQuestion className="size-3.5 shrink-0 opacity-70" />
                <span>{t("canvas.agent.approvalTitle")}</span>
                {pending ? <span className="ml-auto font-normal opacity-50">{t("canvas.agent.approvalPending", { count: pending })}</span> : null}
            </div>
            <div className="mt-1.5 break-words text-sm leading-snug">{item.summary}</div>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => onDecide(item.id, "once")} className="rounded-full px-3 py-1.5 text-xs font-medium transition" style={{ background: theme.node.text, color: theme.canvas.background }}>
                    {t("canvas.agent.approvalOnce")}
                </button>
                <button type="button" onClick={() => onDecide(item.id, secondary.decision)} className="rounded-full border px-3 py-1.5 text-xs transition hover:bg-black/5 dark:hover:bg-white/10" style={{ borderColor: theme.toolbar.border }}>
                    {secondary.label}
                </button>
                <Dropdown trigger={["click"]} placement="topRight" menu={denyMenu}>
                    <button type="button" className="flex items-center gap-0.5 rounded-full px-3 py-1.5 text-xs opacity-60 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
                        {t("canvas.agent.approvalDeny")}
                        <ChevronDown className="size-3 shrink-0" />
                    </button>
                </Dropdown>
            </div>
        </div>
    );
}
