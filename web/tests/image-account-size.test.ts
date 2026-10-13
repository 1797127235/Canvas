import { expect, test } from "bun:test";

import { accountImageSize } from "../src/services/api/image";

test("账号模式 size：像素尺寸原样发送，比例字符串落 1K 档，超限直接报错", () => {
    expect(accountImageSize("auto")).toBeUndefined();
    expect(accountImageSize("")).toBeUndefined();
    // 分辨率=自动 + 比例 → 1K 档表格
    expect(accountImageSize("1:1")).toBe("1024x1024");
    expect(accountImageSize("16:9")).toBe("1536x864");
    expect(accountImageSize("9:16")).toBe("864x1536");
    // 分辨率档位与手动输入的像素尺寸原样发送，不做就近改写
    expect(accountImageSize("1024x1024")).toBe("1024x1024");
    expect(accountImageSize("2048x1152")).toBe("2048x1152");
    expect(accountImageSize("1360x2048")).toBe("1360x2048");
    expect(accountImageSize("3840x2160")).toBe("3840x2160");
    expect(accountImageSize("2048x1024")).toBe("2048x1024");
    // 超限：非 16 倍数、超长边、像素总量下限
    expect(() => accountImageSize("1000x1000")).toThrow();
    expect(() => accountImageSize("5000x5000")).toThrow();
    expect(() => accountImageSize("640x640")).toThrow();
});
