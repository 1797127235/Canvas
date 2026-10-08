# Spec: 模板库入口

## Objective

把现有「提示词库」入口改成「模板库」。现有提示词继续按原数据展示，并归入「提示词」分类；新增空的「画布」分类。点击提示词后的复制、详情和加入素材保持不变。

本阶段不实现画布模板的保存、只读展示和「生同款」。

## Assumptions

1. 路由继续使用 `/prompts`，不新增地址。
2. 顶部导航、页面标题和首页入口文案改为「模板库」。
3. 提示词来源、缓存和数据结构不改。
4. 「画布」分类先只显示空状态。
5. 页面只使用简体中文。

## Tech Stack

- React 19、TypeScript、Vite、React Router、Ant Design、Tailwind、Zustand。
- 文案集中在 `web/src/i18n/locales/zh-CN.ts`。

## Commands

```bash
cd web
bun run dev
bun run typecheck
bun test
```

本阶段不执行构建。

## Project Structure

- `web/src/constant/navigation-tools.ts`：顶部导航入口。
- `web/src/pages/prompts/index.tsx`：模板库页面。
- `web/src/i18n/locales/zh-CN.ts`：导航、标题和分类文案。
- `web/src/services/api/prompts.ts`：现有提示词数据，本阶段不改格式。

## Code Style

沿用现有函数组件和文案键。页面文案不直接写死，新增分类文案放进 `prompts` 文案对象。

```tsx
<h1>{t("prompts.title")}</h1>
<PromptFilter label={t("prompts.kind")} options={kindOptions} selected={selectedKind} onChange={setSelectedKind} />
```

## Testing Strategy

本阶段以手动验证为主。现有 `bun test` 不需要新增测试；不修改提示词解析和缓存。

## Boundaries

- Always：只改模板库入口、标题和分类；提示词点击行为保持不变。
- Ask first：修改 `/prompts` 路由、提示词来源格式或画布数据结构。
- Never：本阶段实现画布模板存储、只读画布或「生同款」。

## Success Criteria

- 顶部导航显示「模板库」，不再显示「提示词库」。
- 页面标题显示「模板库」，现有提示词数量和内容保持不变。
- 分类包含「提示词」和「画布」。
- 选择「提示词」时展示现有提示词；选择「画布」时显示空状态。
- 打开提示词详情、复制提示词和加入素材的行为不变。

## Open Questions

- 数量文案是继续显示「当前共 N 条提示词」，还是改为「当前共 N 条模板」。
