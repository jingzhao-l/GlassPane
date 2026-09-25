# glasspane-harness one-click installer (Windows PowerShell)
#
#   irm https://raw.githubusercontent.com/jingzhao-l/glasspane-harness/main/scripts/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-Version 0.1.0]
#
# Mirrors scripts/install.sh: npm first, GitHub release asset as fallback, verify,
# then the GlassPane-specific next steps. Identity is the same product.json truth
# the POSIX installer uses; harness/tools/product-surface.mjs keeps the URLs in step.
$ErrorActionPreference = "Stop"

$Product = "glasspane-harness"
$Repo = "jingzhao-l/glasspane-harness"
$ReleaseBase = "https://github.com/$Repo/releases/download"
$Version = $null
$DryRun = $false
$NpmPackage = if ($env:GLASSPANE_HARNESS_NPM) { $env:GLASSPANE_HARNESS_NPM } else { $Product }
$InstallRoot = if ($env:GLASSPANE_HARNESS_HOME) { $env:GLASSPANE_HARNESS_HOME } else { Join-Path $HOME ".glasspane-harness" }

foreach ($arg in $args) {
  switch -Regex ($arg) {
    "^-DryRun$" { $DryRun = $true }
    "^-Version$" { $Version = $env:GLASSPANE_HARNESS_VERSION }
    "^-Version=(.*)$" { $Version = $Matches[1] }
    default { Write-Error "Unknown argument: $arg (try -?)" }
  }
}
if ($env:GLASSPANE_HARNESS_VERSION -and -not $Version) { $Version = $env:GLASSPANE_HARNESS_VERSION }

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Blue }
function Info($text) { Write-Host "[INFO]  $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "[OK]    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "[WARN]  $text" -ForegroundColor Yellow }

Write-Host ""
Write-Host "┌───────────────────────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "│  GlassPane Harness (Windows)                                │" -ForegroundColor Cyan
Write-Host "│  evidence-honest GUI verification for macOS apps           │" -ForegroundColor Cyan
Write-Host "└───────────────────────────────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""

Step "Detecting platform"
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "arm64" }
$platform = "windows-$arch"
Info "platform: win32 / $arch"
$npmSpec = if ($Version) { "$NpmPackage@$Version" } else { $NpmPackage }

Step "Install plan"
Info "1) npm:  $npmSpec        (preferred: platform selection and updates are npm's job)"
Info "2) release asset fallback: $ReleaseBase (latest release resolved at install time)"
Info "   install root (fallback path only): $(Join-Path $InstallRoot 'bin')"
if ($DryRun) { Ok "dry run — nothing was installed."; exit 0 }

$installedVia = ""
Step "Installing via npm"
if (Get-Command npm -ErrorAction SilentlyContinue) {
  try {
    npm install -g $npmSpec
    if ($LASTEXITCODE -eq 0) { $installedVia = "npm ($npmSpec)" }
  } catch { Warn "npm install failed ($($_.Exception.Message)) — falling back to the release asset" }
} else {
  Warn "npm not found on PATH — using the GitHub release asset instead"
}

if (-not $installedVia) {
  Step "Installing from the GitHub release asset"
  if (-not $Version) {
    $release = Invoke-RestMethod -Headers @{ "User-Agent" = $Product } -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Version = $release.tag_name.TrimStart("v")
    Info "latest release: v$Version"
  }
  $asset = "$Product-$platform-$Version.zip"
  $url = "$ReleaseBase/v$Version/$asset"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Info "downloading $url"
  $zip = Join-Path $tmp $asset
  Invoke-WebRequest -Uri $url -OutFile $zip
  $bin = Join-Path $InstallRoot "bin"
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Expand-Archive -Path $zip -DestinationPath $bin -Force
  $installedVia = "release asset ($asset)"
}

Step "Verifying"
$cmd = Get-Command $Product -ErrorAction SilentlyContinue
$binPath = if ($cmd) { $cmd.Source } else { Join-Path $InstallRoot "bin\$Product.exe" }
if (-not (Test-Path $binPath)) {
  Write-Error "$Product is not on PATH after install (installed via $installedVia)"
  exit 1
}
$versionOut = & $binPath --version 2>&1 | Select-Object -First 1
Ok "installed via $installedVia"
Ok "$Product --version -> $versionOut"

Step "Next steps"
Write-Host "1. The gp_* tool surface talks to the GlassPane engine (macOS): on Windows the"
Write-Host "   harness runs as a client against a macOS host — see FORK.md."
Write-Host "2. Start: $Product    One-shot: $Product run `"your task`""
Write-Host "Docs: https://github.com/$Repo#readme"
