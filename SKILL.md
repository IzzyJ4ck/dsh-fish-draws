---
name: fish-draws
description: Generate or edit one or more images locally with Qwen-Image-2.1 through ComfyUI, including exact output dimensions, one-to-six reference images, Strata prompt expansion, VRAM handoff, and managed ComfyUI lifecycle.
---

# Fish Draws

Use the deterministic scripts in this skill. Do not assemble ComfyUI graphs manually and never make a nested HTTP request back to Strata: the currently running Strata agent performs prompt rewriting itself before its expert cache is reduced.

## Route the request

- No reference image: text-to-image. Read [references/system-prompt-t2i.md](references/system-prompt-t2i.md).
- One to six reference images: image editing. Read [references/system-prompt-edit.md](references/system-prompt-edit.md).
- More than six reference images: stop and ask the user to reduce the set.

Generate a requested batch in one helper invocation. `Count` is the number of outputs, not the number of reference images.

## Text-to-image order

1. Rewrite the request with the current Strata model according to `system-prompt-t2i.md`. Parse its `rewritten_prompt` and `wh_ratio`.
2. Use the exact default size associated with `wh_ratio`. If the user gave exact dimensions, those dimensions take priority.
3. Ensure ComfyUI is online using the separate startup procedure below.
4. Invoke `scripts/invoke-fish-draws.ps1` once with `-TaskMode T2I`, the rewritten prompt, and either `-AspectRatio` or exact target dimensions.

The approved ratio table is implemented in the scripts. Supported values are `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:10`, `10:16`, `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, `9:21`, `3:1`, and `1:3`. Never approximate a ratio that is not in this table; ask for exact width and height.

## Image-editing order

Resolve size before rewriting because the edit instruction may need outpainting semantics.

1. Resolve every attachment to a local path in original upload order.
2. Identify a content canvas only when the user specifies one. Otherwise the first upload is the content canvas. A canvas selection changes semantic image order; a size-reference selection does not.
3. Call `scripts/resolve-fish-draws-size.ps1` in a short foreground tool call. This call only reads image metadata.
4. If `oversize_confirmation_required` is true, show the user the target size, sample size, and safe envelope. Do not continue unless the user explicitly confirms the risky size. Confirmation permits `-AllowOversize`; it never permits silent resizing.
5. Rewrite the edit request with the current Strata model according to `system-prompt-edit.md`. Give it the resolver's normalized input order, `outpainting_required`, and `outpainting_direction` as orchestration context. Do not put pixel sizes or renderer parameters in the rewritten prompt.
6. Ensure every normalized reference is described. With multiple inputs use every `<imageN>` tag exactly according to the resolver's `input_mapping`; with one input use no tag.
7. Keep the resolver's `request_id` for the whole user request. Ensure ComfyUI is online, then invoke `invoke-fish-draws.ps1` with that value as `RetryGroupId`, `AttemptNumber 1`, and the resolver's `input_images`, target size, sample size, and size source.

Size precedence is deterministic:

1. Exact user width and height.
2. Original dimensions of a user-selected size-reference image.
3. A supported ratio mapped through the default table.
4. Original dimensions of the first uploaded reference image.

Natural size terms count as explicit ratios when unambiguous: square/avatar/album cover → `1:1`; landscape/desktop wallpaper/widescreen/video thumbnail/PPT → `16:9`; portrait/phone wallpaper/story/reel → `9:16`; poster → `2:3`; ID photo/Xiaohongshu → `3:4`; tablet/iPad → `4:3`; panorama → `2:1`; cinematic/ultrawide → `21:9`. For an unmapped term or unsupported ratio, ask for exact dimensions.

Example resolver calls:

```powershell
$images = @("C:\path\canvas.png", "C:\path\reference.jpg")
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\resolve-fish-draws-size.ps1" `
  -InputImages $images `
  -AspectRatio "16:9" `
  -CanvasImage $images[0]
```

```powershell
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\resolve-fish-draws-size.ps1" `
  -InputImages $images `
  -SizeReferenceImage $images[1]
```

Do not use reference preprocessing dimensions as delivery dimensions. Every edit uses an independent custom latent canvas and is cropped after decoding to the exact target.

## ComfyUI service startup

Starting ComfyUI and running the generation helper must be separate DSH tool calls.

