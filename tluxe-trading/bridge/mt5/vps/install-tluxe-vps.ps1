<#
Trading by TLUXE - always-on Windows VPS setup for the MT5 cloud feed (XAUUSD / XAGUSD). Run ONCE, as Administrator,
in an elevated PowerShell on the VPS, AFTER:
  1. MetaTrader 5 is installed and logged in to your broker/demo account once ("Save password" ticked).
  2. The repo is cloned (e.g. C:\TLUXE\TRADING) and bridge\mt5\.env + bridge\mt5\remote_link\.env are filled in.
  3. bridge\mt5\.venv and bridge\mt5\remote_link\.venv exist (the start scripts create the link venv automatically).

It registers three Scheduled Tasks for THIS Windows user, started at logon and restarted automatically on failure:
  TLUXE MT5 Terminal    terminal64.exe (the broker session; MT5 needs an interactive desktop session)
  TLUXE MT5 Bridge      bridge\mt5\start_bridge.cmd       (127.0.0.1:8765 on the VPS only - never exposed)
  TLUXE MT5 Link        bridge\mt5\remote_link\start_remote_link.cmd  (OUTBOUND WSS to the TLUXE gateway)
and disables sleep / hibernation. For reboot recovery without anyone logging in, enable Windows auto-logon for this
user with Sysinternals Autologon (stores the password encrypted in LSA): https://learn.microsoft.com/sysinternals/downloads/autologon

No inbound firewall port is opened. No secret is read, printed or stored by this script.
#>
param(
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..\..").Path,          # ...\tluxe-trading
  [string]$Terminal = "C:\Program Files\MetaTrader 5\terminal64.exe"
)
$ErrorActionPreference = "Stop"
$mt5 = Join-Path $Root "bridge\mt5"
$user = "$env:USERDOMAIN\$env:USERNAME"
foreach ($p in @("$mt5\start_bridge.cmd", "$mt5\remote_link\start_remote_link.cmd", "$mt5\.env", "$mt5\remote_link\.env")) {
  if (-not (Test-Path $p)) { throw "Missing $p - see docs/CLOUD_DEPLOYMENT.md (Windows VPS)." }
}
if (-not (Test-Path $Terminal)) { throw "terminal64.exe not found at $Terminal - pass -Terminal <path>." }

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

function Register-Tluxe([string]$Name, [string]$Exe, [string]$Arguments, [string]$WorkDir, [int]$DelaySec) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = "PT${DelaySec}S"
  $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $WorkDir
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
  Write-Host "registered: $Name"
}

Register-Tluxe "TLUXE MT5 Terminal" $Terminal "" (Split-Path $Terminal) 10
Register-Tluxe "TLUXE MT5 Bridge" "cmd.exe" "/c `"$mt5\start_bridge.cmd`"" $mt5 40
Register-Tluxe "TLUXE MT5 Link" "cmd.exe" "/c `"$mt5\remote_link\start_remote_link.cmd`"" "$mt5\remote_link" 60

# Always on: no sleep / hibernate (monitor may turn off).
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /hibernate off | Out-Null

Write-Host ""
Write-Host "Done. Start now without rebooting:  Start-ScheduledTask 'TLUXE MT5 Terminal'; Start-ScheduledTask 'TLUXE MT5 Bridge'; Start-ScheduledTask 'TLUXE MT5 Link'"
Write-Host "Health:  powershell -File `"$PSScriptRoot\check-tluxe-vps.ps1`""
Write-Host "Reboot recovery: enable Sysinternals Autologon for $user, then test with: Restart-Computer"
