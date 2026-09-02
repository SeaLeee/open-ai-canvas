/**
 * 图片审美评分系统（启发式 v1）
 *
 * 目标：对 AI 生成的图片产出 0-100 的审美分数，用于素材库排序、筛选与初筛，
 * 帮助创作者在批量生成的结果中快速定位"可用图"。
 *
 * 实现说明（重要）：
 * - v1 采用纯前端启发式：曝光/对比度/饱和度/色彩丰富度/清晰度/构图重心，
 *   无需模型调用、零成本、离线可用、确定性。
 * - 接口按"可替换"设计：后续如需接入 CLIP/审美预测模型（服务端批量评分），
 *   只需替换 computeImageAestheticScore 的实现，调用方（素材落库、资产库展示）
 *   无需改动。
 *
 * 评分维度与权重：
 * - 曝光健康度 25%：过曝/死黑占比惩罚，均值落在 [40, 220] 为健康区间
 * - 对比度     20%：亮度标准差，过低发灰、过高生硬，钟形打分
 * - 清晰度     25%：灰度梯度能量（锐度），模糊图直接低分
 * - 色彩丰富度 20%：Hasler-Süsstrunk colorfulness + 平均饱和度
 * - 构图重心   10%：边缘密度在画面三分中心区域的集中度（近似主体突出）
 */

export interface AestheticBreakdown {
    exposure: number;
    contrast: number;
    sharpness: number;
    colorfulness: number;
    composition: number;
}

export interface AestheticResult {
    score: number;
    breakdown: AestheticBreakdown;
    /** 评级：S ≥ 85, A ≥ 75, B ≥ 60, C < 60 */
    grade: "S" | "A" | "B" | "C";
    version: 1;
}

const MAX_DIMENSION = 256;
const scoreCache = new Map<string, AestheticResult | null>();

export function getCachedAestheticScore(url: string): AestheticResult | null {
    return scoreCache.get(url) ?? null;
}

export async function computeImageAestheticScore(url: string, signal?: AbortSignal): Promise<AestheticResult | null> {
    const cacheKey = url;
    if (scoreCache.has(cacheKey)) {
        return scoreCache.get(cacheKey) ?? null;
    }
    try {
        const image = await loadImage(url, signal);
        const { data, width, height } = rasterize(image);
        const result = scorePixels(data, width, height);
        scoreCache.set(cacheKey, result);
        return result;
    } catch {
        // 评分失败不阻塞素材落库主流程
        scoreCache.set(cacheKey, null);
        return null;
    }
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        const cleanup = () => {
            image.onload = null;
            image.onerror = null;
        };
        image.onload = () => {
            cleanup();
            resolve(image);
        };
        image.onerror = () => {
            cleanup();
            reject(new Error("aesthetic: image load failed"));
        };
        signal?.addEventListener(
            "abort",
            () => {
                cleanup();
                image.src = "";
                reject(new DOMException("aesthetic: aborted", "AbortError"));
            },
            { once: true },
        );
        image.src = url;
    });
}

function rasterize(image: HTMLImageElement): { data: Uint8ClampedArray; width: number; height: number } {
    const scale = Math.min(MAX_DIMENSION / (image.naturalWidth || 1), MAX_DIMENSION / (image.naturalHeight || 1), 1);
    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
        throw new Error("aesthetic: canvas 2d unavailable");
    }
    context.drawImage(image, 0, 0, width, height);
    return { data: context.getImageData(0, 0, width, height).data, width, height };
}

