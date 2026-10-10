import type { ReactNode } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AuthGuard } from "@/components/auth/auth-guard";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import RegisterPage from "@/pages/register";
import VideoPage from "@/pages/video";

function Protected({ children }: { children: ReactNode }) {
    return <AuthGuard>{children}</AuthGuard>;
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/login", element: <LoginPage /> },
            { path: "/register", element: <RegisterPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/image", element: <Protected><ImagePage /></Protected> },
            { path: "/video", element: <Protected><VideoPage /></Protected> },
            { path: "/assets", element: <Protected><AssetsPage /></Protected> },
            { path: "/canvas", element: <Protected><CanvasPage /></Protected> },
            { path: "/canvas/:id", element: <Protected><CanvasProjectPage /></Protected> },
            { path: "/config", element: <Protected><ConfigPage /></Protected> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
