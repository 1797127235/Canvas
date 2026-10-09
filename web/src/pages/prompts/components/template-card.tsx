import { useRef, useState } from "react";
import { Card, Tag } from "antd";

import { cn } from "@/lib/utils";
import type { WorkflowTemplate } from "@/services/api/templates";

export function TemplateCard({ item, onOpen }: { item: WorkflowTemplate; onOpen: () => void }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [showVideo, setShowVideo] = useState(false);

    const startPreview = () => {
        const video = videoRef.current;
        if (!video || !item.previewVideo) return;
        // 先在 DOM 上挂 src 再 play，避免绕 React 渲染时序导致 play() 在无 src 时被拒绝。
        if (!video.src) video.src = item.previewVideo;
        void video.play().catch(() => undefined);
    };
    const stopPreview = () => {
        const video = videoRef.current;
        if (video && !video.paused) {
            video.pause();
            video.currentTime = 0;
        }
        setShowVideo(false);
    };

    return (
        <Card hoverable className="group cursor-pointer overflow-hidden" styles={{ body: { padding: 0 } }} onClick={onOpen}>
            <div className="relative aspect-[4/3] w-full overflow-hidden bg-stone-100 dark:bg-stone-900" onMouseEnter={startPreview} onMouseLeave={stopPreview}>
                <div className="h-full w-full transition-transform duration-300 group-hover:scale-[1.03]">
                    <img src={item.cover} alt={item.title} className="h-full w-full object-cover" loading="lazy" />
                    {item.previewVideo ? (
                        <video
                            ref={videoRef}
                            muted
                            loop
                            playsInline
                            preload="none"
                            onPlaying={() => setShowVideo(true)}
                            className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-300", showVideo ? "opacity-100" : "opacity-0")}
                        />
                    ) : null}
                </div>
            </div>
            <div className="p-4">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{item.title}</h2>
                    <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{item.author}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-400">{item.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.tags.map((tag) => (
                        <Tag key={tag} className="m-0 text-[11px]">
                            {tag}
                        </Tag>
                    ))}
                </div>
            </div>
        </Card>
    );
}
