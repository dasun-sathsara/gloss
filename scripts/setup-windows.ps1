#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Gloss on Windows 11 for the current user.

.DESCRIPTION
    Installs Git and uv when missing, clones the Gloss repository, lets the
    launcher install the latest release, downloads the optional Underdog Woof
    voice, writes the private configuration, creates a desktop shortcut, and
    reports what is left to do in Anki.

    Nothing here needs Administrator rights unless winget asks for them.

.PARAMETER InstallDir
    Where the Gloss checkout lives. Default: %USERPROFILE%\Gloss

.PARAMETER ApiKey
    Text endpoint key. Omit it to be prompted without echo.

.PARAMETER ApiBase
    OpenAI-compatible text endpoint, including /v1.

.PARAMETER WoofVoice
    Local voice, juno or mira.

.PARAMETER DeckParent
    Anki parent deck for generated cards.

.PARAMETER DeckDefault
    Default subdeck under the parent.

.PARAMETER NoLaunch
    Configure everything but do not start Gloss at the end.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
#>
[CmdletBinding()]
param(
    [string] $InstallDir = (Join-Path $HOME 'Gloss'),
    [string] $RepoUrl = 'https://github.com/dasun-sathsara/gloss.git',
    [string] $ApiBase = 'https://dasun-sathsara--cliproxy-api.ap-south.modal.run/v1',
    [string] $ApiKey = '',
    [string] $WoofVoice = 'juno',
    [string] $DeckParent = 'Vocabulary',
    [string] $DeckDefault = 'General',
    [string] $AnkiConnectPort = '8765',
    [switch] $NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string] $Message) {
    Write-Host ''
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Stop-Setup([string] $Message) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) -join ';')
}

function Ensure-Command([string] $Name, [string] $WingetId) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) {
        return
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Stop-Setup 'winget is missing. Update App Installer from the Microsoft Store and run again.'
    }
    Write-Step "Installing $Name"
    winget install --id $WingetId --exact --source winget `
        --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    Update-PathFromRegistry
    foreach ($extra in @(
            (Join-Path $HOME '.local\bin'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')
        )) {
        if ((Test-Path $extra) -and ($env:Path -notlike "*$extra*")) {
            $env:Path = "$extra;$env:Path"
        }
    }
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Stop-Setup "$Name was installed but is not on PATH yet. Open a new PowerShell window and run the script again."
    }
}

Write-Host 'Gloss setup for Windows 11' -ForegroundColor Green

# ---------------------------------------------------------------- prerequisites
Ensure-Command git 'Git.Git'
Ensure-Command uv 'astral-sh.uv'

# ---------------------------------------------------------------------- checkout
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Step "Updating $InstallDir"
    git -C $InstallDir fetch --tags --prune
    $dirty = git -C $InstallDir status --porcelain
    if ($dirty) {
        Write-Warning 'The checkout has local changes, so the launcher will skip release updates. Commit or discard them before launching.'
    }
}
elseif (Test-Path $InstallDir) {
    Stop-Setup "$InstallDir exists and is not a Git checkout. Move it away and run again."
}
else {
    Write-Step "Cloning Gloss into $InstallDir"
    git clone $RepoUrl $InstallDir
}

$Config = Join-Path $env:APPDATA 'Gloss'
New-Item -ItemType Directory -Force $Config | Out-Null

# --------------------------------------------------------------------- local voice
$Model = Join-Path $Config 'underdog-woof'
if (Test-Path (Join-Path $Model 'woof_int8.npz')) {
    Write-Host 'Local voice already downloaded.'
}
else {
    Write-Step 'Downloading the local voice (Underdog Woof, about 40 MB)'
    New-Item -ItemType Directory -Force $Model | Out-Null
    uv tool run --from huggingface_hub hf download ConwayResearch/Underdog-Woof --local-dir $Model
}
if (-not (Test-Path (Join-Path $Model 'woof_int8.npz'))) {
    Stop-Setup 'The voice download did not finish. Check the connection and run the script again.'
}

# ------------------------------------------------------------------------ endpoint key
if (-not $ApiKey) {
    $secure = Read-Host -AsSecureString 'Paste the TEXT_API_KEY (input hidden)'
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}
if (-not $ApiKey) {
    Stop-Setup 'TEXT_API_KEY is required because words come from the text endpoint.'
}

# ------------------------------------------------------------------------ env file
Write-Step 'Writing the private .env'
$envFile = Join-Path $Config '.env'
$managed = @(
    'TEXT_API_BASE', 'TEXT_API_KEY', 'WOOF_MODEL_DIR', 'WOOF_VOICE',
    'DECK_PARENT', 'DECK_DEFAULT', 'ANKI_CONNECT_PORT'
)
$existing = @()
if (Test-Path $envFile) {
    $existing = Get-Content $envFile | Where-Object {
        $line = $_
        -not ($managed | Where-Object { $line -like "$_=*" })
    }
}
$lines = @(
    "TEXT_API_BASE=$ApiBase",
    "TEXT_API_KEY=$ApiKey",
    "WOOF_MODEL_DIR=$Model",
    "WOOF_VOICE=$WoofVoice",
    "DECK_PARENT=$DeckParent",
    "DECK_DEFAULT=$DeckDefault",
    "ANKI_CONNECT_PORT=$AnkiConnectPort"
)
Set-Content -Path $envFile -Value (@($existing) + $lines) -Encoding ascii

# ----------------------------------------------------------------------- settings
Write-Step 'Writing settings.json'
$env:GLOSS_SETUP_PARENT = $DeckParent
$env:GLOSS_SETUP_DEFAULT = $DeckDefault
try {
    @'
import json, os, pathlib
path = pathlib.Path(os.environ["APPDATA"]) / "Gloss" / "settings.json"
data = json.loads(path.read_text()) if path.exists() else {}
data.update({
    "text_model": "gemini-3.8-flash-high",
    "deck_parent": os.environ["GLOSS_SETUP_PARENT"],
    "deck_default": os.environ["GLOSS_SETUP_DEFAULT"],
    "seed_decks": ["General"],
    "last_deck": os.environ["GLOSS_SETUP_PARENT"] + "::" + os.environ["GLOSS_SETUP_DEFAULT"],
    "auto_audio": True,
})
path.write_text(json.dumps(data, indent=2) + "\n")
print("settings:", path)
'@ | uv run --no-project --python 3.13 python -
}
finally {
    Remove-Item Env:GLOSS_SETUP_PARENT, Env:GLOSS_SETUP_DEFAULT -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------------ shortcut
Write-Step 'Creating the desktop shortcut'
$link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gloss.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $InstallDir 'Gloss.cmd'
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description = 'Gloss vocabulary cards'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,21"
$shortcut.Save()
Write-Host "Shortcut: $link"

# ---------------------------------------------------------------------------- anki
$anki = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Anki\anki.exe'),
    (Join-Path $env:ProgramFiles 'Anki\anki.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $anki -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Step 'Installing Anki'
    try {
        winget install --id Anki.Anki --exact --source winget `
            --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
        $anki = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\Anki\anki.exe'),
            (Join-Path $env:ProgramFiles 'Anki\anki.exe')
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    catch {
        Write-Warning 'Anki could not be installed automatically. Install it from apps.ankiweb.net.'
    }
}

