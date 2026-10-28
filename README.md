# dsh-fish-draws

DSH Host bundle for controlled local Qwen Image 2.1 generation and editing through ComfyUI. It embeds the `fish-draws` skill, fixed workflow compiler, jobs, exact-size output validation, VRAM handoff, lifecycle management, and authoritative output retention.

> **Public release is currently blocked.** The bundled workflow and prompt references evolved from material shared by a Bilibili/RunningHub author. Local development may continue, but npm/GitHub redistribution must wait for written permission covering modification, public redistribution, packaging, commercial use and attribution, or for an independently rebuilt workflow and independently rewritten prompts. See `THIRD_PARTY_NOTICES.md` and `assets/licensing/redistribution-status.json`.

## Supported environment

- Windows 10/11
- local NVIDIA GPU
- local ComfyUI
- DSH `>=0.2.1-rc.3 <0.3.0`
- Node `^22.19.0 || >=24.0.0`

The bundle does not install ComfyUI, models, custom nodes, or arbitrary third-party workflows. ComfyUI and Strata endpoints must be loopback URLs.

## Development

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

`pnpm run release:check` is intentionally expected to fail until the redistribution gate is resolved and documented.

## Configuration

Set `comfy.root` to the directory containing `main.py`. `storage.outputRoot` defaults to `<comfy.root>\output`. Credentials are referenced by `strata.credentialRef` (default `FISH_DRAWS_STRATA_API_KEY`) and resolved by DSH; secret values are never stored in plugin configuration or task manifests.

Every accepted task writes only its authoritative deliverables to:

```text
<OutputRoot>\fish-draws\<YYYY-MM-DD>\<TaskId>\
  image-1.png
  result.json
```

Multi-output/lottery batches retain all formal outputs. Optional successful candidates are retained under `candidates\` only when configured or while a task waits for user selection.

## Publishing

The first npm publication must be performed manually by the owner with interactive 2FA. Agents must not log in, handle OTP/recovery codes/tokens, or run the real `npm publish`. Manual publication has no CI provenance. See the project release plan before publishing.
