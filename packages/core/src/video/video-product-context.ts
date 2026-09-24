import fs from "node:fs/promises";
import path from "node:path";
import { getAppConfig } from "../config/env.js";

export type VideoProductDocumentContext = {
  sourcePath: string;
  title: string;
  content: string;
  charCount: number;
  truncated: boolean;
};

export type VideoProductContext = {
  documents: VideoProductDocumentContext[];
  combinedMarkdown: string;
  sourcePaths: string[];
  missingPaths: string[];
  maxChars: number;
};

type CacheEntry = {
  key: string;
  value: VideoProductContext | null;
};

let cachedContext: CacheEntry | null = null;

export async function loadVideoProductContext(): Promise<VideoProductContext | null> {
  const config = getAppConfig();
  const sourcePaths = config.videoProductDocPaths.map((item) =>
    path.isAbsolute(item) ? item : path.resolve(config.workspaceRoot, item)
  );
  const maxChars = Math.max(1_000, config.videoProductDocMaxChars);
  const key = JSON.stringify({ sourcePaths, maxChars });

  if (cachedContext?.key === key) {
    return cachedContext.value;
  }

  if (sourcePaths.length === 0) {
    cachedContext = { key, value: null };
    return null;
  }

  const documents: VideoProductDocumentContext[] = [];
  const missingPaths: string[] = [];
  let remainingChars = maxChars;

  for (const sourcePath of sourcePaths) {
    if (remainingChars <= 0) {
      break;
    }

    try {
      const raw = await fs.readFile(sourcePath, "utf8");
      const normalized = raw.replace(/\r\n/g, "\n").trim();
      const content = normalized.slice(0, remainingChars);
      documents.push({
        sourcePath,
        title: extractMarkdownTitle(normalized, sourcePath),
        content,
        charCount: normalized.length,
        truncated: content.length < normalized.length
      });
      remainingChars -= content.length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingPaths.push(sourcePath);
        continue;
      }
      throw error;
    }
  }

  const combinedMarkdown = documents
    .map((document) =>
      [
        `# ${document.title}`,
        `Source: ${document.sourcePath}`,
        document.truncated ? `Note: truncated to fit VIDEO_PRODUCT_DOC_MAX_CHARS=${maxChars}.` : null,
        document.content
      ]
        .filter(Boolean)
        .join("\n\n")
    )
    .join("\n\n---\n\n");

  const value =
    documents.length > 0
      ? {
          documents,
          combinedMarkdown,
          sourcePaths,
          missingPaths,
          maxChars
        }
      : null;

  cachedContext = { key, value };
  return value;
}

function extractMarkdownTitle(content: string, sourcePath: string) {
  const heading = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));

  if (heading) {
    return heading.replace(/^#\s+/, "").trim();
  }

  return path.basename(sourcePath);
}
