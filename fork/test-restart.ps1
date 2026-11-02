#Requires -Version 7.2
<#
.SYNOPSIS
  Tests fork.ps1's install waiter and restart runner against a stand-in app, never the real
  T3 Code. Nothing it starts has a window, because it runs on Adam's desktop: the stand-in app
  and installers are one windowless stub (no forms, no console), every process starts with
  CreateNoWindow, the stand-in "closes" through a file instead of a close button, and a watcher
  checks four times a second that no test process owns a visible window or the keyboard focus.
  If one ever does, the run stops every test process at once and fails.

  Scenarios: a quit followed by a reopen 2 seconds later (the 2026-09-30 race that made a waiter
  skip its install), T3 installing its own downloaded update as it quits, T3 opened while the
  installer runs, T3 not running, and the restart runner (install, and -Force on the current
  build). Also the asar reader and build ordering.

.EXAMPLE
  pwsh fork/test-restart.ps1              # everything
  pwsh fork/test-restart.ps1 -ProveOnly   # only the windowless check: one stand-in, one hidden pwsh
#>
param([switch]$ProveOnly)
$ErrorActionPreference = 'Stop'
$fork = Join-Path $PSScriptRoot 'fork.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "t3fork-nowin-$PID"
$standinDir = Join-Path $testRoot 'app'
$updaterDir = Join-Path $testRoot 'updater'
New-Item -ItemType Directory -Force (Join-Path $standinDir 'resources'), (Join-Path $updaterDir 'pending'), (Join-Path $testRoot 'state') | Out-Null
$env:T3CODE_FORK_STATE_DIR = Join-Path $testRoot 'state'
$env:T3CODE_FORK_APP_DIR = $standinDir
$env:T3CODE_FORK_UPDATER_DIR = $updaterDir
$env:T3FORK_TEST_ROOT = $testRoot
$env:T3_CLI = Join-Path $testRoot 'no-t3-cli.mjs'

# --- No windows, ever ----------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class T3ForkTestWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static HashSet<uint> VisibleOwners() {
    var owners = new HashSet<uint>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) { uint pid; GetWindowThreadProcessId(h, out pid); owners.Add(pid); } return true; }, IntPtr.Zero);
    return owners;
  }
  public static uint ForegroundOwner() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
}
'@

$script:started = [Collections.Generic.List[uint32]]::new()
$script:windowHits = @()

function Get-TestProcesses {
  # Everything run from the test folder, every process this test started, and all their children.
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)
  $ids = [Collections.Generic.HashSet[uint32]]::new()
  foreach ($p in $all) {
    if (($p.ExecutablePath -and $p.ExecutablePath.StartsWith($testRoot, 'OrdinalIgnoreCase')) -or $script:started.Contains([uint32]$p.ProcessId)) {
      [void]$ids.Add($p.ProcessId)
    }
  }
  do {
    $grew = $false
    foreach ($p in $all) { if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add($p.ProcessId)) { $grew = $true } }
  } while ($grew)
  @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) })
}

function Stop-TestProcesses {
  Get-TestProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Assert-NoWindow {
  $owners = [T3ForkTestWindows]::VisibleOwners()
  $focus = [T3ForkTestWindows]::ForegroundOwner()
  foreach ($p in Get-TestProcesses) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    $why = if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) { 'has a main window' }
      elseif ($owners.Contains([uint32]$p.ProcessId)) { 'owns a visible window' }
      elseif ($focus -eq $p.ProcessId) { 'has the keyboard focus' }
    if ($why) {
      $script:windowHits += "$($p.Name) $($p.ProcessId) $why"
      Stop-TestProcesses
      throw "Test process $($p.Name) ($($p.ProcessId)) $why; stopped every test process."
    }
  }
}

function Wait-Test([double]$Seconds, [Diagnostics.Process]$Process) {
  # Sleeps (or waits for $Process) while checking for windows every quarter second.
  $until = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $until) {
    Assert-NoWindow
    if ($Process) { if ($Process.WaitForExit(250)) { return $true } } else { Start-Sleep -Milliseconds 250 }
  }
  if ($Process) { return $Process.HasExited }
}

