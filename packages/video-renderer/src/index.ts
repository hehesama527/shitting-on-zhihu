export type VideoRendererSegment = {
  segmentId: string;
  startMs: number;
  durationMs: number;
  voice: string | null;
  visual: string | null;
  subtitle: string;
};

export type VideoRendererComposition = {
  projectId: string;
  title: string;
  aspectRatio: "16:9";
  resolution: {
    width: number;
    height: number;
  };
  motion?: {
    enabled: boolean;
    zoomMax: number;
    videoFadeSec: number;
    subtitleFadeMs: number;
  };
  segments: VideoRendererSegment[];
};

export const defaultHorizontalComposition = {
  id: "video-hub-horizontal-v1",
  width: 1920,
  height: 1080,
  fps: 30
} as const;

export function validateCompositionInput(input: VideoRendererComposition) {
  if (input.aspectRatio !== "16:9") {
    throw new Error("Only 16:9 video compositions are supported in MVP.");
  }
  if (input.resolution.width !== 1920 || input.resolution.height !== 1080) {
    throw new Error("MVP renderer expects 1920x1080 composition input.");
  }
  if (!input.segments.length) {
    throw new Error("Composition must include at least one segment.");
  }
}
