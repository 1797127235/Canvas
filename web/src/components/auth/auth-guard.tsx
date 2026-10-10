import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";

import { bypassLocalAuth } from "@/lib/auth-access";
import { useUserStore } from "@/stores/use-user-store";

export function AuthGuard({ children, localData = false }: { children: ReactNode; localData?: boolean }) {
    const location = useLocation();
    const status = useUserStore((state) => state.status);

    if (bypassLocalAuth) return <>{children}</>;
    if (status === "loading") return <div className="grid h-full place-items-center bg-background text-sm text-stone-500">正在确认登录状态…</div>;
    if (status === "error") return <div className="grid h-full place-items-center bg-background px-6 text-center text-sm text-stone-500">暂时无法确认登录状态，请刷新重试。</div>;
    if (status !== "authenticated") return <Navigate to={`/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}${location.hash}`)}`} replace />;
    if (localData) return (
        <main className="grid h-full place-items-center bg-background px-6 text-center">
            <section>
                <h1 className="text-xl font-semibold">个人工作台尚未开放</h1>
                <p className="mt-2 text-sm text-stone-500">账号数据存储接入后开放，现有本地数据保持不变。</p>
                <Link to="/prompts" className="mt-4 inline-block text-sm underline underline-offset-4">浏览模板库</Link>
            </section>
        </main>
    );
    return <>{children}</>;
}
