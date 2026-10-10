import { LockKeyhole } from "lucide-react";
import { AccountCredentialsPanel } from "@/components/account/account-credentials-panel";
import { useTranslation } from "react-i18next";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { bypassLocalAuth } from "@/lib/auth-access";

export default function ConfigPage() {
    const { t } = useTranslation();

    if (bypassLocalAuth) {
        return (
            <main className="h-full overflow-y-auto bg-background">
                <div className="mx-auto max-w-6xl px-6 py-6">
                    <div className="mb-5">
                        <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("config.title")}</h1>
                        <p className="mt-1 text-sm text-stone-500">{t("config.description")}</p>
                    </div>
                    <AppConfigPanel />
                </div>
            </main>
        );
    }
    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-6xl px-6 py-6">
                <div className="mb-5">
                    <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">账号配置</h1>
                    <p className="mt-1 text-sm text-stone-500">服务端保存账号配置，旧本地渠道仍只在开发免登录模式使用。</p>
                </div>
                <AccountCredentialsPanel />
            </div>
        </main>
    );
}
