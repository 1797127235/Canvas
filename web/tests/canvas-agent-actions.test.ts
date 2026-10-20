import { expect, test } from "bun:test";

import { mergeNodePatch } from "../src/pages/canvas/hooks/use-canvas-agent-actions";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = (): CanvasNodeData => ({
    id: "n1",
    type: CanvasNodeType.Text,
    title: "原标题",
    position: { x: 10, y: 20 },
    width: 200,
    height: 100,
    metadata: { content: "原正文", prompt: "原提示词" },
});

test("only the provided fields change", () => {
    const next = mergeNodePatch(node(), { title: "新标题" });

    expect(next.title).toBe("新标题");
    expect(next.position).toEqual({ x: 10, y: 20 });
    expect(next.metadata).toEqual({ content: "原正文", prompt: "原提示词" });
});

test("prompt and content are both applied when sent together", () => {
    // 回归用例：早期用条件展开写 metadata，两个字段同时传时后者覆盖前者，prompt 会被静默丢弃。
    const next = mergeNodePatch(node(), { prompt: "新提示词", content: "新正文" });

    expect(next.metadata).toEqual({ content: "新正文", prompt: "新提示词" });
});

test("metadata is copied instead of mutated in place", () => {
    const original = node();
    const next = mergeNodePatch(original, { content: "新正文" });

    expect(next).not.toBe(original);
    expect(next.metadata).not.toBe(original.metadata);
    expect(original.metadata).toEqual({ content: "原正文", prompt: "原提示词" });
});

test("an empty patch leaves the node untouched", () => {
    const original = node();
    const next = mergeNodePatch(original, {});

    expect(next).toEqual(original);
    expect(next).not.toBe(original);
});
