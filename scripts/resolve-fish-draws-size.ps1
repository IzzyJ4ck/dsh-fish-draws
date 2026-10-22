[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateCount(1, 6)]
    [string[]]$InputImages,

    [ValidateRange(0, 100000)]
    [int]$TargetWidth = 0,

    [ValidateRange(0, 100000)]
    [int]$TargetHeight = 0,

    [string]$AspectRatio = "",
    [string]$SizeReferenceImage = "",
    [string]$CanvasImage = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "fish-draws-common.ps1")

if (($TargetWidth -eq 0) -xor ($TargetHeight -eq 0)) {
    throw "TargetWidth and TargetHeight must be supplied together."
}

$records = @()
for ($index = 0; $index -lt $InputImages.Count; $index++) {
    $dimensions = Get-FishDrawsImageDimensions -Path $InputImages[$index]
    $records += [pscustomobject][ordered]@{
        original_index = $index + 1
        path = $dimensions.path
        width = $dimensions.width
        height = $dimensions.height
    }
}

function Find-InputRecord {
    param([string]$RequestedPath, [string]$Purpose)
    if ([string]::IsNullOrWhiteSpace($RequestedPath)) { return $null }
    $fullRequestedPath = [IO.Path]::GetFullPath($RequestedPath)
    $match = $records | Where-Object { $_.path.Equals($fullRequestedPath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($null -eq $match) { throw "$Purpose must name one of InputImages: $fullRequestedPath" }
    return $match
}

$canvasRecord = Find-InputRecord -RequestedPath $CanvasImage -Purpose "CanvasImage"
if ($null -eq $canvasRecord) { $canvasRecord = $records[0] }
$canonicalRecords = @($canvasRecord)
$canonicalRecords += @($records | Where-Object { $_.original_index -ne $canvasRecord.original_index })

$sizeSource = $null
if ($TargetWidth -gt 0) {
    $resolvedWidth = $TargetWidth
    $resolvedHeight = $TargetHeight
    $sizeSource = "explicit"
} elseif (-not [string]::IsNullOrWhiteSpace($SizeReferenceImage)) {
    $sizeRecord = Find-InputRecord -RequestedPath $SizeReferenceImage -Purpose "SizeReferenceImage"
    $resolvedWidth = [int]$sizeRecord.width
    $resolvedHeight = [int]$sizeRecord.height
    $sizeSource = "reference_image_$($sizeRecord.original_index)"
} elseif (-not [string]::IsNullOrWhiteSpace($AspectRatio)) {
    $ratioSizes = Get-FishDrawsRatioSizes
    if (-not $ratioSizes.Contains($AspectRatio)) {
        $supported = @($ratioSizes.Keys) -join ", "
        throw "Aspect ratio '$AspectRatio' has no approved default size. Ask the user for exact width and height. Supported ratios: $supported"
    }
    $resolvedWidth = [int]$ratioSizes[$AspectRatio][0]
    $resolvedHeight = [int]$ratioSizes[$AspectRatio][1]
    $sizeSource = "ratio:$AspectRatio"
} else {
    $resolvedWidth = [int]$records[0].width
    $resolvedHeight = [int]$records[0].height
    $sizeSource = "first_reference_original"
}

$canvas = Get-FishDrawsSampleCanvas -TargetWidth $resolvedWidth -TargetHeight $resolvedHeight
$aspectChanged = Test-FishDrawsAspectChanged `
    -SourceWidth ([int]$canvasRecord.width) `
    -SourceHeight ([int]$canvasRecord.height) `
    -TargetWidth $resolvedWidth `
    -TargetHeight $resolvedHeight
$outpaintingDirection = "none"
if ($aspectChanged) {
    $sourceRatio = [double]$canvasRecord.width / [double]$canvasRecord.height
    $targetRatio = [double]$resolvedWidth / [double]$resolvedHeight
    $outpaintingDirection = $(if ($targetRatio -gt $sourceRatio) { "horizontal" } else { "vertical" })
}

$inputMapping = @()
for ($canonicalIndex = 0; $canonicalIndex -lt $canonicalRecords.Count; $canonicalIndex++) {
    $record = $canonicalRecords[$canonicalIndex]
    $inputMapping += [pscustomobject][ordered]@{
        tag = "<image$($canonicalIndex + 1)>"
        original_index = $record.original_index
        source_path = $record.path
        original_width = $record.width
        original_height = $record.height
        content_canvas = ($canonicalIndex -eq 0)
    }
}

[ordered]@{
    ok = $true
    request_id = [guid]::NewGuid().ToString("N")
    input_images = @($canonicalRecords.path)
    input_mapping = $inputMapping
    reference_original_dimensions = @($inputMapping | ForEach-Object {
        [pscustomobject][ordered]@{
            tag = $_.tag
            path = $_.source_path
            width = $_.original_width
            height = $_.original_height
        }
    })
    size_source = $sizeSource
    target_width = $canvas.target_width
    target_height = $canvas.target_height
    sample_width = $canvas.sample_width
    sample_height = $canvas.sample_height
    sample_pixels = $canvas.sample_pixels
    outpainting_required = $aspectChanged
    outpainting_direction = $outpaintingDirection
    oversize_confirmation_required = (-not $canvas.safe)
    safe_limits = [ordered]@{
        max_sample_width = 2048
        max_sample_height = 2048
        max_sample_pixels = 2400000
    }
} | ConvertTo-Json -Depth 12
