import crypto from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { createOpenAiClient, readLlmRuntimeConfig } from "../config/llm-provider.js";
import { getAppConfig } from "../config/env.js";
import type { VideoMotionPlan, VideoProjectDetail, VideoProjectSegmentSummary, VideoRenderBuilder } from "@zhihu-mvp/shared";
import type { VideoRepository } from "./video-repository.js";
import { buildVideoMotionPlan } from "./video-motion-planner.js";

const execAsync = promisify(exec);
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;

function uniqueAssetPath(storage: VideoAssetStorage, projectId: string, folder: string, prefix: string, extension: string) {
  return path.join(storage.getProjectDir(projectId), folder, `${prefix}-${crypto.randomUUID()}${extension}`);
}

export class VideoAssetStorage {
  constructor(private readonly rootDir = getAppConfig().videoDir) {}

  getProjectDir(projectId: string) {
    return path.join(this.rootDir, projectId);
  }

  async ensureProjectDir(projectId: string) {
    const projectDir = this.getProjectDir(projectId);
    await fs.mkdir(path.join(projectDir, "audio"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "visuals"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "subtitles"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "renders"), { recursive: true });
    return projectDir;
  }

  async ensureFeedbackDir() {
    const dir = path.join(this.rootDir, "feedback");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
}

export class VoiceRenderWorker {
  constructor(
    private readonly repository: VideoRepository,
    private readonly storage = new VideoAssetStorage()
  ) {}

  async renderProject(project: VideoProjectDetail) {
    const config = getAppConfig();
    await this.storage.ensureProjectDir(project.id);

    for (const segment of project.segments) {
      const active = await this.repository.getActiveAsset(project.id, segment.id, "voice");
      if (active) {
        continue;
      }

      await this.repository.updateSegmentStatus(segment.id, "voice_rendering");
      try {
        const outputPath = uniqueAssetPath(this.storage, project.id, "audio", `${segment.order}-${segment.id}-voice`, ".wav");
        if (config.videoRenderMock) {
          await writeSilentWav(outputPath, segment.durationSec);
        } else {
          await assertGpuAvailable(config.cosyGpuCheckCommand);
          await renderWithCosy(segment, outputPath, config);
        }

        const stat = await fs.stat(outputPath);
        const durationMs = config.videoRenderMock
          ? segment.durationSec * 1000
          : ((await readWavDurationMs(outputPath)) ?? segment.durationSec * 1000);
        await this.repository.createAsset({
          projectId: project.id,
          segmentId: segment.id,
          assetType: "voice",
          filePath: outputPath,
          mimeType: "audio/wav",
          durationMs,
          metadata: {
            bytes: stat.size,
            plannedDurationMs: segment.durationSec * 1000,
            renderer: config.videoRenderMock ? "mock" : "cosy"
          }
        });
        await this.repository.updateSegmentStatus(segment.id, "voice_ready");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.updateSegmentStatus(segment.id, "failed", message);
        throw new Error(`Voice render failed for segment ${segment.segmentKey}: ${message}`);
      }
    }
  }
}

export class ImageRenderWorker {
  constructor(
    private readonly repository: VideoRepository,
    private readonly storage = new VideoAssetStorage()
  ) {}

  async renderImage(projectId: string, segment: VideoProjectSegmentSummary) {
    const config = getAppConfig();
    const outputPath = uniqueAssetPath(this.storage, projectId, "visuals", `${segment.order}-${segment.id}-image`, ".png");
    if (config.videoRenderMock) {
      await writeVectorTextPng(outputPath, segment.title, segment.subtitle);
    } else {
      const prompt = `${segment.imagePrompt}

Horizontal 16:9 composition, 1920x1080 final usage, no vertical layout. Use a clean vector-style product explainer look with crisp shapes, restrained colors, and clear visual hierarchy. The image must support the spoken content, not be a generic background. Leave clean negative space for deterministic Chinese text overlays. Do not render readable text, dense illegible text, exchange trading buttons, or profit-guarantee claims.`;
      const imageBytes = await generateImageBytes(prompt, config.videoImageModel, config.videoImageSize);
      await sharp(imageBytes).resize(VIDEO_WIDTH, VIDEO_HEIGHT, { fit: "cover" }).png().toFile(outputPath);
      await addGptImageOverlay(outputPath, segment.title, segment.subtitle);
    }

    await this.repository.createAsset({
      projectId,
      segmentId: segment.id,
      assetType: "image",
      builder: "gpt_image",
      filePath: outputPath,
      mimeType: "image/png",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      replaceSegmentVisuals: true,
      metadata: {
        prompt: segment.imagePrompt
      }
    });
  }
}

export class ChartRenderWorker {
  constructor(
    private readonly repository: VideoRepository,
    private readonly storage = new VideoAssetStorage()
  ) {}

