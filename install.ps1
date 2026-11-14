# Aura one-step install for Windows. No admin rights, no Node.js or git needed beforehand.
#
#   One line (PowerShell):  irm https://raw.githubusercontent.com/MarshallStunt/aura/main/install.ps1 | iex
#   Or double-click "Install Aura (Windows).cmd" in the Aura folder.
#   To use a hub hosted elsewhere:  $env:AURA_HUB = "https://HUB"; then run the line above.
#
# It downloads Node.js from nodejs.org (checksum-verified) into your user folder if you don't have
# Node 20+, gets Aura, pairs this PC (you type a code), and starts Aura at logon as YOU (not admin).
# (no param block: this script also runs through "irm | iex")
$Hub = $env:AURA_HUB
for ($i = 0; $i -lt $args.Count; $i++) { if ($args[$i] -eq "-Hub") { $Hub = $args[$i + 1] } }
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # makes downloads much faster in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Home_ = Join-Path $env:LOCALAPPDATA "Aura"
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
function Say($m) { Write-Host "-> $m" -ForegroundColor Cyan }

# ---------- 1. Node.js (use yours if it's 20+, otherwise a private copy) ----------
$node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and [int](& $sys.Source -p "process.versions.node.split('.')[0]") -ge 20) { $node = $sys.Source }
# Reuse the private copy from a previous install instead of downloading it again.
$private = Join-Path $Home_ "node\node.exe"
if (-not $node -and (Test-Path $private)) { $node = $private; Say "Using Node.js already set up for Aura" }
if (-not $node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  Say "Getting Node.js (one time, about 30 MB)"
  $index = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  $ver = $lts.version
  $name = "node-$ver-win-$arch"
  $zip = Join-Path $Home_ "$name.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest "https://nodejs.org/dist/$ver/SHASUMS256.txt" -UseBasicParsing).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match "  $name.zip$" }) -replace "\s.*", ""
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $got -ne $want.Trim().ToLower()) { Remove-Item $zip; throw "Node.js download failed its checksum. Try again." }
  $nodeRoot = Join-Path $Home_ "node"
  if (Test-Path $nodeRoot) { Remove-Item -Recurse -Force $nodeRoot }
  Expand-Archive $zip -DestinationPath $Home_ -Force
  Rename-Item (Join-Path $Home_ $name) "node"
  Remove-Item $zip
  $node = Join-Path $nodeRoot "node.exe"
}
$nodeDir = Split-Path -Parent $node
$env:Path = "$nodeDir;$env:Path"
$npm = Join-Path $nodeDir "npm.cmd"
if (-not (Test-Path $npm)) { $npm = "npm" }

# Stop a running Aura before its files are replaced.
Get-ScheduledTask -TaskName "Aura" -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue

# ---------- 2. Aura itself (this folder if run from it, otherwise download the latest) ----------
$here = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
$reused = $false
if ($here -and (Test-Path (Join-Path $here "package.json"))) { $Dir = $here }
else {
  $Dir = Join-Path $Home_ "app"
  Say $(if (Test-Path $Dir) { "Updating Aura to the latest version" } else { "Downloading Aura" })
  $zip = Join-Path $Home_ "aura.zip"
  Invoke-WebRequest "https://github.com/MarshallStunt/aura/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $Home_ "extract"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive $zip -DestinationPath $tmp -Force
  $new = Join-Path $tmp "aura-main"
  # Keep the already-installed parts when they haven't changed, so updates are quick.
  $oldLock = Join-Path $Dir "package-lock.json"; $oldMods = Join-Path $Dir "node_modules"
  if ((Test-Path $oldMods) -and (Test-Path $oldLock) -and ((Get-FileHash $oldLock).Hash -eq (Get-FileHash (Join-Path $new "package-lock.json")).Hash)) {
    Move-Item $oldMods (Join-Path $new "node_modules"); $reused = $true
  }
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  Move-Item $new $Dir
  Remove-Item -Recurse -Force $tmp, $zip
}
Set-Location $Dir
if ($reused) { Say "Aura's parts are up to date" }
else {
  Say "Installing Aura's parts"
  & $npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

# ---------- 3. Pair this PC ----------
$hubProc = $null
if (-not $Hub) {
  $entry = Join-Path $Dir "start.js"; $Hub = "http://127.0.0.1:8100"; $name = "Aura (hub + agent)"
  $hubProc = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $Dir 'hub\server.js')`"" -PassThru -WindowStyle Hidden
  Start-Sleep 2
  Write-Host ""
  Write-Host "  Your browser is opening Aura. Set a PIN there, go to System, and enter the code below." -ForegroundColor Yellow
  Start-Process "http://127.0.0.1:8100"
} else { $entry = Join-Path $Dir "agent\agent.js"; $name = "Aura agent" }

& $node (Join-Path $Dir "agent\agent.js") "--hub=$Hub" --pair-only
if ($hubProc) { Stop-Process -Id $hubProc.Id -ErrorAction SilentlyContinue }

# ---------- 4. Start at logon, in your own desktop session (needed for screenshots and the browser) ----------
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "Aura" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "Aura"

# ---------- 5. Aura icon on the Desktop and in the Start menu (opens Aura in its own window) ----------
$browserExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell
foreach ($where in @([Environment]::GetFolderPath("Desktop"), (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))) {
  $lnk = $shell.CreateShortcut((Join-Path $where "Aura.lnk"))
  if ($browserExe) { $lnk.TargetPath = $browserExe; $lnk.Arguments = "--app=$Hub" } else { $lnk.TargetPath = $Hub }
  $lnk.IconLocation = (Join-Path $Dir "assets\aura.ico")
  $lnk.Description = "Aura: your work computer, by voice"
  $lnk.Save()
}
Write-Host "OK  Aura icon added to your Desktop and Start menu" -ForegroundColor Green

# ---------- 6. Browser extension ----------
$bridge = Join-Path $Dir "bridge"
Write-Host ""
Write-Host "OK  $name is installed and runs at logon." -ForegroundColor Green
Write-Host ""
Write-Host "Last step, once: add the browser extension." -ForegroundColor Yellow
Write-Host "  1. In the Chrome/Edge tab that just opened, turn on Developer mode (top right)."
Write-Host "  2. Click 'Load unpacked' and choose this folder (Explorer just opened it):"
Write-Host "     $bridge"
Write-Host "  It connects to Aura by itself. Open Aura any time at http://127.0.0.1:8100"
Start-Process explorer.exe $bridge
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) { Start-Process $chrome "chrome://extensions" } else { Start-Process "msedge" "edge://extensions" -ErrorAction SilentlyContinue }
