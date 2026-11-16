param(
    [string]$Distro = 'Ubuntu',
    [string]$ReportDirectory = "$env:RUNNER_TEMP/wsl-capability",
    [switch]$Provision,
    [switch]$Lifecycle
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
$records = [System.Collections.Generic.List[object]]::new()

function Invoke-Probe([string]$Name, [string[]]$Arguments, [int]$Seconds = 30) {
    $info = [System.Diagnostics.ProcessStartInfo]::new('wsl.exe')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = [DateTime]::UtcNow
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $timedOut = -not $process.WaitForExit($Seconds * 1000)
        if ($timedOut) { $process.Kill($true); $process.WaitForExit() }
        $record = [ordered]@{
            name = $Name; arguments = $Arguments; started = $started.ToString('o')
            durationMs = ([DateTime]::UtcNow - $started).TotalMilliseconds
            timeout = $timedOut; exitCode = $process.ExitCode
            stdout = $stdout.GetAwaiter().GetResult().Replace("`0", '')
            stderr = $stderr.GetAwaiter().GetResult().Replace("`0", '')
        }
    } catch {
        $record = [ordered]@{
            name = $Name; arguments = $Arguments; started = $started.ToString('o')
            timeout = $false; exitCode = $null; stdout = ''; stderr = $_.ToString()
        }
    } finally { $process.Dispose() }
    $records.Add($record)
    return $record
}

$state = 'probe-failed'
$failed = $false
try {
    [void](Invoke-Probe 'version' @('--version'))
    [void](Invoke-Probe 'status' @('--status'))
    [void](Invoke-Probe 'distros' @('--list', '--verbose'))
    $names = Invoke-Probe 'names' @('--list', '--quiet')
    if ($Distro -notin ($names.stdout -split '\r?\n' | ForEach-Object { $_.Trim() })) {
        if (-not $Provision) { throw "Distro $Distro is absent; provisioning is disabled" }
        $install = Invoke-Probe 'provision' @('--install', '--distribution', $Distro, '--no-launch', '--web-download') 180
        if ($install.timeout -or $install.exitCode -ne 0) {
            $state = 'provisioning-failed'
            throw 'WSL distro provisioning did not complete; inspect the report'
        }
    }
    $versions = Invoke-Probe 'distro-version' @('--list', '--verbose')
    $versionOne = @($versions.stdout -split '\r?\n' | Where-Object {
        $_ -match "^\s*\*?\s*$([regex]::Escape($Distro))\s+.+\s+1\s*$"
    })
    if ($versionOne.Count -gt 0 -and $Provision) {
        $version = Invoke-Probe 'version-2' @('--set-version', $Distro, '2') 90
        if ($version.timeout -or $version.exitCode -ne 0) {
            $state = 'provisioning-failed'
            throw 'WSL2 conversion did not complete; inspect the report'
        }
    }
    $vm = Invoke-Probe 'actual-vm' @('-d', $Distro, '-u', 'root', '--exec', 'sh', '-ec', 'uname -r; test -d /proc/sys/fs/binfmt_misc; grep -qi microsoft-standard-WSL2 /proc/sys/kernel/osrelease') 60
    if ($vm.timeout -or $vm.exitCode -ne 0) {
        $diagnostic = $vm.stdout + $vm.stderr
        if ($diagnostic -match 'HCS_E_HYPERV_NOT_INSTALLED|HCS_E_SERVICE_NOT_AVAILABLE|0x80370102|WSL_E_WSL2_NEEDED|virtualization|Virtual Machine Platform') {
            $state = 'vm-unavailable'
        } else { throw 'Actual WSL2 execution failed; this is not a verified unsupported VM' }
    } else {
        $state = 'vm-available'
        if ($Lifecycle) {
            $script = (Join-Path $PSScriptRoot 'wsl-helper-smoke.py')
            $native = (Resolve-Path "$PSScriptRoot/../../reaper/target/napi").Path
            $linuxScript = (Invoke-Probe 'script-path' @('-d', $Distro, '--exec', 'wslpath', '-u', $script)).stdout.Trim()
            $linuxNative = (Invoke-Probe 'native-path' @('-d', $Distro, '--exec', 'wslpath', '-u', $native)).stdout.Trim()
            $linuxScratch = (Invoke-Probe 'scratch-path' @('-d', $Distro, '--exec', 'wslpath', '-u', (Resolve-Path $ReportDirectory).Path)).stdout.Trim()
            $smoke = Invoke-Probe 'real-interop-lifecycle' @('-d', $Distro, '-u', 'root', '--exec', 'python3', $linuxScript, $linuxNative, $linuxScratch) 90
            if ($smoke.timeout -or $smoke.exitCode -ne 0) {
                $state = 'lifecycle-failed'
                throw 'WSL2 runs, but the helper lifecycle failed'
            }
            $state = 'fixture-lifecycle-passed'
        }
    }
} catch {
    $failed = $true
    $records.Add(@{ name = 'failure'; stderr = $_.ToString() })
} finally {
    $report = [ordered]@{
        state = $state; realStudioGate = 'not-run'
        imageOS = $env:ImageOS; imageVersion = $env:ImageVersion
        architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        windows = [Environment]::OSVersion.VersionString
        userInteractive = [Environment]::UserInteractive
        processSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        commit = $env:GITHUB_SHA; distro = $Distro; probes = $records
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$ReportDirectory/report.json" -Encoding utf8
    $summary = "## WSL2 capability: $state`n`nReal Studio release gate: **not run**. A fixture pass does not replace the manual packed-package matrix.`n`nImage: $env:ImageOS / $env:ImageVersion; Windows: $($report.windows); architecture: $($report.architecture).`n`nSee report.json for each command, timeout, exit code, stdout and stderr."
    $summary | Set-Content -LiteralPath "$ReportDirectory/summary.md" -Encoding utf8
    if ($env:GITHUB_STEP_SUMMARY) { $summary | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
    if ($env:GITHUB_OUTPUT) { "state=$state" | Add-Content -LiteralPath $env:GITHUB_OUTPUT }
    Write-Output $summary
}
if ($failed) { exit 1 }
