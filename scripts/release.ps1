# Vydanie novej verzie Sovy na GitHub jedným príkazom:
#   npm run ship -- 1.3.3 "Čo je nové"
# Zvýši verziu, uloží zmeny do gitu, zostaví Setup + Portable a nahrá ich ako GitHub Release.
# GitHub token sa pri prvom spustení vypýta (nezobrazuje sa a neukladá sa do histórie PowerShellu)
# a uloží sa zašifrovaný cez Windows (DPAPI) – rozšifrovať ho vie len tvoj účet na tomto PC.
#   npm run ship -- 1.3.3 -NewToken "Čo je nové"    → zadať nový token (napr. po vypršaní)
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Version,
  [switch]$NewToken,
  # npm odovzdá popis rozdelený na slová – poskladáme ho späť
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Words
)
$ErrorActionPreference = 'Stop'
$Message = ($Words -join ' ').Trim()
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what zlyhalo (kód $LASTEXITCODE)" } }

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Verzia musí byť v tvare 1.2.3 (zadal si: $Version)" }
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ([version]$Version -le [version]$current) { throw "Nová verzia $Version musí byť vyššia ako súčasná $current" }

# ---------------------------------------------------------------- token
# Šifrovanie priamo cez Windows DPAPI (.NET) – bez modulu Microsoft.PowerShell.Security,
# ktorý sa pri spustení z PowerShellu 7 nemusí načítať.
try { Add-Type -AssemblyName System.Security } catch { }
function Protect-Text([string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'))
}
function Unprotect-Text([string]$b64) {
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b64.Trim()), $null, 'CurrentUser')
  [Text.Encoding]::UTF8.GetString($bytes)
}
$tokenFile = Join-Path $env:APPDATA 'Sova-dev\github-token.txt'
if ($NewToken -or -not (Test-Path $tokenFile)) {
  [IO.Directory]::CreateDirectory((Split-Path $tokenFile)) | Out-Null
  $secure = Read-Host 'Vlož GitHub token (pri písaní sa nezobrazuje)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $plain = $plain.Trim()
  if ($plain.Length -lt 20) { throw 'Token vyzerá príliš krátky – skús to znova.' }
  [IO.File]::WriteAllText($tokenFile, (Protect-Text $plain))
  $plain = $null
  Write-Host "Token uložený zašifrovaný: $tokenFile"
}
$token = Unprotect-Text ([IO.File]::ReadAllText($tokenFile))

# ---------------------------------------------------------------- verzia + git
Step "Verzia $current -> $Version"
npm version $Version --no-git-tag-version | Out-Null; Check 'npm version'
$msg = if ($Message) { "Verzia ${Version}: $Message" } else { "Verzia $Version" }
Step 'Ukladám do gitu a nahrávam na GitHub'
git add -A; Check 'git add'
git commit -m $msg; Check 'git commit'
git push; Check 'git push'

# ---------------------------------------------------------------- build + vydanie
Step 'Zostavujem a nahrávam vydanie (pár minút)'
$env:GH_TOKEN = $token
$env:NODE_OPTIONS = '--use-system-ca'
try {
  npm run release; Check 'Zostavenie / nahranie vydania'
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  $token = $null
}
Write-Host "`nHotovo: https://github.com/jkbkpc/sova/releases/tag/v$Version" -ForegroundColor Green
