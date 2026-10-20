import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

const AGENT_SIDEBAR_DEFAULT_WIDTH = 480;
const AGENT_SIDEBAR_MIN_WIDTH = 360;
const AGENT_SIDEBAR_MAX_WIDTH = 860;

// 拖动助手面板左边界改宽度：指针捕获后 pointermove 都落在手柄上，离开手柄也不丢事件。
// 手柄在面板左侧，所以往左拖（clientX 变小）应该变宽，宽度公式是 startWidth + startX - clientX。
export function useAgentSidebarWidth() {
    const [width, setWidth] = useState(AGENT_SIDEBAR_DEFAULT_WIDTH);

    const startResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const handle = event.currentTarget;
            const startX = event.clientX;
            const startWidth = width;
            const maxWidth = Math.min(AGENT_SIDEBAR_MAX_WIDTH, window.innerWidth * 0.92);
            handle.setPointerCapture(event.pointerId);
            const onMove = (moveEvent: PointerEvent) => setWidth(Math.min(maxWidth, Math.max(AGENT_SIDEBAR_MIN_WIDTH, startWidth + startX - moveEvent.clientX)));
            const onEnd = () => {
                if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
                handle.removeEventListener("pointermove", onMove);
                handle.removeEventListener("pointerup", onEnd);
                handle.removeEventListener("pointercancel", onEnd);
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onEnd);
            handle.addEventListener("pointercancel", onEnd);
        },
        [width],
    );

    return { width, startResize };
}
