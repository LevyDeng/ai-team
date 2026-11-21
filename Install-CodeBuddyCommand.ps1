param([switch]$NoUserPath)

$ErrorActionPreference = 'Stop'
$relayRoot = $PSScriptRoot
$relayNode = (Get-Command node.exe -ErrorAction Stop).Source
$relayEntry = Join-Path $relayRoot '.runtime\workbench\agents\codebuddy\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy'
if (-not (Test-Path -LiteralPath $relayEntry -PathType Leaf)) {
    Push-Location -LiteralPath $relayRoot
    try {
        & $relayNode -e "require('./desktop/workbench/vendor-install.cjs').install('codebuddy').then(v=>console.log('Installed CodeBuddy '+v.version)).catch(e=>{console.error(e.message);process.exitCode=1})"
        if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy installation failed.' }
    } finally { Pop-Location }
}
$relayCommandDir = Join-Path $relayRoot 'bin'
$relayCommand = Join-Path $relayCommandDir 'codebuddy.cmd'
if (-not (Test-Path -LiteralPath $relayCommand -PathType Leaf)) { throw 'The Relay Desk command wrapper is missing.' }
& $relayCommand --version
if ($LASTEXITCODE -ne 0) { throw 'CodeBuddy version check failed.' }
if (-not $NoUserPath) {
    $relayEnvironmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $relayOriginalPath = [string]$relayEnvironmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $relayPathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($relayEnvironmentKey.GetValueNames() -contains 'Path') { $relayPathKind = $relayEnvironmentKey.GetValueKind('Path') }
        $relayNormalizedDir = $relayCommandDir.TrimEnd('\')
        $relayAlreadyAdded = @($relayOriginalPath.Split(';') | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $relayNormalizedDir }).Count -gt 0
        if (-not $relayAlreadyAdded) {
            $relayNewPath = $relayOriginalPath.TrimEnd(';')
            if ($relayNewPath) { $relayNewPath += ';' }
            $relayNewPath += $relayCommandDir
            $relayEnvironmentKey.SetValue('Path', $relayNewPath, $relayPathKind)
            Write-Output "Added to user PATH: $relayCommandDir"
        } else { Write-Output 'The command directory is already in user PATH.' }
    } finally { $relayEnvironmentKey.Dispose() }
    if (-not ('RelayCommandEnvironment' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayCommandEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr parameter, string setting, uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $relayBroadcastResult = [UIntPtr]::Zero
    [void][RelayCommandEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$relayBroadcastResult)
}
if (-not (@($env:Path.Split(';') | Where-Object { $_.TrimEnd('\') -ieq $relayCommandDir.TrimEnd('\') }).Count)) { $env:Path += ';' + $relayCommandDir }
Write-Output 'CodeBuddy is ready. Open a new terminal and run: codebuddy'
Write-Output 'Sign in with the same account and region as WorkBuddy. No API key is required for account login.'
