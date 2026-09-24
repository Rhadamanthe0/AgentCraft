# tmp/opencode-relay.test.ps1 — Preuve standalone du relais (sans Pester).
#
# Lancement :  pwsh -File tmp/opencode-relay.test.ps1
# (depuis la racine du projet ; aucun module a installer, PowerShell 7 only.)
#
# Couvre, avec mocks injectes (-HttpHandler) + un serveur loopback ephemere :
# schema session deny-all + tools tous false + ?directory= fixe (job.directory
# ignore), auth Basic/Bearer presentes mais JAMAIS affichees, claim null sans
# inference, malformed job (id/lease absents, id-URL, surpoids) refuses,
# info.error => fail + DELETE, erreurs HTTP redactees, retries d'upload bornes
# sans re-inference + dedup meme lease, expiration => dead-letter sans
# inference, loopback strict, secrets via env uniquement, zero dependance
# (ni install, ni auth.json, ni scan processus/ports, ni docker).
#
# Sortie : lignes PASS/FAIL + resume ; exit 1 si un echec.

param()

$ErrorActionPreference = 'Stop'
$script:Passes = 0
$script:Fails = 0

. (Join-Path $PSScriptRoot '..' 'bridge' 'opencode-relay.ps1')

function Assert-True {
  param([bool]$Cond, [string]$Name)
  if ($Cond) { $script:Passes++; Write-Host "PASS $Name" }
  else { $script:Fails++; Write-Host "FAIL $Name" }
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Name)
  if ("$Actual" -eq "$Expected") { $script:Passes++; Write-Host "PASS $Name" }
  else { $script:Fails++; Write-Host "FAIL $Name (attendu='$Expected' recu='$Actual')" }
}

function Assert-Throws {
  param([scriptblock]$Code, [string]$ExpectCode, [string]$Name, [string]$Match = '')
  try { & $Code; $script:Fails++; Write-Host "FAIL $Name (aucune erreur levee)" }
  catch {
    $c = ''
    try { $c = [string]$_.Exception.Data['RelayCode'] } catch { $c = '' }
    $msg = ''
    try { $msg = $_.Exception.Message } catch { $msg = [string]$_ }
    if ($c -eq $ExpectCode -and ($Match -eq '' -or $msg -match $Match)) {
      $script:Passes++; Write-Host "PASS $Name"
    } else {
      $script:Fails++; Write-Host "FAIL $Name (code='$c' msg='$msg')"
    }
  }
}

# --- Secrets de test (fictifs, memoire seule, jamais affiches) ---
$oldQueue = $env:RELAY_QUEUE_TOKEN
$oldUser = $env:OPENCODE_SERVER_USERNAME
$oldPass = $env:OPENCODE_SERVER_PASSWORD
$env:RELAY_QUEUE_TOKEN = 'fictif-queue-token'
$env:OPENCODE_SERVER_USERNAME = 'fictif-user'
$env:OPENCODE_SERVER_PASSWORD = 'fictif-pass'

$Q = 'http://127.0.0.1:4100'
$D = 'http://127.0.0.1:4096'
$DIR = 'C:\relais\workspace'
$DIRESC = [uri]::EscapeDataString($DIR)

function New-DesktopOk {
  param([string]$Text = '{"fini":0}')
  return @{ info = @{}; parts = @(@{ type = 'step-start' }, @{ type = 'text'; text = $Text }, @{ type = 'step-finish' }) }
}

function New-ClaimJob {
  param([string]$Id = 'job-1', [string]$Lease = 'lease-1')
  return @{
    id = $Id; leaseId = $Lease
    expiresAt = ([datetimeoffset]::UtcNow.AddMinutes(5)).ToString('o')
    system = 'sys-test'; user = 'jeu-test'
    model = 'modele-pirate'; variant = 'low'; directory = 'C:\evil\inject'
  }
}

