[CmdletBinding()]
param(
    [ValidateRange(5, 300)][int]$TimeoutSeconds = 180,
    [ValidateRange(1, 10)][int]$PollSeconds = 3,
    [string]$ComfyBaseUrl = "http://127.0.0.1:8188",
    [string]$ExpectedPython = "E:\ComfyUI\python_embeded\python.exe"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$started = Get-Date
$expected = [IO.Path]::GetFullPath($ExpectedPython)

while ((Get-Date) -lt $deadline) {
    try {
        $stats = Invoke-RestMethod -Uri "$ComfyBaseUrl/system_stats" -Method Get -TimeoutSec 3 -ErrorAction Stop
        [ordered]@{
            ok = $true
            ready = $true
            elapsed_seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 2)
            system_stats = $stats
        } | ConvertTo-Json -Depth 8
        exit 0
    } catch {}

    if (((Get-Date) - $started).TotalSeconds -ge 5) {
        $alive = @(Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object {
            try { ([IO.Path]::GetFullPath([string]$_.Path)).Equals($expected, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
        })
        if ($alive.Count -eq 0) {
            [ordered]@{
                ok = $false
                ready = $false
                failure_class = "startup"
                error = "The expected ComfyUI Python process exited before /system_stats became ready. Read the DSH background job output now; do not wait for the full timeout."
                elapsed_seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 2)
            } | ConvertTo-Json -Compress
            exit 1
        }
    }
    Start-Sleep -Seconds $PollSeconds
}

[ordered]@{
    ok = $false
    ready = $false
    failure_class = "startup"
    error = "ComfyUI did not become ready within $TimeoutSeconds seconds. Read the DSH background job output."
    elapsed_seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 2)
} | ConvertTo-Json -Compress
exit 1
