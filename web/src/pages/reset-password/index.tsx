import { Alert, App, Button, Form, Input } from "antd";
import { ArrowLeft, KeyRound } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useState } from "react";

import { confirmPasswordReset, IdentityApiError } from "@/services/api/identity";

export default function ResetPasswordPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const token = useSearchParams()[0].get("token") || "";
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async ({ password }: { password: string }) => {
        setSubmitting(true);
        setError(null);
        try {
            await confirmPasswordReset(token, password);
            message.success("密码已重置，请用新密码登录");
            navigate("/login", { replace: true });
        } catch (requestError) {
            const text = requestError instanceof IdentityApiError ? requestError.message : "重置失败，请检查网络后重试";
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
                        <KeyRound className="size-5" />
                    </div>
                    <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">设置新密码</h1>
                    <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">设置后该账号的其它登录状态会全部退出。</p>
                </div>
                {error ? <Alert className="mb-5" type="error" showIcon message={error} /> : null}
                {token ? (
                    <Form layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}>
                        <Form.Item label="新密码" name="password" rules={[
                            { required: true, min: 8, max: 128, message: "密码长度需为 8～128 个字符" },
                            { pattern: /^[\x21-\x7e]+$/, message: "密码不能包含空格、中文或控制字符" },
                        ]}>
                            <Input.Password size="large" autoComplete="new-password" placeholder="请输入新密码" />
                        </Form.Item>
                        <Form.Item label="确认新密码" name="confirm" dependencies={["password"]} rules={[
                            { required: true, message: "请再次输入新密码" },
                            ({ getFieldValue }) => ({
                                validator: (_rule, value) => !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致")),
                            }),
                        ]}>
                            <Input.Password size="large" autoComplete="new-password" placeholder="请再次输入新密码" />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
                            重置密码
                        </Button>
                    </Form>
                ) : (
                    <Alert type="error" showIcon message="重置链接无效" description={<Link to="/forgot-password">重新申请重置密码</Link>} />
                )}
            </section>
        </main>
    );
}
