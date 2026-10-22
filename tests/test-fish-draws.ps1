$ErrorActionPreference = "Stop"
$skillRoot = Split-Path -Parent $PSScriptRoot
$commonPath = Join-Path $skillRoot "scripts\fish-draws-common.ps1"
$resolverPath = Join-Path $skillRoot "scripts\resolve-fish-draws-size.ps1"
$invokePath = Join-Path $skillRoot "scripts\invoke-fish-draws.ps1"
$templatePath = Join-Path $skillRoot "assets\qwen21-unified-api.json"
. $commonPath

$script:assertions = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    $script:assertions++
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    $script:assertions++
    if ($Actual -ne $Expected) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." }
}

$caseRoot = "E:\ComfyUI\fish-draws-api-experiment\01-input-topology"
$image1 = Join-Path $caseRoot "case-03-three-images\input-1.png"
$image2 = Join-Path $caseRoot "case-03-three-images\input-2.png"
$image3 = Join-Path $caseRoot "case-03-three-images\input-3.png"
$sixImages = 1..6 | ForEach-Object {
    $extension = $(if ($_ -le 2) { ".jpg" } else { ".png" })
    Join-Path $caseRoot "case-06-six-images\input-$($_)$extension"
}

$defaultPlan = & $resolverPath -InputImages @($image1, $image2) | ConvertFrom-Json
$firstDimensions = Get-FishDrawsImageDimensions -Path $image1
Assert-Equal $defaultPlan.target_width $firstDimensions.width "default edit width follows the first original image"
Assert-Equal $defaultPlan.target_height $firstDimensions.height "default edit height follows the first original image"
Assert-Equal $defaultPlan.size_source "first_reference_original" "default size source"
Assert-True ([string]$defaultPlan.request_id -match '^[a-f0-9]{32}$') "resolver returns a stable-format retry group id"

$ratioPlan = & $resolverPath -InputImages @($image1) -AspectRatio "16:9" | ConvertFrom-Json
Assert-Equal $ratioPlan.target_width 1920 "16:9 width"
Assert-Equal $ratioPlan.target_height 1080 "16:9 height"
Assert-Equal $ratioPlan.sample_width 1920 "16:9 sample width"
Assert-Equal $ratioPlan.sample_height 1088 "16:9 sample height"
Assert-True $ratioPlan.outpainting_required "16:9 differs from the source ratio"

$exactPlan = & $resolverPath -InputImages @($image1) -TargetWidth 1001 -TargetHeight 701 | ConvertFrom-Json
Assert-Equal $exactPlan.sample_width 1008 "non-multiple width rounds up"
Assert-Equal $exactPlan.sample_height 704 "non-multiple height rounds up"

$thirdDimensions = Get-FishDrawsImageDimensions -Path $image3
$referencePlan = & $resolverPath -InputImages @($image1, $image2, $image3) -SizeReferenceImage $image3 | ConvertFrom-Json
Assert-Equal $referencePlan.target_width $thirdDimensions.width "size reference uses original width"
Assert-Equal $referencePlan.target_height $thirdDimensions.height "size reference uses original height"
Assert-Equal $referencePlan.input_images[0] ([IO.Path]::GetFullPath($image1)) "size reference does not reorder semantic inputs"

$reorderedPlan = & $resolverPath -InputImages @($image1, $image2, $image3) -CanvasImage $image3 | ConvertFrom-Json
Assert-Equal $reorderedPlan.input_images[0] ([IO.Path]::GetFullPath($image3)) "content canvas becomes image1"
Assert-Equal $reorderedPlan.input_mapping[0].original_index 3 "mapping preserves original index"

$oversizePlan = & $resolverPath -InputImages @($image1) -TargetWidth 2048 -TargetHeight 2048 | ConvertFrom-Json
Assert-True $oversizePlan.oversize_confirmation_required "2048 square exceeds the tested pixel envelope"

