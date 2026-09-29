import type { CreatePromptDraftInput, PromptSetName, PromptSetView, PromptTestRunInput, UpdatePromptDraftInput } from "@zhihu-mvp/shared";
import { defaultPromptSeeds } from "../prompts/default-prompts.js";
import { createOpenAiClient, readLlmRuntimeConfig, resolveLlmQuotaFallbacks } from "../config/llm-provider.js";
import { PromptRepository } from "../repositories/prompt-repository.js";
import { extractResponseText } from "../utils/json.js";
import { createLlmTextResponse } from "../utils/llm-text.js";

export class PromptService {
  constructor(private readonly promptRepository: PromptRepository) {}

  async bootstrapDefaults() {
    await this.promptRepository.ensurePromptSets(defaultPromptSeeds.map((seed) => ({ name: seed.name, title: seed.title })));

    for (const seed of defaultPromptSeeds) {
      const versions = await this.promptRepository.listPromptVersions(seed.name);
      if (versions.length === 0) {
        const id = await this.promptRepository.createPromptDraft(seed.name, seed.label, seed.content, seed.notes);
        await this.promptRepository.activatePromptVersion(id);
      }
    }
  }

  async listPromptSets(): Promise<PromptSetView[]> {
    const activeSeedNames = new Set(defaultPromptSeeds.map((seed) => seed.name));
    const promptSets = (await this.promptRepository.listPromptSets()).filter((promptSet) => activeSeedNames.has(promptSet.name));
    const result: PromptSetView[] = [];

    for (const promptSet of promptSets) {
      const versions = await this.promptRepository.listPromptVersions(promptSet.name);
      const activeVersionId = await this.promptRepository.getActivePromptVersionId(promptSet.name);
      const activeContent = await this.promptRepository.getActivePromptContent(promptSet.name);
      const testRuns = await this.promptRepository.listPromptTestRuns(promptSet.name);

      result.push({
        ...promptSet,
        versions,
        activeVersionId,
        activeContent,
        testRuns
      });
    }

    return result;
  }

  async getPromptSet(name: PromptSetName): Promise<PromptSetView | null> {
    const promptSet = await this.promptRepository.getPromptSetByName(name);
    if (!promptSet) {
      return null;
    }

    return {
      ...promptSet,
      versions: await this.promptRepository.listPromptVersions(name),
      activeVersionId: await this.promptRepository.getActivePromptVersionId(name),
      activeContent: await this.promptRepository.getActivePromptContent(name),
      testRuns: await this.promptRepository.listPromptTestRuns(name)
    };
  }

  async createDraft(name: PromptSetName, input: CreatePromptDraftInput) {
    return this.promptRepository.createPromptDraft(name, input.label, input.content, input.notes);
  }

  async updateDraft(versionId: number, input: UpdatePromptDraftInput) {
    await this.promptRepository.updatePromptDraft(versionId, input);
  }

  async activatePromptVersion(versionId: number) {
    await this.promptRepository.activatePromptVersion(versionId);
  }

  async rollbackToVersion(versionId: number) {
    await this.promptRepository.activatePromptVersion(versionId);
  }

  async testPrompt(input: PromptTestRunInput) {
    const promptVersion = input.promptVersionId
      ? await this.promptRepository.getPromptVersionById(input.promptVersionId)
      : await this.resolveLatestVersion(input.promptSetName);

    if (!promptVersion) {
      throw new Error("No prompt version available for testing.");
    }

    const client = createOpenAiClient(promptVersion.set_name);
    const runtime = readLlmRuntimeConfig(promptVersion.set_name);

    try {
      const response = await createLlmTextResponse(client, runtime, [
        { role: "system", content: promptVersion.content },
        { role: "user", content: JSON.stringify(input.input, null, 2) }
      ], {
        quotaFallbacks: resolveLlmQuotaFallbacks(promptVersion.set_name)
      });

      const output = extractResponseText(response);
      const testRunId = await this.promptRepository.recordPromptTestRun(promptVersion.id, JSON.stringify(input.input), output, null);
      return { promptVersionId: promptVersion.id, testRunId, output };
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "Unknown prompt test error";
      const testRunId = await this.promptRepository.recordPromptTestRun(promptVersion.id, JSON.stringify(input.input), null, errorText);
      return { promptVersionId: promptVersion.id, testRunId, output: null, error: errorText };
    }
  }

  private async resolveLatestVersion(promptSetName?: PromptSetName) {
    if (!promptSetName) {
      return null;
    }

    const versions = await this.promptRepository.listPromptVersions(promptSetName);
    const latestVersion = versions[0];
    if (!latestVersion) {
      return null;
    }

    return this.promptRepository.getPromptVersionById(latestVersion.id);
  }
}
