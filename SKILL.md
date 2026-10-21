---
name: fish-draws
description: Use when the user asks DSH to draw or generate one or more images locally. Rewrites the request with the already-running Strata model, hands VRAM from Strata to ComfyUI, generates the complete requested batch with Qwen-Image-2.1, unloads ComfyUI models, restores Strata, and displays the resulting PNG files.
---

# Fish Draws

Generate local images through the deterministic helper script in this skill. Do not assemble ComfyUI graphs or call Strata's HTTP generation API yourself.

## Required order

1. Read [references/prompt-rewriter.md](references/prompt-rewriter.md).
2. While answering with the currently running Strata model, rewrite the user's image request according to that reference. Do this before invoking any shell tool. Never make a nested request back to Strata.
3. Resolve the aspect ratio. Preserve an explicit ratio from the user; otherwise choose one using the reference.
4. Use the ratio's default resolution unless the user explicitly requested another supported size.
5. Run `scripts/invoke-fish-draws.ps1` once for the whole batch. Pass the rewritten English prompt, original request, aspect ratio, count, and optional seed. Do not run the script once per image.
6. Parse the script's JSON result. Show the expanded prompt, ratio, dimensions, seed for each image, and every returned PNG inline in the DSH conversation.

## Script invocation

Use Windows PowerShell or PowerShell 7. Quote user-controlled strings as literal arguments; never interpolate them into executable code.

```powershell
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\invoke-fish-draws.ps1" `
  -ExpandedPrompt $expandedPrompt `
  -OriginalPrompt $originalPrompt `
  -AspectRatio "16:9" `
  -Count 1
```

Optional parameters:

- `-Seed N`: reproduce a result. Without it, the script chooses a random base seed.
- `-Width N -Height N`: use only when the user explicitly requests a custom size. Both must be supplied, be divisible by 8, and be no greater than 2048.
- `-Steps N`: default 25; use a different value only when the user explicitly asks or a later calibration changes the default.

The script accepts 1–32 images. It generates them sequentially with different seeds while keeping ComfyUI's models loaded, then unloads once after the complete batch.

## Non-negotiable safety rules

- Never call Strata recursively from the script or from another tool call.
- Never print, copy, or hardcode the Strata API key. The helper reads it from the local Strata configuration in memory.
- Never resize Strata while it reports an active or queued request.
- Treat only HTTP success plus Strata response `status: ok` as a successful VRAM handoff.
- On timeout or error, interrupt/delete the exact ComfyUI prompt and wait for the queue to become idle before unloading.
- If ComfyUI cannot be confirmed idle and unloaded, leave Strata squeezed and clearly warn the user. Restoring Strata while ComfyUI may still own VRAM risks an out-of-memory failure.
- Do not unload ComfyUI between images in the same requested batch.
- Do not claim restoration succeeded unless the helper reports `strata_restored: true`.

## Displaying results

For every path in `images`, render a Markdown image using its absolute path:

```markdown
![Generated image](E:/ComfyUI/ComfyUI/output/fish-draws/...png)
```

Also report the expanded prompt so the run can be reproduced. If the script returns `ok: false`, report its `error`, `cleanup`, and `strata_restored` fields without hiding partial results.

