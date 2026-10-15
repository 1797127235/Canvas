export const CANVAS_IMAGE_PREVIEW_MAX_EDGE = 768;

// 画布上显示一张图需要多少像素：节点尺寸 × 画布缩放 × 屏幕像素比。
export function requiredImageLongEdge(renderedWidth: number, renderedHeight: number, scale: number, devicePixelRatio = globalThis.devicePixelRatio || 1) {
    return Math.max(renderedWidth, renderedHeight) * scale * devicePixelRatio;
}

// 本地模式的缩略图只有一档 768px：够清晰就用，否则调用方回落到原图（blob）。
// 账号模式的 remote: 素材走服务端分档接口，选档由服务端负责，不在客户端判断。
export function fitsLocalPreview(requiredLongEdge: number, previewMaxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE) {
    return requiredLongEdge <= previewMaxEdge;
}

export function getThumbnailDimensions(width: number, height: number, maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function createImageThumbnail(blob: Blob, maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE) {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = getThumbnailDimensions(bitmap.width, bitmap.height, maxEdge);
    if (width === bitmap.width && height === bitmap.height) {
        bitmap.close();
        return undefined;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
        bitmap.close();
        return undefined;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return new Promise<Blob | undefined>((resolve) => canvas.toBlob((result) => resolve(result || undefined), "image/webp", 0.86));
}
