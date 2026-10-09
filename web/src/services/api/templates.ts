import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

// 内置工作流模板：索引和画布数据在 /templates/templates.json，媒体按 files 里的路径单独拉取。
// 用户体系上线后只需把这个文件的请求地址换成服务端接口，数据格式和克隆逻辑不变。
export type WorkflowTemplateFile = {
    storageKey: string;
    path: string;
    mimeType: string;
};

export type WorkflowTemplate = {
    id: string;
    title: string;
    description: string;
    tags: string[];
    author: string;
    cover: string;
    // 成果视频路径，可选；模板卡片悬停时懒加载并静音循环播放。
    previewVideo?: string;
    project: {
        title: string;
        backgroundMode?: CanvasBackgroundMode;
        viewport: ViewportTransform;
        nodes: CanvasNodeData[];
        connections: CanvasConnection[];
    };
    files: WorkflowTemplateFile[];
};

export async function fetchWorkflowTemplates() {
    const response = await fetch("/templates/templates.json");
    if (!response.ok) throw new Error("template index request failed");
    return (await response.json()) as WorkflowTemplate[];
}

// 拉取模板媒体并转成 object URL，返回 storageKey → URL，供预览页注入节点渲染；调用方负责 revoke。
export async function loadTemplateMedia(template: WorkflowTemplate) {
    const entries = await Promise.all(
        template.files.map(async (file) => {
            const response = await fetch(file.path);
            if (!response.ok) throw new Error(`template media request failed: ${file.path}`);
            return [file.storageKey, URL.createObjectURL(await response.blob())] as const;
        }),
    );
    return new Map(entries);
}

// 克隆模板：媒体按原 storageKey 写进本地 IndexedDB（和画布导入同构，打开时 hydrate 自动恢复内容），
// 画布项目用新 id 插入列表，返回新画布 id。
export async function cloneWorkflowTemplate(template: WorkflowTemplate) {
    await Promise.all(
        template.files.map(async (file) => {
            const response = await fetch(file.path);
            if (!response.ok) throw new Error(`template media request failed: ${file.path}`);
            const blob = await response.blob();
            const typed = blob.type ? blob : blob.slice(0, blob.size, file.mimeType);
            await (file.storageKey.startsWith("image:") ? setImageBlob(file.storageKey, typed) : setMediaBlob(file.storageKey, typed));
        }),
    );
    return useCanvasStore.getState().importProject({ ...template.project, title: template.title });
}
