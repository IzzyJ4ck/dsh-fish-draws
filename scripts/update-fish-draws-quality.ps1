[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{32}$')][string]$QualityTaskId,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{32}$')][string]$ExecutionId,
    [Parameter(Mandatory = $true)][bool]$Improved,
    [string]$Diagnosis = "",
    [string]$RuntimeRoot = "E:\ComfyUI\.fish-draws-runtime"
)

$ErrorActionPreference = "Stop"
$directory = Join-Path $RuntimeRoot "quality"
if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [void](New-Item -ItemType Directory -Path $directory -Force) }
$path = Join-Path $directory "$($QualityTaskId.ToLowerInvariant()).json"
$state = $(if (Test-Path -LiteralPath $path -PathType Leaf) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { $null })
$consecutive = $(if ($Improved) { 0 } elseif ($null -eq $state) { 1 } else { [int]$state.consecutive_no_improvement + 1 })
$history = @($(if ($null -eq $state) { @() } else { @($state.history) }))
$history += [ordered]@{ execution_id = $ExecutionId.ToLowerInvariant(); improved = $Improved; diagnosis = $Diagnosis; recorded_at_utc = [datetime]::UtcNow.ToString("o") }
$record = [ordered]@{
    schema_version = 1
    quality_task_id = $QualityTaskId.ToLowerInvariant()
    consecutive_no_improvement = $consecutive
    pause_required = ($consecutive -ge 2)
    history = $history
}
[IO.File]::WriteAllText($path, ($record | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
$record | ConvertTo-Json -Depth 12