  async renderChart(projectId: string, segment: VideoProjectSegmentSummary, chartSpec: Record<string, unknown> | null) {
    const config = getAppConfig();
    if (!chartSpec || Object.keys(chartSpec).length === 0) {
      throw new Error("Hyperframe chart builder requires chartSpec with a data source.");
    }
    if (!config.hyperframeBaseUrl) {
      throw new Error("HYPERFRAME_BASE_URL is not configured. Change the segment builder or configure Hyperframe.");
    }

    const outputPath = uniqueAssetPath(this.storage, projectId, "visuals", `${segment.order}-${segment.id}-chart`, ".png");
    const response = await fetch(`${config.hyperframeBaseUrl.replace(/\/+$/, "")}/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        chartSpec,
        title: segment.title
      })
    });

    if (!response.ok) {
      throw new Error(`Hyperframe render failed: HTTP ${response.status} ${await response.text()}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { filePath?: string; imageBase64?: string };
      if (payload.filePath) {
        await fs.copyFile(payload.filePath, outputPath);
      } else if (payload.imageBase64) {
        await fs.writeFile(outputPath, Buffer.from(payload.imageBase64, "base64"));
      } else {
        throw new Error("Hyperframe JSON response did not include filePath or imageBase64.");
      }
    } else {
      const bytes = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(outputPath, bytes);
    }

    const normalized = await sharp(outputPath).resize(VIDEO_WIDTH, VIDEO_HEIGHT, { fit: "cover" }).png().toBuffer();
    await fs.writeFile(outputPath, normalized);
    await this.repository.createAsset({
      projectId,
      segmentId: segment.id,
      assetType: "chart",
      builder: "hyperframe",
      filePath: outputPath,
      mimeType: "image/png",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      replaceSegmentVisuals: true,
      metadata: {
        chartSpec
      }
    });
  }
}

export class RemotionCardBuilder {
  constructor(
    private readonly repository: VideoRepository,
    private readonly storage = new VideoAssetStorage()
  ) {}

  async renderCard(projectId: string, segment: VideoProjectSegmentSummary, builder: VideoRenderBuilder = "remotion_card") {
    const outputPath = uniqueAssetPath(this.storage, projectId, "visuals", `${segment.order}-${segment.id}-card`, ".png");
    await writeVectorTextPng(outputPath, segment.title, segment.subtitle);
    await this.repository.createAsset({
      projectId,
      segmentId: segment.id,
      assetType: "text_card",
      builder,
      filePath: outputPath,
      mimeType: "image/png",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      replaceSegmentVisuals: true,
      metadata: {
        cardType: "mvp_text_card"
      }
    });
  }
}

export class VisualRenderWorker {
  private readonly imageWorker: ImageRenderWorker;
  private readonly chartWorker: ChartRenderWorker;
  private readonly cardBuilder: RemotionCardBuilder;

  constructor(
    private readonly repository: VideoRepository,
    private readonly storage = new VideoAssetStorage()
  ) {
    this.imageWorker = new ImageRenderWorker(repository, storage);
    this.chartWorker = new ChartRenderWorker(repository, storage);
    this.cardBuilder = new RemotionCardBuilder(repository, storage);
  }

