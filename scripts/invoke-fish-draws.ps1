[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpandedPrompt,

    [string]$OriginalPrompt = "",

    [ValidateSet("T2I", "Edit")]
    [string]$TaskMode = "T2I",

    [ValidateCount(0, 6)]
    [string[]]$InputImages = @(),

    [string]$AspectRatio = "",

    [Alias("Width")]
    [ValidateRange(0, 100000)]
    [int]$TargetWidth = 0,

    [Alias("Height")]
    [ValidateRange(0, 100000)]
    [int]$TargetHeight = 0,

    [ValidateRange(0, 100000)]
    [int]$SampleWidth = 0,

    [ValidateRange(0, 100000)]
    [int]$SampleHeight = 0,

    [string]$SizeSource = "",

    [ValidateSet("Balanced", "Fast")]
    [string]$Acceleration = "Balanced",

    [switch]$AllowOversize,

    [Alias("RetryGroupId")]
    [string]$ExecutionId = "",

    [Alias("AttemptNumber")]
    [ValidateRange(1, 4)]
    [int]$TechnicalAttempt = 1,

    [string]$PreflightManifestPath = "",

    [switch]$CalibrationRun,

    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [long]$Seed = -1,

    [ValidateRange(1, 100)]
    [int]$Steps = 40,

    [ValidateRange(1024, 30000)]
    [int]$ReserveMiB = 21504,

    [ValidateRange(60, 3600)]
    [int]$TimeoutSecondsPerImage = 900,

    [string]$ComfyBaseUrl = "http://127.0.0.1:8188",
    [string]$ComfyInputRoot = "E:\ComfyUI\ComfyUI\input",
    [string]$ComfyOutputRoot = "E:\ComfyUI\ComfyUI\output",
    [string]$StrataConfig = "E:\Strata\strata-iq3_s.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "fish-draws-common.ps1")

if (($TargetWidth -eq 0) -xor ($TargetHeight -eq 0)) {
    throw "TargetWidth and TargetHeight must be supplied together."
}
if (($SampleWidth -eq 0) -xor ($SampleHeight -eq 0)) {
    throw "SampleWidth and SampleHeight must be supplied together."
}
if ($TaskMode -eq "T2I" -and $InputImages.Count -ne 0) {
    throw "T2I does not accept reference images. Use TaskMode Edit."
}
if ($TaskMode -eq "Edit" -and ($InputImages.Count -lt 1 -or $InputImages.Count -gt 6)) {
    throw "Edit requires between one and six reference images."
}

$ratioSizes = Get-FishDrawsRatioSizes
if ($TargetWidth -eq 0) {
    if ($TaskMode -eq "Edit") {
        throw "Edit requires resolved TargetWidth and TargetHeight. Run resolve-fish-draws-size.ps1 before prompt expansion."
    }
    if ([string]::IsNullOrWhiteSpace($AspectRatio) -or -not $ratioSizes.Contains($AspectRatio)) {
        $supported = @($ratioSizes.Keys) -join ", "
        throw "T2I requires a supported AspectRatio or exact target dimensions. Supported ratios: $supported"
    }
    $TargetWidth = [int]$ratioSizes[$AspectRatio][0]
    $TargetHeight = [int]$ratioSizes[$AspectRatio][1]
    if ([string]::IsNullOrWhiteSpace($SizeSource)) { $SizeSource = "ratio:$AspectRatio" }
} elseif ([string]::IsNullOrWhiteSpace($SizeSource)) {
    $SizeSource = "explicit"
}

if ($Count -gt 1) { $Acceleration = "Fast" }
$canvas = Get-FishDrawsSampleCanvas -TargetWidth $TargetWidth -TargetHeight $TargetHeight
if ($SampleWidth -eq 0) {
    $SampleWidth = $canvas.sample_width
    $SampleHeight = $canvas.sample_height
} elseif ($SampleWidth -ne $canvas.sample_width -or $SampleHeight -ne $canvas.sample_height) {
    throw "Sample dimensions must equal the target dimensions rounded up to multiples of 16: $($canvas.sample_width)x$($canvas.sample_height)."
}
$safetyProfileName = Get-FishDrawsSafetyProfileName -TaskMode $TaskMode -InputCount $InputImages.Count -Acceleration $Acceleration -Count $Count
$safetyProfile = Get-FishDrawsSafetyProfile -ProfileName $safetyProfileName
$canvasSafe = Test-FishDrawsCanvasAgainstProfile -Canvas $canvas -Profile $safetyProfile
if (-not $canvasSafe -and -not $AllowOversize) {
    throw "Sampling canvas ${SampleWidth}x${SampleHeight} exceeds safety profile '$safetyProfileName' ($($safetyProfile.max_sample_width)x$($safetyProfile.max_sample_height), $($safetyProfile.max_sample_pixels) pixels). Ask the user to confirm, then retry with -AllowOversize, or use a smaller target."
}
if (-not $PSBoundParameters.ContainsKey("ReserveMiB") -and $null -ne $safetyProfile.reserve_mib) { $ReserveMiB = [int]$safetyProfile.reserve_mib }
if ([string]::IsNullOrWhiteSpace($ExecutionId)) {
    if ($TechnicalAttempt -ne 1) { throw "ExecutionId is required when TechnicalAttempt is greater than one." }
    $ExecutionId = [guid]::NewGuid().ToString("N")
} elseif ($ExecutionId -notmatch '^[a-fA-F0-9]{32}$') {
    throw "ExecutionId must be a 32-character hexadecimal GUID without separators."
}
$ExecutionId = $ExecutionId.ToLowerInvariant()

$tagMatches = [regex]::Matches($ExpandedPrompt, '<image(\d+)>')
$tagNumbers = @($tagMatches | ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
if ($TaskMode -eq "T2I" -and $tagNumbers.Count -gt 0) {
    throw "T2I prompts must not contain <imageN> tags."
}
if ($TaskMode -eq "Edit" -and $InputImages.Count -eq 1 -and $tagNumbers.Count -gt 0) {
    throw "Single-image edit prompts must refer to the image naturally and must not contain <imageN> tags."
}
if ($TaskMode -eq "Edit" -and $InputImages.Count -gt 1) {
    foreach ($number in $tagNumbers) {
        if ($number -lt 1 -or $number -gt $InputImages.Count) {
            throw "Expanded prompt refers to <image$number>, but only $($InputImages.Count) reference images were supplied."
        }
    }
    for ($number = 1; $number -le $InputImages.Count; $number++) {
        if ($tagNumbers -notcontains $number) {
            throw "Multi-image edit prompt must explicitly describe the role of <image$number>."
        }
    }
}

$templatePath = Join-Path (Split-Path -Parent $PSScriptRoot) "assets\qwen21-unified-api.json"
$lifecyclePath = Join-Path $PSScriptRoot "comfy-lifecycle.ps1"
$executionStateRoot = "E:\ComfyUI\.fish-draws-runtime\execution-attempts"
$runtimeRoot = "E:\ComfyUI\.fish-draws-runtime"
$jobId = [guid]::NewGuid().ToString("N")
$startedAt = Get-Date
$referenceDimensions = @()
foreach ($path in $InputImages) { $referenceDimensions += Get-FishDrawsImageDimensions -Path $path }
$outpaintingRequired = $false
$outpaintingDirection = "none"
if ($TaskMode -eq "Edit") {
    $outpaintingRequired = Test-FishDrawsAspectChanged `
        -SourceWidth ([int]$referenceDimensions[0].width) `
        -SourceHeight ([int]$referenceDimensions[0].height) `
        -TargetWidth $TargetWidth `
        -TargetHeight $TargetHeight
    if ($outpaintingRequired) {
        $sourceRatio = [double]$referenceDimensions[0].width / [double]$referenceDimensions[0].height
        $targetRatio = [double]$TargetWidth / [double]$TargetHeight
        $outpaintingDirection = $(if ($targetRatio -gt $sourceRatio) { "horizontal" } else { "vertical" })
    }
}

$result = [ordered]@{
    ok = $false
    job_id = $jobId
    execution_id = $ExecutionId
    technical_attempt = $TechnicalAttempt
    max_technical_attempts = 4
    failure_class = $null
    task_mode = $TaskMode.ToLowerInvariant()
    original_prompt = $OriginalPrompt
    expanded_prompt = $ExpandedPrompt
    aspect_ratio = $AspectRatio
    size_source = $SizeSource
    target_width = $TargetWidth
    target_height = $TargetHeight
    sample_width = $SampleWidth
    sample_height = $SampleHeight
    sample_pixels = ([long]$SampleWidth * [long]$SampleHeight)
    oversize_confirmed = [bool]$AllowOversize
    outpainting_required = $outpaintingRequired
    outpainting_direction = $outpaintingDirection
    acceleration = $Acceleration.ToLowerInvariant()
    count = $Count
    steps = $Steps
    requested_reserve_mib = $ReserveMiB
    vram_free_after_shrink_mib = $null
    minimum_gpu_free_mib = $null
    minimum_system_available_mib = $null
    safety_profile = $safetyProfileName
    safety_profile_calibrated = [bool]$safetyProfile.calibrated
    safety_profile_user_override = [bool]$safetyProfile.user_override
    safety_profile_approval = [string]$safetyProfile.approval_source
    calibration_run = [bool]$CalibrationRun
    reference_original_dimensions = @()
    input_mapping = @()
    images = @()
    outputs = @()
    resource_metrics = $null
    seeds = @()
    strata_restored = $false
    comfy_managed = $false
    cleanup = "not_started"
    error = $null
    duration_seconds = $null
}
for ($index = 0; $index -lt $referenceDimensions.Count; $index++) {
    $result.reference_original_dimensions += [ordered]@{
        tag = "<image$($index + 1)>"
        path = $referenceDimensions[$index].path
        width = $referenceDimensions[$index].width
        height = $referenceDimensions[$index].height
    }
}

$mutex = New-Object System.Threading.Mutex($false, "Local\FishDrawsV1")
$hasMutex = $false
$strataShrunk = $false
$safeToRestore = $false
$restoreReserveKnown = $false
$restoreReserve = $null
$strataHeaders = $null
$strataBaseUrl = $null
$activePromptId = $null
$stagedInputDirectory = $null
$stagedInputNames = @()
$technicalAttemptRegistered = $false
$preflightManifest = $null
$exitCode = 0

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        $Body = $null,
        $Headers = $null,
        [int]$TimeoutSec = 30
    )
    $args = @{ Method = $Method; Uri = $Uri; TimeoutSec = $TimeoutSec; ErrorAction = "Stop" }
    if ($null -ne $Headers) { $args.Headers = $Headers }
    if ($null -ne $Body) {
        $args.ContentType = "application/json; charset=utf-8"
        $args.Body = ConvertTo-FishDrawsJsonUtf8Bytes -Body $Body
    }
    return Invoke-RestMethod @args
}

