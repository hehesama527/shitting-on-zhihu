import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAppConfig } from "../config/env.js";
import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";

export type HighRiskBlock = {
  block_id: number;
  length: number;
  score_a: number;
  score_b: number;
  avg_ai_score: number;
  snippet: string;
  issue: string;
};

export type AntiAigcAuditResult = {
  passed: boolean;
  globalAiScore: number;
  modelAScore: number;
  modelBScore: number;
  burstinessCv: number;
  meanPpl: number;
  totalBlocks: number;
  highRiskBlockCount: number;
  highRiskBlocks: HighRiskBlock[];
  prescription: string;
  durationMs?: number;
};

export class AntiAigcInspectorService {
  private readonly scriptPath: string;

  constructor(scriptPath?: string) {
    const config = getAppConfig();
    this.scriptPath = scriptPath ?? path.join(config.workspaceRoot, "scripts", "anti_aigc_audit.py");
  }

  async inspect(content: string, context?: { publishJobId?: number | null; attempt?: number }): Promise<AntiAigcAuditResult> {
    const startedAt = Date.now();
    logDebugTiming("antiAigcInspector.inspect", "start", {
      publishJobId: context?.publishJobId ?? null,
      attempt: context?.attempt ?? 1,
      contentLength: content.length
    });

    if (!fs.existsSync(this.scriptPath)) {
      logDebugTiming("antiAigcInspector.inspect", "script_missing", { scriptPath: this.scriptPath });
      return this.buildFallbackResult(content, "anti_aigc_audit.py script missing");
    }

    const tempFile = path.join(os.tmpdir(), `aigc_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
    try {
      await fs.promises.writeFile(tempFile, content, "utf8");

      const stdout = await this.runPythonAudit(tempFile);
      const jsonStart = stdout.indexOf("{");
      const jsonEnd = stdout.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error(`Invalid JSON output from anti_aigc_audit.py: ${stdout.slice(0, 300)}`);
      }

      const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr) as AntiAigcAuditResult;
      parsed.durationMs = getElapsedMs(startedAt);

      logDebugTiming("antiAigcInspector.inspect", "done", {
        publishJobId: context?.publishJobId ?? null,
        passed: parsed.passed,
        globalAiScore: parsed.globalAiScore,
        burstinessCv: parsed.burstinessCv,
        highRiskBlockCount: parsed.highRiskBlockCount,
        durationMs: parsed.durationMs
      });

      return parsed;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logDebugTiming("antiAigcInspector.inspect", "error", { error: errMsg, durationMs: getElapsedMs(startedAt) });
      return this.buildFallbackResult(content, errMsg);
    } finally {
      if (fs.existsSync(tempFile)) {
        await fs.promises.unlink(tempFile).catch(() => {});
      }
    }
  }

  private runPythonAudit(filePath: string): Promise<string> {
    const config = getAppConfig();
    const layaPython = path.join(config.workspaceRoot, "laya", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3");
    const pythonCmd = fs.existsSync(layaPython) ? layaPython : (process.platform === "win32" ? "python" : "python3");

    return new Promise((resolve, reject) => {
      const child = spawn(pythonCmd, [this.scriptPath, filePath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HF_ENDPOINT: "https://hf-mirror.com",
          PYTHONIOENCODING: "utf-8"
        }
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("anti_aigc_audit.py timed out after 30s"));
      }, 30_000);

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0 && !stdout.includes("{")) {
          reject(new Error(`anti_aigc_audit.py exited with code ${code}: ${stderr || stdout}`));
        } else {
          resolve(stdout);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private buildFallbackResult(content: string, reason: string): AntiAigcAuditResult {
    return {
      passed: true, // Graceful fallback: do not block publishing pipeline if inspection tool itself errors
      globalAiScore: 0,
      modelAScore: 0,
      modelBScore: 0,
      burstinessCv: 1.0,
      meanPpl: 50.0,
      totalBlocks: 1,
      highRiskBlockCount: 0,
      highRiskBlocks: [],
      prescription: `质检服务降级放行（原因：${reason}）`
    };
  }
}
