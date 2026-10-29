param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [Parameter(Mandatory = $true)][string]$Start,
    [Parameter(Mandatory = $true)][string]$End
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

[Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if (-not $profile) {
    $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() |
        Where-Object { $_.GetNetworkConnectivityLevel() -ne 'None' } |
        Select-Object -First 1
}
if (-not $profile) {
    Write-Output '{"error":"no-profile"}'
    exit 0
}

$states = New-Object Windows.Networking.Connectivity.NetworkUsageStates
$states.Roaming = [Windows.Networking.Connectivity.TriStates]::DoNotCare
$states.Shared = [Windows.Networking.Connectivity.TriStates]::DoNotCare

$attrType = [System.Collections.Generic.IReadOnlyList[Windows.Networking.Connectivity.AttributedNetworkUsage]]

$from = [DateTimeOffset]::Parse($Start).Date
$to = [DateTimeOffset]::Parse($End).DateTime

$days = @()
$cursor = $from
while ($cursor -lt $to) {
    $next = $cursor.AddDays(1)
    if ($next -gt $to) { $next = $to }

    $op = $profile.GetAttributedNetworkUsageAsync(
        [DateTimeOffset]::new($cursor),
        [DateTimeOffset]::new($next),
        $states)
    $records = Await $op $attrType

    $rx = 0.0
    $tx = 0.0
    foreach ($r in $records) {
        if ($r.AttributionId -eq $AppId) {
            $rx += [double]$r.BytesReceived
            $tx += [double]$r.BytesSent
        }
    }

    $days += [pscustomobject]@{
        date = $cursor.ToString('yyyy-MM-dd')
        rx   = $rx
        tx   = $tx
    }
    $cursor = $next
}

[pscustomobject]@{
    appId = $AppId
    days  = $days
} | ConvertTo-Json -Depth 4 -Compress
