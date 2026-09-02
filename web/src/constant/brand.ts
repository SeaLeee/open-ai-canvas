// web/src/constant/brand.ts
// 品牌常量集中管理 —— 换品牌只需改这里，其余文案逐步迁移到本文件引用。
// 注意：LICENSE / NOTICE 中的原版权声明（basketikun、ddcat）必须保留（MIT 协议义务）。
//
// 品牌名已定稿：ShotFlow（Shot = 分镜/镜头，Flow = 工作流），贴合「从分镜到成片」定位。
// 如需更换，只需改 name + logo，再全局搜 "ShotFlow" 替换，成本极低。
export const BRAND = {
    name: "ShotFlow",
    slogan: "从分镜到成片，一步到位",
    description: "AI 影视与短剧创作工作台",
    logo: "/logo.svg",
    website: "https://shotflow.example.com", // 上线前替换为真实域名
} as const;
