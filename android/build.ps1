$ErrorActionPreference = 'Stop'

function Invoke-BuildTool {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Build command failed: $Program ($LASTEXITCODE)"
    }
}

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} else {
    Join-Path $env:LOCALAPPDATA 'Android/Sdk'
}
$tools = Join-Path $sdk 'build-tools/36.0.0'
$platform = Join-Path $sdk 'platforms/android-34/android.jar'
if (-not (Test-Path $platform) -or -not (Test-Path (Join-Path $tools 'aapt2.exe'))) {
    throw 'Install Android SDK Platform 34 and Build Tools 36.0.0 first.'
}
$jdk = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin' } else { '' }
$javac = if ($jdk) { Join-Path $jdk 'javac.exe' } else { 'javac.exe' }
$jar = if ($jdk) { Join-Path $jdk 'jar.exe' } else { 'jar.exe' }
$keytool = if ($jdk) { Join-Path $jdk 'keytool.exe' } else { 'keytool.exe' }
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root '.runtime/android'
$work = Join-Path $output ([guid]::NewGuid().ToString())
$generated = Join-Path $work 'generated'
$classes = Join-Path $work 'classes'
$apk = Join-Path $output 'ai-team-LAN.apk'
$keystore = Join-Path $output 'debug.keystore'
$zxing = Join-Path $output 'zxing-core-3.5.3.jar'
$zxingHash = '8D8064C1636FDAEF7189DD9055C7D59950A8940A12F2293956446EC3C109FD82'
New-Item -ItemType Directory -Force $output, $work, $generated, $classes | Out-Null
try {
    if (-not (Test-Path -LiteralPath $zxing) -or (Get-FileHash -LiteralPath $zxing).Hash -ne $zxingHash) {
        $download = Join-Path $work 'zxing-core.jar'
        Invoke-BuildTool 'curl.exe' @('--fail', '--location', '--silent', '--show-error', '--max-time', '120',
            '--output', $download, 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar')
        if ((Get-FileHash -LiteralPath $download).Hash -ne $zxingHash) {
            throw 'ZXing Core checksum mismatch.'
        }
        Copy-Item -LiteralPath $download -Destination $zxing -Force
    }
    $resources = Join-Path $work 'resources.zip'
    $unsigned = Join-Path $work 'unsigned.apk'
    $code = Join-Path $work 'classes.jar'
    $aligned = Join-Path $work 'aligned.apk'
    $signed = Join-Path $work 'signed.apk'
    Invoke-BuildTool (Join-Path $tools 'aapt2.exe') @('compile', '--dir', (Join-Path $PSScriptRoot 'res'), '-o', $resources)
    Invoke-BuildTool (Join-Path $tools 'aapt2.exe') @('link', '-I', $platform, '--manifest',
        (Join-Path $PSScriptRoot 'AndroidManifest.xml'), '--java', $generated, '-o', $unsigned, $resources)
    $sources = Get-ChildItem (Join-Path $PSScriptRoot 'src'), $generated -Recurse -Filter '*.java' |
        ForEach-Object FullName
    Invoke-BuildTool $javac (@('-encoding', 'UTF-8', '--release', '8',
        '-classpath', "$platform;$zxing", '-d', $classes) + $sources)
    Invoke-BuildTool $jar @('cf', $code, '-C', $classes, '.')
    Invoke-BuildTool (Join-Path $tools 'd8.bat') @('--lib', $platform, '--min-api', '23', '--output', $work, $code, $zxing)
    Invoke-BuildTool $jar @('uf', $unsigned, '-C', $work, 'classes.dex')
    Invoke-BuildTool (Join-Path $tools 'zipalign.exe') @('-f', '4', $unsigned, $aligned)
    if (-not (Test-Path $keystore)) {
        Invoke-BuildTool $keytool @('-genkeypair', '-keystore', $keystore, '-storepass', 'android',
            '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048',
            '-validity', '10000', '-dname', 'CN=ai-team Debug')
    }
    $signer = Join-Path $tools 'apksigner.bat'
    Invoke-BuildTool $signer @('sign', '--ks', $keystore, '--ks-pass', 'pass:android',
        '--key-pass', 'pass:android', '--out', $signed, $aligned)
    Invoke-BuildTool $signer @('verify', '--verbose', $signed)
    Copy-Item -LiteralPath $signed -Destination $apk -Force
    Write-Output $apk
} finally {
    $resolvedWork = (Resolve-Path -LiteralPath $work).Path
    $resolvedOutput = (Resolve-Path -LiteralPath $output).Path
    if ($resolvedWork.StartsWith($resolvedOutput + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedWork -Recurse -Force
    }
}
