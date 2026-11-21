$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'Env.ps1')
$utf8 = New-Object Text.UTF8Encoding($false)
$folder = Join-Path $root ('.runtime\setup-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder -Force | Out-Null
try {
    $parseErrors = $null
    $parseTokens = $null
    $syntax = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'Setup-RelayDesk.ps1'), [ref]$parseTokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'Installer syntax errors.' }
    # Load only pure helpers; never execute installation or connect to a server.
    foreach ($name in @('Invoke-Native', 'Write-Settings')) {
        $definition = $syntax.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        Invoke-Expression $definition.Extent.Text
    }

    $argvFile = Join-Path $folder 'argv.json'
    $expected = @('', 'path with spaces', 'trailing\', 'double"quote', "single'quote", '$(literal)', 'set -eu; printf "%s" "$HOME"')
    $script = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))"
    $code = Invoke-Native 'node.exe' (@('-e', $script, $argvFile) + $expected)
    if ($code -ne 0) { throw 'Native argv child failed.' }
    $actual = [IO.File]::ReadAllText($argvFile) | ConvertFrom-Json
    if ($actual.Count -ne $expected.Count) { throw 'Native argv count changed.' }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($actual[$index] -cne $expected[$index]) { throw "Native argument $index changed." }
    }
    Write-Output 'PASS: native arguments preserve empty strings, quoting, spaces, and literal shell text.'

    $key = Join-Path $folder 'test key'
    $code = Invoke-Native 'ssh-keygen.exe' @('-q', '-t', 'ed25519', '-f', $key, '-N', '', '-C', 'installer-test-only')
    if ($code -ne 0 -or -not (Test-Path -LiteralPath ($key + '.pub'))) { throw 'Dedicated key generation failed.' }
    Write-Output 'PASS: real Ed25519 generation works with an empty passphrase and a spaced path.'

    $settings = Join-Path $folder 'settings.env'
    $secret = 'a' * 64
    [IO.File]::WriteAllText($settings, "# Keep this comment`nWINDOWS_MCP_SECRET=$secret`nSSH_TARGET=old@example.invalid`nCUSTOM_SETTING=keep`n", $utf8)
    Write-Settings $settings @{ SSH_TARGET = 'relay@new.example.invalid'; SSH_PORT = '2222' }
    $values = Read-DotEnv $settings
    if ($values['WINDOWS_MCP_SECRET'] -ne $secret -or $values['CUSTOM_SETTING'] -ne 'keep' -or
        $values['SSH_TARGET'] -ne 'relay@new.example.invalid' -or $values['SSH_PORT'] -ne '2222') { throw 'Settings preservation failed.' }
    if (-not [IO.File]::ReadAllText($settings).StartsWith('# Keep this comment')) { throw 'Settings comment lost.' }
    Write-Output 'PASS: settings updates preserve the secret, comments, and unrelated values.'

    $planFolder = Join-Path $folder 'plan'
    New-Item -ItemType Directory -Path $planFolder | Out-Null
    foreach ($name in @('Setup-RelayDesk.ps1', 'Env.ps1')) { Copy-Item -LiteralPath (Join-Path $root $name) -Destination $planFolder }
    $before = @(Get-ChildItem -LiteralPath $planFolder -Recurse -File).Count
    $code = Invoke-Native 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $planFolder 'Setup-RelayDesk.ps1'), '-Plan')
    if ($code -ne 0 -or @(Get-ChildItem -LiteralPath $planFolder -Recurse -File).Count -ne $before) { throw 'Plan changed an empty installation.' }
    Write-Output 'PASS: plan succeeds in an unconfigured project without creating settings, keys, or runtime files.'
} finally {
    # Every deleted path is a child of this invocation's unique test directory.
    Get-ChildItem -LiteralPath $folder -Recurse -File | Remove-Item -Force
    $planFolder = Join-Path $folder 'plan'
    if (Test-Path -LiteralPath $planFolder) { Remove-Item -LiteralPath $planFolder -Force }
    Remove-Item -LiteralPath $folder -Force
}
