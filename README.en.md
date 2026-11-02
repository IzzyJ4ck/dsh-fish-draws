# fish-draws

English | [简体中文](./README.md)

[![npm](https://img.shields.io/npm/v/%40izzyj4ck%2Fdsh-fish-draws?label=npm)](https://www.npmjs.com/package/@izzyj4ck/dsh-fish-draws)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3%20%3C0.3.0-5B5BD6)

Connect the model in your DSH conversation to local Qwen Image 2.1 and ComfyUI for text-to-image, single-image editing, and multi-image editing.

`fish-draws` is not a hidden image service and does not call a second LLM behind the scenes. The active DSH conversation model understands the request, observes reference images, expands the prompt, and reviews the result. The plugin handles deterministic sizing, VRAM handoff, the controlled ComfyUI workflow, failure recovery, output delivery, and cleanup. Image generation itself always runs locally.

```text
User request
   ↓
Current DSH conversation model
Understand the task, inspect references, expand the prompt
   ↓
fish-draws
Resolve dimensions, hand off VRAM, manage jobs and lifecycle
   ↓
Local ComfyUI + Qwen Image 2.1
   ↓
Return images, expanded prompt, and result.json to DSH
```

## Who it is for

fish-draws is intended for users who:

- already run ComfyUI and Qwen Image 2.1 locally and want to create or edit images from a DSH conversation;
- use an official DeepSeek model to plan tasks while keeping image generation on their own computer;
- use a local model through Strata and want both planning and image generation to stay local;
- share one GPU between a local LLM and an image model and need explicit VRAM handoff;
- need multi-reference roles, exact delivery dimensions, batches, retries, and traceable outputs.

It is not currently intended for macOS, Linux, AMD GPUs, remote ComfyUI services, arbitrary third-party workflows, or automatic installation of ComfyUI, weights, and custom nodes.

## Two common setups

| Setup | Planning model in DSH | Image model | Characteristics |
|---|---|---|---|
| Official DeepSeek model + local image generation | DeepSeek cloud API | Local Qwen Image 2.1 | Easier setup and no local LLM VRAM use; prompts are sent to the DeepSeek API |
| Local model + local image generation | Local Strata/Qwen route | Local Qwen Image 2.1 | Primary use case; planning and generation can stay local, with VRAM handoff on a shared GPU |

> [!IMPORTANT]
> Automatic VRAM handoff currently targets the `/v1/vram` API provided by [Strata](https://github.com/Niko1221/Strata). Other local inference engines may still be used as DSH model routes, but fish-draws cannot guarantee that their VRAM will be released and restored. Running both models on one GPU may therefore OOM or become much slower.

## Features

- Text-to-image, single-image editing, and editing with 1–6 references.
- Explicit `<image1>…<imageN>` roles for multi-image tasks.
- Exact width and height, preset ratios, source-image dimensions, and non-multiple-of-16 delivery sizes.
- Balanced and Fast batch modes.
- One initial technical execution plus up to three technical retries; quality rework uses a separate generation cycle.
- Visual facts and expanded-prompt confirmation for complex edits.
- Strata expert-cache release, restoration, and crash-recovery journal.
- ComfyUI auto-start, model unloading, and ten-minute idle shutdown.
- User-started ComfyUI processes are never closed by the plugin.
- Images and the final expanded prompt are returned in the DSH conversation.
- One authoritative task directory with a reproducible `result.json`.
- Native DSH settings, versioned model profiles, and a fixed end-to-end diagnostic.

## Requirements

- Windows 10/11.
- A local NVIDIA GPU.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>=0.2.1-rc.3 <0.3.0`.
- Node.js `^22.19.0 || >=24.0.0`.
- A working local [ComfyUI](https://github.com/Comfy-Org/ComfyUI) instance whose web UI can be opened independently.
- Qwen Image 2.1 UNet, Qwen3-VL text encoder, and VAE files.

Default model filenames:

```text
qwen-image-2.1-UC-Q8_0_2.gguf
qwen3vl_8b_int8_convrot.safetensors
qwen_image_2.1_vae_bf16.safetensors
```

Model filenames are selected and stored in **Settings → Image Generation → Image model**. The package does not redistribute model weights.

### Nodes used by the production workflow

| Node | Source | Notes |
|---|---|---|
| `UnetLoaderGGUF` | [ComfyUI-GGUF](https://github.com/leejet/ComfyUI-GGUF) | Required to load the default GGUF UNet |
| `PathchSageAttentionKJ` | [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Required for the Sage Attention chain |
| `QwenImage21Cache` | Native in current ComfyUI | Used by Balanced and Fast modes |
| `EasyCache` | Native in current ComfyUI | Added dynamically for Fast batches |

Zove-try's original UI workflow recommended Rgthree. The fish-draws API template removes the frontend switches, group controls, and bypass nodes, so the production plugin does not depend on Rgthree.

<details>
<summary>Give this prompt to your Agent to install and verify the required custom nodes</summary>

```text
Help me inspect and install the custom-node packages required by the current fish-draws production workflow in my Windows portable ComfyUI:

1. ComfyUI-GGUF
   https://github.com/leejet/ComfyUI-GGUF
2. ComfyUI-KJNodes
   https://github.com/kijai/ComfyUI-KJNodes

My portable ComfyUI root is:
<insert the actual path here>

Requirements:

1. First verify that the root contains ComfyUI\main.py, ComfyUI\custom_nodes, and python_embeded\python.exe.
2. Check whether UnetLoaderGGUF, PathchSageAttentionKJ, QwenImage21Cache, and EasyCache are already available. Do not reinstall working nodes.
3. UnetLoaderGGUF must come from ComfyUI-GGUF; PathchSageAttentionKJ must come from ComfyUI-KJNodes. QwenImage21Cache and EasyCache should be native in current ComfyUI. fish-draws does not currently require Rgthree, so do not install it for this task.
4. If a destination already exists, inspect its Git remote and local modifications. Never overwrite a dirty or mismatched directory; report it and wait for me.
5. Clone only missing packages into ComfyUI\custom_nodes.
6. If requirements.txt exists, install it only with the portable python_embeded\python.exe -s -m pip. Never use the system Python.
7. Do not install any other plugin, model, or workflow, and do not change user workflows, models, inputs, outputs, or global configuration.
8. If ComfyUI is running, do not force-close it. Tell me before a restart is needed.
9. After restart, use /object_info or another read-only method to verify all four nodes.
10. Report install paths, repository origins and commits, Python dependency results, node availability, and remaining issues.

Stop and ask me before proceeding if the path is ambiguous, a directory has local modifications, additional permission is required, or another component would need to be downloaded.
```

</details>

## Install

Replace `<profile-name>` with the DSH profile that you actually launch:

```powershell
dsh plugin --profile <profile-name> add @izzyj4ck/dsh-fish-draws
```

Restart DSH. **Image Generation** should appear in Settings and `fish-draws` should appear in the skill catalog.

## Common setup

Both routes require the following:

1. Open **Settings → Image Generation → ComfyUI**.
2. Set **ComfyUI root** to the directory containing `main.py`.
3. Keep the API on loopback, for example `http://127.0.0.1:8188`.
4. Select **Check connection**. If ComfyUI is offline, use **Test start**.
5. Open **Image model** and select **Discover candidates**.
6. Select the UNet, CLIP, and VAE and save the model profile.
7. Select **Probe profile**.

Configuration is snapshotted at preflight. Saving settings during a running task affects only a later task and cannot alter an already submitted workflow or its Strata restoration target.

## Quick start A: official DeepSeek model + local generation

This example uses `DeepSeek-V4.1-Flash 1017 High` for request understanding and prompt expansion. Qwen Image 2.1 still runs locally.

1. Configure the official DeepSeek API in DSH.
2. Create a conversation and select `DeepSeek-V4.1-Flash 1017 High`.
3. Complete the common ComfyUI and model-profile setup above.
4. If Strata is not running locally, disable VRAM handoff under **DSH & Strata**.
5. Send:

```text
使用fish-draws，画一只在雨夜东京小巷里戴红围巾的橘猫，16:9
```

The DSH model expands the request, fish-draws resolves `16:9` to the default `1920×1080`, and local ComfyUI generates the image. The final image and expanded prompt appear in the conversation.

<p align="center">
  <img src="./docs/images/result-deepseek-v4.1-flash.webp" alt="Rainy-night orange cat planned by DeepSeek-V4.1-Flash 1017 High and generated by local Qwen Image 2.1" width="900">
</p>
<p align="center"><sub>Planned by DeepSeek-V4.1-Flash 1017 High; generated by local Qwen Image 2.1.</sub></p>

> [!NOTE]
> This quick start validates text-to-image. Reference-image editing additionally requires the current DSH route to inspect image attachments reliably.

## Quick start B: local Strata/Qwen + local generation

This is the primary fish-draws setup. The tested example uses [Strata](https://github.com/Niko1221/Strata) with `Qwen3.8 Flash-Next IQ3_S` and DSH reasoning effort `High`.

1. Follow the Strata repository to install Strata, prepare the model, and start its local services.
2. Register Strata's OpenAI-compatible inference service as a DSH model route.
3. Create a conversation and select that local Qwen route.
4. Open **Settings → Image Generation → DSH & Strata**.
5. Enable Strata VRAM handoff.
6. Enter the Strata VRAM endpoint, for example `http://127.0.0.1:8080`.
7. Select `none` or `bearer` to match Strata. Bearer secrets are written one-way through DSH credentials and are never displayed.
8. Open **Diagnostics**, refresh the model catalog, select the route, and explicitly confirm that it only accesses a local service.
9. Save and run one fixed T2I diagnostic.
10. Send the same prompt in a normal conversation:

```text
使用fish-draws，画一只在雨夜东京小巷里戴红围巾的橘猫，16:9
```

Execution sequence:

```text
Local Qwen understands the request and expands the prompt
→ Strata temporarily releases expert-cache VRAM
→ Qwen Image 2.1 generates the image
→ ComfyUI unloads all models
→ Strata restores the reserve captured at task start
```

<p align="center">
  <img src="./docs/images/result-strata-qwen.webp" alt="Rainy-night orange cat planned by local Strata Qwen and generated by local Qwen Image 2.1" width="900">
</p>
<p align="center"><sub>Planned by Strata/Qwen3.8 Flash-Next IQ3_S High; generated by local Qwen Image 2.1.</sub></p>

The two examples start from the same user request. They demonstrate two working routes and are not a benchmark of language-model or image quality.

## More examples

Text-to-image:

```text
使用fish-draws，画一座漂浮在云海上的东方未来城市，3:2
```

Single-image edit after attaching one image:

```text
使用fish-draws，把外套改成深蓝色，其他内容保持不变，输出尺寸沿用原图。
```

Multi-image edit after attaching two images in order:

```text
使用fish-draws，把图一中的茶壶完整放到图二的教室桌面上，最终画布使用图二原始尺寸。
```

Complex tasks show visual facts, `<image1>/<image2>` roles, and the expanded prompt for confirmation before generation.

Formal multi-output batch:

```text
使用fish-draws，按同一个要求生成4张让我挑选，16:9。
```

When multiple images, a lottery batch, or comparison is explicitly requested, every image in that batch is a formal output.

## Outputs and retention

Default authoritative task directory:

```text
<OutputRoot>\fish-draws\<YYYY-MM-DD>\<TaskId>\
├─ image-1.png
└─ result.json
```

- A normal single-image task retains only its final image and `result.json`.
- Formal batches retain every requested output.
- `retainAllSuccessfulCandidates=true` additionally retains fully validated candidates.
- Technical-failure fragments, corrupt files, and wrong-size outputs are always removed.
- `result.json` records workflow version, prompts, reference hashes, dimensions, seeds, technical attempts, lifecycle, and cleanup without storing API keys, conversation transcripts, or absolute reference-image paths.

## ComfyUI lifecycle

| ComfyUI origin | At task completion | After ten idle minutes |
|---|---|---|
| Started by the user | Models unload and Strata restores; the process stays alive | Never closed by fish-draws |
| Started by fish-draws | Models unload and Strata restores | Closed if no new image task arrives |

The settings-page stop action only targets a plugin-owned ComfyUI process for which the current DSH Host still holds a live `ChildProcess` handle. It never scans for or terminates arbitrary Python processes.

## Security and privacy

- With a cloud DSH route, the original request, expansion context, and attachments that route needs to inspect may be sent to that provider. “Local generation” means the ComfyUI/Qwen Image generation stage runs locally; it does not make a cloud planning model private.
- ComfyUI and Strata URLs must be loopback.
- Tool inputs cannot supply arbitrary commands, scripts, workflow JSON, or node graphs.
- The workflow topology and SHA-256 are bound to package resources.
- Credentials are resolved through DSH credentials and never written to task configuration, logs, or manifests.
- User references, other tasks, ComfyUI global configuration, and databases are never deleted.
- User-started ComfyUI processes are never closed.
- Every formal output is traceable to the Qwen Image core generation step.
- The Host never calls Strata completions for prompt expansion; expansion always belongs to the active DSH conversation model.

## Known limitations

- The public release supports Windows 10/11, local NVIDIA GPUs, and local ComfyUI only.
- It does not install ComfyUI, weights, custom nodes, or arbitrary third-party workflows.
- The production workflow targets Qwen Image 2.1.
- Automatic VRAM handoff currently supports Strata only.
- High-resolution editing can significantly increase VRAM pressure and generation time.
- Smooth 2560×1440 or 1440×2560 execution depends on task type, quantization, and releasable VRAM.
- A user-started or stale-owner ComfyUI instance must be stopped from its own console.

## Troubleshooting

- **Settings section missing:** verify that the package is installed in the profile DSH actually launches, restart DSH, and ensure the bundle is enabled.
- **ComfyUI connection fails:** verify that the root contains `main.py`, the URL is loopback, and the port is available. Use **Check connection** and the read-only diagnosis.
- **Models or nodes are missing:** verify them in ComfyUI first, then use **Discover candidates**. Do not let an Agent install unrelated nodes speculatively.
- **High-resolution tasks are very slow:** VRAM is probably near its limit and paging. Reduce the requested dimensions, release more Strata expert cache, or use a lighter profile. fish-draws never silently downsizes the requested output.
- **ComfyUI finished but DSH has no image:** inspect `fish_draws_result` and the task `result.json`. Windows output promotion retries transient file locks and falls back to a hash-verified copy when necessary.

## Upgrade

```powershell
dsh plugin --profile <profile-name> add @izzyj4ck/dsh-fish-draws@latest
```

Disabling or removing the plugin does not delete formal images, `result.json`, diagnostics, or candidates waiting for selection. Upgrading from 3.0 to 3.1+ imports legacy model and safety configuration into an **Original configuration** profile while preserving a rollback mirror.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run release:check
```

`release:check` runs type checks, Host and Client tests, build, licensing checks, path checks, package-contents validation, and secret scanning.

## License and attribution

Original plugin code is released under the [MIT License](./LICENSE).

The bundled workflow and prompt references evolved from material shared by **Zove-try**, who granted written permission for modification, public GitHub/npm redistribution, and commercial use with attribution:

- [Original RunningHub workflow by Zove-try](https://www.runninghub.ai/zh-cn/post/2103708646000660481/?inviteCode=rh-v1315)
- [Demonstration video](https://www.bilibili.com/video/BV1HVhX6AEC6/)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)
- [Authorization summary](./assets/licensing/AUTHORIZATION.md)

Models, ComfyUI, custom nodes, and other third-party software remain under their own licenses and are not relicensed by this project's MIT License.
