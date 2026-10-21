[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Register", "Touch", "Status", "Watch")]
    [string]$Action,

    [ValidateSet("Keep", "Immediate", "Idle")]
    [string]$ShutdownMode = "Idle",

    [ValidateRange(1, 1440)]
    [int]$IdleMinutes = 10,

    [string]$ComfyBaseUrl = "http://127.0.0.1:8188",
    [string]$ExpectedPython = "E:\ComfyUI\python_embeded\python.exe",
    [string]$StatePath = (Join-Path (Split-Path -Parent $PSScriptRoot) ".runtime\comfy-owner.json")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$mutexName = "Local\FishDrawsV1"

function Write-LifecycleResult {
    param(
        [bool]$Managed,
        [string]$Result,
        [Nullable[int]]$ProcessId = $null
    )
    [ordered]@{
        ok = $true
        action = $Action.ToLowerInvariant()
        managed = $Managed
        result = $Result
        process_id = $ProcessId
        shutdown_mode = $ShutdownMode.ToLowerInvariant()
        idle_minutes = $IdleMinutes
    } | ConvertTo-Json -Compress
}

function Read-OwnerState {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

function Write-OwnerState {
    param($State)
    $stateDirectory = Split-Path -Parent $StatePath
    if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $stateDirectory -Force)
    }
    $temporaryPath = "$StatePath.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
        Move-Item -LiteralPath $temporaryPath -Destination $StatePath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Remove-OwnerState {
    param($ExpectedState)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return }
    $current = Read-OwnerState
    if ($null -eq $current) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
        return
    }
    if ($null -eq $ExpectedState -or (
        [int]$current.process_id -eq [int]$ExpectedState.process_id -and
        [string]$current.process_start_utc -eq [string]$ExpectedState.process_start_utc
    )) {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    }
}

function Get-ProcessIdentity {
    param([int]$ProcessId)
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return [pscustomobject]@{
            process_id = $ProcessId
            process_path = [IO.Path]::GetFullPath([string]$process.Path)
            process_start_utc = $process.StartTime.ToUniversalTime()
        }
    } catch {
        return $null
    }
}

