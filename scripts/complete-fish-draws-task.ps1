[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{32}$')][string]$TaskId,
    [Parameter(Mandatory = $true)][string]$TaskManifestPath,
    [string]$RuntimeRoot = "E:\ComfyUI\.fish-draws-runtime"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "fish-draws-common.ps1")

$TaskId = $TaskId.ToLowerInvariant()
$taskRoot = Join-Path $RuntimeRoot "tasks"
$activeTaskPath = Join-Path $taskRoot "active-task.json"
if (-not (Test-FishDrawsPathUnderRoot -Path $TaskManifestPath -Root $taskRoot)) {
    throw "Task manifest must remain under the fish-draws runtime task directory."
}
if (-not (Test-Path -LiteralPath $TaskManifestPath -PathType Leaf)) { throw "Task manifest not found: $TaskManifestPath" }
if (-not (Test-Path -LiteralPath $activeTaskPath -PathType Leaf)) { throw "No active fish-draws task is registered." }

$manifest = [IO.File]::ReadAllText($TaskManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$activeTask = [IO.File]::ReadAllText($activeTaskPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ([int]$manifest.schema_version -ne 1 -or [int]$activeTask.schema_version -ne 1 -or [string]$manifest.task_id -ne $TaskId -or [string]$activeTask.task_id -ne $TaskId) {
    throw "Only the currently active task may be completed."
}
$activeManifestPath = [IO.Path]::GetFullPath([string]$activeTask.task_manifest)
$requestedManifestPath = [IO.Path]::GetFullPath($TaskManifestPath)
if (-not $activeManifestPath.Equals($requestedManifestPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The active task manifest does not match TaskManifestPath."
}

Remove-Item -LiteralPath $activeTaskPath -Force
[ordered]@{ ok = $true; task_id = $TaskId; active_task_cleared = $true } | ConvertTo-Json -Compress
