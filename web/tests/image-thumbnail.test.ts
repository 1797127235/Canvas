import { expect, test } from "bun:test";

import { CANVAS_IMAGE_PREVIEW_MAX_EDGE, fitsLocalPreview, getThumbnailDimensions, requiredImageLongEdge } from "../src/lib/image-thumbnail";

test("computes the long edge a node needs on screen", () => {
    expect(requiredImageLongEdge(340, 240, 1, 1)).toBe(340);
    expect(requiredImageLongEdge(340, 240, 1, 2)).toBe(680);
    // 画布放大后需要的像素超过本地 768 单档缩略图。
    expect(requiredImageLongEdge(340, 240, 1.5, 2)).toBe(1020);
});

test("local previews are only used while they hold enough pixels", () => {
    expect(fitsLocalPreview(680, CANVAS_IMAGE_PREVIEW_MAX_EDGE)).toBe(true);
    expect(fitsLocalPreview(1020, CANVAS_IMAGE_PREVIEW_MAX_EDGE)).toBe(false);
});

test("thumbnail dimensions never upscale", () => {
    expect(getThumbnailDimensions(4000, 3000)).toEqual({ width: 768, height: 576 });
    expect(getThumbnailDimensions(400, 300)).toEqual({ width: 400, height: 300 });
});
