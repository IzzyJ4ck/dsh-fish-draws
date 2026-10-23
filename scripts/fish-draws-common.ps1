$ErrorActionPreference = "Stop"

function Test-FishDrawsPathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$AllowRoot
    )
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($AllowRoot -and $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-FishDrawsRatioSizes {
    return [ordered]@{
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
}

function Get-FishDrawsImageDimensions {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Image not found: $fullPath"
    }

    Add-Type -AssemblyName PresentationCore
    $stream = [IO.File]::OpenRead($fullPath)
    try {
        $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create(
            $stream,
            [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
            [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        )
        if ($decoder.Frames.Count -lt 1) { throw "Image has no decodable frame: $fullPath" }
        $frame = $decoder.Frames[0]
        return [pscustomobject][ordered]@{
            path = $fullPath
            width = [int]$frame.PixelWidth
            height = [int]$frame.PixelHeight
        }
    } catch {
        throw "Could not read image dimensions for '$fullPath': $($_.Exception.Message)"
    } finally {
        $stream.Dispose()
    }
}

function Get-FishDrawsImageMetadata {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Image not found: $fullPath" }
    Add-Type -AssemblyName PresentationCore
    $stream = [IO.File]::OpenRead($fullPath)
    try {
        $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create(
            $stream,
            [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
            [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        )
        if ($decoder.Frames.Count -lt 1) { throw "Image has no decodable frame: $fullPath" }
        $frame = $decoder.Frames[0]
        $format = [string]$frame.Format
        $hasAlpha = ($format -match '(?i)(rgba|bgra|prgba|pbgra|argb)')
        if ([IO.Path]::GetExtension($fullPath).Equals(".png", [StringComparison]::OrdinalIgnoreCase)) {
            $header = New-Object byte[] 26
            $stream.Position = 0
            $read = $stream.Read($header, 0, $header.Length)
            if ($read -ge 26 -and $header[0] -eq 137 -and $header[1] -eq 80 -and $header[2] -eq 78 -and $header[3] -eq 71) {
                $hasAlpha = ($header[25] -eq 4 -or $header[25] -eq 6)
            }
        }
        return [pscustomobject][ordered]@{
            path = $fullPath
            width = [int]$frame.PixelWidth
            height = [int]$frame.PixelHeight
            pixel_format = $format
            has_alpha = $hasAlpha
            sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToUpperInvariant()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-FishDrawsSampleCanvas {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(1, 100000)][int]$TargetWidth,
        [Parameter(Mandatory = $true)][ValidateRange(1, 100000)][int]$TargetHeight
    )
    $sampleWidth = [int]([Math]::Ceiling($TargetWidth / 16.0) * 16)
    $sampleHeight = [int]([Math]::Ceiling($TargetHeight / 16.0) * 16)
    $samplePixels = [long]$sampleWidth * [long]$sampleHeight
    return [pscustomobject][ordered]@{
        target_width = $TargetWidth
        target_height = $TargetHeight
        sample_width = $sampleWidth
        sample_height = $sampleHeight
        sample_pixels = $samplePixels
        safe = ($sampleWidth -le 2048 -and $sampleHeight -le 2048 -and $samplePixels -le 2400000)
    }
}

function Get-FishDrawsSafetyProfileName {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("T2I", "Edit")][string]$TaskMode,
        [Parameter(Mandatory = $true)][int]$InputCount,
        [Parameter(Mandatory = $true)][ValidateSet("Balanced", "Fast")][string]$Acceleration,
        [Parameter(Mandatory = $true)][int]$Count
    )
    if ($Acceleration -eq "Fast" -or $Count -gt 1) { return "fast-batch" }
    if ($TaskMode -eq "T2I") { return "t2i-balanced" }
    if ($InputCount -le 1) { return "edit-single-balanced" }
    return "edit-multi-balanced"
}

function Get-FishDrawsSafetyProfile {
    param(
        [Parameter(Mandatory = $true)][string]$ProfileName,
        [string]$DefaultProfilesPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "assets\safety-profiles.json"),
        [string]$CalibratedProfilesPath = "E:\ComfyUI\.fish-draws-runtime\calibration\safety-profiles.json"
    )
    $sourcePath = $DefaultProfilesPath
    if (Test-Path -LiteralPath $CalibratedProfilesPath -PathType Leaf) { $sourcePath = $CalibratedProfilesPath }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Safety profiles not found: $sourcePath" }
    $document = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json
    if ([int]$document.schema_version -ne 1) { throw "Unsupported safety-profile schema in $sourcePath." }
    $profile = $document.profiles.PSObject.Properties[$ProfileName]
    if ($null -eq $profile) { throw "Safety profile '$ProfileName' is missing from $sourcePath." }
    $value = $profile.Value
    $maxWidth = [int]$value.max_sample_width
    $maxHeight = [int]$value.max_sample_height
    $maxPixels = [long]$value.max_sample_pixels
    $calibrated = [bool]$value.calibrated
    $userOverride = ($null -ne $value.PSObject.Properties['user_override'] -and [bool]$value.user_override)
    $approvalSource = $(if ($calibrated) { "calibration" } elseif ($userOverride) { "user_override" } else { "conservative_default" })
    if ($maxWidth -lt 1 -or $maxHeight -lt 1 -or $maxPixels -lt 1) { throw "Safety profile '$ProfileName' contains non-positive limits." }
    if ($maxWidth -gt 2560 -or $maxHeight -gt 2560 -or $maxPixels -gt 3686400) { throw "Safety profile '$ProfileName' exceeds the hard high-resolution candidate envelope." }
    if (($maxWidth -gt 2048 -or $maxHeight -gt 2048 -or $maxPixels -gt 2400000) -and -not ($calibrated -or $userOverride)) { throw "Safety profile '$ProfileName' widens defaults without calibration or an explicit user override." }
    $profileReserve = $(if ($null -eq $value.reserve_mib) { $null } else { [int]$value.reserve_mib })
    if (($calibrated -or $userOverride) -and ($null -eq $profileReserve -or $profileReserve -lt 21504 -or $profileReserve -gt 24576)) { throw "Approved high-resolution profile '$ProfileName' has an invalid reserve_mib." }
    return [pscustomobject][ordered]@{
        name = $ProfileName
        max_sample_width = $maxWidth
        max_sample_height = $maxHeight
        max_sample_pixels = $maxPixels
        calibrated = $calibrated
        user_override = $userOverride
        approval_source = $approvalSource
        reserve_mib = $profileReserve
        source_path = [IO.Path]::GetFullPath($sourcePath)
    }
}

function Test-FishDrawsCanvasAgainstProfile {
    param(
        [Parameter(Mandatory = $true)]$Canvas,
        [Parameter(Mandatory = $true)]$Profile
    )
    return (
        [int]$Canvas.sample_width -le [int]$Profile.max_sample_width -and
        [int]$Canvas.sample_height -le [int]$Profile.max_sample_height -and
        [long]$Canvas.sample_pixels -le [long]$Profile.max_sample_pixels
    )
}

function Test-FishDrawsAspectChanged {
    param(
        [Parameter(Mandatory = $true)][int]$SourceWidth,
        [Parameter(Mandatory = $true)][int]$SourceHeight,
        [Parameter(Mandatory = $true)][int]$TargetWidth,
        [Parameter(Mandatory = $true)][int]$TargetHeight
    )
    $sourceRatio = [double]$SourceWidth / [double]$SourceHeight
    $targetRatio = [double]$TargetWidth / [double]$TargetHeight
    return ([Math]::Abs($sourceRatio - $targetRatio) / $sourceRatio -gt 0.001)
}

function ConvertTo-FishDrawsJsonUtf8Bytes {
    param([Parameter(Mandatory = $true)]$Body)
    $json = $Body | ConvertTo-Json -Depth 40 -Compress
    return ,([Text.Encoding]::UTF8.GetBytes($json))
}

function Get-FishDrawsExecutionStatePath {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutionId,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )
    if ($ExecutionId -notmatch '^[a-fA-F0-9]{32}$') {
        throw "ExecutionId must be a 32-character hexadecimal GUID without separators."
    }
    return Join-Path ([IO.Path]::GetFullPath($StateRoot)) "$($ExecutionId.ToLowerInvariant()).json"
}

function Write-FishDrawsExecutionState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$State
    )
    $json = $State | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Register-FishDrawsTechnicalAttempt {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutionId,
        [Parameter(Mandatory = $true)][ValidateRange(1, 4)][int]$TechnicalAttempt,
        [Parameter(Mandatory = $true)][ValidateSet("T2I", "Edit")][string]$TaskMode,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )

    $fullRoot = [IO.Path]::GetFullPath($StateRoot)
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $fullRoot -Force)
    }
    $statePath = Get-FishDrawsExecutionStatePath -ExecutionId $ExecutionId -StateRoot $fullRoot
    $state = $null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ([string]$state.execution_id -ne $ExecutionId.ToLowerInvariant()) {
            throw "Execution state identity mismatch for '$ExecutionId'."
        }
        if ($state.closed -eq $true) { throw "Execution '$ExecutionId' is already closed by a valid generated result. Start a new ExecutionId for a quality rework." }
    }

    $highestAttempt = $(if ($null -eq $state) { 0 } else { [int]$state.highest_attempt })
    if ($highestAttempt -ge 4) {
        throw "Technical retry limit reached for '$ExecutionId': one initial submission plus three retries are allowed."
    }
    $expectedAttempt = $highestAttempt + 1
    if ($TechnicalAttempt -ne $expectedAttempt) {
        throw "TechnicalAttempt must be $expectedAttempt for execution '$ExecutionId'; received $TechnicalAttempt."
    }

    $now = [DateTime]::UtcNow.ToString("o")
    $record = [ordered]@{
        execution_id = $ExecutionId.ToLowerInvariant()
        task_mode = $TaskMode.ToLowerInvariant()
        max_technical_attempts = 4
        highest_attempt = $TechnicalAttempt
        closed = $false
        last_result_ok = $null
        created_at_utc = $(if ($null -eq $state) { $now } else { [string]$state.created_at_utc })
        updated_at_utc = $now
        last_error = $null
    }
    Write-FishDrawsExecutionState -Path $statePath -State $record
    return [pscustomobject]$record
}

