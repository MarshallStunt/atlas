# Relay one-step install for Windows (run in PowerShell as yourself, not as Administrator).
#   .\install.ps1                      this PC runs the hub and the agent (single user)
#   .\install.ps1 -Hub https://HUB     this PC only runs the agent and pairs with that hub
param([string]$Hub = "")
$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Dir

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -or [int](& node -p "process.versions.node.split('.')[0]") -lt 20) {
  Write-Host "Relay needs Node.js 20 or newer: https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS)"; exit 1
}
Write-Host "-> Installing dependencies"; npm install --omit=dev --silent

$hubProc = $null
if ($Hub -eq "") {
  $entry = Join-Path $Dir "start.js"; $Hub = "http://127.0.0.1:8100"; $name = "Relay (hub + agent)"
  $hubProc = Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $Dir 'hub\server.js')`"" -PassThru -WindowStyle Hidden
  Start-Sleep 1
  Write-Host "-> Open http://127.0.0.1:8100 on THIS PC to set your PIN, then go to Devices and enter the code below."
} else { $entry = Join-Path $Dir "agent\agent.js"; $name = "Relay agent" }

& $node (Join-Path $Dir "agent\agent.js") "--hub=$Hub" --pair-only
if ($hubProc) { Stop-Process -Id $hubProc.Id -ErrorAction SilentlyContinue }

# Start at logon in YOUR desktop session (needed for screenshots and the browser), hidden, restart on failure.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "Relay" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "Relay"
Write-Host "OK  $name runs at logon (Task Scheduler -> Relay)"
Write-Host ""
Write-Host "Last step, once per browser: open edge://extensions or chrome://extensions, turn on Developer mode,"
Write-Host "click 'Load unpacked' and pick:  $(Join-Path $Dir 'bridge')"
Write-Host "It connects to the agent by itself. Choose what Relay may do here at http://127.0.0.1:8101"
