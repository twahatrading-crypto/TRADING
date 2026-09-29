<#
Trading by TLUXE - IBKR COMEX Level-2 depth bridge on the cloud Windows VPS. Run ONCE, as Administrator, AFTER:
  1. IB Gateway (stable, offline installer) is installed and you have logged in to it ONCE yourself.
     IB Gateway > Configure > Settings > API > Settings:
       - Enable ActiveX and Socket Clients: ON
       - Read-Only API: ON            (the bridge never sends orders; this makes IB Gateway refuse them too)
       - Socket port: 4001 (live) or 4002 (paper)  - must equal TLUXE_IBKR_PORT
       - Allow connections from localhost only: ON (trusted IP 127.0.0.1)
     IB Gateway > Configure > Settings > Lock and Exit:
       - Auto restart (daily) at a quiet time - keeps the session through the trading week without re-login.
         IBKR still requires a manual login (with 2FA) after the weekly reset - this script does NOT automate logins.
  2. IBKR's official Python API is installed into bridge\ibkr\.venv (this script creates the venv; see README).
  3. bridge\ibkr\.env is filled in from .env.example (link token only - no IBKR credentials anywhere).

Registers the Scheduled Task "TLUXE IBKR Depth Bridge" for THIS Windows user: started at logon, restarted every minute
on failure, never stopped. Disables sleep / hibernation. Opens NO inbound port. Reads, prints and stores no secret.
#>
param(
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..\..").Path,  # ...\tluxe-trading
  [string]$IbApiPythonClient = ""                                   # optional: ...\IBJts\source\pythonclient
)
$ErrorActionPreference = "Stop"
$ib = Join-Path $Root "bridge\ibkr"
$user = "$env:USERDOMAIN\$env:USERNAME"
foreach ($p in @("$ib\start_bridge.cmd", "$ib\.env", "$ib\requirements.txt")) {
  if (-not (Test-Path $p)) { throw "Missing $p - see bridge\ibkr\README.md." }
}

if (-not (Test-Path "$ib\.venv\Scripts\python.exe")) {
  py -3.11 -m venv "$ib\.venv"
}
& "$ib\.venv\Scripts\python.exe" -m pip install --upgrade pip | Out-Null
& "$ib\.venv\Scripts\python.exe" -m pip install -r "$ib\requirements.txt"
if ($IbApiPythonClient) {
  & "$ib\.venv\Scripts\python.exe" -m pip install $IbApiPythonClient
}
& "$ib\.venv\Scripts\python.exe" -c "import ibapi; print('ibapi', getattr(ibapi, '__version__', 'installed'))"
if ($LASTEXITCODE -ne 0) { throw "IBKR's official ibapi is not installed in $ib\.venv - pass -IbApiPythonClient <...\IBJts\source\pythonclient>." }

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT90S"  # give IB Gateway time to start first
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$ib\start_bridge.cmd`"" -WorkingDirectory $ib
Unregister-ScheduledTask -TaskName "TLUXE IBKR Depth Bridge" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "TLUXE IBKR Depth Bridge" -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-Host "registered: TLUXE IBKR Depth Bridge"

powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /hibernate off | Out-Null

Write-Host ""
Write-Host "Start now:  Start-ScheduledTask 'TLUXE IBKR Depth Bridge'"
Write-Host "IB Gateway itself: add it to Startup for this user (it needs the interactive desktop for its login window)."
Write-Host "Evidence capture (IB Gateway logged in):  $ib\.venv\Scripts\python.exe -m tluxe_ibkr_bridge.capture --gc GCZ6 --si SIZ6 --seconds 120"