function Set-FishDrawsTechnicalAttemptOutcome {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutionId,
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][bool]$Completed,
        [AllowEmptyString()][string]$LastError = ""
    )
    $statePath = Get-FishDrawsExecutionStatePath -ExecutionId $ExecutionId -StateRoot $StateRoot
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "Execution state not found for '$ExecutionId'."
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state.last_result_ok = $Completed
    $state.closed = $Completed
    $state.updated_at_utc = [DateTime]::UtcNow.ToString("o")
    $state.last_error = $(if ([string]::IsNullOrWhiteSpace($LastError)) { $null } else { $LastError })
    Write-FishDrawsExecutionState -Path $statePath -State $state
}

# v2.0 compatibility aliases. Remove after callers have migrated to ExecutionId/TechnicalAttempt.
function Get-FishDrawsRetryStatePath { param([string]$RetryGroupId, [string]$StateRoot); Get-FishDrawsExecutionStatePath -ExecutionId $RetryGroupId -StateRoot $StateRoot }
function Write-FishDrawsRetryState { param([string]$Path, $State); Write-FishDrawsExecutionState -Path $Path -State $State }
function Register-FishDrawsAttempt {
    param([string]$RetryGroupId, [ValidateRange(1, 4)][int]$AttemptNumber, [ValidateSet("T2I", "Edit")][string]$TaskMode, [string]$StateRoot)
    Register-FishDrawsTechnicalAttempt -ExecutionId $RetryGroupId -TechnicalAttempt $AttemptNumber -TaskMode $TaskMode -StateRoot $StateRoot
}
function Set-FishDrawsAttemptOutcome {
    param([string]$RetryGroupId, [string]$StateRoot, [bool]$Completed, [string]$LastError = "")
    Set-FishDrawsTechnicalAttemptOutcome -ExecutionId $RetryGroupId -StateRoot $StateRoot -Completed $Completed -LastError $LastError
}

