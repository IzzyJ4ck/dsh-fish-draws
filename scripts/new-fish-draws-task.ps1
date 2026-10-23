[CmdletBinding()]
param(
    [ValidatePattern('^[a-fA-F0-9]{32}$')][string]$TaskId = ([guid]::NewGuid().ToString("N")),
    [Parameter(Mandatory = $true)][ValidateSet("T2I", "Edit")][string]$TaskMode,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$OriginalPrompt,
    [ValidateCount(0, 6)][string[]]$InputImages = @(),
    [string]$RuntimeRoot = "E:\ComfyUI\.fish-draws-runtime"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "fish-draws-common.ps1")

if ($TaskMode -eq "T2I" -and $InputImages.Count -ne 0) {
    throw "T2I task contracts do not accept reference images."
}
if ($TaskMode -eq "Edit" -and ($InputImages.Count -lt 1 -or $InputImages.Count -gt 6)) {
    throw "Edit task contracts require between one and six reference images."
}

$TaskId = $TaskId.ToLowerInvariant()
$taskRoot = Join-Path $RuntimeRoot "tasks"
if (-not (Test-Path -LiteralPath $taskRoot -PathType Container)) {
    [void](New-Item -ItemType Directory -Path $taskRoot -Force)
}
$activeTaskPath = Join-Path $taskRoot "active-task.json"
if (Test-Path -LiteralPath $activeTaskPath -PathType Leaf) {
    $activeTask = [IO.File]::ReadAllText($activeTaskPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    throw "Fish-draws task '$($activeTask.task_id)' is still active. Finish or cancel that real user task before creating another one; historical or compressed content cannot start a task."
}
$manifestPath = Join-Path $taskRoot "$TaskId.json"
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    throw "Task contract '$TaskId' already exists. Reuse it for technical retries and quality rework instead of creating another task."
}

$references = @()
foreach ($path in $InputImages) {
    $metadata = Get-FishDrawsImageMetadata -Path $path
    $references += [ordered]@{
        path = $metadata.path
        sha256 = $metadata.sha256
        width = $metadata.width
        height = $metadata.height
    }
}

$manifest = [ordered]@{
    schema_version = 1
    task_id = $TaskId
    task_mode = $TaskMode.ToLowerInvariant()
    original_prompt_sha256 = Get-FishDrawsTextSha256 -Text $OriginalPrompt
    references = $references
    created_at_utc = [datetime]::UtcNow.ToString("o")
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
$activeTask = [ordered]@{
    schema_version = 1
    task_id = $TaskId
    task_mode = $TaskMode.ToLowerInvariant()
    task_manifest = $manifestPath
    created_at_utc = $manifest.created_at_utc
}
[IO.File]::WriteAllText($activeTaskPath, ($activeTask | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
[ordered]@{
    ok = $true
    task_id = $TaskId
    task_mode = $TaskMode.ToLowerInvariant()
    task_manifest = $manifestPath
} | ConvertTo-Json -Compress
