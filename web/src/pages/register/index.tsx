import { Alert, App, Button, Form, Input } from "antd";
import { ArrowLeft, UserRoundPlus } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";

import { getSafeAuthRedirect } from "@/lib/auth-redirect";
import { IdentityApiError } from "@/services/api/identity";
import { useUserStore } from "@/stores/use-user-store";

export default function RegisterPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const register = useUserStore((state) => state.register);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const redirect = getSafeAuthRedirect(new URLSearchParams(location.search).get("redirect"));

    const submit = async (values: { email: string; password: string; confirmPassword: string }) => {
        setSubmitting(true);
        setError(null);
        try {
            await register({ email: values.email, password: values.password });
            navigate(redirect, { replace: true });
        } catch (requestError) {
            const text = requestError instanceof IdentityApiError ? requestError.message : "注册失败，请检查网络后重试";
            setError(text);
            message.error(text);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="flex h-full items-center justify-center overflow-y-auto bg-background px-6 py-10">
            <section className="w-full max-w-[420px]">
                <Link to="/" className="mb-10 inline-flex items-center gap-2 text-sm text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100">
                    <ArrowLeft className="size-4" />
                    返回首页
                </Link>
                <div className="mb-8">
                    <div className="mb-4 inline-flex size-10 items-center justify-center rounded-xl bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950">
                        <UserRoundPlus className="size-5" />
                    </div>
                    <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">创建你的账号</h1>
                    <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">注册无限画布账号。</p>
                </div>
                {error ? <Alert className="mb-5" type="error" showIcon message={error} /> : null}
                <Form layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}>
                    <Form.Item label="邮箱" name="email" rules={[{ required: true, type: "email", transform: (value) => typeof value === "string" ? value.trim().toLowerCase() : value, message: "请输入有效邮箱" }]}>
                        <Input size="large" autoComplete="email" placeholder="name@example.com" />
                    </Form.Item>
                    <Form.Item
                        label="密码"
                        name="password"
                        extra="8～128 个英文、数字或符号，不含空格和中文"
                        rules={[
                            { required: true, min: 8, max: 128, message: "密码长度需为 8～128 个字符" },
                            { pattern: /^[\x21-\x7e]+$/, message: "密码只能包含英文、数字或符号，不能包含空格或中文" },
                        ]}
                    >
                        <Input.Password size="large" autoComplete="new-password" placeholder="请输入密码" />
                    </Form.Item>
                    <Form.Item
                        label="确认密码"
                        name="confirmPassword"
                        dependencies={["password"]}
                        rules={[
                            { required: true, message: "请再次输入密码" },
                            ({ getFieldValue }) => ({ validator: (_, value) => (!value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致"))) }),
                        ]}
                    >
                        <Input.Password size="large" autoComplete="new-password" placeholder="请再次输入密码" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
                        注册并开始
                    </Button>
                </Form>
                <p className="mt-6 text-center text-sm text-stone-500 dark:text-stone-400">
                    已有账号？{" "}
                    <Link to={`/login?redirect=${encodeURIComponent(redirect)}`} className="font-medium text-stone-950 underline underline-offset-4 dark:text-stone-100">
                        立即登录
                    </Link>
                </p>
            </section>
        </main>
    );
}