  async renderProject(project: VideoProjectDetail) {
    if (!project.visualRenderPlan) {
      throw new Error("Visual render plan is missing.");
    }

    for (const segment of project.segments) {
      const voiceAsset = await this.repository.getActiveAsset(project.id, segment.id, "voice");
      if (!voiceAsset || !voiceAsset.durationMs || voiceAsset.durationMs <= 0) {
        await this.repository.updateSegmentStatus(
          segment.id,
          "voice_pending",
          "Voice asset with real duration is required before visual render."
        );
        throw new Error(`Visual render requires a voice asset with real duration for segment ${segment.segmentKey}.`);
      }

      const active = await findActiveVisual(this.repository, project.id, segment.id);
      if (active) {
        continue;
      }

      const planSegment = project.visualRenderPlan.segments.find((item) => item.segmentId === segment.segmentKey);
      const builder = planSegment?.builder ?? segment.visualBuilder ?? "remotion_card";
      await this.repository.updateSegmentStatus(segment.id, "visual_rendering");
      try {
        if (builder === "gpt_image") {
          await this.imageWorker.renderImage(project.id, segment);
        } else if (builder === "hyperframe") {
          await this.chartWorker.renderChart(project.id, segment, planSegment?.chartSpec ?? null);
        } else if (builder === "existing_asset") {
          throw new Error("existing_asset builder requires a confirmed active asset; MVP does not auto-select one.");
        } else if (builder === "mixed") {
          await this.imageWorker.renderImage(project.id, segment);
          if (planSegment?.chartSpec) {
            await this.chartWorker.renderChart(project.id, segment, planSegment.chartSpec);
          }
        } else {
          await this.cardBuilder.renderCard(project.id, segment);
        }
        await this.repository.updateSegmentStatus(segment.id, "visual_ready");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.updateSegmentStatus(segment.id, "failed", message);
        throw new Error(`Visual render failed for segment ${segment.segmentKey}: ${message}`);
      }
    }
  }
}

export class VideoComposerWorker {
  constructor(
    private readonly repository: VideoRepository,
    private readonly storage = new VideoAssetStorage()
  ) {}

