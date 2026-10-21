[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpandedPrompt,

    [string]$OriginalPrompt = "",

    [Parameter(Mandatory = $true)]
    [ValidateSet("1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:10", "10:16", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3")]
    [string]$AspectRatio,

    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [long]$Seed = -1,

    [ValidateRange(1, 100)]
    [int]$Steps = 25,

    [ValidateRange(0, 2048)]
    [int]$Width = 0,

    [ValidateRange(0, 2048)]
    [int]$Height = 0,

    [ValidateRange(1024, 30000)]
    [int]$ReserveMiB = 20480,

    [ValidateRange(60, 3600)]
    [int]$TimeoutSecondsPerImage = 900,

    [string]$ComfyBaseUrl = "http://127.0.0.1:8188",
    [string]$ComfyOutputRoot = "E:\ComfyUI\ComfyUI\output",
    [string]$StrataConfig = "E:\Strata\strata-iq3_s.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ratioSizes = @{
    "1:1"   = @(1440, 1440)
    "3:2"   = @(1728, 1152)
    "2:3"   = @(1152, 1728)
    "4:3"   = @(1664, 1248)
    "3:4"   = @(1248, 1664)
    "5:4"   = @(1600, 1280)
    "4:5"   = @(1280, 1600)
    "16:10" = @(1792, 1120)
    "10:16" = @(1120, 1792)
    "16:9"  = @(1920, 1080)
    "9:16"  = @(1080, 1920)
    "2:1"   = @(2048, 1024)
    "1:2"   = @(1024, 2048)
    "21:9"  = @(2016, 864)
    "9:21"  = @(864, 2016)
    "3:1"   = @(2040, 680)
    "1:3"   = @(680, 2040)
}

if (($Width -eq 0) -xor ($Height -eq 0)) {
    throw "Width and Height must be supplied together."
}
if ($Width -eq 0) {
    $Width = [int]$ratioSizes[$AspectRatio][0]
    $Height = [int]$ratioSizes[$AspectRatio][1]
}
if (($Width % 8) -ne 0 -or ($Height % 8) -ne 0) {
    throw "Width and Height must both be divisible by 8."
}

$templatePath = Join-Path (Split-Path -Parent $PSScriptRoot) "assets\qwen21-t2i-api.json"
$jobId = [guid]::NewGuid().ToString("N")
$startedAt = Get-Date
$sampleWidth = [int]([Math]::Ceiling($Width / 16.0) * 16)
$sampleHeight = [int]([Math]::Ceiling($Height / 16.0) * 16)
$result = [ordered]@{
    ok = $false
    job_id = $jobId
    original_prompt = $OriginalPrompt
    expanded_prompt = $ExpandedPrompt
    aspect_ratio = $AspectRatio
    width = $Width
    height = $Height
    sample_width = $sampleWidth
    sample_height = $sampleHeight
    count = $Count
    steps = $Steps
    requested_reserve_mib = $ReserveMiB
    vram_free_after_shrink_mib = $null
    minimum_gpu_free_mib = $null
    images = @()
    seeds = @()
    strata_restored = $false
    cleanup = "not_started"
    error = $null
    duration_seconds = $null
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
$exitCode = 0

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        $Body = $null,
        $Headers = $null,
        [int]$TimeoutSec = 30
    )
    $args = @{
        Method = $Method
        Uri = $Uri
        TimeoutSec = $TimeoutSec
        ErrorAction = "Stop"
    }
    if ($null -ne $Headers) { $args.Headers = $Headers }
    if ($null -ne $Body) {
        $args.ContentType = "application/json"
        $args.Body = ($Body | ConvertTo-Json -Depth 30 -Compress)
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

function Update-MinimumGpuFree {
    $free = Get-GpuFreeMiB
    if ($null -ne $free -and ($null -eq $result.minimum_gpu_free_mib -or $free -lt $result.minimum_gpu_free_mib)) {
        $result.minimum_gpu_free_mib = $free
    }
}

function Test-ComfyOnline {
    try {
        [void](Invoke-RestMethod -Uri "$ComfyBaseUrl/system_stats" -Method Get -TimeoutSec 5 -ErrorAction Stop)
        return $true
    } catch {
        return $false
    }
}

function Test-ComfyIdle {
    try {
        $queue = Invoke-RestMethod -Uri "$ComfyBaseUrl/queue" -Method Get -TimeoutSec 10 -ErrorAction Stop
        return (@($queue.queue_running).Count -eq 0 -and @($queue.queue_pending).Count -eq 0)
    } catch {
        return $false
    }
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
    param([string]$PromptId, [int]$TimeoutSec)
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
                $saveNode = $entry.outputs.PSObject.Properties["10"]
                if ($null -eq $saveNode -or @($saveNode.Value.images).Count -eq 0) {
                    throw "ComfyUI completed prompt $PromptId without a saved image."
                }
                return $saveNode.Value.images
            }
        }
        Start-Sleep -Seconds 2
    }
    throw "ComfyUI prompt $PromptId timed out after $TimeoutSec seconds."
}

