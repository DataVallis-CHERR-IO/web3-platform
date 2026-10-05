// Image models for demo campaign covers (ADR-052 §4; choice TASK-043). Both run
// on fal.ai's queue API with the same FAL_KEY; the admin picks one per batch.
// Kept free of server imports so the admin form can list the choices.

export const DEMO_COVER_MODELS = ["flux-2-pro", "nano-banana-pro"] as const;
export type DemoCoverModel = (typeof DEMO_COVER_MODELS)[number];

/** The cheaper model is the default (David, 2026-10-05). */
export const DEFAULT_COVER_MODEL: DemoCoverModel = "flux-2-pro";

interface FalModel {
  /** fal endpoint id; the queue URL is https://queue.fal.run/<endpoint> */
  endpoint: string;
  /** Model-specific request fields besides the prompt: one 4:3 JPEG at about 1 megapixel. */
  input: Record<string, unknown>;
}

const FAL_MODELS: Record<DemoCoverModel, FalModel> = {
  "flux-2-pro": {
    endpoint: "fal-ai/flux-2-pro",
    input: { image_size: "landscape_4_3", output_format: "jpeg" },
  },
  "nano-banana-pro": {
    endpoint: "fal-ai/nano-banana-pro",
    input: { num_images: 1, aspect_ratio: "4:3", resolution: "1K", output_format: "jpeg" },
  },
};

export function falModel(model: DemoCoverModel): FalModel {
  return FAL_MODELS[model];
}

export function falQueueUrl(model: DemoCoverModel): string {
  return `https://queue.fal.run/${FAL_MODELS[model].endpoint}`;
}

/** A model name from a request; anything unknown falls back to the default. */
export function parseCoverModel(value: unknown): DemoCoverModel {
  return typeof value === "string" && (DEMO_COVER_MODELS as readonly string[]).includes(value)
    ? (value as DemoCoverModel)
    : DEFAULT_COVER_MODEL;
}