function Start-HiddenProcess([string]$Exe, [string[]]$Arguments) {
  $psi = [Diagnostics.ProcessStartInfo]::new($Exe)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
  $p = [Diagnostics.Process]::Start($psi)
  $script:started.Add([uint32]$p.Id)
  $p
}

# --- The stand-in: one windowless stub for the app and both installers ----------------------------
$src = Join-Path $testRoot 'standin.cs'
Set-Content $src -Encoding ASCII -Value @'
using System; using System.Diagnostics; using System.IO; using System.Threading;
static class P {
  static void StartHidden(string exe, string args) {
    Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true });
  }
  static int Main(string[] a) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    if (File.Exists(self + ".cfg")) {
      // An installer: <asar to install>|<where>|<delay ms>|<marker or ->|<exe to start when done or ->[|<fail-once file>]
      // The exe to start is the app, or another installer stub (a launcher that hands the work to a child).
      // With a fail-once file: the first run creates it and exits 2 without installing, as NSIS does when files are held; "always" exits 2 every time.
      string[] c = File.ReadAllText(self + ".cfg").Trim().Split('|');
      if (c.Length > 5 && c[5] == "always") return 2;
      if (c.Length > 5 && c[5] != "-" && !File.Exists(c[5])) { File.WriteAllText(c[5], "x"); return 2; }
      Thread.Sleep(int.Parse(c[2]));
      File.Copy(c[0], c[1], true);
      if (c[3] != "-") File.WriteAllText(c[3], "ran");
      if (c[4] != "-") StartHidden(c[4], "app");
      return 0;
    }
    // The app: runs until the test presses its "close button", a quit file.
    string quit = Path.Combine(Environment.GetEnvironmentVariable("T3FORK_TEST_ROOT"), "quit-" + Process.GetCurrentProcess().Id);
    while (!File.Exists(quit)) Thread.Sleep(100);
    return 0;
  }
}
'@
$stub = Join-Path $testRoot 'stub.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe "/out:$stub" $src | Out-Null
if ($LASTEXITCODE) { throw 'Compiling the stand-in failed.' }
$standinApp = Join-Path $standinDir 'T3 Code (Alpha).exe'
Copy-Item $stub $standinApp

# fork.ps1's own functions, with its three window-touching steps replaced by windowless ones.
$overrides = Join-Path $testRoot 'overrides.ps1'
Set-Content $overrides -Value @'
function Start-HiddenProcess([string]$Exe, [string[]]$Arguments) {
  $psi = [Diagnostics.ProcessStartInfo]::new($Exe)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  foreach ($a in $Arguments) { $psi.ArgumentList.Add($a) }
  [Diagnostics.Process]::Start($psi)
}
function Request-AppClose($P) { New-Item -ItemType File -Force (Join-Path $env:T3FORK_TEST_ROOT "quit-$($P.Id)") | Out-Null; $true }
function Start-App { [void](Start-HiddenProcess $AppExe @('app')) }
function Invoke-Installer([string]$Exe) { $p = Start-HiddenProcess $Exe @('/S'); $p.WaitForExit(); $p.ExitCode }
function Test-AppApi { $true }
'@

function Start-TestPwsh([string]$Body) {
  # A waiter or runner as its task runs it, in a process of its own, with no console window.
  Start-HiddenProcess (Get-Process -Id $PID).Path @('-NoProfile', '-NonInteractive', '-Command', ". '$fork' -Quiet; . '$overrides'; `$InstallerSettleSeconds = 1; $Body")
}

$failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { "PASS  $Name" } else { $script:failures++; "FAIL  $Name $Detail" }
}

