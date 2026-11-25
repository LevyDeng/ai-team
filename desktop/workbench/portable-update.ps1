[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Stage', 'Launch', 'Install', 'Recover')][string]$Mode)

$ErrorActionPreference = 'Stop'
$job = $PSScriptRoot
$base = Split-Path -Parent $job
$root = Split-Path -Parent $base
$id = Split-Path -Leaf $job
if ((Split-Path -Leaf $base) -ne '.ai-team-update' -or
    $id -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'Invalid updater directory.' }
$config = Get-Content -LiteralPath (Join-Path $job 'job.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid update version.' }

$package = "ai-team-$($config.version)-win-x64"
$staged = Join-Path $job $package
$backup = Join-Path $job 'previous'
$discard = Join-Path $job 'discarded'
$active = Join-Path $base 'active.json'
$exe = Join-Path $root 'ai-team.exe'
$runtime = Join-Path $root 'resources/app/.runtime/workbench'
$databaseFiles = @('workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm')
$outerFiles = @('ai-team.exe', 'ai-team_wer.dll', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat',
    'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin',
    'v8_context_snapshot.bin', 'version', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll')
$applicationFolders = @('desktop', 'bin', 'docs', 'server', 'android')
$applicationFiles = @('.env.example', 'package.json', 'README.md', 'ai-team.cmd', 'antigravity-login.cmd',
    'claude-desk.cmd', 'codebuddy-login.cmd', 'Create-DesktopShortcut.ps1', 'Env.ps1', 'Export-RelayDesk.ps1',
    'Install-CodeBuddyCommand.ps1', 'Keep-Awake.ps1', 'New-Secret.ps1', 'Ports.ps1', 'ProcessLifetime.ps1',
    'relay-desk.vbs', 'setup-relay-desk.cmd', 'Setup-RelayDesk.ps1', 'setup-ssh.cmd', 'Setup-Ssh.ps1',
    'start-win-mcp-svr.cmd', 'Start-WindowsMcp.ps1')

function Assert-Directory($Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected directory: $Path"
    }
}

function Get-ManagedPath([string[]]$Parts, [bool]$Directory) {
    if ($Parts.Count -eq 1 -and -not $Directory -and $Parts[0] -in $outerFiles) { return $Parts[0] }
    if ($Parts[0] -eq 'locales' -and ($Directory -or $Parts.Count -gt 1)) { return 'locales' }
    if ($Parts[0] -ne 'resources') { throw 'Unexpected file in portable package.' }
    if ($Directory -and ($Parts.Count -eq 1 -or ($Parts.Count -eq 2 -and $Parts[1] -eq 'app'))) { return }
    if ($Parts.Count -lt 3 -or $Parts[1] -ne 'app') { throw 'Unexpected Electron resources.' }
    if (($Parts.Count -eq 3 -and -not $Directory -and $Parts[2] -in $applicationFiles) -or
        ($Parts[2] -in $applicationFolders -and ($Directory -or $Parts.Count -gt 3))) {
        return "resources/app/$($Parts[2])"
    }
    throw 'Unexpected application file in portable package.'
}

function Expand-Package {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $job 'release.zip'))
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $managed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = 0L
    try {
        if ($archive.Entries.Count -gt 100000) { throw 'Too many ZIP entries.' }
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $directory = $name.EndsWith('/')
            $parts = $name.TrimEnd('/').Split('/')
            if ($parts[0] -cne $package) { throw 'The ZIP must contain one versioned portable folder.' }
            foreach ($part in $parts) {
                if ($part -match '[<>:"|?*\x00-\x1f]|[. ]$|^(CON|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:\.|$)|^\.(git|runtime|ai-team-update|env(?!\.example$))(\.|$)|^\.\.?$' -or -not $part) {
                    throw "Invalid ZIP path: $name"
                }
            }
            if ($parts.Count -eq 1) {
                if (-not $directory) { throw 'The ZIP root must be a directory.' }
                continue
            }
            if (-not $paths.Add($name.TrimEnd('/'))) { throw 'Duplicate ZIP entry.' }
            $relative = $parts[1..($parts.Count - 1)]
            $owned = Get-ManagedPath $relative $directory
            if ($owned) { [void]$managed.Add($owned) }
            $destination = [IO.Path]::Combine($job, ($parts -join [IO.Path]::DirectorySeparatorChar))
            if (-not [IO.Path]::GetFullPath($destination).StartsWith($staged + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'ZIP entry escapes its staging directory.'
            }
            if ($directory) { [void][IO.Directory]::CreateDirectory($destination); continue }
            $total += $entry.Length
            if ($total -gt 3GB) { throw 'Uncompressed package is too large.' }
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)
        }
    } finally { $archive.Dispose() }
    foreach ($file in @('ai-team.exe', 'resources.pak', 'locales/en-US.pak', 'resources/app/package.json',
        'resources/app/desktop/workbench/main.cjs', 'resources/app/desktop/workbench/portable-update.ps1',
        'resources/app/desktop/package.json')) {
        if (-not [IO.File]::Exists((Join-Path $staged $file))) { throw "Incomplete portable package, missing $file." }
    }
    $shim = Get-Content -LiteralPath (Join-Path $staged 'resources/app/package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $app = Get-Content -LiteralPath (Join-Path $staged 'resources/app/desktop/package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($shim.main -ne 'desktop/workbench/main.cjs' -or $shim.name -ne 'ai-team' -or $app.name -ne 'ai-team' -or
        $app.version -ne $config.version -or $shim.version -ne $config.version) { throw 'Unexpected application version or entry point.' }
    # Promote the executable last and restore it last so it always points to a complete program.
    $managed | Where-Object { $_ -ne 'ai-team.exe' } | Sort-Object | Set-Content -LiteralPath (Join-Path $job 'paths.txt') -Encoding UTF8
    Add-Content -LiteralPath (Join-Path $job 'paths.txt') -Value 'ai-team.exe' -Encoding UTF8
    Remove-Item -LiteralPath (Join-Path $job 'release.zip')
}

