[CmdletBinding()]
param(
    [string]$Server,
    [ValidateRange(1, 65535)][int]$Port = 22,
    [string]$AdminUser = 'root',
    [string]$AppUser,
    [string]$KeyPath,
    [switch]$ExistingServer,
    [switch]$SkipDependencies,
    [switch]$SkipLogin,
    [switch]$NoShortcut,
    [switch]$NoLaunch,
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Env.ps1')
$utf8 = New-Object Text.UTF8Encoding($false)
$stageName = '.relay-setup-' + [Guid]::NewGuid().ToString('N')
$localStage = $null
$remoteUploaded = $false
$stage = 'preflight'

function Invoke-Native {
    param([string]$File, [string[]]$Arguments)
    # Serialize argv explicitly: Windows PowerShell 5.1 otherwise drops empty arguments
    # and embedded quotes in remote shell commands. Children inherit this console.
    $quoted = foreach ($argument in $Arguments) {
        $escaped = [regex]::Replace($argument, '(\\*)"', '${1}${1}\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '${1}${1}')
        '"' + $escaped + '"'
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command $File -ErrorAction Stop).Source
    $info.Arguments = $quoted -join ' '
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($info)
    try { $process.WaitForExit(); return $process.ExitCode } finally { $process.Dispose() }
}

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    $code = Invoke-Native $File $Arguments
    if ($code -ne 0) { throw "$File failed with exit code $code during $stage." }
}

function Update-ProcessPath {
    $paths = @($env:Path, [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
        (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local\bin'))
    $env:Path = ($paths | Where-Object { $_ }) -join ';'
}

function Ensure-Command {
    param([string]$Name, [string]$Package)
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
    if ($SkipDependencies) { throw "Missing $Name. Install $Package, or rerun without -SkipDependencies." }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "Install Microsoft App Installer (winget), or manually install $Package, then rerun setup."
    }
    Invoke-Checked 'winget.exe' @('install', '--exact', '--id', $Package, '--source', 'winget',
        '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
    Update-ProcessPath
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Package installed but $Name is unavailable. Reopen setup to refresh PATH." }
}

function Write-Settings {
    param([string]$Path, [hashtable]$Changes)
    $original = [IO.File]::ReadAllText($Path)
    $lines = foreach ($line in ($original -split '\r?\n')) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $Changes.ContainsKey($Matches[1])) {
            $name = $Matches[1]
            "$name=$($Changes[$name])"
            $Changes.Remove($name)
        } else { $line }
    }
    $text = ($lines -join "`r`n").TrimEnd() + "`r`n"
    foreach ($name in $Changes.Keys) { $text += "$name=$($Changes[$name])`r`n" }
    [IO.File]::WriteAllText($Path, $text, $utf8)
}

try {
    if ($Plan) {
        Write-Host @'
Plan only: no files, keys, accounts, packages, or connections will be changed.
1. Check Windows OpenSSH, Node.js 24+, Git, and uv; install missing packages with winget.
2. Reuse a matching .env, or create it with a random 64-character MCP secret.
3. Reuse the selected SSH key, or create a dedicated passwordless Ed25519 key.
4. Manually verify the VPS host fingerprint and enter the initial admin password if needed.
5. On a fresh VPS, install Docker/Python/tmux and create the non-root app user.
6. Verify key login and reverse forwarding; install server scripts and the Claude image.
7. Prepare the local MCP and Electron dependencies. Complete Claude OAuth manually.
8. Save a secret-free result, create a shortcut, and open ai-team.
ExistingServer skips admin provisioning. SkipLogin leaves authentication pending.
ai-team still requires Connect & start and an explicit conversation connection.
'@
        exit 0
    }
    Write-Host 'ai-team setup. Read docs/SETUP.md before continuing. Close ai-team while provisioning.'
    Write-Host 'Account registration, payment, host fingerprint verification, and Claude OAuth are manual steps.'
    $envPath = Join-Path $PSScriptRoot '.env'
    $pendingPath = Join-Path $PSScriptRoot '.runtime\setup-pending.json'
    $values = @{}
    $pending = $null
    if (Test-Path -LiteralPath $pendingPath) { $pending = [IO.File]::ReadAllText($pendingPath) | ConvertFrom-Json }
    if (Test-Path -LiteralPath $envPath) { $values = Read-DotEnv $envPath }
    if (-not $Server -and $values['SSH_TARGET'] -and $values['SSH_TARGET'] -notlike '*your-server.example') {
        $answer = Read-Host "Continue using existing configuration for $($values['SSH_TARGET'])? [Y/n]"
        if ($answer -and $answer -notmatch '^(y|yes)$') { throw 'Use a separate project folder for another server; the existing .env was preserved.' }
        if ($values['SSH_TARGET'] -notmatch '^([a-zA-Z0-9_][a-zA-Z0-9_.-]*)@([a-zA-Z0-9][a-zA-Z0-9.-]*)$') { throw 'Invalid existing SSH_TARGET.' }
        $AppUser = $Matches[1]
        $Server = $Matches[2]
        $Port = [int]$values['SSH_PORT']
        $ExistingServer = $true
        if ($pending -and $pending.target -eq $values['SSH_TARGET'] -and $pending.port -eq $Port -and -not $PSBoundParameters.ContainsKey('ExistingServer')) {
            $ExistingServer = $false
            $AdminUser = $pending.adminUser
            Write-Host 'Resuming the previous fresh-server bootstrap.'
        }
    }
    if (-not $Server) {
        $Server = Read-Host 'VPS IPv4 address or hostname (no user@ prefix)'
        if (-not $PSBoundParameters.ContainsKey('Port')) {
            $enteredPort = Read-Host 'SSH port [22]'
            if ($enteredPort) { $Port = [int]$enteredPort }
        }
        if (-not $ExistingServer -and -not $PSBoundParameters.ContainsKey('AdminUser')) {
            $enteredAdmin = Read-Host 'Initial administrator [root]'
            if ($enteredAdmin) { $AdminUser = $enteredAdmin }
        }
        if (-not $AppUser) {
            $enteredUser = Read-Host 'Daily application account [relay]'
            if ($enteredUser) { $AppUser = $enteredUser }
        }
    }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'SSH port must be between 1 and 65535.' }
    if ($Server -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$' -or $Server -like '*.example') { throw 'Enter your real VPS hostname or IPv4 address.' }
    if (-not $AppUser) { $AppUser = 'relay' }
    foreach ($account in @($AdminUser, $AppUser)) {
        if ($account -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Account names must use lowercase letters, digits, underscore, or hyphen.' }
    }
    if ($AppUser -eq 'root') { throw 'Choose a non-root daily application account with -AppUser.' }
    $target = "$AppUser@$Server"
    if ($values['SSH_TARGET'] -and $values['SSH_TARGET'] -ne 'relay@your-server.example' -and
        ($values['SSH_TARGET'] -ne $target -or [int]$values['SSH_PORT'] -ne $Port)) {
        throw 'The existing .env points to a different destination. Use a separate project folder; it has not been overwritten.'
    }
    Write-Host "Destination: ${target}:$Port. Admin provisioning: $(-not $ExistingServer)."
    if (-not $ExistingServer) {
        Write-Host 'This installs server packages and grants Docker access (root-equivalent) to the app user.'
        if ((Read-Host 'Proceed with this destination? [y/N]') -notmatch '^(y|yes)$') { throw 'Setup canceled before changes.' }
    }

    Update-ProcessPath
    foreach ($command in @('ssh.exe', 'scp.exe', 'ssh-keygen.exe')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw 'Install Windows OpenSSH Client in Optional Features, then rerun setup. See docs/SETUP.md.'
        }
    }
    $stage = 'Windows dependencies'
    Ensure-Command 'node.exe' 'OpenJS.NodeJS.LTS'
    $nodeMajor = & node.exe -p 'parseInt(process.versions.node)'
    if ($LASTEXITCODE -ne 0 -or [int]$nodeMajor -lt 24) { throw 'Install Node.js 24 LTS or newer, then reopen setup.' }
    Ensure-Command 'git.exe' 'Git.Git'
    Ensure-Command 'uv.exe' 'astral-sh.uv'
    if (-not $KeyPath) { $KeyPath = $values['SSH_KEY_PATH'] }
    if (-not $KeyPath) { $KeyPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\relay_desk_ed25519' }
    if ($KeyPath -match '^~[/\\]') { $KeyPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) $KeyPath.Substring(2) }
    $KeyPath = [IO.Path]::GetFullPath($KeyPath)
    if ($KeyPath -match '[\r\n"\x00]') { throw 'Unsupported key path.' }
    $stage = 'SSH key and local settings'
    if (-not (Test-Path -LiteralPath $KeyPath)) {
        if (Test-Path -LiteralPath ($KeyPath + '.pub')) { throw 'A public key exists without its private key. Recover the original key or select a new -KeyPath.' }
        New-Item -ItemType Directory -Path (Split-Path $KeyPath) -Force | Out-Null
        Write-Host 'Creating a dedicated key without a passphrase for unattended SSH. Keep this private key private.'
        Invoke-Checked 'ssh-keygen.exe' @('-t', 'ed25519', '-f', $KeyPath, '-N', '', '-C', 'ai-team')
    }
    if (-not (Test-Path -LiteralPath ($KeyPath + '.pub'))) { throw 'The selected key needs a matching .pub file.' }
    $publicKey = [IO.File]::ReadAllText($KeyPath + '.pub').Trim()
    if ($publicKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/]+={0,2}(?:\s+[^\r\n]*)?$') { throw 'Invalid public key.' }
    if (-not (Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $envPath }
    if (-not $ExistingServer) {
        New-Item -ItemType Directory -Path (Split-Path $pendingPath) -Force | Out-Null
        [IO.File]::WriteAllText($pendingPath, (@{ target = $target; port = $Port; adminUser = $AdminUser } | ConvertTo-Json), $utf8)
    }
    Write-Settings $envPath @{ SSH_TARGET = $target; SSH_PORT = "$Port"; SSH_KEY_PATH = $KeyPath.Replace('\', '/') }
    $values = Read-DotEnv $envPath
    if (-not $values['WINDOWS_MCP_SECRET']) {
        Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'New-Secret.ps1'))
        $values = Read-DotEnv $envPath
    }
    if ($values['WINDOWS_MCP_SECRET'] -cnotmatch '^[a-f0-9]{64}$') { throw 'Existing MCP secret is invalid. Restore .env; setup will not rotate it.' }
    $localPort = Get-EnvPort $values 'LOCAL_MCP_PORT'
    $remotePort = Get-EnvPort $values 'REMOTE_MCP_PORT'
    $maxSessions = 0
    if (-not [int]::TryParse($values['MAX_DESKTOP_SESSIONS'], [ref]$maxSessions) -or $maxSessions -lt 1 -or $maxSessions -gt 8) { throw 'MAX_DESKTOP_SESSIONS must be 1 through 8.' }
    $sshOptions = @('-p', "$Port", '-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20')

    $stage = 'VPS bootstrap'
    if (-not $ExistingServer) {
        Write-Host 'Verify the SSH fingerprint against the VPS console/provider before accepting it. Enter the admin password only at the SSH prompt.'
        $bootstrap = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'server\bootstrap-ubuntu-vps.sh')).Replace("`r`n", "`n")
        $scriptData = [Convert]::ToBase64String($utf8.GetBytes($bootstrap))
        $keyData = [Convert]::ToBase64String($utf8.GetBytes($publicKey + "`n"))
        # Only fixed script bytes, validated account names, and public key bytes enter the remote command.
        $bootstrapCommand = 'set -eu; umask 077; stage=$(mktemp -d); trap ''rm -f -- "$stage/bootstrap.sh" "$stage/key.pub"; rmdir -- "$stage"'' EXIT; ' +
            "printf '%s' '$scriptData' | base64 -d > " + '"$stage/bootstrap.sh"; ' +
            "printf '%s' '$keyData' | base64 -d > " + '"$stage/key.pub"; '
        $elevation = if ($AdminUser -eq 'root') { '' } else { 'sudo ' }
        $bootstrapCommand += $elevation + 'bash "$stage/bootstrap.sh" ' + $AppUser + ' "$stage/key.pub"'
        Invoke-Checked 'ssh.exe' @('-tt', '-p', "$Port", '-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=20', "$AdminUser@$Server", $bootstrapCommand)
    } else {
        Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Setup-Ssh.ps1'), '-KeyPath', $KeyPath)
    }
    Invoke-Checked 'ssh.exe' ($sshOptions + @($target, 'test "$(id -u)" -ne 0 && docker info >/dev/null && command -v python3 && command -v tmux'))
    $stage = 'SSH reverse forwarding check'
    Invoke-Checked 'ssh.exe' ($sshOptions + @('-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:0:127.0.0.1:1', $target, 'true'))

    $stage = 'server deployment'
    $localStage = Join-Path $PSScriptRoot ('.runtime\' + $stageName)
    New-Item -ItemType Directory -Path $localStage -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'server') -File | Where-Object {
        $_.Extension -in @('.sh', '.py', '.json', '.conf') -or $_.Name -in @('Dockerfile', 'Codex.Dockerfile', '.dockerignore')
    } | ForEach-Object {
        [IO.File]::WriteAllText((Join-Path $localStage $_.Name), [IO.File]::ReadAllText($_.FullName).Replace("`r`n", "`n"), $utf8)
    }
    $serverEnv = "WINDOWS_MCP_SECRET=$($values['WINDOWS_MCP_SECRET'])`nLOCAL_MCP_PORT=$localPort`nREMOTE_MCP_PORT=$remotePort`nMAX_DESKTOP_SESSIONS=$maxSessions`n"
    [IO.File]::WriteAllText((Join-Path $localStage 'server.env'), $serverEnv, $utf8)
    Invoke-Checked 'ssh.exe' ($sshOptions + @($target, "umask 077; mkdir -- ~/$stageName"))
    $remoteUploaded = $true
    $scpOptions = @('-P', "$Port", '-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes')
    foreach ($file in (Get-ChildItem -LiteralPath $localStage -File)) {
        Invoke-Checked 'scp.exe' ($scpOptions + @($file.FullName, "${target}:${stageName}/$($file.Name)"))
    }
    Invoke-Checked 'ssh.exe' ($sshOptions + @($target, "bash ~/$stageName/provision-relay.sh"))

    $stage = 'local runtime preparation'
    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot '.runtime\cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $PSScriptRoot '.runtime\python'
    $env:UV_PYTHON_BIN_DIR = Join-Path $PSScriptRoot '.runtime\bin'
    $env:UV_TOOL_DIR = Join-Path $PSScriptRoot '.runtime\tools'
    Invoke-Checked 'uv.exe' @('tool', 'run', '--python', '3.14', '--from', 'git+https://github.com/CursorTouch/Windows-MCP.git@cef52ec47429f22ac3232c112d8f002ac7cb50b1', 'windows-mcp', '--help')
    Invoke-Checked 'node.exe' @((Join-Path $PSScriptRoot 'desktop\start.cjs'), '--prepare-only')
    Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Start-WindowsMcp.ps1'), '-Check')

    $stage = 'Claude authentication'
    $authState = 'pending'
    if (-not $SkipLogin) {
        $authCode = Invoke-Native 'ssh.exe' ($sshOptions + @($target, 'bash ~/windows-mcp/start-claude-container.sh --auth-status >/dev/null 2>&1'))
        if ($authCode -ne 0) {
            Write-Host 'Open the Claude login URL in your browser, verify the correct account, and finish OAuth. Never send the authorization code to anyone.'
            Invoke-Checked 'ssh.exe' ($sshOptions + @('-tt', $target, 'bash ~/windows-mcp/start-claude-container.sh --login'))
        }
        Invoke-Checked 'ssh.exe' ($sshOptions + @($target, 'bash ~/windows-mcp/start-claude-container.sh --auth-status >/dev/null'))
        $authState = 'local-status-confirmed'
    }
    if (-not $NoShortcut) { Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Create-DesktopShortcut.ps1')) }
    $result = @{ checkedAt = [DateTime]::UtcNow.ToString('o'); target = $target; sshPort = $Port;
        serverAndRuntimeReady = $true; claudeAuth = $authState; desktopMcpConnection = 'not-yet-tested'; inference = 'not-tested' }
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot '.runtime\setup-status.json'), ($result | ConvertTo-Json), $utf8)
    if (Test-Path -LiteralPath $pendingPath) { Remove-Item -LiteralPath $pendingPath -Force }
    Write-Host "Runtime and server are ready. Claude authentication: $authState."
    Write-Host 'In ai-team: Connect & start, set project folders, then Establish connection. Send one small test task to verify actual account access and Windows-MCP.'
    if (-not $NoLaunch) { Invoke-Checked 'node.exe' @((Join-Path $PSScriptRoot 'desktop\start.cjs')) }
} catch {
    Write-Host "Setup stopped at [$stage]: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Existing secrets, private keys, and conversation history are not removed. Fix the reported issue and rerun setup.'
    exit 1
} finally {
    # Cleanup only the unique upload directory created by this invocation, never project/history folders.
    if ($remoteUploaded) {
        try {
            $cleanupCode = Invoke-Native 'ssh.exe' ($sshOptions + @($target, "find ~/$stageName -maxdepth 1 -type f -delete && rmdir -- ~/$stageName"))
            if ($cleanupCode -ne 0) { Write-Warning "Remove the private upload directory ~/$stageName on the server after connectivity returns." }
        } catch { Write-Warning "Could not remove ~/$stageName on the server after connectivity was lost." }
    }
    if ($localStage -and (Test-Path -LiteralPath $localStage)) {
        Get-ChildItem -LiteralPath $localStage -File | Remove-Item -Force
        Remove-Item -LiteralPath $localStage -Force
    }
}
