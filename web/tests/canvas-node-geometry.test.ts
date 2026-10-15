import { expect, test } from "bun:test";

import { MAX_EXPANDED_BATCH_CARDS, expandedCardPosition, nodeRenderBounds } from "../src/lib/canvas/canvas-node-geometry";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function imageBatchNode(count: number, position = { x: 0, y: 0 }): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Image,
        title: "batch",
        position,
        width: 340,
        height: 240,
        metadata: { images: Array.from({ length: count }, (_, index) => ({ id: `image-${index}`, content: `image-${index}.png`, status: "success" })) },
    };
}

test("expanded cards lay out on a grid outside the node", () => {
    const node = imageBatchNode(4);
    // 主图占第一格，展开卡片从第二格开始向右排。
    expect(expandedCardPosition(node, 0)).toEqual({ x: 358, y: 0 });
    expect(expandedCardPosition(node, 1)).toEqual({ x: 716, y: 0 });
    expect(expandedCardPosition(node, 2)).toEqual({ x: 1074, y: 0 });
});

test("collapsed nodes report their own bounds", () => {
    const node = imageBatchNode(15, { x: 100, y: 50 });
    expect(nodeRenderBounds(node, false)).toEqual({ left: 100, top: 50, right: 440, bottom: 290 });
});

test("expanded bounds cover the cards that are actually rendered", () => {
    const node = imageBatchNode(15, { x: 100, y: 50 });
    // 15 张 => 4 列 4 行，最多展开 8 张：占满第 1 行并铺开第 2 行前 4 格。
    expect(MAX_EXPANDED_BATCH_CARDS).toBe(8);
    expect(nodeRenderBounds(node, true)).toEqual({
        left: 100,
        top: 50 - 3 * 258,
        right: 100 + 1074 + 340,
        bottom: 290,
    });
});

test("expanded bounds extend above the node so offscreen cards still cull correctly", () => {
    const node = imageBatchNode(6, { x: 0, y: 0 });
    const bounds = nodeRenderBounds(node, true);
    expect(bounds.top).toBeLessThan(node.position.y);
    expect(bounds.right).toBeGreaterThan(node.position.x + node.width);
});