function Write-Json($Path, $Value) {
    $temporary = "$Path.tmp"
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Compress))
    $previous = "$Path.previous"
    if ([IO.File]::Exists($Path)) {
        [IO.File]::Replace($temporary, $Path, $previous)
        [IO.File]::Delete($previous)
    } else { [IO.File]::Move($temporary, $Path) }
}

function Move-Entry($Source, $Destination) {
    $item = Get-Item -LiteralPath $Source -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unexpected link: $Source" }
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
    # Windows may keep an executable's image mapped briefly after its process exits.
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ($true) {
        try {
            if ($item.PSIsContainer) { [IO.Directory]::Move($Source, $Destination) }
            else { [IO.File]::Move($Source, $Destination) }
            return
        } catch {
            if ($_.Exception.InnerException -isnot [IO.IOException] -or [DateTime]::UtcNow -ge $deadline) {
                throw "Could not move ${Source}: $_"
            }
            Start-Sleep -Milliseconds 150
        }
    }
}

function Displace-Entry($Path, $Name) {
    if (Test-Path -LiteralPath $Path) { Move-Entry $Path (Join-Path $discard $Name) }
}

function Backup-Database {
    $database = Join-Path $job 'database'
    [void][IO.Directory]::CreateDirectory($database)
    foreach ($name in $databaseFiles) {
        $source = Join-Path $runtime $name
        if ([IO.File]::Exists($source)) { [IO.File]::Copy($source, (Join-Path $database $name)) }
    }
    [IO.File]::WriteAllText((Join-Path $job 'database-saved'), '')
}

function Restore-Update {
    $plan = Join-Path $job 'plan.json'
    if ([IO.File]::Exists($plan)) {
        foreach ($entry in (Get-Content -LiteralPath $plan -Raw -Encoding UTF8 | ConvertFrom-Json)) {
            $name = $entry.name
            if ((Get-ManagedPath ($name.Split('/')) ($name -match '^(locales|resources/app/(desktop|bin|docs|server|android))$')) -ne $name) {
                throw 'Invalid recovery plan.'
            }
            $current = Join-Path $root $name
            $original = Join-Path $backup $name
            if (Test-Path -LiteralPath $original) {
                Displace-Entry $current $name
                Move-Entry $original $current
            } elseif (-not $entry.existed -and -not (Test-Path -LiteralPath (Join-Path $staged $name))) {
                Displace-Entry $current $name
            }
        }
    }
    if ([IO.File]::Exists((Join-Path $job 'database-saved'))) {
        foreach ($name in $databaseFiles) {
            $original = Join-Path (Join-Path $job 'database') $name
            $current = Join-Path $runtime $name
            if ([IO.File]::Exists($original)) { [IO.File]::Copy($original, $current, $true) }
            else { [IO.File]::Delete($current) }
        }
    }
}

function Start-App([string]$Argument) {
    $start = @{ FilePath = $exe; WorkingDirectory = $root; PassThru = $true }
    if ($Argument) { $start.ArgumentList = @($Argument) }
    Start-Process @start
}

function Remove-StagingTree($Path) {
    # Do not follow junctions or symlinks that may be present in a previous dependency tree.
    foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
        if ($child.PSIsContainer) {
            if (-not ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-StagingTree $child.FullName }
            else { [IO.Directory]::Delete($child.FullName) }
        } else { Remove-Item -LiteralPath $child.FullName -Force }
    }
    [IO.Directory]::Delete($Path)
}

if ($Mode -eq 'Stage') { Expand-Package; exit }
if ($Mode -eq 'Launch') {
    # Give the installer its own process and console lifetime before the GUI exits.
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Mode', 'Install')
    $start = @{
        FilePath = Join-Path $PSHOME 'powershell.exe'
        ArgumentList = $arguments
        WindowStyle = 'Hidden'
        WorkingDirectory = $root
    }
    Start-Process @start
    exit
}

