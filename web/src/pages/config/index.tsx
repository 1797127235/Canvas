import { LockKeyhole } from "lucide-react";
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
        <main className="grid h-full place-items-center overflow-y-auto bg-background px-6">
            <section className="max-w-md text-center">
                <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                    <LockKeyhole className="size-5" />
                </div>
                <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">账号配置尚未开放</h1>
                <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">服务端账号配置完成后，这里会恢复 API Key 和模型设置。</p>
            </section>
        </main>
    );
}
