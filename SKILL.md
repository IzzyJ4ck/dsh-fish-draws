---
name: fish-draws
description: Use when the user asks DSH to draw or generate one or more images locally. Rewrites the request with the already-running Strata model, ensures the persistent ComfyUI service is online, hands VRAM from Strata to ComfyUI, generates the complete requested batch with Qwen-Image-2.1, unloads ComfyUI models, restores Strata, and displays the resulting PNG files.
---

# Fish Draws

Generate local images through the deterministic helper script in this skill. Do not assemble ComfyUI graphs or call Strata's HTTP generation API yourself.

## Required order

1. Read [references/prompt-rewriter.md](references/prompt-rewriter.md).
2. While answering with the currently running Strata model, rewrite the user's image request according to that reference. Do this before invoking any shell tool. Never make a nested request back to Strata.
3. Resolve the aspect ratio. Preserve an explicit ratio from the user; otherwise choose one using the reference.
4. Use the ratio's default resolution unless the user explicitly requested another supported size.
5. Ensure ComfyUI is online by following **ComfyUI service startup** below. Starting ComfyUI and running the helper must be separate tool calls.
6. Only after `GET http://127.0.0.1:8188/system_stats` succeeds, run `scripts/invoke-fish-draws.ps1` once for the whole batch. Pass the rewritten English prompt, original request, aspect ratio, count, and optional seed. Do not run the script once per image.
7. Parse the script's JSON result. If `comfy_managed` is true, arm the idle shutdown watcher once after the complete batch as described below. Never arm it per image.
8. Show the expanded prompt, ratio, dimensions, seed for each image, and every returned PNG inline in the DSH conversation.

## ComfyUI service startup

Treat ComfyUI as a persistent local service. Leave its process running after generation; the helper unloads its models so the idle service should not retain meaningful model VRAM.

First make a short foreground `pwsh` tool call that probes:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8188/system_stats" -Method Get -TimeoutSec 5
```

If the probe succeeds, do not start another server. Continue to the helper invocation.

If the probe fails, make a dedicated DSH `pwsh` tool call with `run_in_background: true`. This call starts only ComfyUI and must not invoke the fish-draws helper:

```text
command: & 'E:\ComfyUI\python_embeded\python.exe' -s 'E:\ComfyUI\ComfyUI\main.py' --windows-standalone-build
workdir: E:\ComfyUI
run_in_background: true
```

Store the returned background job ID. Do not use `Start-Process`, `run_nvidia_gpu.bat`, or a nested shell to launch the server: the DSH tool must own the long-running Python process so its output and lifetime remain observable.

After starting it, use short foreground probe calls to poll `/system_stats` every 3 seconds for at most 180 seconds. The server is ready only when that endpoint returns successfully. If the background job exits before readiness or the deadline expires, read that exact job's output, report the startup error, and stop. Do not invoke the helper and do not resize Strata.

Immediately after a newly started server becomes ready, register the exact listening Python process in a short foreground call:

```powershell
& "C:\Users\26283\.dsh\skills\fish-draws\scripts\comfy-lifecycle.ps1" -Action Register
```

Registration records the PID, executable path, and process start time. If registration fails, report the error and stop before invoking the generation helper. Never register a ComfyUI instance that was already online when the request began; such an instance is user-owned.

Lifecycle state is stored at `E:\ComfyUI\.fish-draws-runtime\comfy-owner.json`, inside the DSH workspace. Run `Register`, `Touch`, the generation helper, and `Watch` with the session's normal `workspace-write` sandbox. Do not request `danger-full-access` merely because the scripts themselves are read from `C:\Users\26283\.dsh\skills`; they only write runtime state and generated output under `E:\ComfyUI`.

When ComfyUI was already online, make a short `-Action Touch` call before invoking the helper. It refreshes the timer only if a valid fish-draws ownership record already exists and otherwise reports `managed: false`, leaving user-owned instances untouched.

The process-owning calls are deliberately separate:

1. The background `pwsh` call owns the ComfyUI Python server.
2. A later foreground `pwsh` call runs `invoke-fish-draws.ps1` only after readiness is confirmed.

Health probes are short control calls; never combine the server command and helper command into one PowerShell process.

## ComfyUI shutdown policy

The configured policy is `Idle` with a 10-minute timeout:

- A user-owned ComfyUI instance is never closed.
- A fish-draws-managed instance stays online during the entire requested batch.
- The idle timer starts or resets only after the helper finishes cleanup and Strata restoration.
- A new request refreshes the timer. A running or queued ComfyUI job also postpones shutdown.
- The watcher validates the recorded PID, executable path, and process start time before closing anything. A stale or mismatched record must never be used to stop a process.

After the complete batch, only when the helper returns `comfy_managed: true`, make a dedicated DSH `pwsh` tool call with `run_in_background: true`:

```text
command: & 'C:\Users\26283\.dsh\skills\fish-draws\scripts\comfy-lifecycle.ps1' -Action Watch -ShutdownMode Idle -IdleMinutes 10
run_in_background: true
```

Do not wait ten minutes in the conversation. Store the watcher job ID and continue displaying the generated results. Starting another watcher after a later managed batch is safe: all watchers read the same refreshed activity record, and only the watcher that obtains the fish-draws mutex can close the verified process.

The lifecycle helper also supports `-ShutdownMode Keep` and `-ShutdownMode Immediate`, but use `Idle -IdleMinutes 10` unless the user explicitly changes the policy.

## Script invocation

Use a separate foreground Windows PowerShell or PowerShell 7 tool call. Quote user-controlled strings as literal arguments; never interpolate them into executable code.

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

- Never launch ComfyUI from inside `invoke-fish-draws.ps1`. If the service is offline, the helper must fail fast and the skill must start it through a separate DSH-managed background tool call.
- Never start a second ComfyUI instance when `/system_stats` already responds.
- Never register or close a ComfyUI process that was already online when the request began.
- Do not close a managed ComfyUI process directly after generation. Arm the configured lifecycle watcher after the complete batch.
- Do not request broader sandbox permissions for lifecycle bookkeeping. Its mutable state belongs inside `E:\ComfyUI`; report a genuine unrelated permission failure instead of preemptively escalating.
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

