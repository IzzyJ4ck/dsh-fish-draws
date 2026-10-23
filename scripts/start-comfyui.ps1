[CmdletBinding()]
param(
    [string]$PythonPath = "E:\ComfyUI\python_embeded\python.exe",
    [string]$MainPath = "E:\ComfyUI\ComfyUI\main.py",
    [string]$ComfyBaseUrl = "http://127.0.0.1:8188"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

try {
    [void](Invoke-RestMethod -Uri "$ComfyBaseUrl/system_stats" -Method Get -TimeoutSec 3 -ErrorAction Stop)
    throw "ComfyUI is already online at $ComfyBaseUrl; do not start a duplicate server."
} catch {
    if ($_.Exception.Message -like "ComfyUI is already online*") { throw }
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "ComfyUI Python not found: $PythonPath" }
if (-not (Test-Path -LiteralPath $MainPath -PathType Leaf)) { throw "ComfyUI main.py not found: $MainPath" }

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
& $PythonPath -s $MainPath --windows-standalone-build
exit $LASTEXITCODE