Assert-Directory $job
Assert-Directory $base
Assert-Directory (Join-Path $root 'resources')
Assert-Directory (Join-Path $root 'resources/app')
$lock = [IO.File]::Open((Join-Path $base 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
$result = $null
$relaunch = $false
$candidate = $null
$ownsUpdate = $false
try {
    if ($Mode -eq 'Recover') {
        if (-not [IO.File]::Exists($active) -or (Get-Content -LiteralPath $active -Raw | ConvertFrom-Json).id -ne $id) {
            throw 'No matching interrupted update.'
        }
        if ([IO.File]::Exists((Join-Path $job 'accepted'))) { $result = 'installed' }
        else {
            $candidateFile = Join-Path $job 'candidate.json'
            if ([IO.File]::Exists($candidateFile)) {
                $saved = Get-Content -LiteralPath $candidateFile -Raw | ConvertFrom-Json
                $processHandle = Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
                if ($processHandle -and $processHandle.StartTime.ToFileTimeUtc().ToString() -eq $saved.time) {
                    $processHandle.Kill()
                    if (-not $processHandle.WaitForExit(15000)) { throw 'Could not stop the incomplete update.' }
                }
            }
            Restore-Update
            $result = 'rolled-back'
        }
        $relaunch = $true
    } else {
        if ([IO.File]::Exists($active)) { throw 'Another update is active.' }
        $parent = Get-Process -Id $config.parentPid
        if ($parent.Path -ne $exe) { throw 'The requesting app does not match this portable installation.' }
        Write-Json $active @{ id = $id }
        $ownsUpdate = $true
        [IO.File]::WriteAllText((Join-Path $job 'waiting'), '')
        if (-not $parent.WaitForExit(60000)) { throw 'The running app did not exit.' }
        $relaunch = $true
        $exitDeadline = [DateTime]::UtcNow.AddSeconds(6)
        do {
            $other = Get-Process -Name 'ai-team' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
            if (-not $other) { break }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $exitDeadline)
        if ($other) { throw 'Other instances of this portable app are still running.' }
        Backup-Database
        $plan = @(Get-Content -LiteralPath (Join-Path $job 'paths.txt') -Encoding UTF8 | ForEach-Object {
            # Get-Content adds provider properties to strings in Windows PowerShell.
            $name = [string]$_
            @{ name = $name; existed = (Test-Path -LiteralPath (Join-Path $root $name)) }
        })
        Write-Json (Join-Path $job 'plan.json') -Value $plan
        foreach ($entry in $plan) {
            $name = $entry.name
            if ($entry.existed) { Move-Entry (Join-Path $root $name) (Join-Path $backup $name) }
            Move-Entry (Join-Path $staged $name) (Join-Path $root $name)
        }
        $candidate = Start-App "--portable-update=$id"
        Write-Json (Join-Path $job 'candidate.json') @{ pid = $candidate.Id; time = $candidate.StartTime.ToFileTimeUtc().ToString() }
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $ready = Join-Path $job 'ready'
        while (-not $candidate.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            if ([IO.File]::Exists($ready) -and [IO.File]::ReadAllText($ready) -eq [string]$candidate.Id) {
                [IO.File]::WriteAllText((Join-Path $job 'accepted'), '')
                $result = 'installed'
                $relaunch = $false
                break
            }
            Start-Sleep -Milliseconds 150
        }
        if (-not $result) { throw 'The newer app did not finish starting.' }
    }
} catch {
    Add-Content -LiteralPath (Join-Path $base 'last-error.log') -Value "$([DateTime]::UtcNow.ToString('o')) $_" -Encoding UTF8
    if (-not $ownsUpdate) { throw }
    if ($candidate) {
        if (-not $candidate.HasExited) {
            # Stop the candidate's Electron children before replacing its files.
            & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $candidate.Id /T /F 2>&1 | Out-Null
            if (-not $candidate.WaitForExit(15000)) { throw 'Could not stop the incomplete update.' }
        }
        $candidate.Dispose()
    }
    try { Restore-Update }
    catch {
        Add-Content -LiteralPath (Join-Path $base 'last-error.log') -Value "Rollback failed: $_" -Encoding UTF8
        throw
    }
    $result = 'rolled-back'
} finally {
    if ($result) {
        Write-Json (Join-Path $base 'result.json') @{ status = $result; version = $config.version; id = $id }
        [IO.File]::Delete($active)
    }
    $lock.Dispose()
}
if ($relaunch) { [void](Start-App) }
if ($result) {
    try { Remove-StagingTree $job }
    catch { Add-Content -LiteralPath (Join-Path $base 'last-error.log') -Value "Staging cleanup failed: $_" -Encoding UTF8 }
}
