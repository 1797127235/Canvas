import { useEffect } from "react";
import { Button, Tooltip } from "antd";
import { Bot, PanelRightClose } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentChatTimeline } from "@/components/agent/agent-chat";
import { AgentChatComposer } from "@/components/agent/agent-chat-composer";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

export function AgentConversationPanel() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const prompt = useAgentStore((state) => state.prompt);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const closePanel = useAgentStore((state) => state.closePanel);
    const userId = useUserStore((state) => state.user?.id);

    useEffect(() => {
        setAgentState({ prompt: "", attachments: [], canvasReferences: [], messages: [], activeThreadId: "", activeTurnId: "", tokenUsage: null, sending: false, waiting: false });
    }, [userId, setAgentState]);

    return (
        <>
            <header className="flex h-12 shrink-0 items-center justify-between border-b px-3" style={{ borderColor: theme.node.stroke }}>
                <div className="flex items-center gap-2 text-sm font-medium"><Bot className="size-4" />Agent</div>
                <Tooltip title={t("agent.panel.collapse")}>
                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.panel.collapseLabel")} style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                </Tooltip>
            </header>
            <AgentChatTimeline theme={theme} sending={false} waiting={false} />
            <div className="shrink-0 border-t px-3 py-2 text-center text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }} role="status">
                {t("agent.panel.runtimeNotConnected")}
            </div>
            <AgentChatComposer
                prompt={prompt}
                placeholder={t("agent.panel.placeholder")}
                theme={theme}
                onPromptChange={(prompt) => setAgentState({ prompt })}
            />
        </>
    );
}
