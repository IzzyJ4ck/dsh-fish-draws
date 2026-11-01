# dsh-fish-draws

DSH Host + Web Client bundle for controlled local Qwen Image 2.1 generation and editing through ComfyUI. It embeds the `fish-draws` skill, fixed workflow compiler, jobs, exact-size output validation, VRAM handoff, lifecycle management, authoritative output retention, and a native DSH settings section.

> **Attribution:** The bundled workflow and prompt references evolved from material shared by **Zove-try**, who granted written permission for modification, GitHub/npm redistribution, and commercial use with attribution. See `THIRD_PARTY_NOTICES.md` and `assets/licensing/AUTHORIZATION.md` for the source and scoped authorization record.

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

`pnpm run release:check` runs the complete type, test, build, licensing, path and secret gate before a package preview is created.

## Configuration

Set `comfy.root` to the directory containing `main.py`. `storage.outputRoot` defaults to `<comfy.root>\output`. Credentials are referenced by `strata.credentialRef` (default `FISH_DRAWS_STRATA_API_KEY`) and resolved by DSH; secret values are never stored in plugin configuration or task manifests.

Every accepted task writes only its authoritative deliverables to:

```text
<OutputRoot>\fish-draws\<YYYY-MM-DD>\<TaskId>\
  image-1.png
  result.json
```

Multi-output/lottery batches retain all formal outputs. Optional successful candidates are retained under `candidates\` only when configured or while a task waits for user selection.

### DSH settings (3.1+)

Open **Settings → Image Generation** to manage:

- ComfyUI root, Python discovery, loopback API, auto-start and the safe plugin-owned stop action;
- versioned image-model profiles and separate T2I/single-edit/multi-edit/Fast safety limits;
- Strata handoff, `none` or `bearer` authentication, and one-way DSH credential storage;
- a fixed 1024×1024 diagnostic run using a DSH route that the user has explicitly confirmed is local.

Settings are snapshotted at preflight. Saving while a task is active affects only a later preflight. The deprecated `promptExpansion.endpoint` is retained for rollback compatibility but is hidden and never called.

The safe stop action only terminates a ComfyUI child process still owned by the current DSH Host through a live process handle. It never scans for or kills arbitrary Python processes. A user-started instance or an instance known only from a stale PID record must be stopped from its own console.

Diagnostic reports and their single validated image are stored once under `<OutputRoot>\fish-draws\diagnostics\<RunId>`. They are not promoted into a normal task directory and are deleted only by an explicit action for that registered RunId.

### 3.0 rollback compatibility

On first 3.1 start, the legacy `models` and `safety` fields become an “Original configuration” profile and remain synchronized as a compatibility mirror of the current profile. Version 3.0 can use only that mirror and cannot manage the other profiles. If 3.0 changes the mirror during a rollback, 3.1 preserves existing profiles and imports the changed mirror as a new “3.0 rollback configuration” profile.

## Publishing

The first npm publication must be performed manually by the owner with interactive 2FA. Agents must not log in, handle OTP/recovery codes/tokens, or run the real `npm publish`. Manual publication has no CI provenance. See the project release plan before publishing.