  async compose(project: VideoProjectDetail) {
    const config = getAppConfig();
    assertCompositionReady(project);
    const projectDir = await this.storage.ensureProjectDir(project.id);
    const renderDir = path.join(projectDir, "renders");
    const renderId = crypto.randomUUID();
    const subtitlePath = path.join(projectDir, "subtitles", `subtitles-${renderId}.srt`);
    const motionPlanPath = path.join(renderDir, `motion-plan-${renderId}.json`);
    const compositionPath = path.join(renderDir, `composition-${renderId}.json`);
    const outputPath = path.join(renderDir, `final-${renderId}.mp4`);
    const latestOutputPath = path.join(renderDir, "final.mp4");
    const motionPlan = buildVideoMotionPlan(project);
    const composition = buildComposition(project, motionPlan);

    await fs.writeFile(motionPlanPath, JSON.stringify(motionPlan, null, 2), "utf8");
    await fs.writeFile(compositionPath, JSON.stringify(composition, null, 2), "utf8");
    await fs.writeFile(subtitlePath, buildSrt(project.segments, project.assets), "utf8");

    await this.repository.createAsset({
      projectId: project.id,
      assetType: "subtitle",
      filePath: subtitlePath,
      mimeType: "application/x-subrip"
    });
    await this.repository.createAsset({
      projectId: project.id,
      assetType: "motion_plan",
      filePath: motionPlanPath,
      mimeType: "application/json",
      metadata: {
        renderer: "motion_planner",
        planVersion: motionPlan.version,
        sceneCount: motionPlan.scenes.length,
        maxSceneDurationMs: motionPlan.maxSceneDurationMs
      }
    });
    await this.repository.createAsset({
      projectId: project.id,
      assetType: "composition",
      filePath: compositionPath,
      mimeType: "application/json",
      metadata: {
        renderer: "remotion",
        motionPlanPath
      }
    });

    if (config.videoRenderMock) {
      await fs.writeFile(outputPath, JSON.stringify({ mockVideo: true, composition }, null, 2), "utf8");
    } else {
      if (!config.remotionRenderCommand) {
        throw new Error("REMOTION_RENDER_COMMAND is not configured. Enable VIDEO_RENDER_MOCK=1 for smoke tests.");
      }
      const command = config.remotionRenderCommand
        .replaceAll("{projectDir}", quote(projectDir))
        .replaceAll("{composition}", quote(compositionPath))
        .replaceAll("{output}", quote(outputPath));
      await execAsync(command, {
        cwd: projectDir,
        timeout: 30 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      });
    }

    const renderedSubtitlePath = replaceExtension(outputPath, ".srt");
    const renderedAssPath = replaceExtension(outputPath, ".ass");
    if (await fileExists(renderedSubtitlePath)) {
      await this.repository.createAsset({
        projectId: project.id,
        assetType: "subtitle",
        filePath: renderedSubtitlePath,
        mimeType: "application/x-subrip",
        metadata: {
          source: "composer",
          burnedInAssPath: (await fileExists(renderedAssPath)) ? renderedAssPath : null
        }
      });
    }

    const stat = await fs.stat(outputPath);
    if (!stat.size) {
      throw new Error("Final video output is empty.");
    }
    await fs.copyFile(outputPath, latestOutputPath);

    const assetId = await this.repository.createAsset({
      projectId: project.id,
      assetType: "video",
      filePath: outputPath,
      mimeType: "video/mp4",
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      durationMs: composition.segments.reduce((sum, segment) => sum + segment.durationMs, 0),
      metadata: {
        compositionPath,
        motionPlanPath,
        subtitlePath,
        renderedSubtitlePath: (await fileExists(renderedSubtitlePath)) ? renderedSubtitlePath : null,
        renderedAssPath: (await fileExists(renderedAssPath)) ? renderedAssPath : null,
        motion: composition.motion,
        motionPlan: {
          version: motionPlan.version,
          sceneCount: motionPlan.scenes.length,
          maxSceneDurationMs: motionPlan.maxSceneDurationMs
        },
        mock: config.videoRenderMock
      }
    });
    await this.repository.markVideoReady(project.id, assetId);
  }
}

function assertCompositionReady(project: VideoProjectDetail) {
  const activeAssets = project.assets.filter((asset) => asset.status === "active");
  for (const segment of project.segments) {
    const hasVoice = activeAssets.some((asset) => asset.segmentId === segment.id && asset.assetType === "voice");
    const hasVisual = activeAssets.some((asset) =>
      asset.segmentId === segment.id && ["image", "chart", "text_card"].includes(asset.assetType)
    );
    if (!hasVoice || !hasVisual) {
      throw new Error(`Composition blocked: segment ${segment.segmentKey} is missing active voice or visual asset.`);
    }
  }
}

async function renderWithCosy(segment: VideoProjectSegmentSummary, outputPath: string, config: ReturnType<typeof getAppConfig>) {
  if (config.cosyTtsBaseUrl) {
    const response = await fetch(`${config.cosyTtsBaseUrl.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text: segment.voiceover,
        outputPath,
        format: "wav",
        useGpu: true
      })
    });
    if (!response.ok) {
      throw new Error(`Cosy TTS HTTP render failed: HTTP ${response.status} ${await response.text()}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("audio/") || contentType.includes("octet-stream")) {
      await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
      return;
    }
    const payload = (await response.json()) as { filePath?: string; ok?: boolean };
    if (payload.filePath && payload.filePath !== outputPath) {
      await fs.copyFile(payload.filePath, outputPath);
    }
    await fs.stat(outputPath);
    return;
  }

  if (config.cosyTtsCommand) {
    const command = config.cosyTtsCommand
      .replaceAll("{text}", quote(segment.voiceover))
      .replaceAll("{output}", quote(outputPath))
      .replaceAll("{segmentId}", quote(segment.id));
    await execAsync(command, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    });
    await fs.stat(outputPath);
    return;
  }

  throw new Error("Cosy TTS is not configured. Set COSY_TTS_BASE_URL or COSY_TTS_COMMAND.");
}

