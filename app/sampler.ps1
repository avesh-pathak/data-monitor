$ErrorActionPreference = 'SilentlyContinue'

$name = 'Wi-Fi'

while ($true) {
    $stats = Get-NetAdapterStatistics -Name $name
    if (-not $stats) {
        $up = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
        if ($up) {
            $name = $up.Name
            $stats = Get-NetAdapterStatistics -Name $name
        }
    }

    if ($stats) {
        $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        Write-Output ("{0} {1} {2}" -f $ms, $stats.ReceivedBytes, $stats.SentBytes)
    }

    Start-Sleep -Milliseconds 1000
}
