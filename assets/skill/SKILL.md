---
name: fish-draws
description: Generate or edit images with the controlled local Qwen Image 2.1 ComfyUI workflow. Use for text-to-image, one-image editing, multi-image editing, image variations, and outpainting. The skill performs visual preflight, prompt expansion, exact sizing, generation, self-review, and bounded quality rework.
---

# fish-draws

Use the Host tools supplied by the `dsh-fish-draws` bundle. Do not run the legacy PowerShell scripts and do not assemble another ComfyUI graph.

## Hard boundary

- Every generation and edit must pass through `fish_draws_preflight` and then `fish_draws_generate`.
- The Qwen Image 2.1 integrated workflow is mandatory. Do not search for, propose, or assemble extra ComfyUI nodes.
- Unless the user explicitly authorizes it for the current task, do not use Python, Pillow, ImageMagick, FFmpeg, PowerShell, or another external tool to change delivered pixels, transparency, colour, content, or composition.
- Read-only inspection, metadata checks, hashes, copying, renaming, and packaging are allowed.
- Prompt expansion is performed by the current DSH model. The Host plugin must never call Strata or another LLM for expansion.

## 1. Understand the request

Classify the task as `t2i` or `edit`. For editing, select 1–6 reference images from current user attachments, workspace-relative files, or prior fish-draws outputs. Never pass an arbitrary absolute path.

Before editing, record per-image facts:

- certain subjects, counts, positions, readable text, occlusion, and relationships;
- uncertain or ambiguous details;
- the role of each image.

Do not turn a guess into a fact. If the task is multi-image composition, identity preservation, readable-text editing, asset separation, detail-dense editing, complex outpainting, or has a crucial blurred/occluded fact, set `complex_confirmation_required=true`. Present the visual-fact summary and expanded prompt to the user and wait for confirmation before generation. Simple recolouring or removing one clear element may proceed directly.

## 2. Resolve the canvas

Call `fish_draws_preflight` before prompt expansion causes any execution side effect.

For editing, size priority is:

1. exact width and height;
2. original dimensions of the specified reference;
3. a supported ratio mapped by the Host;
4. otherwise the first normalized content image's original dimensions.

If a content-canvas image is named, pass its zero-based index so it becomes `<image1>`. A size-reference image does not change semantic order. The Host independently computes a 16-aligned sample canvas, exact crop, safety profile, and whether oversize confirmation is required. Never put pixels, megapixels, latent sizes, node names, or renderer parameters in the expanded prompt.

When the target ratio differs from `<image1>`, the edit instruction must preserve all original content and relative relationships, avoid stretching or cropping, fit the original proportionally, and naturally outpaint new areas (primarily left/right for a wider canvas and top/bottom for a taller canvas). A smaller target may proportionally reduce the original, but must not crop it.

## 3. Expand the prompt

Read the corresponding authoritative reference completely:

- T2I: `references/system-prompt-t2i.md`
- Edit: `references/system-prompt-edit.md`

For multi-image editing, reference every image as `<image1>` through `<imageN>` and state each role. Single-image editing does not use a tag. Preserve identity, text, local-edit, and language rules from the edit reference. Do not include rendering parameters.

For T2I, use the expanded prompt and a supported ratio. Default to 40 steps. For edit, the Host—not the prompt—owns exact size.

## 4. Generate

Call `fish_draws_generate` with the exact preflight digest and the expanded prompt. Pass both complex-task and oversize confirmations only after the user actually confirmed them. Use Fast for an explicitly requested multi-output/lottery batch or when speed is requested; multiple reference images alone do not imply Fast.

Wait with the standard job tools. ComfyUI startup, validation, and preflight failures do not consume technical attempts. Once workflow submission begins, the Host allows the initial attempt plus at most three retryable technical retries. Do not describe these as user quotas or remaining credits.

Call `fish_draws_result` after the job settles. Show both images and the expanded prompt.

## 5. Visual self-review and quality rework

Inspect the output in this order:

1. Was the source image understood correctly?
2. Was the edit/generation plan and expanded prompt correct?
3. Is the miss random generation quality that a new seed may fix?
4. Is the request beyond this model/workflow's capability?

Fix upstream understanding or prompt planning before rerunning. A quality rework is a new execution cycle, not a technical retry. Continue to use only the integrated Qwen workflow.

Track consecutive no-improvement rounds separately from total quality cycles. Pass `no_improvement_rounds=2` only after two consecutive reworks show no clear improvement; an improving rework resets it to zero. The Host then places validated comparison images in `awaiting_selection`. Display them with `fish_draws_result` and ask the user to adopt, continue, or abandon. Use `fish_draws_finalize_selection` only after their answer.

## Retention and safety

The Host owns output promotion, `result.json`, candidate retention, ComfyUI model unloading, Strata restoration, cleanup, and ten-minute idle shutdown for plugin-owned ComfyUI. Never delete task directories yourself. Never close a user-started ComfyUI process.

Use `fish_draws_diagnose` for configuration or lifecycle failures. Its report is deliberately redacted.
