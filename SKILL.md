---
name: fish-draws
description: Generate or edit images locally with Qwen-Image-2.1 through the approved integrated ComfyUI workflow, including exact dimensions, one-to-six references, visual preflight, VRAM handoff, technical retries, quality rework, and managed lifecycle.
---

# Fish Draws

Once fish-draws is selected, explicitly or automatically, these rules apply to the whole task. Use only the deterministic scripts and bundled `qwen21-unified-api.json` workflow. Do not search for, propose, assemble, or ask permission to use additional ComfyUI nodes or workflows.

The current Strata agent performs visual planning and prompt rewriting before its expert cache is reduced. Never make a nested HTTP request back to Strata.

Unless the user explicitly permits free tool choice for the current task, do not use Python, Pillow, ImageMagick, FFmpeg, PowerShell, or another external script to change delivered pixels, alpha, colour, content, or composition. Metadata inspection, hashing, validation, copying, renaming, orchestration, and packaging are allowed.

## Route and prompt expansion

- No reference image: T2I. Read [references/system-prompt-t2i.md](references/system-prompt-t2i.md).
- One to six references: Edit. Read [references/system-prompt-edit.md](references/system-prompt-edit.md).
- More than six references: ask the user to reduce the set.

`Count` is output count, not reference count. Generate a requested selection batch in one invocation; the helper switches to Fast when `Count > 1`.

For T2I, expand according to the T2I system prompt, parse `rewritten_prompt` and `wh_ratio`, and use exact user dimensions when supplied or the approved ratio table otherwise.

For Edit, resolve dimensions before prompt expansion:

1. Resolve attachments in upload order. A selected content canvas becomes `<image1>`; selecting a size-reference does not change semantic order.
2. Run `resolve-fish-draws-size.ps1` and keep its `execution_id`.
3. If `oversize_confirmation_required` is true, show target/sample dimensions and profile limits. Use `-AllowOversize` only after explicit confirmation.
4. Observe the original references directly and record per image: certain visible content, counts, positions, exact readable text, occlusion, and uncertain details. Never turn an inference into a fact.
5. Expand with the edit system prompt. Multi-image prompts must use every normalized `<imageN>`; single-image prompts use no tag.
6. Create a visual preflight manifest, then start or verify ComfyUI and invoke generation.

Multi-image composition, identity preservation, readable-text editing, asset extraction, detail-dense scenes, complex outpainting, and critical ambiguity require showing the user the visual-fact summary and expanded prompt and waiting for confirmation. Simple colour changes and one-element removal may proceed directly.

Create the preflight manifest with `new-fish-draws-preflight.ps1`. Omit `-UserConfirmed` only for `TaskClass Simple`. Generation verifies prompt and input hashes against this manifest.

Size precedence is exact width/height, selected size-reference original dimensions, supported ratio default, then the first upload's original dimensions. Supported ratios are `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:10`, `10:16`, `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21`, `3:1`, and `1:3`. Ask for exact dimensions for other ratios.

Reference preprocessing never determines delivery size. Editing uses an independent latent canvas rounded up to 16 and an exact centre crop after decoding.

## Start ComfyUI separately

Probe `/system_stats` first. If online, do not start another server; call `comfy-lifecycle.ps1 -Action Touch`. Never register an instance that was already online when the request began.

If offline, start `start-comfyui.ps1` in a dedicated DSH `pwsh` call with the JSON boolean `run_in_background: true`. The launcher sets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`. In a separate foreground call, run `wait-comfyui-ready.ps1` while also watching the background job. If the job exits, read its output immediately. Startup failures do not consume a technical attempt.

After a newly started server is ready, call `comfy-lifecycle.ps1 -Action Register`.

## Generate

T2I example:

```powershell
$executionId = [guid]::NewGuid().ToString("N")
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\invoke-fish-draws.ps1" `
  -TaskMode T2I -ExpandedPrompt $expandedPrompt -OriginalPrompt $originalPrompt `
  -AspectRatio "16:9" -ExecutionId $executionId -TechnicalAttempt 1 -Count 1
```

Edit example:

```powershell
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\invoke-fish-draws.ps1" `
  -TaskMode Edit -InputImages @($sizePlan.input_images) `
  -ExpandedPrompt $expandedPrompt -OriginalPrompt $originalPrompt `
  -TargetWidth $sizePlan.target_width -TargetHeight $sizePlan.target_height `
  -SampleWidth $sizePlan.sample_width -SampleHeight $sizePlan.sample_height `
  -SizeSource $sizePlan.size_source -ExecutionId $sizePlan.execution_id `
  -TechnicalAttempt 1 -PreflightManifestPath $preflightManifest -Count 1
```

The helper validates image tags, preflight provenance, safety profile, exact PNG dimensions, cleanup, and Strata restoration. It restores the reserve reported before handoff; never write the machine's usual reserve into the skill.

The approved local envelope for T2I Balanced, single-edit Balanced, multi-edit Balanced, and Fast batch is 2560 per side and 3,686,400 sample pixels, including 2560×1440 and 1440×2560. All use `ReserveMiB=21504`. The single-edit profile is an explicit local user override rather than a claim that it met the 2,048 MiB calibration margin. Larger canvases require explicit confirmation and are never silently resized.

`calibrate-fish-draws-highres.ps1` may remeasure profiles. Successful calibration records exact dimensions, GPU/system memory, duration, and Strata restoration; calibration output is temporary and removed.

## Technical retries and quality rework

One execution permits the initial ComfyUI submission plus three technical retries. The attempt begins immediately before the first `/prompt` submission. Size parsing, validation, visual preflight, and startup do not consume it.

- Reuse one `ExecutionId`; use `TechnicalAttempt` 1, 2, 3, then 4.
- Retry only transport, workflow rejection, encoding, timeout, or interruption failures.
- A valid image closes the execution. Quality rework receives a new `ExecutionId`; it is not a task quota. Never display remaining attempts.
- Use `update-fish-draws-quality.ps1` to record whether a quality round improved. After two consecutive non-improving rounds, pause, show candidates and diagnosis, and ask the user.

Self-check in this order: original-image understanding, prompt plan, random draw quality, then model capability limit. Correct the earliest failed layer. A quality rework may only revise or rerun the bundled Qwen Image workflow; do not compensate with another node chain or external pixel processing.

## Lifecycle and reporting

- Never shrink Strata before size resolution, visual preflight, and prompt expansion finish.
- Never run two fish-draws jobs concurrently.
- Never restore Strata while ComfyUI may still be sampling or retaining models.
- Unload once after the complete Qwen batch.
- Never report success unless every PNG passed exact-dimension validation.
- Never expose the Strata API key or edit the user's UI workflow files.

User-owned ComfyUI is never closed. When `comfy_managed` is true, arm one background `comfy-lifecycle.ps1 -Action Watch -ShutdownMode Idle -IdleMinutes 10` call with JSON boolean `run_in_background: true`.

Display every path in `images` inline. Report original and expanded prompts, input roles, target/sample dimensions, safety approval source, acceleration, steps, seeds, cleanup, and `strata_restored`. On failure report `failure_class`, the complete error, cleanup state, and any validated partial entries already present in `outputs`.