function Get-PropertyValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-GpuFreeMiB {
    try {
        $line = & nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        if ($line -match '^\s*(\d+)') { return [int]$Matches[1] }
    } catch {}
    return $null
}

function Get-SystemAvailableMiB {
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        return [int][Math]::Floor([double]$os.FreePhysicalMemory / 1024.0)
    } catch {
        try { return [int][Math]::Floor((Get-Counter '\Memory\Available MBytes' -ErrorAction Stop).CounterSamples[0].CookedValue) } catch { return $null }
    }
}

function Update-MinimumGpuFree {
    $free = Get-GpuFreeMiB
    if ($null -ne $free -and ($null -eq $result.minimum_gpu_free_mib -or $free -lt $result.minimum_gpu_free_mib)) {
        $result.minimum_gpu_free_mib = $free
    }
    $systemAvailable = Get-SystemAvailableMiB
    if ($null -ne $systemAvailable -and ($null -eq $result.minimum_system_available_mib -or $systemAvailable -lt $result.minimum_system_available_mib)) {
        $result.minimum_system_available_mib = $systemAvailable
    }
}

function Test-ComfyOnline {
    try {
        [void](Invoke-RestMethod -Uri "$ComfyBaseUrl/system_stats" -Method Get -TimeoutSec 5 -ErrorAction Stop)
        return $true
    } catch { return $false }
}

