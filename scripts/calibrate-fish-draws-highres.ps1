[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SingleEditImage,
    [Parameter(Mandatory = $true)][ValidateCount(2, 6)][string[]]$MultiEditImages,
    [ValidateRange(3, 10)][int]$RunsPerOrientation = 3,
    [ValidateRange(1, 100)][int]$Steps = 40,
    [ValidateRange(1024, 30000)][int]$ReserveStartMiB = 21504,
    [ValidateRange(1024, 30000)][int]$ReserveMaximumMiB = 24576,
    [ValidateRange(256, 4096)][int]$ReserveStepMiB = 1024,
    [ValidateRange(512, 16384)][int]$RequiredGpuFreeMiB = 2048,
    [ValidateRange(512, 32768)][int]$RequiredSystemAvailableMiB = 4096,
    [Alias("Profiles")][string[]]$ProfileNames = @("t2i-balanced", "edit-single-balanced", "edit-multi-balanced", "fast-batch"),
    [string]$RuntimeRoot = "E:\ComfyUI\.fish-draws-runtime",
    [string]$ComfyOutputRoot = "E:\ComfyUI\ComfyUI\output"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "fish-draws-common.ps1")

if ($ReserveMaximumMiB -lt $ReserveStartMiB) { throw "ReserveMaximumMiB must be at least ReserveStartMiB." }
foreach ($path in @($SingleEditImage) + @($MultiEditImages)) { [void](Get-FishDrawsImageDimensions -Path $path) }
try { [void](Invoke-RestMethod -Uri "http://127.0.0.1:8188/system_stats" -Method Get -TimeoutSec 5 -ErrorAction Stop) } catch { throw "ComfyUI must be online before calibration; startup is a separate tool call." }

$invokePath = Join-Path $PSScriptRoot "invoke-fish-draws.ps1"
$preflightPath = Join-Path $PSScriptRoot "new-fish-draws-preflight.ps1"
$defaultProfilesPath = Join-Path (Split-Path -Parent $PSScriptRoot) "assets\safety-profiles.json"
$calibrationDirectory = Join-Path $RuntimeRoot "calibration"
if (-not (Test-Path -LiteralPath $calibrationDirectory -PathType Container)) { [void](New-Item -ItemType Directory -Path $calibrationDirectory -Force) }
$profilePath = Join-Path $calibrationDirectory "safety-profiles.json"
$profileDocument = $(if (Test-Path -LiteralPath $profilePath -PathType Leaf) { Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json } else { Get-Content -LiteralPath $defaultProfilesPath -Raw | ConvertFrom-Json })
$pwshPath = (Get-Process -Id $PID).Path
$orientations = @(
    [pscustomobject]@{ width = 2560; height = 1440; name = "landscape" },
    [pscustomobject]@{ width = 1440; height = 2560; name = "portrait" }
)
$knownProfileNames = @("t2i-balanced", "edit-single-balanced", "edit-multi-balanced", "fast-batch")
foreach ($name in $ProfileNames) { if ($knownProfileNames -notcontains $name) { throw "Unknown calibration profile '$name'." } }
$profileDefinitions = @(
    [pscustomobject]@{ name = "t2i-balanced"; task = "T2I"; inputs = @(); acceleration = "Balanced"; count = 1; prompt = "A simple studio still life on a neutral background, coherent lighting, clean composition." },
    [pscustomobject]@{ name = "edit-single-balanced"; task = "Edit"; inputs = @($SingleEditImage); acceleration = "Balanced"; count = 1; prompt = "Preserve the full source image content and composition while producing a faithful calibration render." },
    [pscustomobject]@{ name = "edit-multi-balanced"; task = "Edit"; inputs = @($MultiEditImages); acceleration = "Balanced"; count = 1; prompt = "Use <image1> as the complete primary canvas. Use <image2> only as a secondary visual reference; preserve all primary content for this calibration render." },
    [pscustomobject]@{ name = "fast-batch"; task = "T2I"; inputs = @(); acceleration = "Fast"; count = 2; prompt = "A simple studio still life on a neutral background, coherent lighting, clean composition." }
)
$selectedProfiles = @($profileDefinitions | Where-Object { $ProfileNames -contains $_.name })
$report = [ordered]@{
    schema_version = 1
    started_at_utc = [datetime]::UtcNow.ToString("o")
    candidate_limits = [ordered]@{ max_sample_width = 2560; max_sample_height = 2560; max_sample_pixels = 3686400 }
    requirements = [ordered]@{ consecutive_runs_per_orientation = $RunsPerOrientation; minimum_gpu_free_mib = $RequiredGpuFreeMiB; minimum_system_available_mib = $RequiredSystemAvailableMiB }
    profiles = @()
}