try {
  # ---------- 1. Injection prouvee (contrat de test) ----------
  $p = (Get-Command Start-OpenCodeRelay).Parameters
  Assert-True ($p.ContainsKey('HttpHandler')) 'injection-http-param-present'
  Assert-True ($p.ContainsKey('Once')) 'once-param-present'
  Assert-True ($p.ContainsKey('MaxIterations')) 'maxiterations-param-present'
  Assert-True (-not $p.ContainsKey('QueueToken')) 'aucun-param-queue-token'
  Assert-True (-not $p.ContainsKey('DesktopPassword')) 'aucun-param-password'
  Assert-True (-not $p.ContainsKey('Password')) 'aucun-param-password-bis'

  # ---------- 2. Loopback strict ----------
  Assert-Throws { Assert-RelayConfig 'https://exemple.test:4100' $D $DIR 5 10 60 3 1048576 300 3 } 'RELAY_NON_LOOPBACK' 'queue-non-loopback-refusee'
  Assert-Throws { Assert-RelayConfig $Q 'https://exemple.test:4096' $DIR 5 10 60 3 1048576 300 3 } 'RELAY_NON_LOOPBACK' 'desktop-non-loopback-refuse'
  Assert-Throws { Assert-RelayConfig 'http://user:pass@127.0.0.1:4100' $D $DIR 5 10 60 3 1048576 300 3 } 'RELAY_BAD_URL' 'url-credentials-refusees'
  Assert-Throws { Assert-RelayConfig 'ftp://127.0.0.1:4100' $D $DIR 5 10 60 3 1048576 300 3 } 'RELAY_BAD_URL' 'scheme-non-http-refuse'
  Assert-Throws { Assert-RelayConfig $Q $D '' 5 10 60 3 1048576 300 3 } 'RELAY_BAD_CONFIG' 'directory-manquant-refuse'
  Assert-Throws { Assert-RelayConfig $Q $D 'https://evil/dir' 5 10 60 3 1048576 300 3 } 'RELAY_BAD_CONFIG' 'directory-url-refuse'
  $cfg = Assert-RelayConfig $Q $D $DIR 5 10 60 3 1048576 300 3
  Assert-Equal $cfg.QueueBase $Q 'queue-loopback-acceptee'

  # ---------- 3. Secrets via env uniquement ----------
  $env:RELAY_QUEUE_TOKEN = ''
  Assert-Throws { Get-RelayQueueToken } 'RELAY_NO_TOKEN' 'token-env-manquant-refuse'
  $env:RELAY_QUEUE_TOKEN = 'fictif-queue-token'
  $env:OPENCODE_SERVER_PASSWORD = ''
  Assert-Throws { Get-RelayDesktopCredential } 'RELAY_NO_CREDENTIALS' 'credentials-env-incompletes-refusees'
  $env:OPENCODE_SERVER_PASSWORD = 'fictif-pass'

  # ---------- 4. Claim null : aucune inference ----------
  $script:RelayLastResult = $null
  $cap = @{ calls = @(); desktop = 0 }
  $mockNull = {
    param($Method, $Url, $Headers, $Body, $TimeoutSec)
    $cap.calls += @{ method = $Method; url = $Url }
    if ($Url -like '*/relay/jobs/claim') { return @{ Status = 200; Body = @{ job = $null } } }
    if ($Url -like '*127.0.0.1*') { $cap.desktop++; return @{ Status = 500; Body = 'ne doit pas arriver' } }
    return @{ Status = 200; Body = @{} }
  }.GetNewClosure()
  Start-OpenCodeRelay -QueueBaseUrl $Q -DesktopBaseUrl $D -Directory $DIR -WorkerId 'w-test' `
    -PollIntervalSec 0 -ClaimTimeoutSec 5 -DesktopTimeoutSec 5 -CleanupTimeoutSec 2 `
    -RetryDelayMs 0 -Once -HttpHandler $mockNull
  Assert-Equal $cap.desktop 0 'claim-null-sans-inference'
  $claimCall = @($cap.calls | Where-Object { $_.url -like '*/relay/jobs/claim' })[0]
  Assert-True ($null -ne $claimCall) 'claim-appele'

  # ---------- 5. Happy path : schema fixe, directory hote, secrets non affiches ----------
  $script:RelayLastResult = $null
  $cap2 = @{ calls = @(); bodies = @{}; headers = @{} }
  $job = New-ClaimJob
  $mockOk = {
    param($Method, $Url, $Headers, $Body, $TimeoutSec)
    $cap2.calls += @{ method = $Method; url = $Url }
    if ($Url -like '*/relay/jobs/claim') { return @{ Status = 200; Body = @{ job = $job } } }
    if ($Method -eq 'GET' -and $Url -like '*/experimental/tool/ids*') { return @{ Status = 200; Body = @('read', 'bash') } }
    if ($Method -eq 'POST' -and $Url -match '/session\?') {
      $cap2.bodies['create'] = $Body; return @{ Status = 200; Body = @{ id = 'sess-1' } }
    }
    if ($Url -like '*/message*') {
      $cap2.bodies['message'] = $Body; $cap2.headers['msg'] = $Headers; return @{ Status = 200; Body = (New-DesktopOk) }
    }
    if ($Method -eq 'DELETE') { $cap2.calls += @{ method = 'DELETE-cleanup'; url = $Url }; return @{ Status = 200; Body = @{} } }
    if ($Url -like '*/result') { $cap2.bodies['result'] = $Body; $cap2.calls += @{ method = 'RESULT'; url = $Url }; return @{ Status = 200; Body = @{ stored = $true } } }
    if ($Url -like '*/fail') { $cap2.bodies['fail'] = $Body; return @{ Status = 200; Body = @{} } }
    throw "route mock inattendue : $Method $Url"
  }.GetNewClosure()
  Start-OpenCodeRelay -QueueBaseUrl $Q -DesktopBaseUrl $D -Directory $DIR -WorkerId 'w-test' `
    -PollIntervalSec 0 -ClaimTimeoutSec 5 -DesktopTimeoutSec 5 -CleanupTimeoutSec 2 `
    -RetryDelayMs 0 -Once -HttpHandler $mockOk
  $create = $cap2.bodies['create']
  Assert-Equal $create.model.id 'gpt-6-astra' 'session-modele-fixe'
  Assert-Equal $create.model.providerID 'openai' 'session-provider-fixe'
  Assert-Equal $create.model.variant 'high' 'session-variant-fixe'
  Assert-Equal $create.permission[0].action 'deny' 'session-deny-all'
  $msg = $cap2.bodies['message']
  Assert-Equal $msg.model.modelID 'gpt-6-astra' 'message-model-fixe-malgre-job-pirate'
  Assert-Equal $msg.variant 'high' 'message-variant-fixe-malgre-job-pirate'
  Assert-Equal $msg.tools['read'] $false 'tools-read-false'
  Assert-Equal $msg.tools['bash'] $false 'tools-bash-false'
  Assert-True ($msg.parts[0].text -like '*sys-test*') 'message-porte-system+user'
  foreach ($c in $cap2.calls) {
    if ($c.url -like '*127.0.0.1:4096*') {
      Assert-True ($c.url -like "*directory=$DIRESC*") 'directory-hote-partout'
      Assert-True ($c.url -notlike '*evil*') 'directory-job-ignoree'
    }
  }
  $auth = $cap2.headers['msg']['Authorization']
  Assert-True ($auth -like 'Basic *') 'auth-basic-desktop-envoyee'
  Write-Host '  [preuve] auth desktop : type=Basic present (valeur non affichee)'
  $res = $cap2.bodies['result']
  Assert-Equal $res.leaseId 'lease-1' 'result-leaseId'
  Assert-Equal $res.content '{"fini":0}' 'result-content-texte-seul'
  Assert-True ($null -ne (@($cap2.calls | Where-Object { $_.method -eq 'DELETE-cleanup' })[0])) 'cleanup-delete-appele'

  # ---------- 6. Jobs malformes refuses ----------
  Assert-Throws { Test-RelayJob @{ leaseId = 'l' } 1048576 } 'RELAY_BAD_JOB' 'job-sans-id-refuse'
  Assert-Throws { Test-RelayJob @{ id = 'j' } 1048576 } 'RELAY_BAD_JOB' 'job-sans-lease-refuse'
  Assert-Throws { Test-RelayJob @{ id = 'http://evil/x'; leaseId = 'l'; user = 'u' } 1048576 } 'RELAY_BAD_JOB' 'job-id-url-refuse'
  Assert-Throws { Test-RelayJob @{ id = '../escape'; leaseId = 'l'; user = 'u' } 1048576 } 'RELAY_BAD_JOB' 'job-id-chemin-refuse'
  Assert-Throws { Test-RelayJob @{ id = 'j'; leaseId = 'l'; user = ('x' * 65) } 64 } 'RELAY_JOB_TOO_LARGE' 'job-surpoids-refuse'
  Assert-Throws { Test-RelayJob @{ id = 'j'; leaseId = 'l' } 1048576 } 'RELAY_BAD_JOB' 'job-sans-contenu-refuse'

  # ---------- 7. info.error => fail + DELETE, jamais success ----------
  $script:RelayLastResult = $null
  $cap3 = @{ deletes = 0; fail = $null; result = $false }
  $mockErr = {
    param($Method, $Url, $Headers, $Body, $TimeoutSec)
    if ($Url -like '*/relay/jobs/claim') { return @{ Status = 200; Body = @{ job = (New-ClaimJob -Id 'job-err' -Lease 'lease-err') } } }
    if ($Method -eq 'GET' -and $Url -like '*/experimental/tool/ids*') { return @{ Status = 200; Body = @('t1') } }
    if ($Method -eq 'POST' -and $Url -match '/session\?') { return @{ Status = 200; Body = @{ id = 'sess-e' } } }
    if ($Url -like '*/message*') {
      return @{ Status = 200; Body = @{ info = @{ error = 'modele fictif surcharge' }; parts = @(@{ type = 'text'; text = '{"fini":0}' }) } }
    }
    if ($Method -eq 'DELETE') { $cap3.deletes++; return @{ Status = 200; Body = @{} } }
    if ($Url -like '*/fail') { $cap3.fail = $Body; return @{ Status = 200; Body = @{} } }
    if ($Url -like '*/result') { $cap3.result = $true; return @{ Status = 200; Body = @{} } }
    throw "route mock inattendue : $Method $Url"
  }.GetNewClosure()
  Start-OpenCodeRelay -QueueBaseUrl $Q -DesktopBaseUrl $D -Directory $DIR -WorkerId 'w-test' `
    -PollIntervalSec 0 -ClaimTimeoutSec 5 -DesktopTimeoutSec 5 -CleanupTimeoutSec 2 `
    -RetryDelayMs 0 -Once -HttpHandler $mockErr
  Assert-Equal $cap3.fail.code 'RELAY_MODEL_ERROR' 'info-error-code-fail'
  Assert-Equal $cap3.result $false 'info-error-jamais-success'
  Assert-Equal $cap3.deletes 1 'info-error-cleanup-delete'

  # ---------- 8. Erreur HTTP redactee (secret non remonte) ----------
  $mockHttp500 = {
    param($Method, $Url, $Headers, $Body, $TimeoutSec)
    if ($Method -eq 'GET' -and $Url -like '*/experimental/tool/ids*') { return @{ Status = 200; Body = @('t1') } }
    if ($Method -eq 'POST' -and $Url -match '/session\?') { return @{ Status = 200; Body = @{ id = 'sess-r' } } }
    if ($Url -like '*/message*') { return @{ Status = 500; Body = 'boom Bearer abcdef12345 password=secret-fictif' } }
    if ($Method -eq 'DELETE' -or ($Url -like '*/abort*')) { return @{ Status = 200; Body = @{} } }
    throw "route mock inattendue : $Method $Url"
  }.GetNewClosure()
  try {
    Invoke-RelayInference -System 's' -User 'u' -DesktopBase $D -Directory $DIR `
      -AuthValue 'Basic ZnJpY3RpZg==' -TimeoutSec 5 -CleanupTimeoutSec 2 -HttpHandler $mockHttp500
    $script:Fails++; Write-Host 'FAIL http500-redactee (aucune erreur)'
  } catch {
    $m = $_.Exception.Message
    $ok = ($m -match 'redacted') -and ($m -notmatch 'abcdef12345') -and ($m -notmatch 'secret-fictif')
    Assert-True $ok 'http500-redactee'
  }

  # ---------- 9. Retries upload bornes, une seule inference, dedup meme lease ----------
  $script:RelayLastResult = $null
  $cap4 = @{ messages = 0; results = 0; fails = 0 }
  $job4 = New-ClaimJob -Id 'job-4' -Lease 'lease-4'
  $mockRetry = {
    param($Method, $Url, $Headers, $Body, $TimeoutSec)
    if ($Url -like '*/relay/jobs/claim') { return @{ Status = 200; Body = @{ job = $job4 } } }
    if ($Method -eq 'GET' -and $Url -like '*/experimental/tool/ids*') { return @{ Status = 200; Body = @('t1') } }
    if ($Method -eq 'POST' -and $Url -match '/session\?') { return @{ Status = 200; Body = @{ id = 'sess-4' } } }
    if ($Url -like '*/message*') { $cap4.messages++; return @{ Status = 200; Body = (New-DesktopOk -Text 'ok4') } }
    if ($Method -eq 'DELETE') { return @{ Status = 200; Body = @{} } }
    if ($Url -like '*/result') {
      $cap4.results++
      if ($cap4.results -lt 3) { return @{ Status = 500; Body = 'panne file fictive' } }
      return @{ Status = 200; Body = @{ stored = $true } }
    }
    if ($Url -like '*/fail') { $cap4.fails++; return @{ Status = 200; Body = @{} } }
    throw "route mock inattendue : $Method $Url"
  }.GetNewClosure()
  Start-OpenCodeRelay -QueueBaseUrl $Q -DesktopBaseUrl $D -Directory $DIR -WorkerId 'w-test' `
    -PollIntervalSec 0 -ClaimTimeoutSec 5 -DesktopTimeoutSec 5 -CleanupTimeoutSec 2 `
    -RetryDelayMs 0 -MaxUploadAttempts 3 -Once -HttpHandler $mockRetry
  Assert-Equal $cap4.messages 1 'retry-une-seule-inference'
  Assert-Equal $cap4.results 3 'retry-upload-borne-3'
  Assert-Equal $cap4.fails 0 'retry-pas-de-fail'
  # Re-claim du meme lease : re-emission sans nouvelle inference.
  Start-OpenCodeRelay -QueueBaseUrl $Q -DesktopBaseUrl $D -Directory $DIR -WorkerId 'w-test' `
    -PollIntervalSec 0 -ClaimTimeoutSec 5 -DesktopTimeoutSec 5 -CleanupTimeoutSec 2 `
    -RetryDelayMs 0 -MaxUploadAttempts 3 -Once -HttpHandler $mockRetry
  Assert-Equal $cap4.messages 1 'dedup-meme-lease-sans-reinference'

  # ---------- 10. Expiration => dead-letter, zero inference ----------
  $script:RelayLastResult = $null
  $cap5 = @{ desktop = 0; fail = $null }
  $jobPast = New-ClaimJob -Id 'job-old' -Lease 'lease-old'
  $jobPast.expiresAt = ([datetimeoffset]::UtcNow.AddMinutes(-5)).ToString('o')
  $mockPast = {
    param($Method, $Url, $Headers, $Body, $TimeoutSec)
    if ($Url -like '*/relay/jobs/claim') { return @{ Status = 200; Body = @{ job = $jobPast } } }
    if ($Url -like '*127.0.0.1:4096*') { $cap5.desktop++; return @{ Status = 500; Body = 'ne doit pas arriver' } }
    if ($Url -like '*/fail') { $cap5.fail = $Body; return @{ Status = 200; Body = @{} } }
    if ($Url -like '*/result') { return @{ Status = 200; Body = @{} } }
    throw "route mock inattendue : $Method $Url"
  }.GetNewClosure()
  Start-OpenCodeRelay -QueueBaseUrl $Q -DesktopBaseUrl $D -Directory $DIR -WorkerId 'w-test' `
    -PollIntervalSec 0 -ClaimTimeoutSec 5 -DesktopTimeoutSec 5 -CleanupTimeoutSec 2 `
    -RetryDelayMs 0 -Once -HttpHandler $mockPast
  Assert-Equal $cap5.desktop 0 'expire-sans-inference'
  Assert-Equal $cap5.fail.code 'JOB_EXPIRED' 'expire-dead-letter'

  # ---------- 11. Serveur loopback ephemere (vrai HTTP, Bearer present non affiche) ----------
  $tcp = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $tcp.Start()
  $freePort = $tcp.LocalEndpoint.Port
  $tcp.Stop()
  $serverJob = Start-Job -ScriptBlock {
    param($Port)
    $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $l.Start()
    try {
      $t = $l.BeginAcceptTcpClient($null, $null)
      if (-not $t.AsyncWaitHandle.WaitOne(15000)) { return @{ accepted = $false } }
      $c = $l.EndAcceptTcpClient($t)
      $c.ReceiveTimeout = 5000
      $s = $c.GetStream()
      $buf = New-Object byte[] 65536
      $raw = ''
      $start = [DateTime]::UtcNow
      while ($raw -notmatch "`r`n`r`n" -and ([DateTime]::UtcNow - $start).TotalSeconds -lt 10) {
        $n = $s.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $raw += [Text.Encoding]::UTF8.GetString($buf, 0, $n)
      }
      $len = 0
      if ($raw -match '(?i)Content-Length:\s*(\d+)') { $len = [int]$Matches[1] }
      $headEnd = $raw.IndexOf("`r`n`r`n")
      $bodySoFar = ''
      if ($headEnd -ge 0) { $bodySoFar = $raw.Substring($headEnd + 4) }
      while ([Text.Encoding]::UTF8.GetByteCount($bodySoFar) -lt $len -and ([DateTime]::UtcNow - $start).TotalSeconds -lt 10) {
        $n = $s.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $bodySoFar += [Text.Encoding]::UTF8.GetString($buf, 0, $n)
      }
      $firstLine = ($raw -split "`r`n")[0]
      $hasBearer = $raw -match '(?i)Authorization:\s*Bearer\s+\S+'
      $payload = '{"job":null}'
      $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
      $head = "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
      $hbytes = [Text.Encoding]::UTF8.GetBytes($head)
      $s.Write($hbytes, 0, $hbytes.Length)
      $s.Write($bytes, 0, $bytes.Length)
      $s.Flush()
      $c.Close()
      return @{
        accepted = $true; methodOk = ($firstLine -like 'POST /relay/jobs/claim*')
        authBearerPresent = [bool]$hasBearer; bodyHasWorker = ($bodySoFar -like '*workerId*')
      }
    } finally { $l.Stop() }
  } -ArgumentList $freePort
  Start-Sleep -Milliseconds 1500
  $claimed = Request-RelayClaim -QueueBase "http://127.0.0.1:$freePort" -QueueToken 'fictif-queue-token' `
    -WorkerId 'w-loop' -TimeoutSec 10
  Assert-Equal $claimed $null 'loopback-claim-null-reel'
  $srv = Wait-Job -Job $serverJob -Timeout 20 | Out-Null
  $out = Receive-Job -Job $serverJob
  Remove-Job -Job $serverJob -Force -ErrorAction SilentlyContinue
  Assert-True ([bool]$out.accepted) 'loopback-connexion-acceptee'
  Assert-True ([bool]$out.methodOk) 'loopback-claim-route-vue-serveur'
  Assert-True ([bool]$out.authBearerPresent) 'loopback-bearer-present (valeur non lue)'
  Assert-True ([bool]$out.bodyHasWorker) 'loopback-workerId-transmis'
  Write-Host '  [preuve] serveur ephemere 127.0.0.1 : Bearer present verifie serveur, jamais affiche'

  # ---------- 12. Zero dependance / zero binding ----------
  $src = Get-Content (Join-Path $PSScriptRoot '..' 'bridge' 'opencode-relay.ps1') -Raw
  foreach ($tok in @('Install-Module', 'Install-Package', 'Get-Process', 'Invoke-WebRequest', 'curl.exe', 'docker ')) {
    Assert-True (-not ($src -like "*$tok*")) "nodep-sans-$($tok.Replace(' ','-').Replace('.','-'))"
  }
  # auth.json : la REGLE (jamais lu) est documentee en commentaire, mais aucun
  # code ne doit y acceder : on verifie le code seul, commentaires retires.
  $codeOnly = (($src -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
  Assert-True (-not ($codeOnly -match 'auth\.json')) 'nodep-lecture-auth-json-absente'
  Assert-True ($src -match 'auth\.json') 'doc-regle-auth-json-documentee'
} finally {
  $env:RELAY_QUEUE_TOKEN = $oldQueue
  $env:OPENCODE_SERVER_USERNAME = $oldUser
  $env:OPENCODE_SERVER_PASSWORD = $oldPass
  $script:RelayStopRequested = $false
  $script:RelayLastResult = $null
}

Write-Host ("`n[relay-test] passes={0} fails={1}" -f $script:Passes, $script:Fails)
if ($script:Fails -gt 0) { exit 1 }