async function assertGpuAvailable(command: string) {
  try {
    await execAsync(command, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    throw new Error(`GPU check failed; Cosy TTS will not run on CPU fallback. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function extractImageBytes(response: Record<string, unknown>) {
  const data = Array.isArray(response.data) ? (response.data as Array<Record<string, unknown>>) : [];
  const first = data[0];
  if (!first) {
    throw new Error("Image generation returned no image data.");
  }
  if (typeof first.b64_json === "string") {
    return Buffer.from(first.b64_json, "base64");
  }
  if (typeof first.url === "string") {
    const responseFromUrl = await fetch(first.url);
    if (!responseFromUrl.ok) {
      throw new Error(`Failed to download generated image: HTTP ${responseFromUrl.status}`);
    }
    return Buffer.from(await responseFromUrl.arrayBuffer());
  }
  throw new Error("Image generation response did not include b64_json or url.");
}

async function readWavDurationMs(filePath: string) {
  const buffer = await fs.readFile(filePath);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16 && chunkDataOffset + 12 <= buffer.length) {
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || !dataBytes) {
    return null;
  }
  return Math.round((dataBytes / byteRate) * 1000);
}

async function generateImageBytes(prompt: string, model: string, size: string) {
  const client = createOpenAiClient("video");
  try {
    const response = await (client as unknown as {
      images: {
        generate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
    }).images.generate({
      model,
      prompt,
      size,
      n: 1
    });
    return extractImageBytes(response);
  } catch (error) {
    if (!isUnsupportedImageModelError(error)) {
      throw error;
    }
    return generateImageBytesWithResponses(prompt);
  }
}

async function generateImageBytesWithResponses(prompt: string) {
  const client = createOpenAiClient("video");
  const runtime = readLlmRuntimeConfig("video");
  const response = await (client as unknown as {
    responses: {
      create(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  }).responses.create({
    model: runtime.model,
    input: prompt,
    tools: [
      {
        type: "image_generation",
        quality: "medium",
        size: "1536x1024",
        output_format: "png"
      }
    ],
    tool_choice: {
      type: "image_generation"
    }
  });
  const output = Array.isArray(response.output) ? (response.output as Array<Record<string, unknown>>) : [];
  const imageCall = output.find((item) => item.type === "image_generation_call" && typeof item.result === "string");
  if (!imageCall || typeof imageCall.result !== "string") {
    throw new Error("Responses image_generation returned no image data.");
  }
  return Buffer.from(imageCall.result, "base64");
}

function isUnsupportedImageModelError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const errorWithStatus = error as Error & { status?: unknown };
  const status = typeof errorWithStatus.status === "number" ? errorWithStatus.status : null;
  return status === 400 && /unsupported|not support|不支持|请切换到/i.test(error.message);
}

async function findActiveVisual(repository: VideoRepository, projectId: string, segmentId: string) {
  return (
    (await repository.getActiveAsset(projectId, segmentId, "image")) ??
    (await repository.getActiveAsset(projectId, segmentId, "chart")) ??
    (await repository.getActiveAsset(projectId, segmentId, "text_card"))
  );
}

async function writeTextPng(outputPath: string, title: string, subtitle: string) {
  const svg = `<svg width="${VIDEO_WIDTH}" height="${VIDEO_HEIGHT}" viewBox="0 0 ${VIDEO_WIDTH} ${VIDEO_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="1920" height="1080" fill="#f7f3ec"/>
  <rect x="96" y="96" width="1728" height="888" rx="36" fill="#ffffff" stroke="#d9d0c4" stroke-width="3"/>
  <text x="160" y="300" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="72" font-weight="700" fill="#222">${escapeXml(title).slice(0, 34)}</text>
  <foreignObject x="160" y="380" width="1600" height="420">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Microsoft YaHei, Noto Sans SC, Arial; font-size: 44px; line-height: 1.45; color: #3d3630;">${escapeXml(subtitle)}</div>
  </foreignObject>
  <text x="160" y="900" font-family="Arial" font-size="28" fill="#9f6b00">Video Production Hub · 16:9</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function writeVectorTextPng(outputPath: string, title: string, subtitle: string) {
  const titleLines = wrapSvgText(title, 18, 2);
  const subtitleLines = wrapSvgText(subtitle, 24, 3);
  const titleTspans = titleLines
    .map((line, index) => `<tspan x="150" dy="${index === 0 ? 0 : 82}">${escapeXml(line)}</tspan>`)
    .join("");
  const subtitleTspans = subtitleLines
    .map((line, index) => `<tspan x="150" dy="${index === 0 ? 0 : 58}">${escapeXml(line)}</tspan>`)
    .join("");
  const headerTitle = titleLines[0] ?? title;
  const svg = `<svg width="${VIDEO_WIDTH}" height="${VIDEO_HEIGHT}" viewBox="0 0 ${VIDEO_WIDTH} ${VIDEO_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="1920" height="1080" fill="#f6f8fb"/>
  <rect x="72" y="64" width="1776" height="952" rx="28" fill="#ffffff" stroke="#d9e1ec" stroke-width="2"/>
  <rect x="96" y="88" width="1728" height="88" rx="16" fill="#111827"/>
  <text x="128" y="144" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="36" font-weight="700" fill="#ffffff">${escapeXml(headerTitle).slice(0, 28)}</text>
  <text x="1690" y="144" text-anchor="end" font-family="Arial" font-size="24" font-weight="700" fill="#8bd3ff">CryptoPathX</text>
  <rect x="128" y="220" width="260" height="50" rx="25" fill="#e0f2fe"/>
  <text x="258" y="254" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="24" font-weight="800" fill="#0369a1">方法卡片</text>
  <text x="150" y="358" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="66" font-weight="800" fill="#111827">${titleTspans}</text>
  <rect x="128" y="550" width="1040" height="270" rx="22" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
  <text x="150" y="630" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="42" font-weight="500" fill="#334155">${subtitleTspans}</text>
  <g transform="translate(1250 340)">
    <rect x="0" y="0" width="420" height="86" rx="18" fill="#ecfdf5" stroke="#bbf7d0" stroke-width="2"/>
    <circle cx="46" cy="43" r="18" fill="#10b981"/>
    <path d="M37 43l7 8 13-17" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="82" y="54" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="28" font-weight="800" fill="#166534">先定规则</text>
    <rect x="0" y="126" width="420" height="86" rx="18" fill="#eff6ff" stroke="#bfdbfe" stroke-width="2"/>
    <circle cx="46" cy="169" r="18" fill="#2563eb"/>
    <path d="M35 169h22M46 158v22" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <text x="82" y="180" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="28" font-weight="800" fill="#1d4ed8">再看结果</text>
    <rect x="0" y="252" width="420" height="86" rx="18" fill="#fff7ed" stroke="#fed7aa" stroke-width="2"/>
    <circle cx="46" cy="295" r="18" fill="#f59e0b"/>
    <path d="M36 299c10-20 20-20 30 0" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <text x="82" y="306" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="28" font-weight="800" fill="#9a3412">记录问题</text>
  </g>
  <line x1="128" y1="944" x2="1792" y2="944" stroke="#e2e8f0" stroke-width="2"/>
  <text x="128" y="982" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="24" fill="#64748b">横版 16:9 矢量信息卡，服务口播内容，不构成投资建议。</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function writeSilentWav(outputPath: string, durationSec: number) {
  const sampleRate = 16_000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const samples = Math.max(1, Math.round(sampleRate * durationSec));
  const dataSize = samples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  await fs.writeFile(outputPath, buffer);
}

function buildComposition(project: VideoProjectDetail, motionPlan: VideoMotionPlan) {
  let cursorMs = 0;
  const assets = project.assets.filter((asset) => asset.status === "active");
  return {
    projectId: project.id,
    title: project.title,
    aspectRatio: "16:9",
    resolution: {
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT
    },
    motion: {
      enabled: true,
      zoomMax: 1.035,
      videoFadeSec: 0.35,
      subtitleFadeMs: 180
    },
    motionPlan,
    segments: project.segments.map((segment) => {
      const voice = assets.find((asset) => asset.segmentId === segment.id && asset.assetType === "voice");
      const durationMs = voice?.durationMs ?? segment.durationSec * 1000;
      const item = {
        segmentId: segment.id,
        startMs: cursorMs,
        durationMs,
        voice: voice?.filePath ?? null,
        visual: selectSegmentVisualAsset(assets, segment.id)?.filePath ?? null,
        subtitle: segment.subtitle
      };
      cursorMs += durationMs;
      return item;
    })
  };
}

function selectSegmentVisualAsset(assets: VideoProjectDetail["assets"], segmentId: string) {
  const segmentAssets = assets.filter(
    (asset) => asset.segmentId === segmentId && ["image", "chart", "text_card"].includes(asset.assetType)
  );
  const priority = new Map([
    ["image", 0],
    ["chart", 1],
    ["text_card", 2]
  ]);
  return segmentAssets.sort((left, right) => {
    const typeDiff = (priority.get(left.assetType) ?? 99) - (priority.get(right.assetType) ?? 99);
    if (typeDiff !== 0) {
      return typeDiff;
    }
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  })[0] ?? null;
}

async function addGptImageOverlay(outputPath: string, title: string, subtitle: string) {
  const titleLines = wrapSvgText(title, 13, 2);
  const subtitleLines = wrapSvgText(subtitle, 22, 2);
  const titleTspans = titleLines
    .map((line, index) => `<tspan x="126" dy="${index === 0 ? 0 : 66}">${escapeXml(line)}</tspan>`)
    .join("");
  const subtitleTspans = subtitleLines
    .map((line, index) => `<tspan x="126" dy="${index === 0 ? 0 : 44}">${escapeXml(line)}</tspan>`)
    .join("");
  const overlay = `<svg width="${VIDEO_WIDTH}" height="${VIDEO_HEIGHT}" viewBox="0 0 ${VIDEO_WIDTH} ${VIDEO_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#020617" stop-opacity="0.68"/>
      <stop offset="0.48" stop-color="#020617" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#020617" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#shade)"/>
  <rect x="96" y="88" width="760" height="380" rx="28" fill="#ffffff" fill-opacity="0.96" stroke="#dbeafe" stroke-width="2"/>
  <rect x="126" y="124" width="160" height="44" rx="22" fill="#e0f2fe"/>
  <text x="206" y="154" text-anchor="middle" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="22" font-weight="800" fill="#0369a1">知识卡片</text>
  <text x="126" y="238" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="50" font-weight="850" fill="#0f172a">${titleTspans}</text>
  <text x="126" y="368" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="31" font-weight="500" fill="#334155">${subtitleTspans}</text>
  <rect x="96" y="902" width="760" height="58" rx="18" fill="#ffffff" fill-opacity="0.9"/>
  <text x="126" y="940" font-family="Microsoft YaHei, Noto Sans SC, Arial" font-size="24" font-weight="600" fill="#475569">案例复盘表达，不构成投资建议。</text>
</svg>`;
  const composed = await sharp(outputPath)
    .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
    .png()
    .toBuffer();
  await fs.writeFile(outputPath, composed);
}

function buildSrt(segments: VideoProjectSegmentSummary[], assets: VideoProjectDetail["assets"]) {
  let cursorMs = 0;
  const activeAssets = assets.filter((asset) => asset.status === "active");
  return segments
    .map((segment, index) => {
      const voice = activeAssets.find((asset) => asset.segmentId === segment.id && asset.assetType === "voice");
      const durationMs = voice?.durationMs ?? segment.durationSec * 1000;
      const start = cursorMs;
      const end = cursorMs + durationMs;
      cursorMs = end;
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${segment.subtitle}\n`;
    })
    .join("\n");
}

function formatSrtTime(ms: number) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = Math.floor(ms % 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(millis).padStart(3, "0")}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function quote(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function replaceExtension(filePath: string, extension: string) {
  return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`);
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapSvgText(value: string, maxCharsPerLine: number, maxLines: number) {
  const chars = Array.from(value.trim());
  const lines: string[] = [];
  let current = "";
  let units = 0;
  for (const char of chars) {
    const charUnits = /[\x00-\x7F]/.test(char) ? 0.55 : 1;
    if (units + charUnits > maxCharsPerLine && current) {
      lines.push(current);
      current = "";
      units = 0;
      if (lines.length >= maxLines) {
        break;
      }
    }
    current += char;
    units += charUnits;
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === maxLines && chars.length > lines.join("").length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[，。；、,.!?！？\s]+$/, "")}...`;
  }
  return lines.length ? lines : [value];
}
