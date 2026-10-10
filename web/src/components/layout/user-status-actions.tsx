import type { CSSProperties } from "react";
import { DoorOpen, Keyboard, LogOut, Puzzle, Settings2, UserRoundPlus } from "lucide-react";
import { App, Button, Tooltip } from "antd";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { bypassLocalAuth, canAccessLocalFeatures } from "@/lib/auth-access";
import { useConfigStore } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [loggingOut, setLoggingOut] = useState(false);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const canvasTheme = canvasThemes[theme];
    const userStatus = useUserStore((state) => state.status);
    const user = useUserStore((state) => state.user);
    const logout = useUserStore((state) => state.logout);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const naturalIconClass =
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;

    const handleLogout = async () => {
        setLoggingOut(true);
        try {
            await logout();
        } catch {
            message.error("退出失败，请检查网络后重试");
        } finally {
            setLoggingOut(false);
        }
    };

    if (!canAccessLocalFeatures(userStatus)) {
        return (
            <div className="inline-flex shrink-0 items-center gap-1">
                <Tooltip title="登录">
                    <Link to="/login" className={naturalIconClass} style={iconStyle} aria-label="登录">
                        <DoorOpen className="size-4" />
                    </Link>
                </Tooltip>
                <Tooltip title="注册">
                    <Link to="/register" className={naturalIconClass} style={iconStyle} aria-label="注册">
                        <UserRoundPlus className="size-4" />
                    </Link>
                </Tooltip>
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
            </div>
        );
    }

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {user ? <span className="hidden max-w-40 truncate text-xs text-stone-500 lg:inline dark:text-stone-400">{user.email}</span> : null}
            {bypassLocalAuth ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")} title={t("navigation.config")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                    <Puzzle className="size-4" />
                </button>
            ) : null}

            <AnimatedThemeToggler
                theme={theme}
                onThemeChange={setTheme}
                className={naturalIconClass}
                style={iconStyle}
                aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
                title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
            />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {userStatus === "authenticated" ? (
                <Tooltip title="退出登录">
                    <Button type="text" shape="circle" className="!h-7 !w-7 !min-w-7" icon={<LogOut className="size-4" />} aria-label="退出登录" loading={loggingOut} onClick={() => void handleLogout()} />
                </Tooltip>
            ) : null}
        </div>
    );
}
