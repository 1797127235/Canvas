import type { ReactNode } from "react";

import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasNodeResource = {
    kind: CanvasResourceKind;
    text?: string;
    url?: string;
};

// Static definitions for built-in canvas nodes. New node implementations can be added here without a remote plugin runtime.
export type CanvasNodeDefinition = {
    type: string;
    title: string;
    icon: ReactNode;
    description?: string;
    defaultSize: { width: number; height: number };
    defaultMetadata?: CanvasNodeMetadata;
    minimapColor?: string;
    showInCreateMenu?: boolean;
    hasSourceHandle?: boolean;
    keepAspectRatio?: (node: CanvasNodeData) => boolean;
    resource?: (node: CanvasNodeData) => CanvasNodeResource | null;
};