$unsupportedFailed = $false
try { [void](& $resolverPath -InputImages @($image1) -AspectRatio "5:2") } catch { $unsupportedFailed = $true }
Assert-True $unsupportedFailed "unsupported ratio is rejected"

$utf8Bytes = ConvertTo-FishDrawsJsonUtf8Bytes -Body @{ prompt = "把黑色上衣改成深红色" }
Assert-True ($utf8Bytes -is [byte[]]) "JSON encoder returns a byte array rather than a lossy string"
$utf8RoundTrip = [Text.Encoding]::UTF8.GetString($utf8Bytes) | ConvertFrom-Json
Assert-Equal $utf8RoundTrip.prompt "把黑色上衣改成深红色" "Chinese prompt survives explicit UTF-8 JSON serialization"

$retryTestRoot = Join-Path ([IO.Path]::GetTempPath()) ("fish-draws-retry-test-" + [guid]::NewGuid().ToString("N"))
try {
    $retryGroup = [guid]::NewGuid().ToString("N")
    $attempt1 = Register-FishDrawsAttempt -RetryGroupId $retryGroup -AttemptNumber 1 -TaskMode Edit -StateRoot $retryTestRoot
    Assert-Equal $attempt1.attempts_remaining 2 "first attempt leaves two retries"
    Set-FishDrawsAttemptOutcome -RetryGroupId $retryGroup -StateRoot $retryTestRoot -Completed $true
    $attempt2 = Register-FishDrawsAttempt -RetryGroupId $retryGroup -AttemptNumber 2 -TaskMode Edit -StateRoot $retryTestRoot
    Assert-Equal $attempt2.attempts_remaining 1 "a visually unsuccessful result may consume attempt two"
    $attempt3 = Register-FishDrawsAttempt -RetryGroupId $retryGroup -AttemptNumber 3 -TaskMode Edit -StateRoot $retryTestRoot
    Assert-Equal $attempt3.attempts_remaining 0 "third attempt exhausts retries"
    $fourthFailed = $false
    try { [void](Register-FishDrawsAttempt -RetryGroupId $retryGroup -AttemptNumber 3 -TaskMode Edit -StateRoot $retryTestRoot) } catch { $fourthFailed = $_.Exception.Message -like '*at most three*' }
    Assert-True $fourthFailed "retry ledger rejects a fourth invocation"

    $sequenceGroup = [guid]::NewGuid().ToString("N")
    [void](Register-FishDrawsAttempt -RetryGroupId $sequenceGroup -AttemptNumber 1 -TaskMode T2I -StateRoot $retryTestRoot)
    $duplicateFailed = $false
    try { [void](Register-FishDrawsAttempt -RetryGroupId $sequenceGroup -AttemptNumber 1 -TaskMode T2I -StateRoot $retryTestRoot) } catch { $duplicateFailed = $_.Exception.Message -like '*must be 2*' }
    Assert-True $duplicateFailed "retry ledger rejects repeated attempt numbers"
} finally {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $retryRootFull = [IO.Path]::GetFullPath($retryTestRoot).TrimEnd('\') + '\'
    if ($retryRootFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $retryTestRoot) -like 'fish-draws-retry-test-*') {
        Remove-Item -LiteralPath $retryTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Build-Graph {
    param([string[]]$Names, [string]$Acceleration = "Balanced")
    return New-FishDrawsGraph `
        -TemplatePath $templatePath `
        -ExpandedPrompt "test prompt" `
        -InputImageNames $Names `
        -TargetWidth 1001 `
        -TargetHeight 701 `
        -SampleWidth 1008 `
        -SampleHeight 704 `
        -Seed 123 `
        -Steps 40 `
        -Acceleration $Acceleration `
        -FilenamePrefix "fish-draws/test"
}

foreach ($count in @(0, 1, 2, 6)) {
    $names = @()
    for ($index = 1; $index -le $count; $index++) { $names += "fish-draws/test/input-$index.png" }
    $graph = Build-Graph -Names $names
    $classes = @($graph.PSObject.Properties.Value.class_type)
    Assert-True ($classes -notcontains "ResolutionSelector") "graph with $count inputs omits ResolutionSelector"
    Assert-Equal $graph.'6'.inputs.resolution 0 "encoder resolution remains zero"
    Assert-Equal $graph.'8'.inputs.latent_image[0] "7" "sampler latent always comes from EmptyLatentImage"
    Assert-Equal $graph.'7'.inputs.width 1008 "custom latent width"
    Assert-Equal $graph.'7'.inputs.height 704 "custom latent height"
    Assert-Equal $graph.'10'.inputs.width 1001 "exact crop width"
    Assert-Equal $graph.'10'.inputs.height 701 "exact crop height"
    $imageInputs = @($graph.'6'.inputs.PSObject.Properties | Where-Object { $_.Name -like 'images.image_*' })
    Assert-Equal $imageInputs.Count $count "encoder has exactly $count reference connections"
}

$balanced = Build-Graph -Names @("fish-draws/test/input-1.png") -Acceleration Balanced
Assert-True ($null -eq $balanced.PSObject.Properties['12']) "balanced graph omits EasyCache"
Assert-Equal $balanced.'8'.inputs.model[0] "3" "balanced model chain ends at Sage"

$fast = Build-Graph -Names @("fish-draws/test/input-1.png") -Acceleration Fast
Assert-Equal $fast.'12'.class_type "EasyCache" "fast graph includes EasyCache"
Assert-Equal $fast.'12'.inputs.model[0] "3" "EasyCache follows Sage"
Assert-Equal $fast.'8'.inputs.model[0] "12" "sampler follows EasyCache"

$beforeTarget = @($fast.'10'.inputs.width, $fast.'10'.inputs.height, $fast.'7'.inputs.width, $fast.'7'.inputs.height)
$fast.'101'.inputs.megapixels = 0.5
$afterTarget = @($fast.'10'.inputs.width, $fast.'10'.inputs.height, $fast.'7'.inputs.width, $fast.'7'.inputs.height)
Assert-Equal ($afterTarget -join 'x') ($beforeTarget -join 'x') "reference preprocessing cannot change delivery canvas"

$templateText = Get-Content -LiteralPath $templatePath -Raw
Assert-True (-not $templateText.Contains("ResolutionSelector")) "template omits ResolutionSelector"
$editPrompt = Get-Content -LiteralPath (Join-Path $skillRoot "references\system-prompt-edit.md") -Raw
Assert-True ($editPrompt.Contains('outpainting_required')) "edit prompt consumes deterministic outpainting context"
Assert-True (-not $editPrompt.Contains('"wh_ratio"')) "edit prompt does not return a size decision"
$t2iPrompt = Get-Content -LiteralPath (Join-Path $skillRoot "references\system-prompt-t2i.md") -Raw
Assert-True ($t2iPrompt.Contains('"rewritten_prompt"')) "T2I system prompt returns rewritten_prompt"
Assert-True ($t2iPrompt.Contains('"wh_ratio"')) "T2I system prompt returns wh_ratio"

$invokeText = Get-Content -LiteralPath $invokePath -Raw
Assert-True ($invokeText.Contains('ConvertTo-FishDrawsJsonUtf8Bytes -Body $Body')) "JSON request bodies use explicit UTF-8 bytes"
Assert-True ($invokeText.Contains('application/json; charset=utf-8')) "JSON requests declare UTF-8"
Assert-True ($invokeText.Contains('[ValidateRange(1, 3)]')) "generation helper exposes a three-attempt ceiling"

[ordered]@{
    ok = $true
    assertions = $script:assertions
    tested_input_counts = @(0, 1, 2, 6)
} | ConvertTo-Json -Compress