$addon = Join-Path $env:APPDATA 'Anki2\addons21\2055492159'
$addonInstalled = Test-Path $addon

# --------------------------------------------------------------------------- launch
$health = $null
if ($NoLaunch) {
    Write-Host ''
    Write-Host 'Skipped launch because -NoLaunch was given.'
}
else {
    Write-Step 'Starting Gloss (the launcher installs the latest release)'
    & (Join-Path $InstallDir 'Gloss.cmd')
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8776/api/health' -TimeoutSec 2
            break
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $health) {
        Stop-Setup 'Gloss did not answer on 127.0.0.1:8776. See %APPDATA%\Gloss\startup.log.'
    }
    $state = Invoke-RestMethod 'http://127.0.0.1:8776/api/bootstrap'
    Write-Host "Gloss $($health.version) is running. Words: $($state.text_provider). Audio: $($state.audio_provider)/$($state.audio_voice)."
    if (-not $state.audio_ready) {
        Write-Warning 'Audio is not ready. Check WOOF_MODEL_DIR in the .env and restart Gloss.'
    }
}

# --------------------------------------------------------------------------- summary
Write-Host ''
Write-Host 'Installed' -ForegroundColor Green
Write-Host "  App        $InstallDir"
Write-Host "  Config     $Config"
Write-Host "  Voice      $Model ($WoofVoice)"
Write-Host "  Shortcut   $link"
Write-Host ''
Write-Host 'Left to do in Anki' -ForegroundColor Yellow
if (-not $anki) {
    Write-Host '  1. Install Anki from https://apps.ankiweb.net and open it once.'
}
else {
    Write-Host "  1. Open Anki ($anki)."
}
if (-not $addonInstalled) {
    Write-Host '  2. Tools > Add-ons > Get Add-ons, paste 2055492159, then restart Anki.'
}
else {
    Write-Host '  2. AnkiConnect add-on is installed.'
}
Write-Host '  3. Sync with AnkiWeb if this collection lives on another computer.'
Write-Host '  4. In Gloss, open Anki and choose Set up Anki once.'
Write-Host ''
Write-Host 'Then paste a few words in Gloss, generate, listen, and sync to Anki.' -ForegroundColor Green
