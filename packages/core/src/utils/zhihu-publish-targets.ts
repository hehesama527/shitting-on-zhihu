export const ZHIHU_PUBLISH_LABELS = {
  write: ["写回答", "编辑回答", "继续写"],
  submit: ["发布回答", "提交回答", "提交修改", "更新回答", "保存修改", "发布修改"],
  view: ["查看我的回答"],
  excluded: ["发布设置", "保存草稿", "草稿备份"]
} as const;

export type ZhihuPublishAction = keyof typeof ZHIHU_PUBLISH_LABELS;

export function normalizeZhihuPublishLabel(value: string) {
  return value.replace(/[\u200b-\u200d\uFEFF]/g, "").replace(/\s+/g, "").trim();
}

export function findZhihuPublishLabel(
  values: string[],
  action: Exclude<ZhihuPublishAction, "excluded">
) {
  const labels = ZHIHU_PUBLISH_LABELS[action];
  return values.find((value) => {
    const normalized = normalizeZhihuPublishLabel(value);
    return labels.some((label) => normalized === normalizeZhihuPublishLabel(label));
  }) ?? null;
}

export function isZhihuPublishLabel(value: string, action: Exclude<ZhihuPublishAction, "excluded">) {
  const normalized = normalizeZhihuPublishLabel(value);
  return ZHIHU_PUBLISH_LABELS[action].some((label) => normalized === normalizeZhihuPublishLabel(label));
}