function Touch-ManagedComfyActivity {
    if (-not (Test-Path -LiteralPath $lifecyclePath -PathType Leaf)) { return $false }
    try {
        $activityJson = & $lifecyclePath -Action Touch -ComfyBaseUrl $ComfyBaseUrl
        $activity = $activityJson | ConvertFrom-Json
        return ($activity.managed -eq $true)
    } catch { return $false }
}

function Test-ComfyIdle {
    try {
        $queue = Invoke-RestMethod -Uri "$ComfyBaseUrl/queue" -Method Get -TimeoutSec 10 -ErrorAction Stop
        return (@($queue.queue_running).Count -eq 0 -and @($queue.queue_pending).Count -eq 0)
    } catch { return $false }
}

function Wait-ComfyIdle {
    param([int]$TimeoutSec = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-ComfyIdle) { return $true }
        Update-MinimumGpuFree
        Start-Sleep -Seconds 2
    }
    return $false
}

function Free-ComfyModels {
    if (-not (Test-ComfyIdle)) { return $false }
    [void](Invoke-JsonRequest -Method Post -Uri "$ComfyBaseUrl/free" -Body @{ unload_models = $true; free_memory = $true } -TimeoutSec 30)
    Start-Sleep -Seconds 5
    return (Test-ComfyIdle)
}

