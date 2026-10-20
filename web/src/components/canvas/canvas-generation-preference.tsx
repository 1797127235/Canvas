import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal } from "lucide-react";
import { Slider, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { OptionPill, SettingGroup } from "@/components/settings-controls";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import {
    clampVideoSeconds,
    computeMediaSize,
    computeVideoSize,
    inferMediaRatio,
    inferMediaScale,
    inferVideoRatio,
    mediaRatioOptions,
    mediaScaleOptions,
    parseVideoResolution,
    VIDEO_SECONDS_MAX,
    VIDEO_SECONDS_MIN,
    videoRatioOptions,
} from "@/lib/media-size";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

// 助手输入框旁的「生成偏好」：写入的是全局默认生成参数（图片/视频节点没有自身参数时就用它），
// 所以这里选完即成为该用户的默认偏好，和「配置与用户偏好」里的默认值同一份数据。
type PreferenceTab = "image" | "video";

export function CanvasGenerationPreference() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;
            // 模型下拉是 Radix 弹层，挂到 body 上，点它不能把整个偏好面板关掉。
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target) || target.closest('[data-slot="select-content"]')) return;
            setOpen(false);
        };
        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    return (
        <>
            <Tooltip title={t("canvas.generationPreference.title")}>
                <button
                    ref={buttonRef}
                    type="button"
                    onClick={() => setOpen((current) => !current)}
                    className="grid size-8 shrink-0 place-items-center rounded-full transition hover:bg-black/10 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                    aria-label={t("canvas.generationPreference.title")}
                    title={t("canvas.generationPreference.title")}
                >
                    <SlidersHorizontal className="size-[18px]" />
                </button>
            </Tooltip>
            {open && buttonRect ? <PreferencePortal buttonRect={buttonRect} panelRef={panelRef} /> : null}
        </>
    );
}

function PreferencePortal({ buttonRect, panelRef }: { buttonRect: DOMRect; panelRef: RefObject<HTMLDivElement | null> }) {
    const { t } = useTranslation();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [tab, setTab] = useState<PreferenceTab>("image");
    const width = 330;
    const gap = 8;
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, buttonRect.left));
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left,
        bottom: window.innerHeight - buttonRect.top + gap,
        maxHeight: Math.max(260, buttonRect.top - margin * 2),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="thin-scrollbar"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            data-canvas-no-zoom
        >
            <ImageSettingsTheme theme={theme}>
                <div className="space-y-4" style={{ color: theme.node.text }}>
                    <div className="text-base font-semibold">{t("canvas.generationPreference.title")}</div>
                    <div className="grid grid-cols-2 gap-1 rounded-full border p-1" style={{ borderColor: theme.node.stroke }}>
                        {(["image", "video"] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                className="h-8 rounded-full text-sm transition hover:opacity-80"
                                style={{ background: tab === value ? theme.toolbar.activeBg : "transparent", color: theme.node.text, fontWeight: tab === value ? 500 : 400 }}
                                onClick={() => setTab(value)}
                            >
                                {t(`canvas.generationPreference.${value}`)}
                            </button>
                        ))}
                    </div>
                    {tab === "image" ? <ImagePreference config={config} theme={theme} onChange={updateConfig} /> : <VideoPreference config={config} theme={theme} onChange={updateConfig} />}
                    <SettingGroup title={t("canvas.generationPreference.model")} color={theme.node.muted}>
                        <ModelPicker
                            config={config}
                            value={tab === "image" ? config.imageModel : config.videoModel}
                            onChange={(model) => updateConfig(tab === "image" ? "imageModel" : "videoModel", model)}
                            capability={tab}
                            fullWidth
                            onMissingConfig={() => openConfigDialog(true)}
                        />
                    </SettingGroup>
                </div>
            </ImageSettingsTheme>
        </div>,
        document.body,
    );
}

function ImagePreference({ config, theme, onChange }: { config: ReturnType<typeof useEffectiveConfig>; theme: CanvasTheme; onChange: (key: "size", value: string) => void }) {
    const { t } = useTranslation();
    const scale = inferMediaScale(config.size || "auto");
    const ratio = inferMediaRatio(config.size || "auto");

    return (
        <>
            <SettingGroup title={t("canvas.generationPreference.ratio")} color={theme.node.muted}>
                <RatioGrid options={mediaRatioOptions} selected={ratio} theme={theme} onSelect={(value) => onChange("size", computeMediaSize(scale, value))} />
            </SettingGroup>
            <SettingGroup title={t("canvas.generationPreference.clarity")} color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2">
                    {mediaScaleOptions.map((value) => (
                        <OptionPill key={value} selected={scale === value} theme={theme} onClick={() => onChange("size", computeMediaSize(value, ratio === "auto" ? "1:1" : ratio))}>
                            {value === "auto" ? t("settingsPanels.common.auto") : value}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
        </>
    );
}

function VideoPreference({ config, theme, onChange }: { config: ReturnType<typeof useEffectiveConfig>; theme: CanvasTheme; onChange: (key: "videoSize" | "vquality" | "videoSeconds", value: string) => void }) {
    const { t } = useTranslation();
    const ratio = inferVideoRatio(config.videoSize || "auto");
    const resolution = parseVideoResolution(config.vquality);
    const seconds = Number(clampVideoSeconds(config.videoSeconds || "6"));
    const selectResolution = (value: string) => {
        onChange("vquality", value);
        if (ratio !== "auto") onChange("videoSize", computeVideoSize(value, ratio));
    };

    return (
        <>
            <SettingGroup title={t("canvas.generationPreference.ratio")} color={theme.node.muted}>
                <RatioGrid options={videoRatioOptions} selected={ratio} theme={theme} onSelect={(value) => onChange("videoSize", computeVideoSize(resolution, value))} />
            </SettingGroup>
            <SettingGroup title={t("canvas.generationPreference.clarity")} color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2">
                    {["480", "720", "1080"].map((value) => (
                        <OptionPill key={value} selected={resolution === value} theme={theme} onClick={() => selectResolution(value)}>
                            {value}p
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title={t("canvas.generationPreference.duration")} color={theme.node.muted}>
                <div className="flex items-center gap-3">
                    <Slider className="min-w-0 flex-1" min={VIDEO_SECONDS_MIN} max={VIDEO_SECONDS_MAX} step={1} value={seconds} onChange={(value) => onChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                    <span className="w-9 shrink-0 text-sm tabular-nums" style={{ color: theme.node.muted }}>
                        {seconds}s
                    </span>
                </div>
            </SettingGroup>
        </>
    );
}

function RatioGrid({ options, selected, theme, onSelect }: { options: readonly { value: string; width: number; height: number }[]; selected: string; theme: CanvasTheme; onSelect: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-4 gap-2">
            {options.map((item) => (
                <button
                    key={item.value}
                    type="button"
                    className="flex h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent text-xs transition hover:opacity-80"
                    style={{ borderColor: selected === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                    onClick={() => onSelect(item.value)}
                >
                    <RatioIcon width={item.width} height={item.height} color={theme.node.text} />
                    <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                </button>
            ))}
        </div>
    );
}

function RatioIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return <span className="h-6" />;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 22 : Math.max(8, 22 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(8, 22 / ratio) : 22;
    return (
        <span className="grid h-6 w-8 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}
