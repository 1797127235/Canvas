import { useEffect, useState } from "react";
import { Alert, Button, Input, Select, Space } from "antd";

import { clearCredential, getCredential, saveBaseUrl, saveCredential, type CredentialStatus } from "@/services/api/account";
import { useCatalogStore } from "@/stores/use-catalog-store";
import { useConfigStore, type ModelCapability } from "@/stores/use-config-store";

const modelFields = [
    { capability: "image", field: "imageModel", label: "图片模型" },
    { capability: "video", field: "videoModel", label: "视频模型" },
    { capability: "text", field: "textModel", label: "文本模型" },
    { capability: "audio", field: "audioModel", label: "音频模型" },
] as const satisfies ReadonlyArray<{ capability: ModelCapability; field: string; label: string }>;

export function AccountCredentialsPanel() {
    const [key, setKey] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [status, setStatus] = useState<CredentialStatus | null>(null);
    const { models, status: catalogStatus, error: catalogError, load, reset } = useCatalogStore();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [notice, setNotice] = useState<{ text: string; type: "success" | "error" } | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let active = true;
        void getCredential().then((value) => {
            if (!active) return;
            setStatus(value);
            setBaseUrl(value.baseUrl ?? "");
        }).catch((error) => {
            if (active) setNotice({ text: error instanceof Error ? error.message : "账号配置读取失败", type: "error" });
        });
        return () => { active = false; };
    }, []);
    const save = async () => {
        if (!key.trim()) return;
        setBusy(true);
        try {
            await saveCredential(key.trim());
            setKey("");
            setStatus(await getCredential());
            reset();
            await load();
            setNotice({ text: "API Key 已保存", type: "success" });
        } catch (error) {
            setNotice({ text: error instanceof Error ? error.message : "API Key 保存失败", type: "error" });
        } finally {
            setBusy(false);
        }
    };
    const saveUpstream = async () => {
        setBusy(true);
        try {
            await saveBaseUrl(baseUrl.trim());
            const next = await getCredential();
            setStatus(next);
            setBaseUrl(next.baseUrl ?? "");
            // 换了上游就得重新按新地址发现模型。
            reset();
            await load();
            setNotice({ text: "上游地址已保存", type: "success" });
        } catch (error) {
            setNotice({ text: error instanceof Error ? error.message : "上游地址保存失败", type: "error" });
        } finally {
            setBusy(false);
        }
    };
    const clear = async () => {
        setBusy(true);
        try {
            await clearCredential();
            reset();
            setKey("");
            setBaseUrl("");
            setStatus({ configured: false, masked: null, baseUrl: null });
            setNotice({ text: "API Key 已清除", type: "success" });
        } catch (error) {
            setNotice({ text: error instanceof Error ? error.message : "API Key 清除失败", type: "error" });
        } finally {
            setBusy(false);
        }
    };
    return <section className="max-w-xl space-y-5">
        {notice ? <Alert title={notice.text} type={notice.type} showIcon /> : null}
        <div>
            <h2 className="text-base font-semibold">账号 API Key</h2>
            <p className="mt-1 text-sm text-muted-foreground">Key 在服务端加密保存。所有生成使用这一把 Key，可用模型从上游读取。</p>
        </div>
        <Space.Compact block>
            <Input.Password disabled={busy} value={key} onChange={(event) => setKey(event.target.value)} placeholder={status?.configured ? `当前：${status.masked}` : "输入 API Key"} onPressEnter={() => void save()} />
            <Button type="primary" loading={busy} disabled={!key.trim()} onClick={() => void save()}>保存</Button>
        </Space.Compact>
        <Button danger disabled={!status?.configured || busy} onClick={() => void clear()}>清除 API Key</Button>
        <div>
            <h2 className="text-base font-semibold">上游地址</h2>
            <p className="mt-1 text-sm text-muted-foreground">留空使用部署配置的默认上游。需带路径前缀，例如 https://api.example.com/v1。</p>
        </div>
        <Space.Compact block>
            <Input disabled={busy || !status?.configured} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="留空使用默认上游地址" onPressEnter={() => void saveUpstream()} />
            <Button loading={busy} disabled={!status?.configured || baseUrl.trim() === (status.baseUrl ?? "")} onClick={() => void saveUpstream()}>保存</Button>
        </Space.Compact>
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">上游模型</h2>
                <Button type="text" loading={catalogStatus === "loading"} disabled={!status?.configured || busy} onClick={() => { reset(); void load(); }}>刷新模型</Button>
            </div>
            {status?.configured && catalogError ? <Alert title={catalogError} type="error" showIcon /> : null}
            {modelFields.map(({ capability, field, label }) => {
                const options = models.filter((model) => model.capability === capability).map((model) => ({ value: model.id, label: model.name }));
                return <label key={field} className="block space-y-1">
                    <span className="text-sm">{label}</span>
                    <Select className="w-full" showSearch optionFilterProp="label" value={options.some((item) => item.value === config[field]) ? config[field] : options[0]?.value} options={options} placeholder="上游暂无此类模型" disabled={busy || !options.length} onChange={(value) => updateConfig(field, value)} />
                </label>;
            })}
            <p className="text-xs text-muted-foreground">视频继续使用原生清晰度、比例、时长、参考模式、声音和水印设置，实际支持范围由所选上游模型决定。</p>
        </div>
    </section>;
}