function New-FishDrawsGraph {
    param(
        [Parameter(Mandatory = $true)][string]$TemplatePath,
        [Parameter(Mandatory = $true)][string]$ExpandedPrompt,
        [string[]]$InputImageNames = @(),
        [Parameter(Mandatory = $true)][int]$TargetWidth,
        [Parameter(Mandatory = $true)][int]$TargetHeight,
        [Parameter(Mandatory = $true)][int]$SampleWidth,
        [Parameter(Mandatory = $true)][int]$SampleHeight,
        [Parameter(Mandatory = $true)][long]$Seed,
        [Parameter(Mandatory = $true)][int]$Steps,
        [Parameter(Mandatory = $true)][ValidateSet("Balanced", "Fast")][string]$Acceleration,
        [Parameter(Mandatory = $true)][string]$FilenamePrefix
    )

    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
        throw "Workflow template not found: $TemplatePath"
    }
    if ($InputImageNames.Count -gt 6) { throw "At most six reference images are supported." }

    $graph = Get-Content -LiteralPath $TemplatePath -Raw | ConvertFrom-Json
    $graph.'6'.inputs.prompt = $ExpandedPrompt
    $graph.'6'.inputs.resolution = 0
    $graph.'7'.inputs.width = $SampleWidth
    $graph.'7'.inputs.height = $SampleHeight
    $graph.'8'.inputs.seed = $Seed
    $graph.'8'.inputs.steps = $Steps
    $graph.'10'.inputs.width = $TargetWidth
    $graph.'10'.inputs.height = $TargetHeight
    $graph.'10'.inputs.x = [int](($SampleWidth - $TargetWidth) / 2)
    $graph.'10'.inputs.y = [int](($SampleHeight - $TargetHeight) / 2)
    $graph.'11'.inputs.filename_prefix = $FilenamePrefix

    if ($Acceleration -eq "Fast") {
        $easyCache = [pscustomobject][ordered]@{
            inputs = [pscustomobject][ordered]@{
                reuse_threshold = 0.15
                start_percent = 0.20
                end_percent = 0.95
                verbose = $false
                model = @("3", 0)
            }
            class_type = "EasyCache"
            _meta = [pscustomobject]@{ title = "EasyCache fast mode" }
        }
        $graph | Add-Member -NotePropertyName "12" -NotePropertyValue $easyCache
        $graph.'8'.inputs.model = @("12", 0)
    } else {
        $graph.'8'.inputs.model = @("3", 0)
    }

    for ($index = 0; $index -lt $InputImageNames.Count; $index++) {
        $loadId = (100 + ($index * 2)).ToString()
        $scaleId = (101 + ($index * 2)).ToString()
        $loadNode = [pscustomobject][ordered]@{
            inputs = [pscustomobject]@{ image = [string]$InputImageNames[$index] }
            class_type = "LoadImage"
            _meta = [pscustomobject]@{ title = "Reference image $($index + 1)" }
        }
        $scaleNode = [pscustomobject][ordered]@{
            inputs = [pscustomobject][ordered]@{
                upscale_method = "lanczos"
                megapixels = 1.0
                resolution_steps = 1
                image = @($loadId, 0)
            }
            class_type = "ImageScaleToTotalPixels"
            _meta = [pscustomobject]@{ title = "Encode reference $($index + 1) at 1MP" }
        }
        $graph | Add-Member -NotePropertyName $loadId -NotePropertyValue $loadNode
        $graph | Add-Member -NotePropertyName $scaleId -NotePropertyValue $scaleNode
        $graph.'6'.inputs | Add-Member -NotePropertyName "images.image_$($index + 1)" -NotePropertyValue @($scaleId, 0)
    }

    return $graph
}