function Quote-PowerShellLiteral { param([string]$Value); return "'" + $Value.Replace("'", "''") + "'" }

function Remove-CalibrationOutputs {
    param($RunResult)
    $allowedRoot = [IO.Path]::GetFullPath((Join-Path $ComfyOutputRoot "fish-draws-calibration")).TrimEnd('\') + '\'
    foreach ($item in @($RunResult.outputs)) {
        if ($null -eq $item -or [string]::IsNullOrWhiteSpace([string]$item.path)) { continue }
        $path = [IO.Path]::GetFullPath(([string]$item.path).Replace('/', '\'))
        if ($path.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $path -PathType Leaf)) { Remove-Item -LiteralPath $path -Force }
    }
}

foreach ($profile in $selectedProfiles) {
    $profileReport = [ordered]@{ name = $profile.name; passed = $false; selected_reserve_mib = $null; attempts = @(); reason = $null }
    for ($reserve = $ReserveStartMiB; $reserve -le $ReserveMaximumMiB -and -not $profileReport.passed; $reserve += $ReserveStepMiB) {
        $reservePassed = $true
        foreach ($orientation in $orientations) {
            for ($run = 1; $run -le $RunsPerOrientation; $run++) {
                $executionId = [guid]::NewGuid().ToString("N")
                $preflight = $null
                if ($profile.task -eq "Edit") {
                    $facts = @()
                    for ($index = 0; $index -lt $profile.inputs.Count; $index++) {
                        $facts += [ordered]@{ image_tag = $(if ($profile.inputs.Count -gt 1) { "<image$($index + 1)>" } else { "" }); certain = @("performance calibration reference"); counts = @(); positions = @(); readable_text = @(); occlusion = @(); uncertain = @() }
                    }
                    $preflightResult = & $preflightPath -ExecutionId $executionId -InputImages $profile.inputs -TaskClass Simple -FactsJson ($facts | ConvertTo-Json -Depth 8 -Compress) -ExpandedPrompt $profile.prompt -CalibrationOnly -RuntimeRoot $RuntimeRoot | ConvertFrom-Json
                    $preflight = [string]$preflightResult.preflight_manifest
                }

                $wrapperPath = Join-Path ([IO.Path]::GetTempPath()) "fish-draws-calibration-$executionId.ps1"
                $inputLiteral = "@(" + (@($profile.inputs | ForEach-Object { Quote-PowerShellLiteral $_ }) -join ",") + ")"
                $command = @(
                    "& $(Quote-PowerShellLiteral $invokePath)",
                    "-ExpandedPrompt $(Quote-PowerShellLiteral $profile.prompt)",
                    "-OriginalPrompt 'high-resolution calibration'",
                    "-TaskMode $($profile.task)",
                    "-InputImages $inputLiteral",
                    "-TargetWidth $($orientation.width) -TargetHeight $($orientation.height)",
                    "-Acceleration $($profile.acceleration) -Count $($profile.count)",
                    "-ExecutionId $executionId -TechnicalAttempt 1",
                    "-Steps $Steps -ReserveMiB $reserve -AllowOversize -CalibrationRun"
                ) -join " "
                if ($null -ne $preflight) { $command += " -PreflightManifestPath $(Quote-PowerShellLiteral $preflight)" }
                [IO.File]::WriteAllText($wrapperPath, $command, (New-Object Text.UTF8Encoding($false)))
                $raw = $null
                $exitCode = 1
                $runResult = $null
                try {
                    $raw = & $pwshPath -NoProfile -NonInteractive -File $wrapperPath 2>&1
                    $exitCode = $LASTEXITCODE
                    $text = (@($raw | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
                    $runResult = $text | ConvertFrom-Json
                } catch {
                    $runResult = [pscustomobject]@{ ok = $false; error = $_.Exception.Message; minimum_gpu_free_mib = $null; minimum_system_available_mib = $null; strata_restored = $false; outputs = @() }
                } finally {
                    Remove-Item -LiteralPath $wrapperPath -Force -ErrorAction SilentlyContinue
                }
                $validOutputs = ($runResult.ok -eq $true -and @($runResult.outputs).Count -eq $profile.count -and @($runResult.outputs | Where-Object { [int]$_.width -ne $orientation.width -or [int]$_.height -ne $orientation.height }).Count -eq 0)
                $gpuOkay = ($null -ne $runResult.minimum_gpu_free_mib -and [int]$runResult.minimum_gpu_free_mib -ge $RequiredGpuFreeMiB)
                $systemOkay = ($null -ne $runResult.minimum_system_available_mib -and [int]$runResult.minimum_system_available_mib -ge $RequiredSystemAvailableMiB)
                $restored = ($runResult.strata_restored -eq $true)
                $passed = ($exitCode -eq 0 -and $validOutputs -and $gpuOkay -and $systemOkay -and $restored)
                $profileReport.attempts += [ordered]@{
                    reserve_mib = $reserve
                    orientation = $orientation.name
                    run = $run
                    passed = $passed
                    duration_seconds = $runResult.duration_seconds
                    minimum_gpu_free_mib = $runResult.minimum_gpu_free_mib
                    minimum_system_available_mib = $runResult.minimum_system_available_mib
                    strata_restored = $runResult.strata_restored
                    error = $runResult.error
                }
                Remove-CalibrationOutputs -RunResult $runResult
                if (-not $passed) { $reservePassed = $false; break }
            }
            if (-not $reservePassed) { break }
        }
        if ($reservePassed) {
            $profileReport.passed = $true
            $profileReport.selected_reserve_mib = $reserve
            $entry = $profileDocument.profiles.PSObject.Properties[$profile.name].Value
            $entry.max_sample_width = 2560
            $entry.max_sample_height = 2560
            $entry.max_sample_pixels = 3686400
            $entry.calibrated = $true
            if ($null -eq $entry.PSObject.Properties['user_override']) { $entry | Add-Member -NotePropertyName user_override -NotePropertyValue $false } else { $entry.user_override = $false }
            if ($null -eq $entry.PSObject.Properties['reserve_mib']) { $entry | Add-Member -NotePropertyName reserve_mib -NotePropertyValue $reserve } else { $entry.reserve_mib = $reserve }
            if ($null -eq $entry.PSObject.Properties['calibrated_at_utc']) { $entry | Add-Member -NotePropertyName calibrated_at_utc -NotePropertyValue ([datetime]::UtcNow.ToString("o")) } else { $entry.calibrated_at_utc = [datetime]::UtcNow.ToString("o") }
        }
    }
    if (-not $profileReport.passed) { $profileReport.reason = "No reserve from $ReserveStartMiB through $ReserveMaximumMiB passed every orientation/run and resource requirement." }
    $report.profiles += $profileReport
}

$report.completed_at_utc = [datetime]::UtcNow.ToString("o")
$report.ok = (@($report.profiles | Where-Object { -not $_.passed }).Count -eq 0)
[IO.File]::WriteAllText($profilePath, ($profileDocument | ConvertTo-Json -Depth 15), (New-Object Text.UTF8Encoding($false)))
$reportPath = Join-Path $calibrationDirectory "highres-$((Get-Date).ToString('yyyyMMdd-HHmmss')).json"
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
[ordered]@{ ok = $report.ok; report = $reportPath; safety_profiles = $profilePath; profiles = $report.profiles } | ConvertTo-Json -Depth 20
if (-not $report.ok) { exit 1 }
