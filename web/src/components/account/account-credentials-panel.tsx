import { useEffect, useState } from "react";
import { Alert, Button, Input, Space } from "antd";

import { clearCredential, getCredential, saveCredential } from "@/services/api/account";
import { fetchServerModels, type PublicModel } from "@/services/api/catalog";

export function AccountCredentialsPanel() {
    const [key, setKey] = useState("");
    const [status, setStatus] = useState<{ configured: boolean; masked: string | null } | null>(null);
    const [models, setModels] = useState<PublicModel[]>([]);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        void Promise.all([getCredential(), fetchServerModels()]).then(([credential, serverModels]) => {
            setStatus(credential);
            setModels(serverModels);
        }).catch((error) => setMessage(error instanceof Error ? error.message : "账号配置读取失败"));
    }, []);
    const save = async () => {
        if (!key.trim()) return;
        setBusy(true);
        try {
            await saveCredential(key);
            setStatus({ configured: true, masked: `${key.slice(0, 4)}••••${key.slice(-4)}` });
            setKey("");
            setMessage("API Key 已保存");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "API Key 保存失败");
        } finally {
            setBusy(false);
        }
    };
    const clear = async () => {
        setBusy(true);
        try {
            await clearCredential();
            setStatus({ configured: false, masked: null });
            setMessage("API Key 已清除");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "API Key 清除失败");
        } finally {
            setBusy(false);
        }
    };
    return <section className="max-w-xl space-y-5">
        {message ? <Alert message={message} type={message.includes("失败") ? "error" : "success"} showIcon /> : null}
        <div>
            <h2 className="text-base font-semibold">账号 API Key</h2>
            <p className="mt-1 text-sm text-stone-500">Key 只在服务端加密保存，页面不会重新显示完整内容。</p>
        </div>
        <Space.Compact block>
            <Input.Password value={key} onChange={(event) => setKey(event.target.value)} placeholder={status?.configured ? `当前：${status.masked}` : "输入 API Key"} />
            <Button type="primary" loading={busy} disabled={!key.trim()} onClick={() => void save()}>保存</Button>
        </Space.Compact>
        <Button danger disabled={!status?.configured || busy} onClick={() => void clear()}>清除 API Key</Button>
        <div>
            <h2 className="text-base font-semibold">服务端模型</h2>
            {models.length ? <ul className="mt-2 space-y-1 text-sm text-stone-600 dark:text-stone-300">{models.map((model) => <li key={model.id}>{model.name} · {model.capability}</li>)}</ul> : <p className="mt-2 text-sm text-stone-500">管理员尚未配置可用模型。</p>}
        </div>
    </section>;
}
