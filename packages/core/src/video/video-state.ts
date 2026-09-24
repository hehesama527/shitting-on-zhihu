import type { VideoProjectStatus } from "@zhihu-mvp/shared";

const allowedTransitions: Partial<Record<VideoProjectStatus, VideoProjectStatus[]>> = {
  topic_selected: ["writing", "failed", "archived"],
  writing: ["script_pending_confirmation", "failed"],
  script_pending_confirmation: ["render_plan_pending_confirmation", "failed", "archived"],
  render_plan_pending_confirmation: ["script_confirmed", "failed", "archived"],
  script_confirmed: ["assets_pending", "render_plan_pending_confirmation", "failed", "archived"],
  assets_pending: ["voice_rendering", "failed", "archived"],
  voice_rendering: ["visual_rendering", "assets_ready", "failed"],
  visual_rendering: ["assets_ready", "failed"],
  assets_ready: ["composing", "failed", "archived"],
  composing: ["video_ready", "video_review_required", "failed"],
  video_ready: ["approved", "video_review_required", "failed", "archived"],
  video_review_required: ["approved", "assets_pending", "failed", "archived"],
  approved: ["archived"],
  failed: ["writing", "assets_pending", "composing", "archived"],
  archived: []
};

export function assertVideoProjectTransition(from: VideoProjectStatus, to: VideoProjectStatus) {
  if (from === to) {
    return;
  }

  const allowed = allowedTransitions[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Invalid video project status transition: ${from} -> ${to}`);
  }
}

export function canStartVideoAssetProduction(input: {
  scriptConfirmedAt: string | null;
  visualRenderPlanConfirmedAt: string | null;
}) {
  return Boolean(input.scriptConfirmedAt && input.visualRenderPlanConfirmedAt);
}
