<# Trading by TLUXE - VPS health check (read-only). Shows the scheduled tasks and the LOCAL bridge health on this VPS.
   The bridge token is read from bridge\mt5\.env and sent only to 127.0.0.1 on this machine; it is never printed. #>
$mt5 = (Resolve-Path "$PSScriptRoot\..").Path
Get-ScheduledTask -TaskName "TLUXE MT5*" | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  "{0,-20} {1,-8} last run {2}  result {3}" -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult
}
$token = (Get-Content "$mt5\.env" | Where-Object { $_ -match '^TLUXE_BRIDGE_TOKEN=' }) -replace '^TLUXE_BRIDGE_TOKEN=', ''
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:8765/v1/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
  "bridge: OK  terminal={0}  server={1}  company={2}" -f $h.terminal.state, $h.account.server, $h.account.company
} catch { "bridge: NOT REACHABLE ($($_.Exception.Message))" }
