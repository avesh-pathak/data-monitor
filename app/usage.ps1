param(
    [string]$AppsStart = '',
    [string]$AppsEnd = ''
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

$now = [DateTimeOffset]::Now
$todayStart = [DateTimeOffset]::new($now.Date)
$windowStart = [DateTimeOffset]::new($now.Date.AddDays(-58))

$usageType = [System.Collections.Generic.IReadOnlyList[Windows.Networking.Connectivity.NetworkUsage]]

# Daily buckets, start-anchored: bucket i begins at windowStart + i days.
$op = $profile.GetNetworkUsageAsync($windowStart, $now, [Windows.Networking.Connectivity.DataUsageGranularity]::PerDay, $states)
$dayUsage = Await $op $usageType

$days = @()
for ($i = 0; $i -lt $dayUsage.Count; $i++) {
    $days += [pscustomobject]@{
        date = $windowStart.Date.AddDays($i).ToString('yyyy-MM-dd')
        rx   = [double]$dayUsage[$i].BytesReceived
        tx   = [double]$dayUsage[$i].BytesSent
    }
}

# Hourly buckets for today only.
$op = $profile.GetNetworkUsageAsync($todayStart, $now, [Windows.Networking.Connectivity.DataUsageGranularity]::PerHour, $states)
$hourUsage = Await $op $usageType

$hours = @()
for ($i = 0; $i -lt $hourUsage.Count; $i++) {
    $hours += [pscustomobject]@{
        hour = $i
        rx   = [double]$hourUsage[$i].BytesReceived
        tx   = [double]$hourUsage[$i].BytesSent
    }
}

# Hourly buckets across the whole window, for the weekday-by-hour heatmap.
$op = $profile.GetNetworkUsageAsync($windowStart, $now, [Windows.Networking.Connectivity.DataUsageGranularity]::PerHour, $states)
$hourAll = Await $op $usageType

$hoursAll = @()
for ($i = 0; $i -lt $hourAll.Count; $i++) {
    $hoursAll += [pscustomobject]@{
        rx = [double]$hourAll[$i].BytesReceived
        tx = [double]$hourAll[$i].BytesSent
    }
}

# Per-app totals for the requested window (defaults to today).
$attrStart = $todayStart
$attrEnd = $now
if ($AppsStart -and $AppsEnd) {
    try {
        $attrStart = [DateTimeOffset]::Parse($AppsStart)
        $attrEnd = [DateTimeOffset]::Parse($AppsEnd)
    } catch {
        $attrStart = $todayStart
        $attrEnd = $now
    }
}

$attrType = [System.Collections.Generic.IReadOnlyList[Windows.Networking.Connectivity.AttributedNetworkUsage]]
$op = $profile.GetAttributedNetworkUsageAsync($attrStart, $attrEnd, $states)
$attributed = Await $op $attrType

function Get-FriendlyName([string]$id) {
    if ([string]::IsNullOrWhiteSpace($id)) { return 'System / unattributed' }
    $file = ($id -split '\\')[-1]
    $base = [System.IO.Path]::GetFileNameWithoutExtension($file)
    switch ($base.ToLowerInvariant()) {
        'brave' { return 'Brave' }
        'chrome' { return 'Chrome' }
        'msedge' { return 'Edge' }
        'firefox' { return 'Firefox' }
        'code' { return 'VS Code' }
        'node' { return 'Node.js' }
        'curl' { return 'curl' }
        'git-remote-https' { return 'Git' }
        'opencode' { return 'OpenCode' }
        'discord' { return 'Discord' }
        'spotify' { return 'Spotify' }
        'explorer' { return 'Explorer' }
        'svchost' { return 'Windows services' }
        'backgroundtaskhost' { return 'Windows background' }
        default { return $base }
    }
}

$apps = @()
foreach ($a in $attributed) {
    $name = $a.AttributionName
    if ([string]::IsNullOrWhiteSpace($name)) { $name = Get-FriendlyName $a.AttributionId }
    $apps += [pscustomobject]@{
        name = $name
        id   = $a.AttributionId
        rx   = [double]$a.BytesReceived
        tx   = [double]$a.BytesSent
    }
}

[pscustomobject]@{
    profile     = $profile.ProfileName
    generatedAt = $now.ToString('o')
    days        = $days
    hours       = $hours
    hoursFrom   = $windowStart.ToString('o')
    hoursAll    = $hoursAll
    apps        = $apps
} | ConvertTo-Json -Depth 5 -Compress
