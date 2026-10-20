# 网关与提供商扩展契约

## 目标

Gateway 是提供商扩展底座，不内置任何具体提供商。新增提供商时，只新增自包含 provider 包，并在 `server/src/gateway/providers.ts` 注册一次；不修改 Catalog schema、生成业务逻辑、任务恢复流程或其他 provider。

provider 包自带唯一 ID、模型发现解析器、可选的模型归属判定和能力实现。每项能力实现负责创建 AI SDK 模型、映射该能力的 provider options；视频能力额外负责 operation schema、下载器与必要的输入校验。共享上游目录中，provider 可在包内声明其负责的上游模型 ID；Catalog 显式 providerId 覆盖优先，其次由 provider 自我认领，最后才回退到 discoveryProviderId。provider 不得引用或硬编码其他 provider 的 ID。包不得依赖 Express、账号仓储、任务仓储或媒体表。

## 结构

```text
server/src/gateway/
  contracts.ts       # provider package 与 ModelBinding 公共契约
  registry.ts        # 通用注册、分发和 operation envelope 校验
  index.ts           # 业务侧唯一 gateway 入口
  providers.ts       # 应用组合入口；provider packages 仅在此注册
  providers/<id>/    # 新增的自包含 provider 包
  transport.ts       # 通用、安全的 HTTP transport
```

组合入口只注册实际部署的 provider 包；当前包含 C2A 与 AgnesAI。没有注册的 provider 仍会让模型发现、Catalog providerId 校验和模型调用明确失败；这不是兼容模式或默认协议。新数据库直接按目标任务结构建表，不对旧表或旧任务执行升级。

## 契约

`ProviderDefinition` 声明 `id`、可选 `discoverModels` 和由实现构成的 `capabilities`。能力实现本身就是支持能力清单，不再另存一份能力列表。

业务调用只使用 `ModelBinding`：`providerId`、`capability`、`upstreamModel` 和 `baseUrl`。provider-specific 参数由对应能力的 options hook 生成；通用生成模块不得比较具体 provider ID。

Catalog 的 providerId 及发现 provider 校验都由运行时 registry 派生。模型发现通过目录中的显式 `discoveryProviderId` 选择 provider；共享目录的模型生成先使用显式模型覆盖，再由注册 provider 自己认领模型，仍无人认领时使用发现 provider。最终生成仍按每个模型自身的 providerId 分发。

视频任务保存统一版本化 envelope：版本、binding 和 opaque operation。恢复时先校验通用 binding，再由对应 provider 包校验其 operation schema 并提供状态查询模型及结果下载器。运行时代码只接受目标 envelope；不转换或兼容任何旧任务记录。

## 扩展验收

新增 provider 包后只需在 `providers.ts` 注册一次，并同步 `catalog.example.json`、待测试记录和变更日志。测试应使用虚构 provider definition 验证注册后可用于 Catalog 校验、发现、能力分发和 operation 恢复；未知 provider、缺失能力及不合 schema 的 operation 必须拒绝。生产组合入口不得包含测试 provider 或默认厂商实现。
