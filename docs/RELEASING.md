# First manual npm release runbook

This project is intended to publish as `@izzyj4ck/dsh-fish-draws`. The first release is manual, interactive, and performed by the package owner. No automation token, `.npmrc`, GitHub Actions workflow, or CI provenance is used.

## Stop gate: third-party redistribution

Do not pack for release or publish while `assets/licensing/redistribution-status.json` has `redistribution_approved: false`.

Release may proceed only after either:

1. the original author provides written permission for modification, public GitHub/npm redistribution, packaging, commercial use, and states attribution requirements; or
2. the workflow is independently rebuilt from clearly licensed official material and the prompt references are independently rewritten.

Record the source link, authorization/rebuild record, attribution and review date in `THIRD_PARTY_NOTICES.md` and the machine-readable licensing file. `pnpm run release:scan` must pass.

## Responsibility boundary

The Agent may run tests, build, scan, dry-runs, inspect a tarball, calculate its hash, and test-install it into an isolated DSH profile. The owner must register/verify the npm account, enable 2FA, retain recovery codes privately, run `npm login`, enter OTP, give final confirmation, and personally run the real `npm publish`.

Never send passwords, OTPs, recovery codes or tokens to an Agent. Never commit `.npmrc`, `.env`, credentials, or registry tokens.

## A. Account and environment

1. Register the npm account and verify its email.
2. Enable 2FA for publishing. Store recovery codes away from this repository and development machine.
3. Verify compatible tools:

   ```powershell
   node --version
   npm --version
   ```

   Stop if Node does not satisfy `package.json#engines.node`.

4. Inspect the registry without changing global configuration:

   ```powershell
   npm config get registry
   ```

   Expected: `https://registry.npmjs.org/`. Stop and investigate any other value.

5. The owner logs in interactively:

   ```powershell
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

   `whoami` must return `izzyj4ck`. Do not place an OTP on the command line.

## B. Name, repository and release commit

1. Check the exact candidate name:

   ```powershell
   npm view @izzyj4ck/dsh-fish-draws --registry=https://registry.npmjs.org/
   ```

   npm 404 means the name may be available; only the final publish response is authoritative. A normal response requires confirming ownership before proceeding.

2. Inspect Git:

   ```powershell
   git status --short
   git rev-parse HEAD
   git log -1 --oneline
   ```

   Require a clean reviewed release commit, version `3.1.1`, and repository `https://github.com/IzzyJ4ck/dsh-fish-draws`.

## C. Tests, build and release gate

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run release:check
```

Stop on any failure. Review `package.json`: name/version/description/keywords/author/license/repository/homepage/bugs, ESM entry points and exports, files allowlist, icon, Node/DSH engines, bundle patch, dependency classes and public npm publishConfig. `private: true` must not exist. There must be no install/build/prepare lifecycle script.

## D. Preview and create the tarball

Run in this order:

```powershell
npm pack --dry-run --json
npm publish --dry-run --access public --registry=https://registry.npmjs.org/
npm pack --json
tar -tf .\izzyj4ck-dsh-fish-draws-3.1.1.tgz
Get-FileHash .\izzyj4ck-dsh-fish-draws-3.1.1.tgz -Algorithm SHA256
```

The archive must contain the prebuilt Host JS, declarations, `cordis.patch.yml`, manifest, READMEs, MIT license, third-party notices, locale, icon, bundled skill, prompt references, fixed workflow, safety config and licensing record.

Stop if it contains `node_modules`, `.git`, images, reference inputs, `.fish-draws-runtime`, `.env`, `.npmrc`, tokens, sessions, logs, coverage, temporary data, machine-path configuration, model weights, or unlicensed assets. The package must not require build/prepare during installation.

## E. Install the exact tarball into an isolated profile

```powershell
dsh plugin --profile <test-profile> add "<absolute-path-to-tgz>"
```

Verify bundle selection and `--dump-config`, tool registration, bundled skill discovery, disable/enable, and removal. In both `E:\ComfyUI` and an unrelated project workspace verify no repeated elevation, then test T2I, one-image edit, multi-image edit, exact dimensions, lifecycle/Strata restoration, retention and cleanup. Verify disable removes both tools and skill; uninstall leaves no package/profile row.

Stop if any tarball test fails. Do not publish.

## F. Final human confirmation and publish

Before publication display and review: npm identity, exact name/version, official registry, public access, Git commit, tarball filename/size/SHA-256/file summary, test results, and the fact that this manual release has no CI provenance.

Only the owner then runs:

```powershell
npm publish "<absolute-path-to-verified-tgz>" --access public --registry=https://registry.npmjs.org/
```

The owner completes interactive 2FA. Do not add `--provenance`; an Agent must not run this command.

## G. Verify the registry release

```powershell
npm view @izzyj4ck/dsh-fish-draws@3.1.1 --registry=https://registry.npmjs.org/
npm view @izzyj4ck/dsh-fish-draws@3.1.1 dist.tarball --registry=https://registry.npmjs.org/
dsh plugin --profile <fresh-profile> add "@izzyj4ck/dsh-fish-draws@3.1.1"
```

Repeat fresh-profile tool, skill, localization/icon, cross-workspace generation, output, disable and uninstall checks. Record package/version, npm and tarball URLs, Git commit/tag, local tgz SHA-256, publish time and verification result—never credentials.

Only after these checks and explicit owner confirmation should a DSH plugin-market index entry or PR be prepared.

## Failure and rollback

If publish reports failure, first query `npm view @izzyj4ck/dsh-fish-draws@3.1.1`. If absent, fix permission/2FA/manifest/network issues and reuse the unchanged verified tgz. If present, do not publish that name/version again.

For a defective published version, prefer:

```powershell
npm deprecate "@izzyj4ck/dsh-fish-draws@3.1.1" "<problem description>"
```

Fix, bump the patch version (for example `3.0.1`), and repeat every test/pack/install/publish step. Consider unpublish only when npm policy explicitly permits it and withdrawal is necessary. A used `name@version` is never reusable, even after withdrawal.