First probe in a short foreground call:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8188/system_stats" -Method Get -TimeoutSec 5
```

If it succeeds, do not start another server. Run `comfy-lifecycle.ps1 -Action Touch`; this refreshes a valid fish-draws ownership record and leaves user-owned instances untouched.

If it fails, start only ComfyUI with a dedicated DSH `pwsh` call using `run_in_background: true`:

```text
command: & 'E:\ComfyUI\python_embeded\python.exe' -s 'E:\ComfyUI\ComfyUI\main.py' --windows-standalone-build
workdir: E:\ComfyUI
run_in_background: true
```

Do not use `Start-Process`, a batch launcher, or a nested shell. Poll `/system_stats` every three seconds for at most 180 seconds. If the owned background job exits or readiness times out, report its output and stop before resizing Strata.

After a newly started server becomes ready, register the exact listener:

```powershell
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\comfy-lifecycle.ps1" -Action Register
```

Never register a server that was already online when the request began; it is user-owned. Lifecycle state remains under `E:\ComfyUI\.fish-draws-runtime` so normal workspace permission is sufficient.

## Generation invocation

Text-to-image example:

```powershell
$retryGroupId = [guid]::NewGuid().ToString("N")
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\invoke-fish-draws.ps1" `
  -TaskMode T2I `
  -ExpandedPrompt $expandedPrompt `
  -OriginalPrompt $originalPrompt `
  -AspectRatio "16:9" `
  -RetryGroupId $retryGroupId `
  -AttemptNumber 1 `
  -Count 1
```

Image-edit example after parsing the resolver JSON:

```powershell
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\invoke-fish-draws.ps1" `
  -TaskMode Edit `
  -InputImages @($sizePlan.input_images) `
  -ExpandedPrompt $expandedPrompt `
  -OriginalPrompt $originalPrompt `
  -TargetWidth $sizePlan.target_width `
  -TargetHeight $sizePlan.target_height `
  -SampleWidth $sizePlan.sample_width `
  -SampleHeight $sizePlan.sample_height `
  -SizeSource $sizePlan.size_source `
  -RetryGroupId $sizePlan.request_id `
  -AttemptNumber 1 `
  -Count 1
```

Append `-AllowOversize` only after explicit confirmation. Use `-Acceleration Fast` when the user asks for speed or a draw/selection batch. The helper automatically switches to Fast when `Count` is greater than one. Default mode is Balanced; default steps are 40.

The helper validates prompt tags, creates unique temporary ComfyUI input copies, submits the complete batch sequentially, unloads once, restores Strata, deletes only its own temporary inputs, and verifies every saved PNG's dimensions.

## Attempt limit

A user request may run the generation helper at most three times total, including the initial attempt. This limit applies whether the helper reports an execution error or the produced image fails the requested visual edit on inspection.

- Create one `RetryGroupId` per user request and reuse it unchanged. For edits, use the resolver's `request_id`; do not rerun the resolver to obtain a fresh ID merely to bypass the limit.
- Use `AttemptNumber 1`, then 2, then 3. Never repeat or skip a number.
- A retry must change something justified by the observed failure, such as correcting a transport bug or refining an ambiguous edit instruction. Never blindly resubmit the same graph and prompt.
- `Count` is one batch attempt, regardless of how many outputs it contains. Prefer a requested selection batch over repeated single-image calls.
- After attempt 3, stop. Report the three outcomes and the remaining diagnosis; ask the user how to proceed instead of invoking the helper again.

The helper persists each retry group under `E:\ComfyUI\.fish-draws-runtime\retry-attempts` and rejects a fourth invocation even across separate DSH tool calls. Its result reports `retry_group_id`, `attempt_number`, `max_attempts`, and `attempts_remaining`.

## Shutdown policy

- User-owned ComfyUI: never close it.
- Skill-managed ComfyUI: after the complete batch, arm one ten-minute idle watcher.
- Never arm a watcher per output image.

Use a separate background tool call only when the generation result says `comfy_managed: true`:

```text
command: & 'C:\Users\26283\.dsh\skills\fish-draws\scripts\comfy-lifecycle.ps1' -Action Watch -ShutdownMode Idle -IdleMinutes 10
workdir: E:\ComfyUI
run_in_background: true
```

## Safety invariants

- Never resize Strata before prompt expansion and edit-size resolution are complete.
- Never run two fish-draws jobs concurrently.
- Never restore Strata while ComfyUI may still be sampling or retaining models.
- Never unload ComfyUI between images in one batch.
- Never change `RetryGroupId`, rerun the resolver, or start a new helper sequence to evade the three-attempt limit for the same user request.
- Never report success unless every delivered PNG passed exact-dimension validation.
- Never claim Strata restoration unless `strata_restored` is true.
- Never hardcode or display the Strata API key; the helper reads it from the existing Strata config.
- Do not edit the user's UI workflow files.

## Display results

Show every path in `images` inline with its absolute path. Also report:

- original and expanded prompts;
- normalized input mapping for edits;
- size source, target size, internal sample size, and outpainting direction;
- acceleration mode, steps, and each seed;
- ComfyUI cleanup and Strata restoration status.

If `ok` is false, report `error`, `cleanup`, `strata_restored`, and any already validated partial outputs without hiding them.