function Test-OwnerState {
    param($State)
    if ($null -eq $State -or [string]$State.owner -ne "fish-draws") { return $false }
    if ([string]$State.comfy_base_url -ne $ComfyBaseUrl) { return $false }
    $identity = Get-ProcessIdentity -ProcessId ([int]$State.process_id)
    if ($null -eq $identity) { return $false }
    $expectedPath = [IO.Path]::GetFullPath([string]$State.process_path)
    if (-not $identity.process_path.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    try {
        $recordedStart = ([datetime]$State.process_start_utc).ToUniversalTime()
    } catch {
        return $false
    }
    return ([Math]::Abs(($identity.process_start_utc - $recordedStart).TotalSeconds) -lt 1.0)
}

function Set-LastActivityNow {
    param($State)
    $State.last_activity_utc = [datetime]::UtcNow.ToString("o")
    Write-OwnerState -State $State
}

function Get-QueueIdle {
    try {
        $queue = Invoke-RestMethod -Uri "$ComfyBaseUrl/queue" -Method Get -TimeoutSec 10 -ErrorAction Stop
        return (@($queue.queue_running).Count -eq 0 -and @($queue.queue_pending).Count -eq 0)
    } catch {
        return $false
    }
}

if ($Action -eq "Register") {
    $uri = [uri]$ComfyBaseUrl
    $listenerProcessId = $null
    try {
        $listener = Get-NetTCPConnection -LocalPort $uri.Port -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($null -ne $listener) { $listenerProcessId = [int]$listener.OwningProcess }
    } catch {}
    if ($null -eq $listenerProcessId) {
        $netstatPath = Join-Path $env:SystemRoot "System32\netstat.exe"
        foreach ($line in (& $netstatPath -ano -p tcp)) {
            $fields = @($line.Trim() -split "\s+")
            if ($fields.Count -ge 5 -and $fields[0] -eq "TCP" -and $fields[1] -like "*:$($uri.Port)" -and $fields[3] -eq "LISTENING") {
                $listenerProcessId = [int]$fields[4]
                break
            }
        }
    }
    if ($null -eq $listenerProcessId) { throw "No listening ComfyUI process was found on port $($uri.Port)." }
    $identity = Get-ProcessIdentity -ProcessId $listenerProcessId
    if ($null -eq $identity) { throw "The ComfyUI listener process could not be inspected." }
    $expectedPath = [IO.Path]::GetFullPath($ExpectedPython)
    if (-not $identity.process_path.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The process listening on port $($uri.Port) is not the expected ComfyUI Python executable."
    }
    $now = [datetime]::UtcNow.ToString("o")
    $state = [pscustomobject][ordered]@{
        version = 1
        owner = "fish-draws"
        process_id = $identity.process_id
        process_path = $identity.process_path
        process_start_utc = $identity.process_start_utc.ToString("o")
        comfy_base_url = $ComfyBaseUrl
        registered_utc = $now
        last_activity_utc = $now
    }
    Write-OwnerState -State $state
    Write-LifecycleResult -Managed $true -Result "registered" -ProcessId $identity.process_id
    return
}

if ($Action -eq "Touch" -or $Action -eq "Status") {
    $state = Read-OwnerState
    if (-not (Test-OwnerState -State $state)) {
        if ($null -ne $state) { Remove-OwnerState -ExpectedState $state }
        Write-LifecycleResult -Managed $false -Result "not_managed"
        return
    }
    if ($Action -eq "Touch") {
        Set-LastActivityNow -State $state
        Write-LifecycleResult -Managed $true -Result "activity_updated" -ProcessId ([int]$state.process_id)
    } else {
        Write-LifecycleResult -Managed $true -Result "managed" -ProcessId ([int]$state.process_id)
    }
    return
}

if ($ShutdownMode -eq "Keep") {
    $state = Read-OwnerState
    $managed = Test-OwnerState -State $state
    Write-LifecycleResult -Managed $managed -Result "kept" -ProcessId $(if ($managed) { [int]$state.process_id } else { $null })
    return
}

$idleThresholdSeconds = $IdleMinutes * 60
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
try {
    while ($true) {
        $state = Read-OwnerState
        if (-not (Test-OwnerState -State $state)) {
            if ($null -ne $state) { Remove-OwnerState -ExpectedState $state }
            Write-LifecycleResult -Managed $false -Result "owner_gone"
            return
        }

        if ($ShutdownMode -eq "Idle") {
            $lastActivity = ([datetime]$state.last_activity_utc).ToUniversalTime()
            if (([datetime]::UtcNow - $lastActivity).TotalSeconds -lt $idleThresholdSeconds) {
                Start-Sleep -Seconds 5
                continue
            }
        }

        $mutexHeld = $false
        try {
            try {
                $mutexHeld = $mutex.WaitOne(0)
            } catch [System.Threading.AbandonedMutexException] {
                $mutexHeld = $true
            }
            if (-not $mutexHeld) {
                Start-Sleep -Seconds 5
                continue
            }

            $state = Read-OwnerState
            if (-not (Test-OwnerState -State $state)) {
                if ($null -ne $state) { Remove-OwnerState -ExpectedState $state }
                Write-LifecycleResult -Managed $false -Result "owner_gone"
                return
            }
            if ($ShutdownMode -eq "Idle") {
                $lastActivity = ([datetime]$state.last_activity_utc).ToUniversalTime()
                if (([datetime]::UtcNow - $lastActivity).TotalSeconds -lt $idleThresholdSeconds) {
                    continue
                }
            }
            if (-not (Get-QueueIdle)) {
                Set-LastActivityNow -State $state
                continue
            }

            try {
                $body = @{ unload_models = $true; free_memory = $true } | ConvertTo-Json -Compress
                [void](Invoke-RestMethod -Uri "$ComfyBaseUrl/free" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30 -ErrorAction Stop)
            } catch {}

            $latest = Read-OwnerState
            if (-not (Test-OwnerState -State $latest)) { continue }
            if ($ShutdownMode -eq "Idle") {
                $lastActivity = ([datetime]$latest.last_activity_utc).ToUniversalTime()
                if (([datetime]::UtcNow - $lastActivity).TotalSeconds -lt $idleThresholdSeconds) { continue }
            }
            if (-not (Get-QueueIdle)) {
                Set-LastActivityNow -State $latest
                continue
            }

            Stop-Process -Id ([int]$latest.process_id) -Force -ErrorAction Stop
            Remove-OwnerState -ExpectedState $latest
            Write-LifecycleResult -Managed $true -Result "closed" -ProcessId ([int]$latest.process_id)
            return
        } finally {
            if ($mutexHeld) { [void]$mutex.ReleaseMutex() }
        }

        Start-Sleep -Seconds 5
    }
} finally {
    $mutex.Dispose()
}
