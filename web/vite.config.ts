import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webDir = dirname(fileURLToPath(import.meta.url));
const appVersion = process.env.CANVAS_BUILD_VERSION?.trim() || readFileSync(resolve(webDir, "../VERSION"), "utf8").trim();
const appChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";

export default defineConfig({
    plugins: [react()],
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __APP_CHANGELOG__: JSON.stringify(appChangelog),
        "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    },
    server: {
        proxy: {
            "/api": {
                target: apiProxyTarget,
                changeOrigin: true,
                xfwd: true,
            },
            "/oauth/linuxdo/callback": {
                target: apiProxyTarget,
                changeOrigin: true,
                xfwd: true,
            },
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    build: {
        // 单 chunk 上限告警：超过 1.5MB 的 chunk 会在构建时提示，防止回归
        chunkSizeWarningLimit: 1536,
        rollupOptions: {
            output: {
                manualChunks(id: string) {
                    if (!id.includes("node_modules")) {
                        return undefined;
                    }
                    // 重型可视化引擎：仅在画布/3D 路由按需加载，独立分包提升缓存命中率
                    if (id.includes("three") || id.includes("@react-three") || id.includes("fiber")) {
                        return "vendor-three";
                    }
                    if (id.includes("tldraw")) {
                        return "vendor-tldraw";
                    }
                    if (id.includes("excalidraw")) {
                        return "vendor-excalidraw";
                    }
                    if (id.includes("leafer")) {
                        return "vendor-leafer";
                    }
                    // 富文本/编辑器
                    if (id.includes("@tiptap") || id.includes("codemirror") || id.includes("@lezer")) {
                        return "vendor-editor";
                    }
                    // 媒体处理
                    if (id.includes("ffmpeg") || id.includes("mediapipe") || id.includes("@vidstack")) {
                        return "vendor-media";
                    }
                    // UI 框架：antd 体积大且几乎每路由都用，独立分包便于长缓存
                    if (id.includes("antd") || id.includes("@ant-design") || id.includes("rc-")) {
                        return "vendor-antd";
                    }
                    // React 核心 + 状态/数据层
                    if (
                        id.includes("react") ||
                        id.includes("scheduler") ||
                        id.includes("@tanstack") ||
                        id.includes("zustand") ||
                        id.includes("axios")
                    ) {
                        return "vendor-react";
                    }
                    // 其余三方依赖统一兜底，避免散落小 chunk
                    return "vendor-misc";
                },
            },
        },
    },
});
