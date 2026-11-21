[CmdletBinding()]
param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot '.runtime\release\relay-desk-source.zip' }
$stage = Join-Path $PSScriptRoot ('.runtime\release\source-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    # An allowlist excludes machine credentials, caches, transcripts, and unrelated proxy configuration.
    $rootFiles = @('.env.example', '.gitignore', 'Env.ps1', 'Ports.ps1', 'ProcessLifetime.ps1',
        'New-Secret.ps1', 'Setup-Ssh.ps1', 'Setup-RelayDesk.ps1', 'Export-RelayDesk.ps1',
        'Create-DesktopShortcut.ps1', 'Keep-Awake.ps1', 'Start-WindowsMcp.ps1',
        'setup-relay-desk.cmd', 'setup-ssh.cmd', 'relay-desk.cmd', 'relay-desk-classic.cmd', 'claude-desk.cmd', 'relay-desk.vbs', 'start-win-mcp-svr.cmd')
    foreach ($name in $rootFiles) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stage }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'docs\DISTRIBUTION.md') -Destination (Join-Path $stage 'README.md')
    foreach ($folder in @('desktop', 'server', 'docs')) {
        $target = Join-Path $stage $folder
        New-Item -ItemType Directory -Path $target | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $folder) -File | Where-Object {
            $_.Name -ne 'inspect-existing-proxy.py' -and (
                $_.Extension -in @('.cjs', '.js', '.css', '.html', '.json', '.sh', '.py', '.conf', '.md', '.txt') -or
                $_.Name -in @('Dockerfile', 'Codex.Dockerfile', '.dockerignore'))
        } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target }
    }
    $assets = Join-Path $stage 'desktop\assets'
    New-Item -ItemType Directory -Path $assets | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'desktop\assets') -File -Filter 'badge-*.png' |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $assets }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop\assets\role-avatars.png') -Destination $assets
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop\assets\model-avatars') -Destination $assets -Recurse
    $workbenchSource = Join-Path $PSScriptRoot 'desktop\workbench'
    $workbenchTarget = Join-Path $stage 'desktop\workbench'
    Get-ChildItem -LiteralPath $workbenchSource -Recurse -File | Where-Object {
        $_.Extension -in @('.cjs', '.js', '.css', '.html', '.py', '.svg') -or $_.Name -eq 'LICENSE'
    } | ForEach-Object {
        $relative = $_.FullName.Substring($workbenchSource.Length).TrimStart('\')
        $destination = Join-Path $workbenchTarget $relative
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination
    }
    $OutputPath = [IO.Path]::GetFullPath($OutputPath)
    New-Item -ItemType Directory -Path (Split-Path $OutputPath) -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # Opening with CreateNew protects a previous release from accidental replacement.
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $OutputPath)
    Write-Host "Created source-only distribution: $OutputPath"
} finally {
    if (Test-Path -LiteralPath $stage) {
        $stageAbsolute = [IO.Path]::GetFullPath($stage)
        $releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.runtime\release')) + [IO.Path]::DirectorySeparatorChar
        if (-not $stageAbsolute.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase) -or
            (Split-Path $stageAbsolute -Leaf) -notmatch '^source-[a-f0-9]{32}$') { throw 'Unexpected release staging directory.' }
        Remove-Item -LiteralPath $stageAbsolute -Recurse -Force
    }
}
