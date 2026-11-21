[CmdletBinding()]
param([switch]$Rotate)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Env.ps1')
$envPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $envPath
}
$values = Read-DotEnv $envPath
if ($values['WINDOWS_MCP_SECRET'] -and -not $Rotate) {
    throw 'A secret already exists. Use -Rotate only when you want to replace it on both machines.'
}
$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$secret = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
$content = [IO.File]::ReadAllText($envPath)
if ($values.ContainsKey('WINDOWS_MCP_SECRET')) {
    $content = [regex]::Replace($content, '(?m)^\s*WINDOWS_MCP_SECRET\s*=.*$', "WINDOWS_MCP_SECRET=$secret")
} else {
    $content = $content.TrimEnd() + "`r`nWINDOWS_MCP_SECRET=$secret`r`n"
}
[IO.File]::WriteAllText($envPath, $content, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Saved a cryptographically random 64-character hexadecimal secret to .env.'
Write-Host 'Copy the same .env to the server script directory. The secret was not printed.'

