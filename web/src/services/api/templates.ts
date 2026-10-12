import { setMediaBlob, uploadMediaFile } from "@/services/file-storage";
import { setImageBlob, uploadImage } from "@/services/image-storage";
import { bypassLocalAuth, canAccessLocalFeatures } from "@/lib/auth-access";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";
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

// 克隆模板：账号模式重新上传媒体并改写引用，开发豁免模式写入 IndexedDB；返回新画布 id。
export async function cloneWorkflowTemplate(template: WorkflowTemplate) {
    if (!canAccessLocalFeatures(useUserStore.getState().status)) throw new Error("AUTH_REQUIRED");
    const userId = useUserStore.getState().user?.id;
    if (!bypassLocalAuth && (useWorkspaceStore.getState().owner !== userId || useWorkspaceStore.getState().status !== "ready")) throw new Error("账号工作区尚未就绪");
    const controller = new AbortController();
    const checkAccount = () => {
        if (!bypassLocalAuth && userId !== useUserStore.getState().user?.id) controller.abort(new Error("账号已切换，克隆已取消"));
        controller.signal.throwIfAborted();
    };
    const unsubscribe = useUserStore.subscribe(() => {
        if (!bypassLocalAuth && userId !== useUserStore.getState().user?.id) controller.abort(new Error("账号已切换，克隆已取消"));
    });
    try {
        const replacements = new Map<string, { storageKey: string; url: string }>();
        for (const file of template.files) {
            checkAccount();
            const response = await fetch(templateMediaPath(file.path), { signal: controller.signal });
            if (!response.ok) throw new Error(`template media request failed: ${file.path}`);
            const blob = await response.blob();
            const typed = blob.type ? blob : blob.slice(0, blob.size, file.mimeType);
            checkAccount();
            if (bypassLocalAuth) {
                await (file.storageKey.startsWith("image:") ? setImageBlob(file.storageKey, typed) : setMediaBlob(file.storageKey, typed));
                continue;
            }
            const uploaded = file.storageKey.startsWith("image:") ? await uploadImage(typed, { signal: controller.signal }) : await uploadMediaFile(typed, file.storageKey.split(":")[0], { signal: controller.signal });
            checkAccount();
            if (!uploaded.storageKey) throw new Error("template media upload failed");
            replacements.set(file.storageKey, { storageKey: uploaded.storageKey, url: uploaded.url });
        }
        const project = structuredClone(template.project);
        if (replacements.size) rewriteMediaReferences(project, replacements);
        checkAccount();
        return useCanvasStore.getState().importProject({ ...project, title: template.title });
    } finally {
        unsubscribe();
    }
}

function templateMediaPath(path: string) {
    let url: URL;
    try {
        url = new URL(path, window.location.origin);
    } catch {
        throw new Error("template media path invalid");
    }
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/templates/")) throw new Error("template media path invalid");
    return `${url.pathname}${url.search}`;
}

function rewriteMediaReferences(value: unknown, replacements: Map<string, { storageKey: string; url: string }>) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            if (typeof item === "string" && replacements.has(item)) value[index] = replacements.get(item)!.storageKey;
            else rewriteMediaReferences(item, replacements);
        });
        return;
    }
    const record = value as Record<string, unknown>;
    const replacement = typeof record.storageKey === "string" ? replacements.get(record.storageKey) : undefined;
    if (replacement) {
        record.storageKey = replacement.storageKey;
        if (typeof record.content === "string") record.content = replacement.url;
        if (typeof record.dataUrl === "string") record.dataUrl = replacement.url;
        if (typeof record.url === "string") record.url = replacement.url;
    }
    Object.values(record).forEach((item) => rewriteMediaReferences(item, replacements));
}
