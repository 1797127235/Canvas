import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore, type AgentChatItem, type AgentTokenUsage } from "@/stores/use-agent-store";
import { AgentChatMessage, AgentWorkingMessage } from "./agent-chat-message";
import { agentMessageToChatMessage } from "./agent-event-formatters";
import { AgentScrollToBottom } from "./agent-scroll-to-bottom";

const SCROLL_BOTTOM_THRESHOLD = 48;
const historyMessageStyle = { contentVisibility: "auto", containIntrinsicSize: "0 80px" } as const;

type Theme = (typeof canvasThemes)[keyof typeof canvasThemes];

export function AgentChatTimeline({ theme, sending, waiting }: { theme: Theme; sending: boolean; waiting: boolean }) {
    const { t } = useTranslation();
    const messages = useAgentStore((state) => state.messages);
    const listRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const followRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const updateScrollState = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
        followRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
    }, []);
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        if (!list) return;
        followRef.current = true;
        list.scrollTo({ top: list.scrollHeight, behavior });
        setShowScrollToBottom(false);
    }, []);
    useEffect(() => {
        const frame = requestAnimationFrame(() => (followRef.current ? scrollToBottom("auto") : updateScrollState()));
        return () => cancelAnimationFrame(frame);
    }, [messages, scrollToBottom, updateScrollState]);
    useEffect(() => {
        const content = contentRef.current;
        if (!content) return;
        const observer = new ResizeObserver(() => {
            if (followRef.current) scrollToBottom("auto");
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [scrollToBottom]);

    return (
        <div className="relative min-h-0 flex-1">
            <div ref={listRef} className="thin-scrollbar h-full select-text overflow-y-auto" onScroll={updateScrollState}>
                <div ref={contentRef} className="space-y-4 px-4 pt-4">
                    {messages.map((item) => <AgentChatMessageRow key={item.id} item={item} theme={theme} />)}
                    {(sending || waiting) && !messages.some((item) => item.streamId) ? <AgentWorkingMessage text={t("agent.message.thinking")} activityKey="waiting" theme={theme} /> : null}
                </div>
            </div>
            {showScrollToBottom ? <AgentScrollToBottom theme={theme} title={t("agent.chat.latestMessages")} onClick={() => scrollToBottom()} /> : null}
        </div>
    );
}

const AgentChatMessageRow = memo(function AgentChatMessageRow({ item, theme }: { item: AgentChatItem; theme: Theme }) {
    return <div style={item.streamId ? undefined : historyMessageStyle}><AgentChatMessage item={agentMessageToChatMessage(item)} theme={theme} /></div>;
});

export function AgentUsageBar({ usage, theme }: { usage: AgentTokenUsage; theme: Theme }) {
    return <div className="flex items-center justify-center gap-4 px-4 pt-1 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{usage.input} / {usage.cached} / {usage.output}</div>;
}
