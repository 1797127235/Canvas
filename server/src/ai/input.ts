import { z } from "zod";

// 账号模式下的素材身份：浏览器只提交 remote:<uuid>，字节由服务端从 user_media 读取。
// 这里不再接受内联 data URL——那会让每次生成都把全部素材重传一遍（实测单次 29.5MB）。
export const mediaRef = z.string().regex(/^remote:[0-9a-f-]{36}$/);
export function mediaRefId(ref: string) {
    return ref.slice("remote:".length);
}

const imageInput = z.strictObject({
    prompt: z.string().min(1), n: z.number().int().positive().optional(),
    size: z.string().regex(/^\d+x\d+$/).optional(), quality: z.string().optional(), background: z.string().optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(), images: z.array(mediaRef).optional(),
});
const videoInput = z.strictObject({
    prompt: z.string().min(1), seconds: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    size: z.string().regex(/^\d+x\d+$/).optional(), resolution_name: z.string().optional(),
    generate_audio: z.boolean().optional(), watermark: z.boolean().optional(), mode: z.enum(["frames", "reference"]).optional(),
    images: z.array(mediaRef).optional(), videos: z.array(mediaRef).optional(), audios: z.array(mediaRef).optional(),
});
const textInput = z.strictObject({
    messages: z.array(z.strictObject({
        role: z.enum(["system", "user", "assistant"]),
        content: z.union([z.string(), z.array(z.discriminatedUnion("type", [
            z.strictObject({ type: z.literal("text"), text: z.string() }),
            z.strictObject({ type: z.literal("image_url"), image_url: z.strictObject({ url: z.string() }) }),
        ]))]),
    })).min(1),
    stream: z.boolean().optional(), reasoning_effort: z.string().optional(),
});
const speechInput = z.strictObject({
    input: z.string().min(1), voice: z.string().min(1), response_format: z.string().optional(),
    speed: z.number().positive().optional(), instructions: z.string().optional(),
});
// 任务号由前端预先生成并随请求提交：节点在发起请求时就已经持有任务号，
// 刷新后即可凭它恢复，不必等待建任务响应（上游模型发现可能耗时数秒）。
const taskIdField = { taskId: z.string().uuid().optional() };
export const generationInput = z.discriminatedUnion("capability", [
    z.strictObject({ capability: z.literal("image"), ...taskIdField, modelId: z.string().min(1), input: imageInput }),
    z.strictObject({ capability: z.literal("video"), ...taskIdField, modelId: z.string().min(1), input: videoInput }),
    z.strictObject({ capability: z.literal("text"), modelId: z.string().min(1), input: textInput }),
    z.strictObject({ capability: z.literal("audio"), modelId: z.string().min(1), input: speechInput }),
]);
export type ImageInput = z.infer<typeof imageInput>;
export type VideoInput = z.infer<typeof videoInput>;
export type TextInput = z.infer<typeof textInput>;
export type SpeechInput = z.infer<typeof speechInput>;
