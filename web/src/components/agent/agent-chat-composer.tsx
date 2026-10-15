import { useRef } from "react";
import { Button, Tooltip } from "antd";
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";
import { AgentChatPromptInput } from "./agent-chat-prompt-input";

import type { AgentChatAttachment } from "./agent-chat-message";

export function AgentChatComposer({
    prompt,
    attachments = [],
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onStop,
    onAddFiles,
    onRemoveAttachment,
}: {
    prompt: string;
    attachments?: AgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit?: () => void;
    onStop?: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
}) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const canvasReferences = useAgentStore((state) => state.canvasReferences);
    const canSubmit = Boolean(onSubmit) && !disabled && !sending && Boolean(prompt.trim() || attachments.length || canvasReferences.length);

    return (
        <div className="px-2 pb-2 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="rounded-[24px] border px-3 pb-3 pt-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative size-14 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }} title={item.name}>
                                <img src={item.url} alt={item.name} className="size-full object-cover" />
                                {onRemoveAttachment ? <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label={t("agent.composer.removeImage")}><X className="size-3" /></button> : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                <AgentChatPromptInput value={prompt} disabled={disabled || sending} placeholder={placeholder} theme={theme} onChange={onPromptChange} onSubmit={() => { if (canSubmit) onSubmit?.(); }} onAddFiles={onAddFiles} />
                <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        {onAddFiles ? <>
                            <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => { void onAddFiles(event.target.files); event.target.value = ""; }} />
                            <Tooltip title={t("agent.composer.uploadImage")}><Button type="text" shape="circle" className="!h-9 !w-9 !min-w-9" disabled={disabled || sending} style={{ color: theme.node.muted }} icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()} aria-label={t("agent.composer.uploadImage")} /></Tooltip>
                        </> : null}
                    </div>
                    <Tooltip title={t(sending ? "agent.composer.stop" : "agent.composer.send")} placement="top">
                        <Button type={sending ? "default" : "primary"} danger={sending} shape="circle" className="!h-10 !w-10 !min-w-10" disabled={sending ? !onStop : !canSubmit} icon={sending ? <Square className="size-4" /> : <ArrowUp className="size-4" />} onClick={() => sending ? onStop?.() : onSubmit?.()} aria-label={t(sending ? "agent.composer.stop" : "agent.composer.send")} />
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
