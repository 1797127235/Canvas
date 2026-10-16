import { expect, test } from "bun:test";

import { accountMediaPreviewTier, accountMediaPreviewUrl } from "../src/services/api/media";

const storageKey = "remote:123e4567-e89b-12d3-a456-426614174000";

test("normalizes account preview requests to server tiers", () => {
    expect(accountMediaPreviewTier()).toBe(512);
    expect(accountMediaPreviewTier(0)).toBe(512);
    expect(accountMediaPreviewTier(512)).toBe(512);
    expect(accountMediaPreviewTier(513)).toBe(1024);
    expect(accountMediaPreviewTier(1024)).toBe(1024);
    expect(accountMediaPreviewTier(1025)).toBe(2048);
    expect(accountMediaPreviewTier(10000)).toBe(2048);
});

test("uses one canonical URL for each preview tier", () => {
    expect(accountMediaPreviewUrl(storageKey)).toBe(`/api/media/${storageKey.slice("remote:".length)}/preview?w=512`);
    expect(accountMediaPreviewUrl(storageKey, 181)).toBe(accountMediaPreviewUrl(storageKey, 512));
    expect(accountMediaPreviewUrl(storageKey, 186)).toBe(accountMediaPreviewUrl(storageKey, 512));
    expect(accountMediaPreviewUrl(storageKey, 1020)).toBe(accountMediaPreviewUrl(storageKey, 1024));
    expect(accountMediaPreviewUrl("image:local", 512)).toBe("");
});
