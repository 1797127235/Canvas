import { Alert, App, Button, Form, Input } from "antd";
import { ArrowLeft, MailCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";

import { IdentityApiError, requestPasswordReset } from "@/services/api/identity";

export default function ForgotPasswordPage() {
    const { message } = App.useApp();
    const [submitting, setSubmitting] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async ({ email }: { email: string }) => {
        setSubmitting(true);
        setError(null);
        try {
            await requestPasswordReset(email);
            setSent(true);
        } catch (requestError) {
            const text = requestError instanceof IdentityApiError ? requestError.message : "请求失败，请检查网络后重试";
            setError(text);
            message.error(text);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="flex h-full items-center justify-center overflow-y-auto bg-background px-6 py-10">
            <section className="w-full max-w-[420px]">
                <Link to="/login" className="mb-10 inline-flex items-center gap-2 text-sm text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100">
                    <ArrowLeft className="size-4" />
                    返回登录
                </Link>
                <div className="mb-8">
                    <div className="mb-4 inline-flex size-10 items-center justify-center rounded-xl bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950">
                        <MailCheck className="size-5" />
                    </div>
                    <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">重置密码</h1>
                    <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">输入注册邮箱，我们会发送一条重置链接，30 分钟内有效。</p>
                </div>
                {error ? <Alert className="mb-5" type="error" showIcon message={error} /> : null}
                {sent ? (
                    <Alert type="success" showIcon message="如果该邮箱已注册，重置链接已发出" description="没有收到请检查垃圾邮件，或稍后重新申请。" />
                ) : (
                    <Form layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}>
                        <Form.Item label="邮箱" name="email" rules={[{ required: true, type: "email", transform: (value) => typeof value === "string" ? value.trim().toLowerCase() : value, message: "请输入有效邮箱" }]}>
                            <Input size="large" autoComplete="email" placeholder="name@example.com" />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
                            发送重置链接
                        </Button>
                    </Form>
                )}
            </section>
        </main>
    );
}
