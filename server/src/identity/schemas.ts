import { z } from "zod";

export const passwordSchema = z.string().regex(/^[\x21-\x7E]{8,128}$/);

export function normalizeEmail(value: string) {
    return value.trim().toLowerCase();
}
