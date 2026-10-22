$ErrorActionPreference = "Stop"

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

function Get-FishDrawsRetryStatePath {
    param(
        [Parameter(Mandatory = $true)][string]$RetryGroupId,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )
    if ($RetryGroupId -notmatch '^[a-fA-F0-9]{32}$') {
        throw "RetryGroupId must be a 32-character hexadecimal GUID without separators."
    }
    return Join-Path ([IO.Path]::GetFullPath($StateRoot)) "$($RetryGroupId.ToLowerInvariant()).json"
}

function Write-FishDrawsRetryState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$State
    )
    $json = $State | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Register-FishDrawsAttempt {
    param(
        [Parameter(Mandatory = $true)][string]$RetryGroupId,
        [Parameter(Mandatory = $true)][ValidateRange(1, 3)][int]$AttemptNumber,
        [Parameter(Mandatory = $true)][ValidateSet("T2I", "Edit")][string]$TaskMode,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )

    $fullRoot = [IO.Path]::GetFullPath($StateRoot)
    if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $fullRoot -Force)
    }
    $statePath = Get-FishDrawsRetryStatePath -RetryGroupId $RetryGroupId -StateRoot $fullRoot
    $state = $null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ([string]$state.retry_group_id -ne $RetryGroupId.ToLowerInvariant()) {
            throw "Retry state identity mismatch for '$RetryGroupId'."
        }
    }

    $highestAttempt = $(if ($null -eq $state) { 0 } else { [int]$state.highest_attempt })
    if ($highestAttempt -ge 3) {
        throw "Retry limit reached for '$RetryGroupId': at most three total generation attempts are allowed."
    }
    $expectedAttempt = $highestAttempt + 1
    if ($AttemptNumber -ne $expectedAttempt) {
        throw "AttemptNumber must be $expectedAttempt for retry group '$RetryGroupId'; received $AttemptNumber."
    }

    $now = [DateTime]::UtcNow.ToString("o")
    $record = [ordered]@{
        retry_group_id = $RetryGroupId.ToLowerInvariant()
        task_mode = $TaskMode.ToLowerInvariant()
        max_attempts = 3
        highest_attempt = $AttemptNumber
        attempts_remaining = 3 - $AttemptNumber
        last_result_ok = $null
        created_at_utc = $(if ($null -eq $state) { $now } else { [string]$state.created_at_utc })
        updated_at_utc = $now
        last_error = $null
    }
    Write-FishDrawsRetryState -Path $statePath -State $record
    return [pscustomobject]$record
}

function Set-FishDrawsAttemptOutcome {
    param(
        [Parameter(Mandatory = $true)][string]$RetryGroupId,
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)][bool]$Completed,
        [AllowEmptyString()][string]$LastError = ""
    )
    $statePath = Get-FishDrawsRetryStatePath -RetryGroupId $RetryGroupId -StateRoot $StateRoot
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "Retry state not found for '$RetryGroupId'."
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state.last_result_ok = $Completed
    $state.updated_at_utc = [DateTime]::UtcNow.ToString("o")
    $state.last_error = $(if ([string]::IsNullOrWhiteSpace($LastError)) { $null } else { $LastError })
    Write-FishDrawsRetryState -Path $statePath -State $state
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
