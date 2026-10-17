import nodemailer from "nodemailer";

export type MailerConfig = {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
};

export type Mailer = {
    sendPasswordReset: (to: string, link: string) => Promise<void>;
};

export function createMailer(config: MailerConfig): Mailer {
    const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === 465,
        auth: { user: config.user, pass: config.password },
    });
    return {
        async sendPasswordReset(to, link) {
            await transport.sendMail({
                from: config.from,
                to,
                subject: "重置无限画布密码",
                text: `在浏览器中打开下面的链接设置新密码，链接 30 分钟内有效：\n\n${link}\n\n如果不是你本人操作，请忽略这封邮件。`,
            });
        },
    };
}
