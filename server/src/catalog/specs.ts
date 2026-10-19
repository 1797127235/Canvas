import type { CatalogModel } from "./catalog.js";
import { findModelSpec, type ModelsDevLoader } from "./models-dev.js";

// 只在目录展示时补参考规格；账号发现、生成和助手调用不依赖规格服务。
export async function withModelSpecs(models: CatalogModel[], loadSpecs?: ModelsDevLoader): Promise<CatalogModel[]> {
    if (!loadSpecs || !models.length) return models;
    try {
        const specs = await loadSpecs();
        return models.map(model => {
            const spec = findModelSpec(specs, model.upstreamModel, model.specProviderId);
            return spec ? { ...model, spec } : model;
        });
    } catch {
        return models;
    }
}
