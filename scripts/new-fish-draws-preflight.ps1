[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{32}$')][string]$ExecutionId,
    [Parameter(Mandatory = $true)][ValidateCount(1, 6)][string[]]$InputImages,
    [Parameter(Mandatory = $true)][ValidateSet("Simple", "MultiImage", "Identity", "ReadableText", "AssetExtraction", "DetailDense", "ComplexOutpainting", "Ambiguous")][string]$TaskClass,
    [Parameter(Mandatory = $true)][string]$FactsJson,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ExpandedPrompt,
    [switch]$UserConfirmed,
    [switch]$CalibrationOnly,
    [string]$RuntimeRoot = "E:\ComfyUI\.fish-draws-runtime"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "fish-draws-common.ps1")

$facts = @($FactsJson | ConvertFrom-Json)
if ($facts.Count -ne $InputImages.Count) { throw "FactsJson must contain exactly one visual fact record per input image." }
$references = @()
for ($index = 0; $index -lt $InputImages.Count; $index++) {
    $metadata = Get-FishDrawsImageMetadata -Path $InputImages[$index]
    $fact = $facts[$index]
    $expectedTag = "<image$($index + 1)>"
    if ($InputImages.Count -gt 1 -and [string]$fact.image_tag -ne $expectedTag) { throw "Fact record $($index + 1) must use image_tag '$expectedTag'." }
    foreach ($uncertainty in @($fact.uncertain)) {
        $text = ([string]$uncertainty).Trim()
        if ($text.Length -ge 4 -and $ExpandedPrompt.IndexOf($text, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "ExpandedPrompt repeats an unconfirmed observation as fact: '$text'. Resolve it or describe it explicitly as uncertain."
        }
    }
    $references += [ordered]@{
        image_tag = $(if ($InputImages.Count -gt 1) { $expectedTag } else { $null })
        path = $metadata.path
        sha256 = $metadata.sha256
        width = $metadata.width
        height = $metadata.height
        facts = [ordered]@{
            certain = @($fact.certain)
            counts = @($fact.counts)
            positions = @($fact.positions)
            readable_text = @($fact.readable_text)
            occlusion = @($fact.occlusion)
            uncertain = @($fact.uncertain)
        }
    }
}

$requiresConfirmation = ($TaskClass -ne "Simple" -or $InputImages.Count -gt 1)
$ready = ($CalibrationOnly -or -not $requiresConfirmation -or [bool]$UserConfirmed)
$directory = Join-Path $RuntimeRoot "preflight"
if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [void](New-Item -ItemType Directory -Path $directory -Force) }
$path = Join-Path $directory "$($ExecutionId.ToLowerInvariant()).json"
$manifest = [ordered]@{
    schema_version = 1
    execution_id = $ExecutionId.ToLowerInvariant()
    task_class = $TaskClass.ToLowerInvariant()
    requires_confirmation = $requiresConfirmation
    user_confirmed = [bool]$UserConfirmed
    calibration_only = [bool]$CalibrationOnly
    ready = $ready
    expanded_prompt = $ExpandedPrompt
    expanded_prompt_sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ExpandedPrompt)))
    references = $references
    created_at_utc = [datetime]::UtcNow.ToString("o")
}
[IO.File]::WriteAllText($path, ($manifest | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
[ordered]@{ ok = $true; ready = $ready; requires_confirmation = $requiresConfirmation; preflight_manifest = $path } | ConvertTo-Json -Compress
