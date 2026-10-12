import { z } from "zod";
import { bypassLocalAuth } from "@/lib/auth-access";
import { useUserStore } from "@/stores/use-user-store";
import { setImageBlob, uploadImage } from "@/services/image-storage";
import { setMediaBlob, uploadMediaFile } from "@/services/file-storage";

type PackageFile = { path: string; storageKey: string; mimeType: string };
type PackageValue = string | number | boolean | null | PackageValue[] | { [key: string]: PackageValue };
const jsonSchema: z.ZodType<PackageValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(jsonSchema)]));

export async function importPackageMedia<T>(data: T, files: PackageFile[], zip: Map<string, Blob>): Promise<T> {
    const userId = useUserStore.getState().user?.id;
    const replacements = new Map<string, { storageKey: string; url: string }>();
    await Promise.all(files.map(async (item) => {
        const file = zip.get(item.path);
        if (!file) throw new Error("导入包缺少媒体文件");
        const blob = file.slice(0, file.size, item.mimeType || file.type);
        if (bypassLocalAuth) {
            await (blob.type.startsWith("image/") ? setImageBlob(item.storageKey, blob) : setMediaBlob(item.storageKey, blob));
            return undefined;
        }
        const stored = blob.type.startsWith("image/") ? await uploadImage(blob) : await uploadMediaFile(blob);
        if (stored.storageKey) replacements.set(item.storageKey, { storageKey: stored.storageKey, url: stored.url });
        return undefined;
    }));
    if (bypassLocalAuth) return data;
    if (!userId || userId !== useUserStore.getState().user?.id) throw new Error("账号已切换，导入已取消");
    const replace = (value: PackageValue): PackageValue => {
        if (typeof value === "string") {
            const file = replacements.get(value);
            if (file) return file.storageKey;
            if (value.startsWith("/api/media/")) return replacements.get(`remote:${value.slice("/api/media/".length)}`)?.url || value;
            return value;
        }
        if (Array.isArray(value)) return value.map(replace);
        if (!value || typeof value !== "object") return value;
        const record = value;
        const file = typeof record.storageKey === "string" ? replacements.get(record.storageKey) : undefined;
        const result = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, replace(item)]));
        if (file) for (const field of ["content", "dataUrl", "url"]) {
            if (field in record) result[field] = file.url;
        }
        return result;
    };
    return replace(jsonSchema.parse(data)) as T;
}