function scorePixels(data: Uint8ClampedArray, width: number, height: number): AestheticResult {
    const pixelCount = width * height;
    const gray = new Float32Array(pixelCount);
    let sum = 0;
    let clipped = 0;
    let saturationSum = 0;
    let rgSum = 0;
    let ybSum = 0;
    let rgSqSum = 0;
    let ybSqSum = 0;

    for (let i = 0; i < pixelCount; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        gray[i] = y;
        sum += y;
        if (y <= 4 || y >= 251) clipped++;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        saturationSum += max === 0 ? 0 : (max - min) / max;

        // Hasler-Süsstrunk colorfulness: rg = R-G, yb = 0.5(R+G)-B
        const rg = r - g;
        const yb = 0.5 * (r + g) - b;
        rgSum += rg;
        ybSum += yb;
        rgSqSum += rg * rg;
        ybSqSum += yb * yb;
    }

    const mean = sum / pixelCount;
    const variance = (() => {
        let acc = 0;
        for (let i = 0; i < pixelCount; i++) {
            const d = gray[i] - mean;
            acc += d * d;
        }
        return acc / pixelCount;
    })();
    const std = Math.sqrt(variance);

    // 曝光：均值健康区间 + 裁剪惩罚
    const meanHealth = 1 - Math.min(1, Math.abs(mean - 128) / 96);
    const clipRatio = clipped / pixelCount;
    const exposure = clamp01(meanHealth * (1 - Math.min(1, clipRatio * 4)));

    // 对比度：std 钟形（理想约 55-75）
    const contrast = clamp01(1 - Math.abs(std - 64) / 64);

    // 清晰度：平均梯度能量（Sobel 近似）
    const sharpness = clamp01(gradientEnergy(gray, width, height) / 26);

    // 色彩：colorfulness（理想约 40-110）+ 饱和度
    const rgMean = rgSum / pixelCount;
    const ybMean = ybSum / pixelCount;
    const rgStd = Math.sqrt(Math.max(0, rgSqSum / pixelCount - rgMean * rgMean));
    const ybStd = Math.sqrt(Math.max(0, ybSqSum / pixelCount - ybMean * ybMean));
    const colorfulnessRaw = Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);
    const colorfulness = clamp01(0.6 * bell(colorfulnessRaw, 72, 72) + 0.4 * clamp01((saturationSum / pixelCount) / 0.55));

    // 构图：中心三分区域边缘密度占比（主体突出近似）
    const composition = clamp01(centerEdgeConcentration(gray, width, height) * 1.35);

    const score = Math.round(
        clamp01(exposure * 0.25 + contrast * 0.2 + sharpness * 0.25 + colorfulness * 0.2 + composition * 0.1) * 100,
    );

    return {
        score,
        breakdown: {
            exposure: Math.round(exposure * 100),
            contrast: Math.round(contrast * 100),
            sharpness: Math.round(sharpness * 100),
            colorfulness: Math.round(colorfulness * 100),
            composition: Math.round(composition * 100),
        },
        grade: gradeOf(score),
        version: 1,
    };
}

function gradientEnergy(gray: Float32Array, width: number, height: number): number {
    if (width < 3 || height < 3) return 0;
    let acc = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const gx =
                -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] +
                gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1];
            const gy =
                -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
                gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
            acc += Math.sqrt(gx * gx + gy * gy);
            count++;
        }
    }
    return count === 0 ? 0 : acc / count;
}

function centerEdgeConcentration(gray: Float32Array, width: number, height: number): number {
    if (width < 9 || height < 9) return 0.5;
    const x0 = Math.floor(width / 3);
    const x1 = Math.ceil((width * 2) / 3);
    const y0 = Math.floor(height / 3);
    const y1 = Math.ceil((height * 2) / 3);
    const edge = (x: number, y: number) => {
        const i = y * width + x;
        return Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + width] - gray[i - width]);
    };
    let center = 0;
    let centerCount = 0;
    let total = 0;
    let totalCount = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const value = edge(x, y);
            total += value;
            totalCount++;
            if (x >= x0 && x < x1 && y >= y0 && y < y1) {
                center += value;
                centerCount++;
            }
        }
    }
    if (totalCount === 0 || centerCount === 0) return 0.5;
    const centerAvg = center / centerCount;
    const outerAvg = (total - center) / (totalCount - centerCount);
    if (outerAvg <= 0) return 1;
    return centerAvg / (centerAvg + outerAvg);
}

function bell(value: number, center: number, tolerance: number): number {
    return clamp01(1 - Math.abs(value - center) / tolerance);
}

function clamp01(value: number): number {
    if (Number.isNaN(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

function gradeOf(score: number): AestheticResult["grade"] {
    if (score >= 85) return "S";
    if (score >= 75) return "A";
    if (score >= 60) return "B";
    return "C";
}

/** 素材元数据中存储的审美字段 */
export interface AestheticMetadata {
    aestheticScore: number;
    aestheticGrade: AestheticResult["grade"];
    aestheticBreakdown: AestheticBreakdown;
    aestheticVersion: 1;
}

export function toAestheticMetadata(result: AestheticResult): AestheticMetadata {
    return {
        aestheticScore: result.score,
        aestheticGrade: result.grade,
        aestheticBreakdown: result.breakdown,
        aestheticVersion: 1,
    };
}
