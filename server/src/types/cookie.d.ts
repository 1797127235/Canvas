declare module "cookie" {
    export type SerializeOptions = {
        httpOnly?: boolean;
        maxAge?: number;
        path?: string;
        sameSite?: boolean | "lax" | "strict" | "none";
        secure?: boolean;
    };

    export function parse(header: string, options?: { decode?: (value: string) => string }): Record<string, string | undefined>;
    export function serialize(name: string, value: string, options?: SerializeOptions): string;
}
