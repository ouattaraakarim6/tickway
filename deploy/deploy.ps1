# deploy/deploy.ps1 — Déploiement TickWay depuis le PC (Windows PowerShell)
# 1) vérifie l'état git  2) pousse sur GitHub  3) lance le déploiement sur o2switch via SSH  4) vérifie le site
#
# Usage :  powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
# Prérequis : alias SSH « o2switch-tickway » configuré dans ~/.ssh/config, IP autorisée dans cPanel (Autorisation SSH).
param(
  [string]$Branch = "main",
  [string]$SshHost = "o2switch-tickway",
  [string]$RemoteAppDir = "~/tickway-plateforme",
  [string]$SiteUrl = "https://tick-way.com",
  [switch]$SkipEnv   # ne pas resynchroniser le .env de production
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }

Step "Vérification du dépôt local"
$current = (git rev-parse --abbrev-ref HEAD).Trim()
if ($current -ne $Branch) { throw "Vous êtes sur la branche '$current' : basculez sur '$Branch' avant de déployer." }
$dirty = git status --porcelain
if ($dirty) { throw "Modifications non commitées : commitez-les (sans le fichier .env) avant de déployer.`n$dirty" }
foreach ($f in @(".env", ".env.production")) {
  if (git ls-files -- $f) { throw "Le fichier $f est suivi par git : retirez-le (git rm --cached $f) !" }
}

Step "Envoi sur GitHub ($Branch)"
git push origin $Branch
if ($LASTEXITCODE -ne 0) { throw "git push a échoué." }

if (-not $SkipEnv) {
  Step "Variables d'environnement de production (.env local + .env.production -> serveur)"
  node deploy/push-env.mjs --host $SshHost --app-dir $RemoteAppDir --site $SiteUrl
  if ($LASTEXITCODE -ne 0) { throw "La synchronisation du .env de production a échoué." }
}

$CanonicalHost = ([Uri]$SiteUrl).Host

Step "Déploiement sur o2switch via SSH ($SshHost)"
ssh $SshHost "HEALTHCHECK_URL='$SiteUrl/api/founder/status' CANONICAL_HOST='$CanonicalHost' BRANCH='$Branch' bash $RemoteAppDir/deploy/o2switch-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "Le déploiement distant a échoué (code $LASTEXITCODE)." }

Step "Vérification du site"
$resp = Invoke-WebRequest -Uri "$SiteUrl/api/founder/status" -UseBasicParsing -TimeoutSec 30
if ($resp.StatusCode -ne 200) { throw "Le site répond avec le code $($resp.StatusCode)." }
$homePage = Invoke-WebRequest -Uri $SiteUrl -UseBasicParsing -TimeoutSec 30

Step "Vérification des redirections vers https://$CanonicalHost"
# curl.exe (inclus dans Windows 10/11) sans suivre les redirections : on lit le code et la destination
$checks = @(
  @{ Url = "http://$CanonicalHost/";                         Code = "301"; Target = "https://$CanonicalHost/" },
  @{ Url = "http://www.$CanonicalHost/";                     Code = "301"; Target = "https://$CanonicalHost/" },
  @{ Url = "https://www.$CanonicalHost/";                    Code = "301"; Target = "https://$CanonicalHost/" },
  @{ Url = "http://www.$CanonicalHost/paiement-retour?cmd=X"; Code = "301"; Target = "https://$CanonicalHost/paiement-retour?cmd=X" },
  @{ Url = "https://$CanonicalHost/";                        Code = "200"; Target = "" }
)
$failed = @()
foreach ($c in $checks) {
  $out = (& curl.exe -s -o NUL --max-time 20 -w "%{http_code} %{redirect_url}" $c.Url) -join ""
  $parts = $out.Trim().Split(" ", 2)
  $code = $parts[0]; $target = if ($parts.Count -gt 1) { $parts[1] } else { "" }
  $ok = ($code -eq $c.Code) -and ($target -eq $c.Target)
  $label = if ($ok) { "OK " } else { "ERR" }
  Write-Host ("  [{0}] {1,-48} -> {2} {3}" -f $label, $c.Url, $code, $target)
  if (-not $ok) { $failed += $c.Url }
}
if ($failed.Count) { throw "Redirections incorrectes : $($failed -join ', '). Vérifiez le DNS de www et le certificat SSL (tick-way.com + www)." }

Write-Host "`nOK - $SiteUrl en ligne (API $($resp.StatusCode), accueil $($homePage.StatusCode)), redirections http/www valides." -ForegroundColor Green
