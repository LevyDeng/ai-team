param([switch]$Classic, [switch]$Both)
$ErrorActionPreference = 'Stop'
$electron = Join-Path $PSScriptRoot 'desktop\node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw 'Run ai-team.cmd once to prepare the desktop runtime.' }
$shortcutHelper = Join-Path $PSScriptRoot 'desktop\create-shortcuts.cjs'
$helperArgs = @($shortcutHelper)
if ($Both) { $helperArgs += '--both' }
elseif ($Classic) { $helperArgs += '--classic' }
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $helperProcess = Start-Process -FilePath $electron -ArgumentList (($helperArgs | ForEach-Object { '"' + $_ + '"' }) -join ' ') -WindowStyle Hidden -Wait -PassThru
    if ($helperProcess.ExitCode -ne 0) { throw 'Shortcut creation failed.' }
    Write-Host 'ai-team desktop shortcut created. Unpin the old taskbar item and pin the app again.'
} finally {
    if ($null -eq $previousRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
}