function Wait-StrataIdle {
    param([int]$TimeoutSec = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $status = Invoke-JsonRequest -Method Get -Uri "$strataBaseUrl/v1/status" -Headers $strataHeaders -TimeoutSec 15
        $inFlight = Get-PropertyValue $status "in_flight"
        $busy = Get-PropertyValue $status "busy"
        $queued = Get-PropertyValue $status "queued"
        if (($null -eq $inFlight -or [int]$inFlight -eq 0) -and $busy -ne $true -and ($null -eq $queued -or [int]$queued -eq 0)) {
            return $status
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "Strata still has an active or queued request; VRAM was not resized."
}

function Stop-ComfyPromptSafely {
    param([string]$PromptId)
    if ([string]::IsNullOrWhiteSpace($PromptId)) { return (Wait-ComfyIdle -TimeoutSec 30) }
    try { [void](Invoke-JsonRequest -Method Post -Uri "$ComfyBaseUrl/interrupt" -Body @{ prompt_id = $PromptId } -TimeoutSec 15) } catch {}
    try { [void](Invoke-JsonRequest -Method Post -Uri "$ComfyBaseUrl/queue" -Body @{ delete = @($PromptId) } -TimeoutSec 15) } catch {}
    return (Wait-ComfyIdle -TimeoutSec 120)
}

function Wait-ComfyResult {
    param([string]$PromptId, [int]$TimeoutSec, [string[]]$SaveNodeIds = @("11"))
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Update-MinimumGpuFree
        $history = Invoke-RestMethod -Uri "$ComfyBaseUrl/history/$PromptId" -Method Get -TimeoutSec 15 -ErrorAction Stop
        $entryProperty = $history.PSObject.Properties | Where-Object { $_.Name -eq $PromptId } | Select-Object -First 1
        if ($null -ne $entryProperty) {
            $entry = $entryProperty.Value
            if ($entry.status.completed -eq $true) {
                if ($entry.status.status_str -ne "success") {
                    $messages = $entry.status.messages | ConvertTo-Json -Depth 20 -Compress
                    throw "ComfyUI execution failed for prompt ${PromptId}: $messages"
                }
                $saved = @()
                foreach ($saveNodeId in $SaveNodeIds) {
                    $saveNode = $entry.outputs.PSObject.Properties[$saveNodeId]
                    if ($null -eq $saveNode -or @($saveNode.Value.images).Count -eq 0) {
                        throw "ComfyUI completed prompt $PromptId without an image from save node '$saveNodeId'."
                    }
                    $saved += @($saveNode.Value.images)
                }
                return $saved
            }
        }
        Start-Sleep -Seconds 2
    }
    throw "ComfyUI prompt $PromptId timed out after $TimeoutSec seconds."
}

function Stage-ReferenceImages {
    if ($InputImages.Count -eq 0) { return }
    $inputRootFull = [IO.Path]::GetFullPath($ComfyInputRoot).TrimEnd('\') + '\'
    if (-not (Test-Path -LiteralPath $inputRootFull -PathType Container)) { throw "ComfyUI input directory not found: $inputRootFull" }
    $fishRoot = Join-Path $inputRootFull "fish-draws"
    $script:stagedInputDirectory = Join-Path $fishRoot $jobId
    [void](New-Item -ItemType Directory -Path $script:stagedInputDirectory -Force)
    for ($index = 0; $index -lt $InputImages.Count; $index++) {
        $source = [IO.Path]::GetFullPath($InputImages[$index])
        $extension = [IO.Path]::GetExtension($source)
        if ([string]::IsNullOrWhiteSpace($extension)) { $extension = ".png" }
        $filename = "input-$($index + 1)$($extension.ToLowerInvariant())"
        $destination = Join-Path $script:stagedInputDirectory $filename
        Copy-Item -LiteralPath $source -Destination $destination -Force
        $relative = "fish-draws/$jobId/$filename"
        $script:stagedInputNames += $relative
        $result.input_mapping += [ordered]@{
            tag = "<image$($index + 1)>"
            source_path = $source
            staged_name = $relative
            original_width = $referenceDimensions[$index].width
            original_height = $referenceDimensions[$index].height
            content_canvas = ($index -eq 0)
        }
    }
}

function Remove-StagedReferenceImages {
    if ([string]::IsNullOrWhiteSpace($script:stagedInputDirectory)) { return $true }
    try {
        $allowedRoot = [IO.Path]::GetFullPath((Join-Path $ComfyInputRoot "fish-draws")).TrimEnd('\') + '\'
        $candidate = [IO.Path]::GetFullPath($script:stagedInputDirectory).TrimEnd('\') + '\'
        if (-not $candidate.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or $candidate.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove staged inputs outside the fish-draws input root."
        }
        if (Test-Path -LiteralPath $script:stagedInputDirectory -PathType Container) {
            Remove-Item -LiteralPath $script:stagedInputDirectory -Recurse -Force
        }
        return $true
    } catch {
        $result.error = (($result.error + "; ").TrimStart('; ')) + "Temporary input cleanup failed: $($_.Exception.Message)"
        return $false
    }
}

function Get-TextSha256 {
    param([string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text)))
}

function Read-ValidatedPreflightManifest {
    if ($TaskMode -ne "Edit") { return $null }
    if ([string]::IsNullOrWhiteSpace($PreflightManifestPath)) { throw "Edit requires a visual preflight manifest created by new-fish-draws-preflight.ps1." }
    $preflightRoot = Join-Path $runtimeRoot "preflight"
    if (-not (Test-FishDrawsPathUnderRoot -Path $PreflightManifestPath -Root $preflightRoot)) { throw "Preflight manifest must remain under the fish-draws runtime preflight directory." }
    if (-not (Test-Path -LiteralPath $PreflightManifestPath -PathType Leaf)) { throw "Preflight manifest not found: $PreflightManifestPath" }
    $manifest = Get-Content -LiteralPath $PreflightManifestPath -Raw | ConvertFrom-Json
    if ([int]$manifest.schema_version -ne 1 -or [string]$manifest.execution_id -ne $ExecutionId) { throw "Preflight manifest identity mismatch." }
    if ([bool]$manifest.calibration_only -ne [bool]$CalibrationRun) { throw "Calibration-only preflight manifests cannot be used for normal delivery, and normal manifests cannot be substituted during calibration." }
    if ($manifest.ready -ne $true) { throw "Preflight requires user confirmation before generation." }
    if ([string]$manifest.expanded_prompt_sha256 -ne (Get-TextSha256 -Text $ExpandedPrompt)) { throw "Expanded prompt changed after preflight confirmation." }
    if (@($manifest.references).Count -ne $InputImages.Count) { throw "Preflight reference count mismatch." }
    for ($index = 0; $index -lt $InputImages.Count; $index++) {
        $metadata = Get-FishDrawsImageMetadata -Path $InputImages[$index]
        if ([string]$manifest.references[$index].sha256 -ne $metadata.sha256) { throw "Reference image $($index + 1) changed after visual preflight." }
    }
    return $manifest
}

function Resolve-ComfyOutputPath {
    param($ImageRecord)
    if ($ImageRecord.type -ne "output") { throw "Unexpected ComfyUI image type '$($ImageRecord.type)'." }
    $outputRootFull = [IO.Path]::GetFullPath($ComfyOutputRoot).TrimEnd('\') + '\'
    $candidate = Join-Path $ComfyOutputRoot (Join-Path ([string]$ImageRecord.subfolder) ([string]$ImageRecord.filename))
    $fullPath = [IO.Path]::GetFullPath($candidate)
    if (-not $fullPath.StartsWith($outputRootFull, [StringComparison]::OrdinalIgnoreCase)) { throw "ComfyUI returned a path outside the output directory." }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "ComfyUI output was not found: $fullPath" }
    return $fullPath
}

$failurePhase = "preflight"
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw "Another fish-draws job is already running." }
    $preflightManifest = Read-ValidatedPreflightManifest
    if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw "Workflow template not found: $templatePath" }
    if (-not (Test-Path -LiteralPath $StrataConfig -PathType Leaf)) { throw "Strata config not found: $StrataConfig" }
    $failurePhase = "startup"
    if (-not (Test-ComfyOnline)) { throw "ComfyUI is offline at $ComfyBaseUrl. Start it as a separate DSH-managed background job, wait for /system_stats, then run this helper again." }

    $failurePhase = "technical"
    $result.comfy_managed = Touch-ManagedComfyActivity
    if (-not (Wait-ComfyIdle -TimeoutSec 30)) { throw "ComfyUI already has another running or queued job." }
    if (-not (Free-ComfyModels)) { throw "ComfyUI was not confirmed idle before the VRAM handoff." }
    Stage-ReferenceImages

    $config = Get-Content -LiteralPath $StrataConfig -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$config.api_key)) { throw "Strata config has no api_key." }
    $strataBaseUrl = "http://127.0.0.1:$([int]$config.port)"
    $strataHeaders = @{ Authorization = "Bearer $($config.api_key)" }

    $preStatus = Wait-StrataIdle -TimeoutSec 90
    if ($preStatus.loaded -ne $true) { throw "Strata is not loaded." }
    if ($preStatus.vram.elastic -ne $true) { throw "Strata VRAM elasticity is not enabled." }
    $priorReserve = Get-PropertyValue $preStatus.vram "reserve_mib"
    if ($null -ne $priorReserve) {
        $restoreReserveKnown = $true
        $restoreReserve = [int]$priorReserve
    }

    $shrink = Invoke-JsonRequest -Method Post -Uri "$strataBaseUrl/v1/vram" -Headers $strataHeaders -Body @{ reserve_mib = $ReserveMiB } -TimeoutSec 330
    if ($shrink.status -ne "ok") { throw "Strata rejected the VRAM handoff with status '$($shrink.status)'." }
    $strataShrunk = $true
    $actualFree = Get-PropertyValue $shrink "vram_free_mib"
    $result.vram_free_after_shrink_mib = $actualFree
    if ($null -eq $actualFree -or [int]$actualFree -lt $ReserveMiB) {
        throw "Strata freed only $actualFree MiB; the requested reserve is $ReserveMiB MiB."
    }

    if ($Seed -lt 0) { $Seed = [long](Get-Random -Minimum 1 -Maximum 2147483647) }
    for ($index = 0; $index -lt $Count; $index++) {
        $imageSeed = $Seed + $index
        $result.seeds += $imageSeed
        $outputNamespace = $(if ($CalibrationRun) { "fish-draws-calibration" } else { "fish-draws" })
        $prefix = "$outputNamespace/$((Get-Date).ToString('yyyyMMdd'))/$jobId/image-$($index + 1)"
        $graph = New-FishDrawsGraph `
            -TemplatePath $templatePath `
            -ExpandedPrompt $ExpandedPrompt `
            -InputImageNames $stagedInputNames `
            -TargetWidth $TargetWidth `
            -TargetHeight $TargetHeight `
            -SampleWidth $SampleWidth `
            -SampleHeight $SampleHeight `
            -Seed $imageSeed `
            -Steps $Steps `
            -Acceleration $Acceleration `
            -FilenamePrefix $prefix

        if (-not $technicalAttemptRegistered) {
            [void](Register-FishDrawsTechnicalAttempt `
                -ExecutionId $ExecutionId `
                -TechnicalAttempt $TechnicalAttempt `
                -TaskMode $TaskMode `
                -StateRoot $executionStateRoot)
            $technicalAttemptRegistered = $true
        }
        $submission = Invoke-JsonRequest -Method Post -Uri "$ComfyBaseUrl/prompt" -Body @{ prompt = $graph; client_id = "fish-draws-$jobId" } -TimeoutSec 30
        if ([string]::IsNullOrWhiteSpace([string]$submission.prompt_id)) { throw "ComfyUI did not return a prompt_id." }
        $activePromptId = [string]$submission.prompt_id
        $images = Wait-ComfyResult -PromptId $activePromptId -TimeoutSec $TimeoutSecondsPerImage
        foreach ($image in @($images)) {
            $fullPath = Resolve-ComfyOutputPath -ImageRecord $image
            $metadata = Get-FishDrawsImageMetadata -Path $fullPath
            if ($metadata.width -ne $TargetWidth -or $metadata.height -ne $TargetHeight) {
                throw "Generated PNG has $($metadata.width)x$($metadata.height), expected ${TargetWidth}x${TargetHeight}."
            }
            $normalizedPath = $fullPath -replace '\\', '/'
            $outputRecord = [ordered]@{
                path = $normalizedPath
                width = $metadata.width
                height = $metadata.height
                seed = $imageSeed
            }
            $result.images += $normalizedPath
            $result.outputs += $outputRecord
        }
        $activePromptId = $null
    }

    if (-not (Wait-ComfyIdle -TimeoutSec 60)) { throw "ComfyUI did not become idle after the batch." }
    if (-not (Free-ComfyModels)) { throw "ComfyUI models could not be confirmed unloaded after the batch." }
    $safeToRestore = $true
    $result.cleanup = "comfy_unloaded"
    $result.ok = $true
}
catch {
    $result.error = $_.Exception.Message
    $result.failure_class = $failurePhase
    $exitCode = 1
    if ($strataShrunk) {
        $stopped = Stop-ComfyPromptSafely -PromptId $activePromptId
        if ($stopped -and (Free-ComfyModels)) {
            $safeToRestore = $true
            $result.cleanup = "interrupted_and_comfy_unloaded"
        } else {
            $result.cleanup = "comfy_not_confirmed_idle_strata_left_squeezed"
        }
    }
}
finally {
    if ($strataShrunk -and $safeToRestore) {
        try {
            $restoreBody = @{ reserve_mib = $null }
            if ($restoreReserveKnown) { $restoreBody.reserve_mib = $restoreReserve }
            $restored = Invoke-JsonRequest -Method Post -Uri "$strataBaseUrl/v1/vram" -Headers $strataHeaders -Body $restoreBody -TimeoutSec 330
            if ($restored.status -eq "ok") {
                $result.strata_restored = $true
            } else {
                $result.ok = $false
                $result.error = (($result.error + "; ").TrimStart('; ')) + "Strata restore returned status '$($restored.status)'."
                $exitCode = 1
            }
        } catch {
            $result.ok = $false
            $result.error = (($result.error + "; ").TrimStart('; ')) + "Strata restore failed: $($_.Exception.Message)"
            $exitCode = 1
        }
    }
    $inputsRemoved = Remove-StagedReferenceImages
    if (-not $inputsRemoved) {
        $result.ok = $false
        $exitCode = 1
    } elseif (-not [string]::IsNullOrWhiteSpace($stagedInputDirectory) -and $result.cleanup -eq "comfy_unloaded") {
        $result.cleanup = "comfy_unloaded_inputs_removed"
    } elseif (-not [string]::IsNullOrWhiteSpace($stagedInputDirectory) -and $result.cleanup -eq "interrupted_and_comfy_unloaded") {
        $result.cleanup = "interrupted_comfy_unloaded_inputs_removed"
    } elseif (-not [string]::IsNullOrWhiteSpace($stagedInputDirectory) -and $result.cleanup -eq "not_started") {
        $result.cleanup = "inputs_removed_before_vram_handoff"
    }
    if ($result.comfy_managed) { [void](Touch-ManagedComfyActivity) }
    if ($technicalAttemptRegistered) {
        try {
            Set-FishDrawsTechnicalAttemptOutcome `
                -ExecutionId $ExecutionId `
                -StateRoot $executionStateRoot `
                -Completed ([bool]$result.ok) `
                -LastError ([string]$result.error)
        } catch {
            $result.ok = $false
            $result.error = (($result.error + "; ").TrimStart('; ')) + "Technical-attempt state update failed: $($_.Exception.Message)"
            $exitCode = 1
        }
    }
    if ($hasMutex) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
}

$result.duration_seconds = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
$result.resource_metrics = [ordered]@{
    requested_reserve_mib = $ReserveMiB
    vram_free_after_shrink_mib = $result.vram_free_after_shrink_mib
    minimum_gpu_free_mib = $result.minimum_gpu_free_mib
    minimum_system_available_mib = $result.minimum_system_available_mib
    duration_seconds = $result.duration_seconds
}
$result | ConvertTo-Json -Depth 30
exit $exitCode
