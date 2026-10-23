$ErrorActionPreference = "Stop"
$skillRoot = Split-Path -Parent $PSScriptRoot
$commonPath = Join-Path $skillRoot "scripts\fish-draws-common.ps1"
$resolverPath = Join-Path $skillRoot "scripts\resolve-fish-draws-size.ps1"
$taskPath = Join-Path $skillRoot "scripts\new-fish-draws-task.ps1"
$completeTaskPath = Join-Path $skillRoot "scripts\complete-fish-draws-task.ps1"
$preflightPath = Join-Path $skillRoot "scripts\new-fish-draws-preflight.ps1"
$qualityPath = Join-Path $skillRoot "scripts\update-fish-draws-quality.ps1"
$invokePath = Join-Path $skillRoot "scripts\invoke-fish-draws.ps1"
$alphaInspectorPath = Join-Path $skillRoot "scripts\inspect-fish-draws-alpha.py"
$templatePath = Join-Path $skillRoot "assets\qwen21-unified-api.json"
. $commonPath

$script:assertions = 0
function Assert-True { param([bool]$Condition, [string]$Message); $script:assertions++; if (-not $Condition) { throw "Assertion failed: $Message" } }
function Assert-Equal { param($Actual, $Expected, [string]$Message); $script:assertions++; if ($Actual -ne $Expected) { throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'." } }
function Assert-Throws { param([scriptblock]$Action, [string]$Like, [string]$Message); $script:assertions++; try { & $Action; throw "Expected throw did not occur." } catch { if ($_.Exception.Message -notlike $Like) { throw "Assertion failed: $Message. Got '$($_.Exception.Message)'." } } }

$caseRoot = "E:\ComfyUI\fish-draws-api-experiment\01-input-topology"
$image1 = Join-Path $caseRoot "case-03-three-images\input-1.png"
$image2 = Join-Path $caseRoot "case-03-three-images\input-2.png"
$image3 = Join-Path $caseRoot "case-03-three-images\input-3.png"

# Exact edit sizing and local high-resolution policy.
$defaultPlan = & $resolverPath -InputImages @($image1, $image2) | ConvertFrom-Json
$firstDimensions = Get-FishDrawsImageDimensions -Path $image1
Assert-Equal $defaultPlan.target_width $firstDimensions.width "default edit width follows first original"
Assert-Equal $defaultPlan.target_height $firstDimensions.height "default edit height follows first original"
Assert-Equal $defaultPlan.size_source "first_reference_original" "default size source"
Assert-True ([string]$defaultPlan.execution_id -match '^[a-f0-9]{32}$') "resolver returns execution id"
Assert-Equal $defaultPlan.execution_id $defaultPlan.request_id "request_id remains a compatibility alias"

$ratioPlan = & $resolverPath -InputImages @($image1) -AspectRatio "16:9" | ConvertFrom-Json
Assert-Equal $ratioPlan.target_width 1920 "16:9 width"
Assert-Equal $ratioPlan.target_height 1080 "16:9 height"
Assert-Equal $ratioPlan.sample_height 1088 "sample height rounds to 16"
Assert-True $ratioPlan.outpainting_required "ratio change requires outpainting"

$exactPlan = & $resolverPath -InputImages @($image1) -TargetWidth 1001 -TargetHeight 701 | ConvertFrom-Json
Assert-Equal $exactPlan.sample_width 1008 "non-multiple width rounds up"
Assert-Equal $exactPlan.sample_height 704 "non-multiple height rounds up"

$thirdDimensions = Get-FishDrawsImageDimensions -Path $image3
$referencePlan = & $resolverPath -InputImages @($image1, $image2, $image3) -SizeReferenceImage $image3 | ConvertFrom-Json
Assert-Equal $referencePlan.target_width $thirdDimensions.width "size reference uses original width"
Assert-Equal $referencePlan.input_images[0] ([IO.Path]::GetFullPath($image1)) "size reference does not reorder semantics"

$reorderedPlan = & $resolverPath -InputImages @($image1, $image2, $image3) -CanvasImage $image3 | ConvertFrom-Json
Assert-Equal $reorderedPlan.input_images[0] ([IO.Path]::GetFullPath($image3)) "content canvas becomes image1"
Assert-Equal $reorderedPlan.input_mapping[0].original_index 3 "mapping preserves original index"

$landscapePlan = & $resolverPath -InputImages @($image1) -TargetWidth 2560 -TargetHeight 1440 | ConvertFrom-Json
$portraitPlan = & $resolverPath -InputImages @($image1) -TargetWidth 1440 -TargetHeight 2560 | ConvertFrom-Json
Assert-True (-not $landscapePlan.oversize_confirmation_required) "single edit accepts 2560x1440"
Assert-True (-not $portraitPlan.oversize_confirmation_required) "single edit accepts 1440x2560"
Assert-Equal $landscapePlan.safety_profile_approval "user_override" "single edit records explicit user approval"
$overHardCapPlan = & $resolverPath -InputImages @($image1) -TargetWidth 2561 -TargetHeight 1440 | ConvertFrom-Json
Assert-True $overHardCapPlan.oversize_confirmation_required "hard width excess remains gated"
Assert-Throws { [void](& $resolverPath -InputImages @($image1) -AspectRatio "5:2") } "*no approved default size*" "unsupported ratio is rejected"

$tamperedProfiles = Join-Path ([IO.Path]::GetTempPath()) ("fish-draws-unsafe-profile-" + [guid]::NewGuid().ToString("N") + ".json")
try {
    [IO.File]::WriteAllText($tamperedProfiles, '{"schema_version":1,"profiles":{"t2i-balanced":{"max_sample_width":4096,"max_sample_height":4096,"max_sample_pixels":16777216,"calibrated":false,"user_override":true,"reserve_mib":21504}}}', (New-Object Text.UTF8Encoding($false)))
    Assert-Throws { [void](Get-FishDrawsSafetyProfile -ProfileName "t2i-balanced" -CalibratedProfilesPath $tamperedProfiles) } "*hard high-resolution candidate envelope*" "user override cannot exceed hard cap"
} finally { Remove-Item -LiteralPath $tamperedProfiles -Force -ErrorAction SilentlyContinue }

# Explicit UTF-8 and initial submission plus three technical retries.
$utf8Bytes = ConvertTo-FishDrawsJsonUtf8Bytes -Body @{ prompt = "把黑色上衣改成深红色 🎉" }
Assert-True ($utf8Bytes -is [byte[]]) "JSON encoder returns bytes"
Assert-Equal (([Text.Encoding]::UTF8.GetString($utf8Bytes) | ConvertFrom-Json).prompt) "把黑色上衣改成深红色 🎉" "Chinese and emoji survive UTF-8"

$alphaSourceTimestamp = (Get-Item -LiteralPath $image1).LastWriteTimeUtc
$alphaInspection = & "E:\ComfyUI\python_embeded\python.exe" $alphaInspectorPath $image1 | ConvertFrom-Json
Assert-True ($alphaInspection.ok -and $alphaInspection.width -gt 0 -and $alphaInspection.height -gt 0) "standard-library alpha inspector reads a real PNG without modifying it"
Assert-Equal (Get-Item -LiteralPath $image1).LastWriteTimeUtc $alphaSourceTimestamp "alpha inspection is read-only"

$executionRoot = Join-Path ([IO.Path]::GetTempPath()) ("fish-draws-execution-test-" + [guid]::NewGuid().ToString("N"))
try {
    $execution = [guid]::NewGuid().ToString("N")
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $state = Register-FishDrawsTechnicalAttempt -ExecutionId $execution -TechnicalAttempt $attempt -TaskMode Edit -StateRoot $executionRoot
        Assert-Equal $state.highest_attempt $attempt "technical attempt $attempt recorded"
        Set-FishDrawsTechnicalAttemptOutcome -ExecutionId $execution -StateRoot $executionRoot -Completed $false -LastError "temporary"
    }
    Assert-Throws { [void](Register-FishDrawsTechnicalAttempt -ExecutionId $execution -TechnicalAttempt 4 -TaskMode Edit -StateRoot $executionRoot) } "*one initial submission plus three retries*" "fifth submission is rejected"

    $closed = [guid]::NewGuid().ToString("N")
    [void](Register-FishDrawsTechnicalAttempt -ExecutionId $closed -TechnicalAttempt 1 -TaskMode T2I -StateRoot $executionRoot)
    Set-FishDrawsTechnicalAttemptOutcome -ExecutionId $closed -StateRoot $executionRoot -Completed $true
    Assert-Throws { [void](Register-FishDrawsTechnicalAttempt -ExecutionId $closed -TechnicalAttempt 2 -TaskMode T2I -StateRoot $executionRoot) } "*already closed*" "valid output closes technical cycle"

    $qualityExecution = [guid]::NewGuid().ToString("N")
    Assert-Equal (Register-FishDrawsTechnicalAttempt -ExecutionId $qualityExecution -TechnicalAttempt 1 -TaskMode T2I -StateRoot $executionRoot).highest_attempt 1 "quality rework uses a new execution"
} finally { Remove-Item -LiteralPath $executionRoot -Recurse -Force -ErrorAction SilentlyContinue }

# The only image graph is the integrated Qwen workflow.
function Build-CoreGraph {
    param([string[]]$Names, [string]$Acceleration = "Balanced")
    New-FishDrawsGraph -TemplatePath $templatePath -ExpandedPrompt "test prompt" -InputImageNames $Names -TargetWidth 1001 -TargetHeight 701 -SampleWidth 1008 -SampleHeight 704 -Seed 123 -Steps 40 -Acceleration $Acceleration -FilenamePrefix "fish-draws/test"
}
foreach ($count in @(0, 1, 2, 6)) {
    $names = @()
    for ($index = 1; $index -le $count; $index++) { $names += "fish-draws/test/input-$index.png" }
    $graph = Build-CoreGraph -Names $names
    Assert-True (@($graph.PSObject.Properties.Value.class_type) -notcontains "ResolutionSelector") "core graph omits ResolutionSelector"
    Assert-Equal $graph.'6'.inputs.resolution 0 "encoder resolution remains zero"
    Assert-Equal $graph.'8'.inputs.latent_image[0] "7" "sampler latent comes from EmptyLatentImage"
    Assert-Equal $graph.'7'.inputs.width 1008 "custom latent width"
    Assert-Equal $graph.'10'.inputs.width 1001 "exact crop width"
    Assert-Equal @($graph.'6'.inputs.PSObject.Properties | Where-Object Name -like 'images.image_*').Count $count "reference topology count"
}
$fast = Build-CoreGraph -Names @("fish-draws/test/input-1.png") -Acceleration Fast
Assert-Equal $fast.'12'.class_type "EasyCache" "fast graph includes EasyCache"
Assert-Equal $fast.'8'.inputs.model[0] "12" "sampler follows EasyCache"

# Visual preflight and quality pause policy.
$preflightRoot = Join-Path ([IO.Path]::GetTempPath()) ("fish-draws-preflight-test-" + [guid]::NewGuid().ToString("N"))
try {
    $t2iTaskId = [guid]::NewGuid().ToString("N")
    $t2iTask = & $taskPath -TaskId $t2iTaskId -TaskMode T2I -OriginalPrompt "雨夜橘猫" -RuntimeRoot $preflightRoot | ConvertFrom-Json
    Assert-Equal $t2iTask.task_id $t2iTaskId "T2I task contract preserves task id"
    $t2iManifest = [IO.File]::ReadAllText($t2iTask.task_manifest, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Equal $t2iManifest.task_mode "t2i" "T2I task contract locks mode"
    Assert-Equal @($t2iManifest.references).Count 0 "T2I task contract has no references"
    Assert-True ([string]$t2iManifest.original_prompt_sha256 -match '^[a-f0-9]{64}$') "task contract stores prompt hash"
    Assert-True (-not ([IO.File]::ReadAllText($t2iTask.task_manifest, [Text.Encoding]::UTF8).Contains("雨夜橘猫"))) "task contract does not store clear prompt"
    Assert-Throws { [void](& $taskPath -TaskMode Edit -OriginalPrompt "phantom replay" -InputImages @($image1) -RuntimeRoot $preflightRoot) } "*still active*" "a historical replay cannot create a second active task"
    $t2iComplete = & $completeTaskPath -TaskId $t2iTaskId -TaskManifestPath $t2iTask.task_manifest -RuntimeRoot $preflightRoot | ConvertFrom-Json
    Assert-True $t2iComplete.active_task_cleared "completing a task clears the active lock"
    Assert-Throws { [void](& $taskPath -TaskId $t2iTaskId -TaskMode T2I -OriginalPrompt "duplicate" -RuntimeRoot $preflightRoot) } "*already exists*" "a completed task id cannot be rebound"

    $editTaskId = [guid]::NewGuid().ToString("N")
    $editTask = & $taskPath -TaskId $editTaskId -TaskMode Edit -OriginalPrompt "combine references" -InputImages @($image1, $image2) -RuntimeRoot $preflightRoot | ConvertFrom-Json
    $editManifest = [IO.File]::ReadAllText($editTask.task_manifest, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Equal $editManifest.task_mode "edit" "Edit task contract locks mode"
    Assert-Equal @($editManifest.references).Count 2 "Edit task contract binds every reference"
    $multiFacts = @(
        [ordered]@{ image_tag = "<image1>"; certain = @("primary"); counts = @(); positions = @(); readable_text = @(); occlusion = @(); uncertain = @() },
        [ordered]@{ image_tag = "<image2>"; certain = @("reference"); counts = @(); positions = @(); readable_text = @(); occlusion = @(); uncertain = @() }
    ) | ConvertTo-Json -Depth 8 -Compress
    $multi = & $preflightPath -TaskId $editTaskId -ExecutionId ([guid]::NewGuid().ToString("N")) -InputImages @($image1, $image2) -TaskClass Simple -FactsJson $multiFacts -ExpandedPrompt "Use <image1> as primary and <image2> as reference." -RuntimeRoot $preflightRoot | ConvertFrom-Json
    Assert-True (-not $multi.ready) "multi-image edit always waits for confirmation"
    [void](& $completeTaskPath -TaskId $editTaskId -TaskManifestPath $editTask.task_manifest -RuntimeRoot $preflightRoot)
    Assert-Throws { [void](& $taskPath -TaskId $editTaskId -TaskMode T2I -OriginalPrompt "duplicate" -RuntimeRoot $preflightRoot) } "*already exists*" "task id cannot be rebound to another mode"

    $singleEditTaskId = [guid]::NewGuid().ToString("N")
    $singleEditTask = & $taskPath -TaskId $singleEditTaskId -TaskMode Edit -OriginalPrompt "single edit" -InputImages @($image1) -RuntimeRoot $preflightRoot | ConvertFrom-Json
    $facts = @([ordered]@{ image_tag = ""; certain = @("one person"); counts = @("one person"); positions = @("center"); readable_text = @(); occlusion = @(); uncertain = @("small blurred badge") }) | ConvertTo-Json -Depth 8 -Compress
    $simple = & $preflightPath -TaskId $singleEditTaskId -ExecutionId ([guid]::NewGuid().ToString("N")) -InputImages @($image1) -TaskClass Simple -FactsJson $facts -ExpandedPrompt "Change the shirt colour." -RuntimeRoot $preflightRoot | ConvertFrom-Json
    Assert-True $simple.ready "simple edit may proceed"
    $identity = & $preflightPath -TaskId $singleEditTaskId -ExecutionId ([guid]::NewGuid().ToString("N")) -InputImages @($image1) -TaskClass Identity -FactsJson $facts -ExpandedPrompt "Preserve the person's identity." -RuntimeRoot $preflightRoot | ConvertFrom-Json
    Assert-True (-not $identity.ready) "identity edit waits for confirmation"
    Assert-Throws { [void](& $preflightPath -TaskId $singleEditTaskId -ExecutionId ([guid]::NewGuid().ToString("N")) -InputImages @($image1) -TaskClass Simple -FactsJson $facts -ExpandedPrompt "Make the small blurred badge blue." -RuntimeRoot $preflightRoot) } "*unconfirmed observation*" "uncertainty cannot become prompt fact"
    [void](& $completeTaskPath -TaskId $singleEditTaskId -TaskManifestPath $singleEditTask.task_manifest -RuntimeRoot $preflightRoot)
} finally { Remove-Item -LiteralPath $preflightRoot -Recurse -Force -ErrorAction SilentlyContinue }

$qualityRoot = Join-Path ([IO.Path]::GetTempPath()) ("fish-draws-quality-test-" + [guid]::NewGuid().ToString("N"))
try {
    $task = [guid]::NewGuid().ToString("N")
    $first = & $qualityPath -QualityTaskId $task -ExecutionId ([guid]::NewGuid().ToString("N")) -Improved $false -RuntimeRoot $qualityRoot | ConvertFrom-Json
    Assert-True (-not $first.pause_required) "first non-improving round does not pause"
    $second = & $qualityPath -QualityTaskId $task -ExecutionId ([guid]::NewGuid().ToString("N")) -Improved $false -RuntimeRoot $qualityRoot | ConvertFrom-Json
    Assert-Equal $second.consecutive_no_improvement 2 "two non-improving rounds are counted"
    Assert-True $second.pause_required "second non-improving round pauses"
} finally { Remove-Item -LiteralPath $qualityRoot -Recurse -Force -ErrorAction SilentlyContinue }

# Integration boundaries, output contract, startup and privacy.
$invokeText = Get-Content -LiteralPath $invokePath -Raw
$skillText = Get-Content -LiteralPath (Join-Path $skillRoot "SKILL.md") -Raw
$startText = Get-Content -LiteralPath (Join-Path $skillRoot "scripts\start-comfyui.ps1") -Raw
Assert-True $startText.Contains('$env:PYTHONUTF8 = "1"') "launcher enables Python UTF-8"
Assert-True $startText.Contains('$env:PYTHONIOENCODING = "utf-8"') "launcher sets UTF-8 stdio"
Assert-True $skillText.Contains('run_in_background: true') "background flag is a JSON boolean"
Assert-True $skillText.Contains('Do not replace the DSH background call with `Start-Process`') "detached lifecycle launch is forbidden"
Assert-True $skillText.Contains('compressed summary') "historical summaries cannot authorize generation"
Assert-True $skillText.Contains('Within one user turn, never switch between T2I and Edit') "task mode is immutable within one turn"
Assert-True $skillText.Contains('Never infer that transparency is impossible merely from node names') "native alpha is tested empirically"
Assert-True $skillText.Contains('Do not threshold, clamp, key, matte, or otherwise rewrite alpha') "alpha validation remains read-only"
Assert-True (Test-Path -LiteralPath $taskPath -PathType Leaf) "task-contract helper exists"
Assert-True (Test-Path -LiteralPath $completeTaskPath -PathType Leaf) "task-completion helper exists"
Assert-True (Test-Path -LiteralPath $alphaInspectorPath -PathType Leaf) "read-only alpha inspector exists"
Assert-True $invokeText.Contains('[string]$TaskId') "generation accepts task identity"
Assert-True $invokeText.Contains('Read-ValidatedTaskManifest') "generation verifies task contract"
Assert-True $invokeText.Contains('active-task.json') "generation accepts only the active real user task"
Assert-True $invokeText.Contains('$TaskId/$jobId') "output namespace is scoped by task id"
Assert-True $invokeText.Contains('[ValidateRange(1, 4)]') "helper exposes four technical submissions"
Assert-True (-not $invokeText.Contains('attempts_remaining')) "output has no quota wording"
Assert-True $invokeText.Contains('images = @()') "v2.0 images contract is present"
Assert-True $invokeText.Contains('outputs = @()') "v2.0 outputs contract is present"
foreach ($removed in @('core_outputs', 'final_outputs', 'capabilities_applied', 'capability_versions', 'PostprocessPlanPath', 'Invoke-RegisteredPostprocess')) {
    Assert-True (-not $invokeText.Contains($removed)) "removed production layer is absent: $removed"
}
foreach ($removedPath in @('assets\capability-registry.json', 'references\capability-policy.md', 'scripts\fish-draws-capabilities.ps1', 'scripts\fish-draws-capability-compilers.ps1', 'scripts\invoke-fish-draws-lab.ps1', 'scripts\complete-fish-draws-lab.ps1', 'scripts\new-fish-draws-postprocess-plan.ps1')) {
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $skillRoot $removedPath))) "dynamic capability file is absent: $removedPath"
}
Assert-True $skillText.Contains('Do not search for, propose, assemble, or ask permission to use additional ComfyUI nodes') "skill forbids dynamic node selection"
Assert-True (-not $skillText.Contains('session-')) "skill stores no DSH session id"
Assert-True (-not $skillText.Contains('api_key')) "skill instructions do not expose API key"
$graphIndex = $invokeText.IndexOf('$graph = New-FishDrawsGraph')
$registerIndex = $invokeText.IndexOf('Register-FishDrawsTechnicalAttempt')
$submitIndex = $invokeText.IndexOf('$submission = Invoke-JsonRequest -Method Post -Uri "$ComfyBaseUrl/prompt"', $registerIndex)
Assert-True ($graphIndex -ge 0 -and $registerIndex -gt $graphIndex -and $submitIndex -gt $registerIndex) "attempt begins immediately before first submission"

[ordered]@{ ok = $true; assertions = $script:assertions; tested_input_counts = @(0, 1, 2, 6); capability_layer_absent = $true } | ConvertTo-Json -Compress