try {
  if ($ProveOnly) {
    # The smallest run: one stand-in app and one hidden pwsh, watched for 5 seconds.
    $app = Start-HiddenProcess $standinApp @('app')
    $shell = Start-HiddenProcess (Get-Process -Id $PID).Path @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 3')
    [void](Wait-Test 5)
    Check 'the stand-in app is still running' (-not $app.HasExited)
    Check 'the hidden pwsh ran and exited' $shell.HasExited
    New-Item -ItemType File -Force (Join-Path $testRoot "quit-$($app.Id)") | Out-Null
    Check 'the stand-in app quits through its quit file' ([bool](Wait-Test 5 $app))
    return
  }

  function New-Asar([string]$Path, [string]$Version) {
    # The asar layout: uint32 4, uint32 header pickle size, then the pickle (uint32 payload size,
    # int32 length, JSON header, padding), then the files.
    $pkg = [Text.Encoding]::UTF8.GetBytes((@{ name = 't3code'; version = $Version } | ConvertTo-Json -Compress))
    $json = [Text.Encoding]::UTF8.GetBytes((@{ files = @{ 'package.json' = @{ size = $pkg.Length; offset = '0' } } } | ConvertTo-Json -Compress -Depth 5))
    $pad = (4 - ($json.Length % 4)) % 4
    $payload = 4 + $json.Length + $pad
    $ms = [IO.MemoryStream]::new()
    $w = [IO.BinaryWriter]::new($ms)
    $w.Write([uint32]4); $w.Write([uint32](4 + $payload)); $w.Write([uint32]$payload); $w.Write([int32]$json.Length)
    $w.Write($json); $w.Write([byte[]]::new($pad)); $w.Write($pkg)
    [IO.File]::WriteAllBytes($Path, $ms.ToArray())
  }
  $v1 = '0.0.9-fork.20990101.1'; $v2 = '0.0.9-fork.20990101.2'; $v3 = '0.0.9-fork.20990101.3'
  foreach ($v in $v1, $v2, $v3) { New-Asar (Join-Path $testRoot "$v.asar") $v }
  $liveAsar = Join-Path $standinDir 'resources\app.asar'
  $marker = Join-Path $testRoot 'our-installer-ran'

  function New-Installer([string]$Path, [string]$Asar, [int]$DelayMs, [string]$Marker = '-', [string]$Reopen = '-', [string]$FailOnce = '-') {
    Copy-Item $stub $Path -Force
    Set-Content "$Path.cfg" -Encoding ASCII -NoNewline -Value "$Asar|$liveAsar|$DelayMs|$Marker|$Reopen|$FailOnce"
    $Path
  }
  function Get-OurInstaller([int]$DelayMs = 0) { New-Installer (Join-Path $testRoot 'T3-Code-test-x64.exe') (Join-Path $testRoot "$v2.asar") $DelayMs $marker }
  function Get-Mains { @(Get-CimInstance Win32_Process -Filter "Name='T3 Code (Alpha).exe'" | Where-Object { $_.ExecutablePath -like "$standinDir\*" }) }
  function Start-Standin {
    $p = Start-HiddenProcess $standinApp @('app')
    $until = (Get-Date).AddSeconds(10)
    while (-not (Get-Mains | Where-Object ProcessId -eq $p.Id) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }
    $p
  }
  function Close-Standin($P) { New-Item -ItemType File -Force (Join-Path $testRoot "quit-$($P.Id)") | Out-Null }
  function Reset-Case {
    Stop-TestProcesses
    Start-Sleep -Milliseconds 300
    $script:started.Clear()
    Copy-Item (Join-Path $testRoot "$v1.asar") $liveAsar -Force
    Remove-Item $marker, (Join-Path $testRoot 'quit-*'), (Join-Path $testRoot 'state\logs\*') -Force -ErrorAction SilentlyContinue
  }
  function Get-RunLog { (Get-ChildItem (Join-Path $testRoot 'state\logs') -Filter '*.log' -ErrorAction SilentlyContinue | Get-Content) -join "`n" }
  function Start-Waiter([string]$Installer, [string]$Ver) {
    Start-TestPwsh "`$InstallTaskName = 'T3 Code fork install (test)'; Install-WhenClosed '$Installer' '$Ver'"
  }

  . $fork -Quiet
  . $overrides

  # --- Build ordering and the asar reader ---------------------------------------------------------
  Check 'fork builds sort by date, then counter' ((Compare-Build '0.0.45-fork.20260930.2' '0.0.45-fork.20260930.1') -gt 0 -and
    (Compare-Build '0.0.45-fork.20260930.1' '0.0.45-fork.20260929.9') -gt 0)
  Check 'an official version sorts before its fork builds' ((Compare-Build '0.0.45-fork.20260101.1' '0.0.45') -gt 0 -and
    (Compare-Build '0.0.45' '0.0.44-fork.20261231.9') -gt 0)
  Reset-Case
  Check 'reads the build from a stand-in app.asar' ((Get-InstalledBuild) -eq $v1) "got $(Get-InstalledBuild)"
  $realAsar = Join-Path $env:LOCALAPPDATA 'Programs\t3code\resources\app.asar'
  if (Test-Path $realAsar) {
    # A folder holding only a copy of the real archive, so the exe's FileVersion cannot answer.
    $only = Join-Path $testRoot 'asar-only'
    New-Item -ItemType Directory -Force (Join-Path $only 'resources') | Out-Null
    Copy-Item $realAsar (Join-Path $only 'resources\app.asar')
    $AppDir = $only; $AppExe = Join-Path $only 'T3 Code (Alpha).exe'
    $real = Get-InstalledBuild
    $AppDir = $standinDir; $AppExe = $standinApp
    Check "reads the real T3's build from its app.asar ($real)" ($real -match '^\d+\.\d+\.\d+(-fork\.\d{8}\.\d+)?$')
  }

  # --- Finding the exe the installer wrote ------------------------------------------------------------
  $renamedDir = Join-Path $testRoot 'renamed'
  New-Item -ItemType Directory -Force $renamedDir | Out-Null
  Copy-Item $stub (Join-Path $renamedDir 'T3 Code (Beta).exe')
  Copy-Item $stub (Join-Path $renamedDir 'Uninstall T3 Code (Beta).exe')
  $env:T3CODE_FORK_APP_DIR = $renamedDir
  $found = Find-AppInstall
  Check 'install: finds the renamed exe, not the uninstaller' ($found.Exe -eq (Join-Path $renamedDir 'T3 Code (Beta).exe')) "got $($found.Exe)"
  [void](Update-AppInstall)
  Check 'install: Update-AppInstall follows the rename' ($AppExeName -eq 'T3 Code (Beta).exe' -and $AppDir -eq $renamedDir) "got $AppExeName in $AppDir"
  Remove-Item (Join-Path $renamedDir 'T3 Code (Beta).exe') -Force
  Check 'install: reports no exe when the installer left none' (-not (Update-AppInstall) -and -not (Find-AppInstall).Exe)
  $env:T3CODE_FORK_APP_DIR = $standinDir
  [void](Update-AppInstall)

  # --- Which running threads keep a restart waiting -------------------------------------------------------
  $judge = [pscustomobject]@{ id = 'thread:delegated-task:command%3Amcp%3Aserver-ledger-judge%253Athread%253Ax%3Aledger-judge%3Ajudge-1'; title = 'Judge L6: Verify'; state = 'running' }
  $scheduled = [pscustomobject]@{ id = 'thread:project:03fc6826-b73a-4556-ae6c-864d0755613f:3c612bc3-baf5-4dcc-b985-c1b2'; title = 'GameFab Mac daily port'; state = 'running' }
  $worker = [pscustomobject]@{ id = 'thread:delegated-task:command%3Amcp%3Aabc%3Adelegate-task%3Adef'; title = 'Optimize G6 pages'; state = 'running' }
  $top = [pscustomobject]@{ id = 'aa566e71-4105-4461-b7ce-cb7cfa185186'; title = 'Claude Account Pool Watch'; state = 'running' }
  Check 'idle: judge threads do not count as busy' (Test-BackgroundThread $judge)
  Check 'idle: scheduled-task threads do not count as busy' (Test-BackgroundThread $scheduled)
  Check 'idle: a delegated worker and a chat still count' (-not (Test-BackgroundThread $worker) -and -not (Test-BackgroundThread $top))
  Check 'idle: config titles name tick loops' (Test-BackgroundThread $top @('Pool Watch$'))

  # --- Quit, then reopen 2 seconds later (the 2026-09-30 race) -------------------------------------
  Reset-Case
  $first = Start-Standin
  $waiter = Start-Waiter (Get-OurInstaller) $v2
  [void](Wait-Test 4)
  Close-Standin $first
  [void](Wait-Test 2)
  $reopened = Start-Standin
  $reopenedAt = Get-Date
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  $mains = Get-Mains
  Check 'race: the waiter finished' $done
  Check 'race: it saw the quit although T3 reopened 2 s later' ($log -match 'T3 Code quit') $log
  Check 'race: it closed the reopened T3' ($log -match 'reopened \d+ s after it quit' -and $reopened.HasExited) $log
  Check 'race: it installed' ((Test-Path $marker) -and (Get-InstalledBuild) -eq $v2) "build $(Get-InstalledBuild)"
  Check 'race: one T3 runs afterwards, started after the install' ($mains.Count -eq 1 -and $mains[0].CreationDate -gt $reopenedAt) "mains: $($mains.Count)"

  # --- T3 installs its own downloaded update as it quits ---------------------------------------------
  Reset-Case
  $first = Start-Standin
  $waiter = Start-Waiter (Get-OurInstaller) $v2
  [void](Wait-Test 4)
  # What T3's quit handler does: start the downloaded installer, which reopens T3 when done.
  $pending = New-Installer (Join-Path $updaterDir "pending\T3-Code-$v3-x64.exe") (Join-Path $testRoot "$v3.asar") 3000 '-' $standinApp
  [void](Start-HiddenProcess $pending @('--updated', '/S', '--force-run'))
  Close-Standin $first
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  [void](Wait-Test 1)
  Check 'own update: the waiter finished' $done
  Check 'own update: it waited for T3''s installer' ($log -match 'installing the update it downloaded') $log
  Check 'own update: it did not start a second installer' (-not (Test-Path $marker))
  Check 'own update: T3 has the newer build it installed itself' ((Get-InstalledBuild) -eq $v3) "build $(Get-InstalledBuild)"
  Check 'own update: exactly one T3 runs' ((Get-Mains).Count -eq 1) "mains: $((Get-Mains).Count)"
  Remove-Item $pending, "$pending.cfg" -Force -ErrorAction SilentlyContinue

  # --- T3's installer is a launcher: it exits and a child keeps installing (the 2026-11-02 race) ----------
  # The launcher exits after 3 s without touching the files; its child writes the new build 6 s later.
  # The waiter must not read the build, or start its own installer, when the launcher alone is gone.
  Reset-Case
  $first = Start-Standin
  $waiter = Start-Waiter (Get-OurInstaller) $v2
  [void](Wait-Test 4)
  $child = New-Installer (Join-Path $updaterDir 'pending\child-installer.exe') (Join-Path $testRoot "$v2.asar") 6000 '-' $standinApp
  $launcher = New-Installer (Join-Path $updaterDir "pending\T3-Code-$v2-x64.exe") (Join-Path $testRoot "$v1.asar") 3000 '-' $child
  [void](Start-HiddenProcess $launcher @('--updated', '/S', '--force-run'))
  Close-Standin $first
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  [void](Wait-Test 1)
  Check 'launcher: the waiter finished' $done $log
  Check 'launcher: it kept waiting after the launcher exited' ($log -match 'installing the update it downloaded') $log
  Check 'launcher: T3 installed the target build itself, so no second installer ran' ((-not (Test-Path $marker)) -and (Get-InstalledBuild) -eq $v2 -and $log -match 'installed .+ itself' -and $log -notmatch 'over it') "build $(Get-InstalledBuild)`n$log"
  Check 'launcher: exactly one T3 runs' ((Get-Mains).Count -eq 1) "mains: $((Get-Mains).Count)"
  Remove-Item $launcher, "$launcher.cfg", $child, "$child.cfg" -Force -ErrorAction SilentlyContinue

  # --- T3 installs an older build than the one asked for ---------------------------------------------------
  Reset-Case
  $first = Start-Standin
  $ours = New-Installer (Join-Path $testRoot 'T3-Code-test-x64.exe') (Join-Path $testRoot "$v3.asar") 0 $marker
  $waiter = Start-Waiter $ours $v3
  [void](Wait-Test 4)
  $pending = New-Installer (Join-Path $updaterDir "pending\T3-Code-$v2-x64.exe") (Join-Path $testRoot "$v2.asar") 3000 '-' $standinApp
  [void](Start-HiddenProcess $pending @('--updated', '/S', '--force-run'))
  Close-Standin $first
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  Check 'older update: the waiter finished' $done $log
  Check 'older update: it waited for T3''s installer, then installed over it' ($log -match 'installing the update it downloaded' -and $log -match "installed $([regex]::Escape($v2)) itself; installing $([regex]::Escape($v3)) over it") $log
  Check 'older update: our installer ran after it and the newer build is in place' ((Test-Path $marker) -and (Get-InstalledBuild) -eq $v3 -and (Get-Mains).Count -eq 1) "build $(Get-InstalledBuild), mains $((Get-Mains).Count)"
  Remove-Item $pending, "$pending.cfg", $ours, "$ours.cfg" -Force -ErrorAction SilentlyContinue

  # --- The installer exits 2 once (files held by another install) ------------------------------------------
  Reset-Case
  $first = Start-Standin
  $failFile = Join-Path $testRoot 'exit2-seen'
  Remove-Item $failFile -Force -ErrorAction SilentlyContinue
  $flaky = New-Installer (Join-Path $testRoot 'T3-Code-flaky-x64.exe') (Join-Path $testRoot "$v2.asar") 0 $marker '-' $failFile
  $waiter = Start-Waiter $flaky $v2
  [void](Wait-Test 4)
  Close-Standin $first
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  Check 'exit 2: the waiter finished' $done $log
  Check 'exit 2: it retried once and installed' ((Test-Path $failFile) -and (Test-Path $marker) -and (Get-InstalledBuild) -eq $v2 -and ([regex]::Matches($log, '\] installing ')).Count -eq 2 -and $log -notmatch 'FAILED') $log
  Check 'exit 2: one T3 runs afterwards' ((Get-Mains).Count -eq 1) "mains: $((Get-Mains).Count)"

  # --- The installer exits 2 every time: one retry, then it fails with the code ---------------------------------
  Reset-Case
  $first = Start-Standin
  $stuck = New-Installer (Join-Path $testRoot 'T3-Code-stuck-x64.exe') (Join-Path $testRoot "$v2.asar") 0 $marker '-' 'always'
  $waiter = Start-Waiter $stuck $v2
  [void](Wait-Test 4)
  Close-Standin $first
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  Check 'exit 2 twice: one retry, then the waiter fails with the code' ($done -and ([regex]::Matches($log, '\] installing ')).Count -eq 2 -and (-not (Test-Path $marker))) $log

  # --- T3 opened while the installer runs --------------------------------------------------------------
  Reset-Case
  $first = Start-Standin
  $waiter = Start-Waiter (Get-OurInstaller 5000) $v2
  [void](Wait-Test 4)
  Close-Standin $first
  $until = (Get-Date).AddSeconds(30)
  while (-not ((Get-RunLog) -match '\] installing ') -and (Get-Date) -lt $until) { [void](Wait-Test 0.25) }
  [void](Wait-Test 1)
  $during = Start-Standin
  $done = Wait-Test 120 $waiter
  $log = Get-RunLog
  Check 'during install: the waiter finished' $done
  Check 'during install: it restarted the T3 opened meanwhile' ($log -match 'opened during the install' -and $during.HasExited) $log
  Check 'during install: installed, one T3 runs' ((Get-InstalledBuild) -eq $v2 -and (Get-Mains).Count -eq 1) "build $(Get-InstalledBuild), mains $((Get-Mains).Count)"

  # --- T3 not running ------------------------------------------------------------------------------------
  Reset-Case
  $waiter = Start-Waiter (Get-OurInstaller) $v2
  $done = Wait-Test 60 $waiter
  Check 'not running: installs at once and starts T3' ($done -and (Get-InstalledBuild) -eq $v2 -and (Get-Mains).Count -eq 1)

  # --- WMI reads empty while T3 runs (the 2026-11-02 false "quit on its own") --------------------------------
  # Under load the CIM query fails or returns nothing; an empty read must not count as T3 having quit.
  function Get-CimInstance { if ($script:blindWmi) { return }; CimCmdlets\Get-CimInstance @args }
  Reset-Case
  $first = Start-Standin
  $script:blindWmi = $true
  try {
    $q = Wait-AppQuit (Get-Date).AddSeconds(3)
    $seen = Get-AppMain | Select-Object -First 1
    $runs = Test-AppRunning
  } finally { $script:blindWmi = $false }
  Check 'blind WMI: no quit is reported while T3 runs' ($null -eq $q -and -not $first.HasExited) "quit at $q"
  Check 'blind WMI: the main process is still found' ($runs -and $seen.ProcessId -eq $first.Id) "seen $($seen.ProcessId), expected $($first.Id)"
  $script:blindWmi = $true
  try {
    Close-Standin $first
    $q = Wait-AppQuit (Get-Date).AddSeconds(15)
  } finally { $script:blindWmi = $false }
  Check 'blind WMI: the real quit is still reported' ($q -and $first.HasExited)

  # --- A process survives the kill: the installer must not start ---------------------------------------------
  Reset-Case
  $first = Start-Standin
  function Stop-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, [int]$Id, [switch]$Force)
    process {
      $target = $InputObject ? $InputObject.Id : $Id
      if ($script:immortal -contains $target) { Write-Error "Access is denied ($target)"; return }
      Microsoft.PowerShell.Management\Stop-Process -Id $target -Force
    }
  }
  $script:immortal = @($first.Id)
  $realCloseApp = ${function:Close-App}
  ${function:Close-App} = { param([int]$Seconds) }
  $LeftoverWaitSeconds = 1; $KillWaitSeconds = 1
  $threw = $null
  try { [void](Complete-Install (Get-OurInstaller) $v2 (Get-Date).AddSeconds(-10) 6>$null) } catch { $threw = "$_" }
  $log = Get-RunLog
  $survived = -not $first.HasExited
  $script:immortal = @()
  ${function:Close-App} = $realCloseApp
  Remove-Item Function:\Stop-Process
  $LeftoverWaitSeconds = 15; $KillWaitSeconds = 10
  Check 'survivor: the installer was not started' ((-not (Test-Path $marker)) -and $log -notmatch '\] installing ') $log
  Check 'survivor: it fails and names the process that is still running' ($survived -and $threw -match "\b$($first.Id)\b" -and $threw -match 'T3 Code') "threw: $threw"
  Check 'survivor: it tried to end the process twice' (([regex]::Matches($log, "could not end .*\b$($first.Id)\b")).Count -ge 2) $log

  # --- restart -Now: close T3, install, reopen ------------------------------------------------------------
  function Start-RestartRun([string]$Installer, [string]$Ver) {
    # What the restart task runs, with no thread to wait for or report to.
    [ordered]@{ version = $Ver; installer = $Installer; from = $v1; armedAt = (Get-Date).ToString('o')
      giveUpAt = (Get-Date).AddMinutes(5).ToString('o'); whenIdle = $false; idleMinutes = 10; ignore = @(); thread = '' } |
      ConvertTo-Json | Set-Content (Join-Path $testRoot 'state\restart.json') -Encoding UTF8
    Start-TestPwsh "`$RestartTaskName = 'T3 Code fork restart (test)'; Invoke-RestartRun"
  }

  Reset-Case
  $first = Start-Standin
  $run = Start-RestartRun (Get-OurInstaller) $v2
  $done = Wait-Test 120 $run
  $log = Get-RunLog
  Check 'restart: finished' $done
  Check 'restart: closed T3 through its close button' ($log -match 'closing T3 Code' -and $first.HasExited -and $log -notmatch 'did not close') $log
  Check 'restart: installed and reopened T3' ((Test-Path $marker) -and (Get-InstalledBuild) -eq $v2 -and (Get-Mains).Count -eq 1 -and $log -match "back on $([regex]::Escape($v2))") $log
  Check 'restart: cleared its request' (-not (Test-Path (Join-Path $testRoot 'state\restart.json')))

  Reset-Case
  Copy-Item (Join-Path $testRoot "$v2.asar") $liveAsar -Force
  $first = Start-Standin
  $run = Start-RestartRun (Get-OurInstaller) $v2
  $done = Wait-Test 120 $run
  $log = Get-RunLog
  Check 'restart -Force on the current build: only restarts T3' ($done -and $log -match 'nothing to install' -and -not (Test-Path $marker) -and
    $first.HasExited -and (Get-Mains).Count -eq 1) $log
} catch {
  $script:failures++
  "FAIL  $_"
} finally {
  Stop-TestProcesses
  Check 'no test process ever showed a window or took the focus' (-not $script:windowHits) ($script:windowHits -join '; ')
  Start-Sleep -Milliseconds 500
  Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  ''
  if ($failures) { "$failures check(s) failed." } else { 'All checks passed.' }
}
if ($failures) { exit 1 }
