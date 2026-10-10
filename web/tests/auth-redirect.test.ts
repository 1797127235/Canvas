import { expect, test } from "bun:test";

import { DEFAULT_AUTH_REDIRECT, getSafeAuthRedirect } from "../src/lib/auth-redirect";

test("keeps same-origin paths and query strings", () => {
    expect(getSafeAuthRedirect("/prompts?template=workflow#preview")).toBe("/prompts?template=workflow#preview");
});

test("rejects external and protocol-relative redirects", () => {
    expect(getSafeAuthRedirect("https://evil.example/account")).toBe(DEFAULT_AUTH_REDIRECT);
    expect(getSafeAuthRedirect("//evil.example/account")).toBe(DEFAULT_AUTH_REDIRECT);
    expect(getSafeAuthRedirect("/\\evil.example")).toBe(DEFAULT_AUTH_REDIRECT);
});