try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw "Another fish-draws job is already running." }

    if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw "Workflow template not found: $templatePath" }
    if (-not (Test-Path -LiteralPath $StrataConfig -PathType Leaf)) { throw "Strata config not found: $StrataConfig" }

    if (-not (Test-ComfyOnline)) { throw "ComfyUI is offline at $ComfyBaseUrl. Start it as a separate DSH-managed background job, wait for /system_stats, then run this helper again." }
    if (-not (Wait-ComfyIdle -TimeoutSec 30)) { throw "ComfyUI already has another running or queued job." }
    if (-not (Free-ComfyModels)) { throw "ComfyUI was not confirmed idle before the VRAM handoff." }

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
    $outputRootFull = [IO.Path]::GetFullPath($ComfyOutputRoot).TrimEnd('\') + '\'

    for ($index = 0; $index -lt $Count; $index++) {
        $imageSeed = $Seed + $index
        $result.seeds += $imageSeed
        $graph = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
        $graph.'4'.inputs.prompt = $ExpandedPrompt
        $graph.'5'.inputs.width = $sampleWidth
        $graph.'5'.inputs.height = $sampleHeight
        $graph.'7'.inputs.seed = $imageSeed
        $graph.'7'.inputs.steps = $Steps
        $graph.'9'.inputs.width = $Width
        $graph.'9'.inputs.height = $Height
        $graph.'9'.inputs.x = [int](($sampleWidth - $Width) / 2)
        $graph.'9'.inputs.y = [int](($sampleHeight - $Height) / 2)
        $graph.'10'.inputs.filename_prefix = "fish-draws/$((Get-Date).ToString('yyyyMMdd'))/$jobId/image-$($index + 1)"

        $submission = Invoke-JsonRequest -Method Post -Uri "$ComfyBaseUrl/prompt" -Body @{ prompt = $graph; client_id = "fish-draws-$jobId" } -TimeoutSec 30
        if ([string]::IsNullOrWhiteSpace([string]$submission.prompt_id)) {
            throw "ComfyUI did not return a prompt_id."
        }
        $activePromptId = [string]$submission.prompt_id
        $images = Wait-ComfyResult -PromptId $activePromptId -TimeoutSec $TimeoutSecondsPerImage
        foreach ($image in @($images)) {
            if ($image.type -ne "output") { throw "Unexpected ComfyUI image type '$($image.type)'." }
            $candidate = Join-Path $ComfyOutputRoot (Join-Path ([string]$image.subfolder) ([string]$image.filename))
            $fullPath = [IO.Path]::GetFullPath($candidate)
            if (-not $fullPath.StartsWith($outputRootFull, [StringComparison]::OrdinalIgnoreCase)) {
                throw "ComfyUI returned a path outside the output directory."
            }
            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Generated image was not found: $fullPath" }
            $result.images += ($fullPath -replace '\\', '/')
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
    if ($hasMutex) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
}

$result.duration_seconds = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
$result | ConvertTo-Json -Depth 20
exit $exitCode
