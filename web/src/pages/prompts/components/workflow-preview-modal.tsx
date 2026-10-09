import { CopyPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Modal, Spin } from "antd";
import { useTranslation } from "react-i18next";

import { CanvasNode } from "@/components/canvas/canvas-node";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { registerMediaUrl } from "@/services/image-storage";
import { cloneWorkflowTemplate, loadTemplateMedia, type WorkflowTemplate } from "@/services/api/templates";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

const noop = () => undefined;

export function WorkflowPreviewModal({ template, onClose }: { template: WorkflowTemplate | null; onClose: () => void }) {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [media, setMedia] = useState<Map<string, string>>(new Map());
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [cloning, setCloning] = useState(false);

    useEffect(() => {
        if (!template) return;
        let cancelled = false;
        let urls: string[] = [];
        void loadTemplateMedia(template)
            .then((map) => {
                if (cancelled) {
                    map.forEach((url) => URL.revokeObjectURL(url));
                    return;
                }
                urls = [...map.values()];
                map.forEach((url, key) => {
                    if (key.startsWith("image:")) registerMediaUrl(key, url);
                });
                setMedia(map);
            })
            .catch(() => {
                if (!cancelled) message.error(t("prompts.templateLoadFailed"));
            });
        return () => {
            cancelled = true;
            urls.forEach((url) => URL.revokeObjectURL(url));
        };
    }, [template, message, t]);

    // 预览展示用的节点副本：视频/音频的播放地址换成模板媒体 object URL（图片走 registerMediaUrl 注册表）。
    const displayNodes = useMemo(() => {
        if (!template) return [];
        if (!media.size) return template.project.nodes;
        return template.project.nodes.map((node) => {
            const key = node.metadata?.storageKey;
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && key && media.has(key)) {
                return { ...node, metadata: { ...node.metadata, content: media.get(key) } };
            }
            return node;
        });
    }, [template, media]);

    const nodeById = useMemo(() => new Map(displayNodes.map((node) => [node.id, node])), [displayNodes]);

    const groupChildCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const group of displayNodes.filter((node) => node.type === CanvasNodeType.Group)) {
            counts.set(
                group.id,
                displayNodes.filter(
                    (node) =>
                        node.id !== group.id &&
                        node.type !== CanvasNodeType.Group &&
                        node.position.x + node.width / 2 >= group.position.x &&
                        node.position.x + node.width / 2 <= group.position.x + group.width &&
                        node.position.y + node.height / 2 >= group.position.y &&
                        node.position.y + node.height / 2 <= group.position.y + group.height,
                ).length,
            );
        }
        return counts;
    }, [displayNodes]);

    useEffect(() => {
        if (!displayNodes.length) return;
        const frame = requestAnimationFrame(() => {
            // 用 clientWidth/clientHeight 取布局尺寸，避免 Modal 弹出动画的 transform 缩放干扰测量。
            const container = containerRef.current;
            if (container?.clientWidth && container.clientHeight) setViewport(fitViewport(displayNodes, container.clientWidth, container.clientHeight));
        });
        return () => cancelAnimationFrame(frame);
    }, [displayNodes]);

    const handleClone = async () => {
        if (!template || cloning) return;
        setCloning(true);
        try {
            const id = await cloneWorkflowTemplate(template);
            message.success(t("prompts.cloneSuccess"));
            onClose();
            navigate(`/canvas/${id}`);
        } catch {
            message.error(t("prompts.cloneFailed"));
        } finally {
            setCloning(false);
        }
    };

    return (
        <Modal
            open={Boolean(template)}
            onCancel={onClose}
            footer={null}
            centered
            width="min(1100px, 94vw)"
            styles={{ body: { padding: 0, height: "min(70vh, 720px)" } }}
            title={
                <div className="flex items-end justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="m-0 truncate text-base font-semibold text-stone-950 dark:text-stone-100">{template?.title}</h2>
                        <p className="m-0 mt-1 text-xs font-normal text-stone-400 dark:text-stone-500">{t("prompts.cloneHint")}</p>
                    </div>
                    <Button type="primary" size="small" icon={<CopyPlus className="size-4" />} loading={cloning} disabled={!template} onClick={handleClone}>
                        {t("prompts.cloneTemplate")}
                    </Button>
                </div>
            }
        >
            <div ref={containerRef} className="relative h-full w-full overflow-hidden">
                {!media.size ? (
                    <div className="absolute inset-0 z-10 grid place-items-center">
                        <Spin />
                    </div>
                ) : null}
                {template ? (
                    <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" backgroundMode={template.project.backgroundMode || "lines"} onViewportChange={setViewport}>
                        <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                            {template.project.connections.map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;
                                return <ConnectionPath key={connection.id} connection={connection} from={from} to={to} active={false} onSelect={noop} />;
                            })}
                        </svg>
                        {/* 预览只展示流程：节点不响应鼠标，隐藏悬停标题、下载等工具；仅保留视频播放控件。 */}
                        <div className="pointer-events-none [&_[data-canvas-video]]:pointer-events-auto">
                            {displayNodes.map((node) => (
                                <CanvasNode
                                    key={node.id}
                                    data={node}
                                    scale={viewport.k}
                                    isSelected={false}
                                    isRelated={false}
                                    isFocusRelated={false}
                                    isConnectionTarget={false}
                                    isConnecting={false}
                                    showPanel={false}
                                    showImageInfo={false}
                                    groupChildCount={groupChildCounts.get(node.id) || 0}
                                    onMouseDown={noop}
                                    onHoverStart={noop}
                                    onHoverEnd={noop}
                                    onConnectStart={noop}
                                    onResizeStart={noop}
                                    onResize={noop}
                                    onResizeEnd={noop}
                                    onContentChange={noop}
                                    onTitleChange={noop}
                                    onContextMenu={noop}
                                    renderNodeContent={node.type === CanvasNodeType.Config ? renderConfigContent : undefined}
                                />
                            ))}
                        </div>
                    </InfiniteCanvas>
                ) : null}
            </div>
        </Modal>
    );
}

function renderConfigContent(node: CanvasNodeData) {
    return <TemplateConfigContent node={node} />;
}

function TemplateConfigContent({ node }: { node: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const meta = node.metadata || {};
    const model = String(meta.model || "").split("::").pop();
    const params = [meta.size, meta.quality, meta.seconds ? `${meta.seconds}s` : "", meta.vquality ? `${meta.vquality}p` : ""].filter(Boolean);
    return (
        <div className="flex h-full w-full flex-col gap-2 overflow-hidden p-4 text-left">
            <p className="line-clamp-[7] whitespace-pre-wrap text-xs leading-5" style={{ color: theme.node.text }}>
                {meta.composerContent || meta.prompt}
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-400 dark:text-stone-500">
                {model ? <span className="truncate">{model}</span> : null}
                {params.map((item) => (
                    <span key={item}>{item}</span>
                ))}
            </div>
        </div>
    );
}

// 初始视口：把全部节点缩放居中到容器内。
function fitViewport(nodes: CanvasNodeData[], width: number, height: number): ViewportTransform {
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const boundsWidth = Math.max(...nodes.map((node) => node.position.x + node.width)) - minX;
    const boundsHeight = Math.max(...nodes.map((node) => node.position.y + node.height)) - minY;
    const k = Math.min(1, Math.max(0.05, Math.min((width - 120) / boundsWidth, (height - 140) / boundsHeight)));
    return { k, x: (width - boundsWidth * k) / 2 - minX * k, y: (height - boundsHeight * k) / 2 - minY * k };
}
