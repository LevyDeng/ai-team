[CmdletBinding()]
param(
    [string]$KeyPath = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\id_ed25519'),
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Env.ps1')
try {
    $envPath = Join-Path $PSScriptRoot '.env'
    $settingsPath = $envPath
    if (-not (Test-Path -LiteralPath $settingsPath)) { $settingsPath = Join-Path $PSScriptRoot '.env.example' }
    $values = Read-DotEnv $settingsPath
    $target = $values['SSH_TARGET']
    $sshPort = 0
    if ($target -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$') {
        throw 'SSH_TARGET must have the form user@host.'
    }
    if (-not [int]::TryParse($values['SSH_PORT'], [ref]$sshPort) -or $sshPort -lt 1 -or $sshPort -gt 65535) {
        throw 'Invalid SSH_PORT.'
    }
    $KeyPath = (Resolve-Path -LiteralPath $KeyPath).ProviderPath
    $publicPath = $KeyPath + '.pub'
    # Read only the public key. The private key stays with the local SSH client.
    $publicText = [IO.File]::ReadAllText($publicPath).Trim()
    if ($publicText -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+/]+={0,2})(?:\s+[^\r\n]*)?$') {
        throw 'Unsupported public key format.'
    }
    $publicKey = $Matches[1] + ' ' + $Matches[2]
    [Convert]::FromBase64String($Matches[2]) | Out-Null
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    if ($Check) {
        Write-Host "Configuration OK. Public key: $publicPath; destination: ${target}:$sshPort"
        exit 0
    }
    & $ssh -p "$sshPort" -i $KeyPath -o 'IdentitiesOnly=yes' -o 'BatchMode=yes' `
        -o 'ConnectTimeout=15' -o 'StrictHostKeyChecking=yes' $target 'true' *> $null
    if ($LASTEXITCODE -ne 0) {
        # Only validated key type/base64 data enter this command. Preserve all existing authorized keys.
        $remoteCommand = "set -eu; umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; grep -Fq -- '$publicKey' ~/.ssh/authorized_keys || printf '\n%s\n' '$publicKey windows-mcp-client' >> ~/.ssh/authorized_keys; printf 'Public key installed.\n'"
        Write-Host "Installing your public key on ${target}:$sshPort. Enter the server password in this window."
        & $ssh -p "$sshPort" -o 'ConnectTimeout=15' -o 'StrictHostKeyChecking=ask' `
            -o 'PreferredAuthentications=keyboard-interactive,password' -o 'PubkeyAuthentication=no' $target $remoteCommand
        if ($LASTEXITCODE -ne 0) { throw 'Public key installation failed. No local configuration was changed.' }
    }

    Write-Host 'Checking that SSH works without a password prompt...'
    & $ssh -p "$sshPort" -i $KeyPath -o 'IdentitiesOnly=yes' -o 'BatchMode=yes' `
        -o 'ConnectTimeout=15' -o 'StrictHostKeyChecking=yes' $target 'printf KEY_AUTH_OK'
    if ($LASTEXITCODE -ne 0) {
        throw 'Key installed, but unattended login failed. If the key has a passphrase, load it into ssh-agent with ssh-add, then retry.'
    }
    if (-not (Test-Path -LiteralPath $envPath)) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $envPath
    }
    $content = [IO.File]::ReadAllText($envPath)
    $setting = 'SSH_KEY_PATH=' + $KeyPath.Replace('\', '/')
    if ($values.ContainsKey('SSH_KEY_PATH')) {
        $content = [regex]::Replace($content, '(?m)^[ \t]*SSH_KEY_PATH[ \t]*=.*$', [Text.RegularExpressions.MatchEvaluator]{ param($match) $setting })
    } else {
        $content = $content.TrimEnd() + "`r`n$setting`r`n"
    }
    [IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
    Write-Host "`nPassword-free SSH verified. SSH_KEY_PATH saved to .env."
    Write-Host 'Server information for checking Claude Code compatibility:'
    & $ssh -p "$sshPort" -i $KeyPath -o 'IdentitiesOnly=yes' -o 'BatchMode=yes' $target `
        'cat /etc/os-release; uname -m; getconf GNU_LIBC_VERSION; free -h'
} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

