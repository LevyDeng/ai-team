function Get-McpPortCandidates {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$PreferredPort,
        [ValidateRange(1, 100)][int]$Count = 20
    )

    $occupied = New-Object 'Collections.Generic.HashSet[int]'
    foreach ($endpoint in [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
        [void]$occupied.Add($endpoint.Port)
    }
    $excluded = @()
    $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
    try {
        $ranges = & $netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in $ranges) {
                if ($line -match '^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$') {
                    $excluded += ,@([int]$Matches[1], [int]$Matches[2])
                }
            }
        }
    } catch {
        # The bind check below remains authoritative if exclusion discovery is unavailable.
        Write-Verbose 'Could not read TCP exclusion ranges; checking availability by binding.'
    }

    $ports = New-Object 'Collections.Generic.List[int]'
    for ($offset = 0; $offset -lt 64512 -and $ports.Count -lt $Count; $offset++) {
        $candidate = 1024 + (($PreferredPort - 1024 + $offset) % 64512)
        if ($occupied.Contains($candidate)) { continue }
        $reserved = $false
        foreach ($range in $excluded) {
            if ($candidate -ge $range[0] -and $candidate -le $range[1]) {
                $reserved = $true
                break
            }
        }
        if ($reserved) { continue }

        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $candidate)
        $listener.Server.ExclusiveAddressUse = $true
        try {
            $listener.Start()
            $ports.Add($candidate)
        } catch {
            $socketError = $_.Exception
            while ($socketError.InnerException) { $socketError = $socketError.InnerException }
            if ($socketError -isnot [Net.Sockets.SocketException] -or
                $socketError.SocketErrorCode -notin @([Net.Sockets.SocketError]::AddressAlreadyInUse, [Net.Sockets.SocketError]::AccessDenied)) { throw }
        } finally { $listener.Stop() }
    }
    return $ports.ToArray()
}
