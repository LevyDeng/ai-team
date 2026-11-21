[CmdletBinding()]
param([switch]$Check, [switch]$ServiceOnly, [switch]$ForceControl, [int]$PreferredLocalPort = 0)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Env.ps1')
. (Join-Path $PSScriptRoot 'Ports.ps1')
$service = $null
$instanceLock = $null
$ownsLock = $false
try {
    $values = Read-DotEnv (Join-Path $PSScriptRoot '.env')
    if ($values['WINDOWS_MCP_SECRET'] -cnotmatch '^[a-f0-9]{64}$') {
        throw 'WINDOWS_MCP_SECRET must be 64 hexadecimal characters. Run New-Secret.ps1.'
    }
    $localPort = Get-EnvPort $values 'LOCAL_MCP_PORT'
    if ($PreferredLocalPort -ne 0) {
        if ($PreferredLocalPort -lt 1024 -or $PreferredLocalPort -gt 65535) { throw 'PreferredLocalPort must be between 1024 and 65535.' }
        $localPort = $PreferredLocalPort
    }
    $remotePort = Get-EnvPort $values 'REMOTE_MCP_PORT'
    $sshPort = 0
    if (-not [int]::TryParse($values['SSH_PORT'], [ref]$sshPort) -or $sshPort -lt 1 -or $sshPort -gt 65535) {
        throw 'SSH_PORT must be between 1 and 65535.'
    }
    $target = $values['SSH_TARGET']
    if ($target -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$') {
        throw 'SSH_TARGET must have the form user@host.'
    }
    $uv = (Get-Command uv.exe -ErrorAction Stop).Source
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $sshArgs = @('-N', '-T', '-p', "$sshPort",
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15',
        '-o', 'GatewayPorts=no', '-o', 'StrictHostKeyChecking=ask',
        '-R', "127.0.0.1:${remotePort}:127.0.0.1:${localPort}")
    if ($values['SSH_KEY_PATH']) {
        $keyPath = $values['SSH_KEY_PATH']
        if ($keyPath.StartsWith('~/') -or $keyPath.StartsWith('~\')) {
            $keyPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) $keyPath.Substring(2)
        } elseif (-not [IO.Path]::IsPathRooted($keyPath)) {
            $keyPath = Join-Path $PSScriptRoot $keyPath
        }
        if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'SSH_KEY_PATH does not exist.' }
        $sshArgs += @('-i', $keyPath, '-o', 'IdentitiesOnly=yes')
    }
    $sshArgs += $target
    if ($Check) {
        Write-Host "Configuration OK. Windows: 127.0.0.1:$localPort; server: 127.0.0.1:$remotePort; SSH: ${target}:$sshPort"
        exit 0
    }

    $preferredPort = $localPort
    $selectedPort = $null
    $candidates = @(Get-McpPortCandidates -PreferredPort $preferredPort -Count 20)
    if ($candidates.Count -eq 0) { throw 'No available local MCP ports were found.' }
    Write-Host "Available local MCP candidates: $($candidates -join ', ')."
    foreach ($candidate in $candidates) {
        $instanceLock = New-Object Threading.Mutex($false, "Local\WindowsMcpLauncher-$candidate")
        try { $ownsLock = $instanceLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsLock = $true }
        if ($ownsLock) {
            $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $candidate)
            $listener.Server.ExclusiveAddressUse = $true
            try {
                $listener.Start()
                $selectedPort = $candidate
            } catch {
                $socketError = $_.Exception
                while ($socketError.InnerException) { $socketError = $socketError.InnerException }
                if ($socketError -isnot [Net.Sockets.SocketException] -or
                    $socketError.SocketErrorCode -notin @([Net.Sockets.SocketError]::AddressAlreadyInUse, [Net.Sockets.SocketError]::AccessDenied)) { throw }
            } finally { $listener.Stop() }
            if ($null -ne $selectedPort) { break }
            $instanceLock.ReleaseMutex()
            $ownsLock = $false
        }
        $instanceLock.Dispose()
        $instanceLock = $null
        Write-Host "Local candidate $candidate became unavailable. Trying the next candidate."
    }
    if ($null -eq $selectedPort) { throw 'All local MCP candidates became unavailable. Retry to refresh the available port list.' }
    $localPort = $selectedPort
    $forwardIndex = [Array]::IndexOf($sshArgs, '-R')
    $sshArgs[$forwardIndex + 1] = "127.0.0.1:${remotePort}:127.0.0.1:${localPort}"
    Write-Host "MCP_PORT=$localPort"
    . (Join-Path $PSScriptRoot 'ProcessLifetime.ps1')

    $logs = Join-Path $PSScriptRoot 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime\cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.runtime\python'
    $env:UV_PYTHON_BIN_DIR = Join-Path $PSScriptRoot '.runtime\bin'
    $env:UV_TOOL_DIR = Join-Path $PSScriptRoot '.runtime\tools'
    $env:WINDOWS_MCP_AUTH_KEY = $values['WINDOWS_MCP_SECRET']
    $env:ANONYMIZED_TELEMETRY = 'false'
    $env:PYTHONUTF8 = '1'
    # An explicit empty config prevents unrelated per-user settings from overriding this launcher.
    $configPath = Join-Path $PSScriptRoot ".runtime\server-$localPort.toml"
    New-Item -ItemType Directory -Path (Split-Path $configPath) -Force | Out-Null
    [IO.File]::WriteAllText($configPath, "[server]`n", (New-Object Text.UTF8Encoding($false)))
    # This fixed upstream commit supplies the desktop-control switch missing from PyPI 0.8.8.
    $packageSource = 'git+https://github.com/CursorTouch/Windows-MCP.git@cef52ec47429f22ac3232c112d8f002ac7cb50b1'
    $serviceArgs = @('tool', 'run', '--python', '3.14', '--from', $packageSource,
        'windows-mcp', 'serve', '--config', ('"' + $configPath + '"'),
        '--transport', 'streamable-http', '--stateless-http', '--host', '127.0.0.1', '--port', "$localPort")
    if ($ForceControl) { $serviceArgs += '--no-control' } else { $serviceArgs += '--control' }
    Write-Host 'Starting Windows-MCP. First run downloads Python and dependencies; this can take several minutes.'
    $service = Start-Process -FilePath $uv -ArgumentList $serviceArgs -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "mcp-$localPort.out.log") `
        -RedirectStandardError (Join-Path $logs "mcp-$localPort.err.log")
    Remove-Item Env:\WINDOWS_MCP_AUTH_KEY

    $url = "http://127.0.0.1:$localPort/mcp"
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($service.HasExited) { throw "Windows-MCP exited. See logs\mcp-$localPort.err.log." }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2 | Out-Null
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) {
                $ready = $true
                break
            }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw "Timed out waiting for the authenticated MCP service. See logs\mcp-$localPort.err.log." }
    Write-Host "Windows-MCP is ready at $url (Bearer authentication enabled)."
    if ($ServiceOnly) {
        Write-Host 'MCP_READY'
        while (-not $service.HasExited) { Start-Sleep -Seconds 1 }
        throw "Windows-MCP exited. See logs\mcp-$localPort.err.log."
    }
    Write-Host "Opening SSH reverse tunnel to ${target}:$sshPort. Enter your SSH password if prompted."
    Write-Host "Claude endpoint on the server: http://127.0.0.1:$remotePort/mcp"
    Write-Host 'Keep this window open. Press Ctrl+C or close it to stop both processes.'
    while (-not $service.HasExited) {
        & $ssh @sshArgs
        if ($service.HasExited) { break }
        Write-Host "SSH disconnected (exit $LASTEXITCODE). Retrying in 5 seconds."
        Start-Sleep -Seconds 5
    }
    throw "Windows-MCP exited. See logs\mcp-$localPort.err.log."
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($service -and -not $service.HasExited) {
        Stop-Process -InputObject $service -Force -ErrorAction SilentlyContinue
    }
    if ($ownsLock) { $instanceLock.ReleaseMutex() }
    if ($instanceLock) { $instanceLock.Dispose() }
}

