#Requires -Version 7.0
# bridge/opencode-relay.ps1 — Relais Windows sortant : file d'attente -> OpenCode Desktop.
#
# PERIMETRE EXCLUSIF : ce script est un composant Windows autorise explicitement
# par l'utilisateur. Il ne touche ni au bot, ni au superviseur, ni a la config,
# ni a .opencode. Il ne demarre rien de persistant et ne gere aucun binding
# Desktop (ni lecture de auth.json, ni scan de processus/ports).
#
# Role : worker sortant (outbound). Il RECLAME un job LLM sur une file locale
# future (kernel, contrat : bridge/relay-contract.md), l'execute en UNE inference
# sur le serveur OpenCode Desktop deja present (loopback, auth Basic via env
# memoire seule), puis REMONTE le resultat. Une seule job inflight a la fois,
# polling borne, arret propre sur CTRL+C.
#
# Confiance ZERO envers la file (hote non fiable) :
# - URLs : -QueueBaseUrl et -DesktopBaseUrl EXIGES en loopback (localhost,
#   127.x, ::1), scheme http(s), credentials dans l'URL refusees. Aucune URL
#   venue du job n'est utilisee.
# - -Directory est le SEUL repertoire (parametre hote explicite, passe en
#   ?directory= sur chaque endpoint). Job.directory / Job.model / Job.variant
#   sont IGNORES : modele/variant fixes Astra High (openai/gpt-6-astra, high).
# - Messages seuls = donnees, bornes a 1 Mo (UTF-8). Job trop gros refuse.
# - Desktop : permission deny-all a la creation + tools {id:false} explicites
#   (GET /experimental/tool/ids dynamique, liste vide/illisible = REFUS avant
#   message, jamais tools:{}). Parties non-texte ignorees, jamais executees.
#   info.error (string ou objet) => erreur, jamais success.
# - Secrets : credentials Desktop via env OPENCODE_SERVER_USERNAME /
#   OPENCODE_SERVER_PASSWORD (memoire seule, jamais console/argv/fichier) ;
#   token file via env RELAY_QUEUE_TOKEN (jamais logue). Erreurs redactees.
# - Session Desktop ephemere par job : abort borne best-effort puis DELETE borne
#   systematique ; orpheline exposee via cleanupFailed + sessionId (sans secret).
# - Resultat : upload idempotent meme lease (retries bornes, jamais de nouvelle
#   inference pour le meme lease ; cache memoire du dernier resultat si l'upload
#   echoue). Expiration => dead-letter (fail JOB_EXPIRED), pas d'inference 2x.
#
# Tests : tmp/opencode-relay.test.ps1 (assertions PS standalone, sans Pester,
# fonctions injectables via -HttpHandler / mock, serveur loopback ephemere).
# Import sans execution : . ./bridge/opencode-relay.ps1  (le main ne tourne que
# en invocation directe, jamais en dot-sourcing '.').

param(
  [string]$QueueBaseUrl = '',
  [string]$DesktopBaseUrl = '',
  [string]$Directory = '',
  [string]$WorkerId = '',
  [int]$PollIntervalSec = 5,
  [int]$ClaimTimeoutSec = 10,
  [int]$DesktopTimeoutSec = 60,
  [int]$CleanupTimeoutSec = 3,
  [int]$MaxMessageBytes = 1048576,
  [int]$JobMaxAgeSec = 300,
  [int]$MaxUploadAttempts = 3,
  [int]$RetryDelayMs = 500,
  [int]$MaxIterations = 0,
  [switch]$Once,
  [scriptblock]$HttpHandler = $null
)

$script:RelayModelId = 'gpt-6-astra'
$script:RelayProviderId = 'openai'
$script:RelayVariant = 'high'
$script:RelayTitle = 'minecraft-relay'
$script:RelayStopRequested = $false
# Cache memoire du dernier resultat : { JobId, LeaseId, Result, Uploaded }.
# Sert les retries d'upload (meme lease, meme contenu, sans re-inference) et
# la dedup si la file reserve le meme lease.
$script:RelayLastResult = $null

function Throw-Relay {
  param([string]$Message, [string]$Code = 'RELAY_ERROR', [object]$Status = $null)
  $ex = New-Object System.Exception($Message)
  $ex.Data['RelayCode'] = $Code
  if ($null -ne $Status) { $ex.Data['RelayStatus'] = $Status }
  throw $ex
}

function Get-RelayCode {
  param($ErrRecord)
  $ex = $ErrRecord.Exception
  if ($null -ne $ex -and $null -ne $ex.Data -and $ex.Data.Contains('RelayCode')) {
    return [string]$ex.Data['RelayCode']
  }
  return ''
}

function Redact-RelaySecret {
  param([string]$Text)
  $s = [string]$Text
  $s = $s -replace 'Basic\s+[A-Za-z0-9+/=]{8,}', 'Basic [redacted]'
  $s = $s -replace 'Bearer\s+[^\s"'']+', 'Bearer [redacted]'
  $s = $s -replace '(?i)password\s*[:=]\s*[^\s"'']+', 'password:[redacted]'
  $s = $s -replace '(?i)api[_-]?key\s*[:=]\s*[^\s"'']+', 'api_key:[redacted]'
  if ($s.Length -gt 200) { $s = $s.Substring(0, 200) }
  return $s
}

function Write-RelayLog {
  param([string]$Message)
  # Jamais de secret ici : l'appelant ne passe que des ids/compteurs rediges.
  Write-Host ("[relay] {0}" -f $Message)
}

function Test-RelayLoopbackUrl {
  param([string]$Url, [string]$Name = 'URL')
  if ([string]::IsNullOrWhiteSpace($Url)) {
    Throw-Relay "$Name manquante" 'RELAY_BAD_URL'
  }
  if ($Url -match '@') {
    Throw-Relay "$Name avec credentials refusee" 'RELAY_BAD_URL'
  }
  try { $u = [uri]$Url } catch { Throw-Relay "$Name invalide" 'RELAY_BAD_URL' }
  if ($u.Scheme -ne 'http' -and $u.Scheme -ne 'https') {
    Throw-Relay "$Name http(s) requise" 'RELAY_BAD_URL'
  }
  $h = $u.Host.ToLowerInvariant()
  $ok = $false
  if ($h -eq 'localhost' -or $h -eq '::1' -or $h -eq '[::1]') { $ok = $true }
  elseif ($h -match '^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { $ok = $true }
  if (-not $ok) {
    Throw-Relay "$Name non-loopback refusee" 'RELAY_NON_LOOPBACK'
  }
  return ($u.ToString().TrimEnd('/'))
}

function Assert-RelayConfig {
  param(
    [string]$QueueBaseUrl, [string]$DesktopBaseUrl, [string]$Directory,
    [int]$PollIntervalSec, [int]$ClaimTimeoutSec, [int]$DesktopTimeoutSec,
    [int]$CleanupTimeoutSec, [int]$MaxMessageBytes, [int]$JobMaxAgeSec,
    [int]$MaxUploadAttempts
  )
  $q = Test-RelayLoopbackUrl $QueueBaseUrl 'QueueBaseUrl'
  $d = Test-RelayLoopbackUrl $DesktopBaseUrl 'DesktopBaseUrl'
  if ([string]::IsNullOrWhiteSpace($Directory)) {
    Throw-Relay 'Directory manquant (parametre hote explicite requis)' 'RELAY_BAD_CONFIG'
  }
  if ($Directory -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    Throw-Relay 'Directory en forme d URL refuse (repertoire hote attendu)' 'RELAY_BAD_CONFIG'
  }
  foreach ($pair in @(
      @('PollIntervalSec', $PollIntervalSec, 0, 300),
      @('ClaimTimeoutSec', $ClaimTimeoutSec, 1, 120),
      @('DesktopTimeoutSec', $DesktopTimeoutSec, 1, 600),
      @('CleanupTimeoutSec', $CleanupTimeoutSec, 1, 60),
      @('MaxMessageBytes', $MaxMessageBytes, 1, 4194304),
      @('JobMaxAgeSec', $JobMaxAgeSec, 1, 3600),
      @('MaxUploadAttempts', $MaxUploadAttempts, 1, 10))) {
    if ($pair[1] -lt $pair[2] -or $pair[1] -gt $pair[3]) {
      Throw-Relay ("{0} hors bornes ({1}..{2})" -f $pair[0], $pair[2], $pair[3]) 'RELAY_BAD_CONFIG'
    }
  }
  return @{ QueueBase = $q; DesktopBase = $d }
}

function Get-RelayQueueToken {
  # Token file UNIQUEMENT via env dediee, memoire seule, jamais logue.
  $t = $env:RELAY_QUEUE_TOKEN
  if ([string]::IsNullOrWhiteSpace($t)) {
    Throw-Relay 'RELAY_QUEUE_TOKEN absent (env requise)' 'RELAY_NO_TOKEN'
  }
  return $t
}

function Get-RelayDesktopCredential {
  # Credentials Desktop UNIQUEMENT via env, memoire seule.
  # Jamais en argv, jamais en console, jamais via fichier (pas de auth.json).
  $u = $env:OPENCODE_SERVER_USERNAME
  $p = $env:OPENCODE_SERVER_PASSWORD
  if ([string]::IsNullOrWhiteSpace($u) -or [string]::IsNullOrWhiteSpace($p)) {
    Throw-Relay 'OPENCODE_SERVER_USERNAME/PASSWORD incomplets (env requises)' 'RELAY_NO_CREDENTIALS'
  }
  $sec = ConvertTo-SecureString -String $p -AsPlainText -Force
  $p = $null
  return (New-Object System.Management.Automation.PSCredential($u, $sec))
}

function New-RelayBasicAuthValue {
  param([string]$Username, [string]$Password)
  $raw = ('{0}:{1}' -f $Username, $Password)
  return ('Basic {0}' -f [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw)))
}

function New-RelayHeaders {
  param([string]$AuthValue)
  $h = @{ 'Content-Type' = 'application/json' }
  if (-not [string]::IsNullOrWhiteSpace($AuthValue)) { $h['Authorization'] = $AuthValue }
  return $h
}

# Transport unique. Contrat du mock (-HttpHandler) : scriptblock
# (Method, Url, Headers, Body-objet, TimeoutSec) -> @{ Status=int; Body=obj }.
# Le wrapper possede la classification HTTP + redaction, jamais le mock.
function Invoke-RelayHttpJson {
  param(
    [string]$Method, [string]$Url, [hashtable]$Headers,
    [object]$Body, [int]$TimeoutSec, [scriptblock]$HttpHandler = $null
  )
  if ($HttpHandler) {
    return (& $HttpHandler $Method $Url $Headers $Body $TimeoutSec)
  }
  $params = @{
    Uri = $Url; Method = $Method; TimeoutSec = $TimeoutSec
    Headers = $Headers; ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $params['Body'] = ($Body | ConvertTo-Json -Depth 12 -Compress)
    $params['ContentType'] = 'application/json'
  }
  try {
    $resp = Invoke-RestMethod @params
    return @{ Status = 200; Body = $resp }
  } catch {
    $status = $null
    $ex = $_.Exception
    if ($null -ne $ex -and $null -ne $ex.StatusCode -and ($ex -is [System.Net.Http.HttpRequestException])) {
      try { $status = [int]$ex.StatusCode } catch { $status = $null }
    }
    if ($null -eq $status -and $null -ne $ex -and $null -ne $ex.Response) {
      try { $status = [int]$ex.Response.StatusCode } catch { $status = $null }
    }
    $label = $(if ($null -ne $status) { "HTTP $status" } else { 'reseau' })
    Throw-Relay ("transport {0} : {1}" -f $label, (Redact-RelaySecret $ex.Message)) 'RELAY_HTTP' $status
  }
}

function Assert-RelayOk {
  param($Result, [string]$What)
  $st = 0
  try { $st = [int]$Result.Status } catch { $st = 0 }
  if ($st -lt 200 -or $st -ge 300) {
    $detail = ''
    try { $detail = ($Result.Body | ConvertTo-Json -Compress -Depth 6) } catch { $detail = [string]$Result.Body }
    Throw-Relay ("{0} HTTP {1} : {2}" -f $What, $st, (Redact-RelaySecret $detail)) 'RELAY_HTTP' $st
  }
  return $Result.Body
}

function Get-RelayProp {
  param($Obj, [string]$Name)
  if ($null -eq $Obj) { return $null }
  if ($Obj -is [hashtable]) {
    if ($Obj.ContainsKey($Name)) { return $Obj[$Name] }
    return $null
  }
  $prop = $Obj.PSObject.Properties[$Name]
  if ($null -ne $prop) { return $prop.Value }
  return $null
}

function Get-RelayToolIds {
  param($Body)
  $raw = $Body
  if ($Body -is [string]) {
    # Tableau a un element deroule par PowerShell a la frontiere d'un return :
    # un id isole (serveur ou mock) reste un id valide, pas une liste illisible.
    $raw = @($Body)
  } elseif ($Body -is [hashtable] -and $Body.ContainsKey('ids')) { $raw = $Body['ids'] }
  elseif ($null -ne (Get-RelayProp $Body 'ids') -and ($Body -isnot [array])) {
    $raw = Get-RelayProp $Body 'ids'
  }
  if ($raw -is [string]) { $raw = @($raw) }
  if ($raw -isnot [array]) {
    Throw-Relay 'liste d outils illisible' 'RELAY_BAD_RESPONSE'
  }
  $ids = @($raw | Where-Object { $_ -is [string] -and $_ -ne '' })
  if ($ids.Count -eq 0) {
    Throw-Relay 'liste d outils vide (refus)' 'RELAY_NO_TOOLS'
  }
  return $ids
}

function Get-RelaySessionId {
  param($Body)
  foreach ($key in @('id', 'sessionID', 'sessionId')) {
    $v = Get-RelayProp $Body $key
    if ($v -is [string] -and $v -ne '') { return $v }
  }
  $sess = Get-RelayProp $Body 'session'
  $v = Get-RelayProp $sess 'id'
  if ($v -is [string] -and $v -ne '') { return $v }
  $info = Get-RelayProp $Body 'info'
  $v = Get-RelayProp $info 'id'
  if ($v -is [string] -and $v -ne '') { return $v }
  Throw-Relay 'session sans identifiant' 'RELAY_BAD_RESPONSE'
}

function Assert-RelayNoModelError {
  param($Body)
  $raw = Get-RelayProp (Get-RelayProp $Body 'info') 'error'
  if ($null -eq $raw -or $raw -eq '' -or $raw -eq $false) { return }
  $code = 'RELAY_MODEL_ERROR'
  $message = ''
  if ($raw -is [string]) { $message = $raw }
  elseif ($raw -is [hashtable] -or $raw -is [psobject]) {
    $c = Get-RelayProp $raw 'code'
    if ($c -is [string] -and $c -ne '') { $code = $c.Substring(0, [Math]::Min(80, $c.Length)) }
    $cand = Get-RelayProp $raw 'message'
    if (-not ($cand -is [string] -and $cand -ne '')) { $cand = Get-RelayProp $raw 'text' }
    if (-not ($cand -is [string] -and $cand -ne '')) { $cand = Get-RelayProp $raw 'error' }
    if ($cand -is [string] -and $cand -ne '') { $message = $cand }
    else {
      try { $message = (@{ code = (Get-RelayProp $raw 'code'); message = (Get-RelayProp $raw 'message') } | ConvertTo-Json -Compress) }
      catch { $message = 'erreur modele' }
    }
  } else { $message = [string]$raw }
  Throw-Relay ("inference erreur modele : {0}" -f (Redact-RelaySecret $message)) 'RELAY_MODEL_ERROR'
}

function Get-RelayText {
  param($Body)
  $parts = Get-RelayProp $Body 'parts'
  if ($null -eq $parts) { Throw-Relay 'reponse sans contenu' 'RELAY_EMPTY' }
  if ($parts -isnot [array]) { $parts = @($parts) }
  $texts = @()
  foreach ($part in $parts) {
    $t = Get-RelayProp $part 'type'
    $x = Get-RelayProp $part 'text'
    if ($t -eq 'text' -and $x -is [string] -and $x -ne '') { $texts += $x }
  }
  $content = ($texts -join '')
  if ([string]::IsNullOrWhiteSpace($content)) { Throw-Relay 'reponse sans contenu' 'RELAY_EMPTY' }
  return $content
}

function Get-RelayUsage {
  param($Body)
  $info = Get-RelayProp $Body 'info'
  $u = Get-RelayProp $info 'tokens'
  if ($null -eq $u) { $u = Get-RelayProp $info 'usage' }
  if ($null -eq $u) { $u = Get-RelayProp $Body 'usage' }
  return $u
}

function New-RelaySession {
  param([string]$DesktopBase, [string]$DirEsc, [string]$AuthValue, [int]$TimeoutSec, [scriptblock]$HttpHandler = $null)
  $res = Invoke-RelayHttpJson -Method 'POST' -Url ("$DesktopBase/session?directory=$DirEsc") `
    -Headers (New-RelayHeaders $AuthValue) `
    -Body @{
      title = $script:RelayTitle
      model = @{ id = $script:RelayModelId; providerID = $script:RelayProviderId; variant = $script:RelayVariant }
      permission = @(@{ permission = '*'; pattern = '*'; action = 'deny' })
    } -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
  return (Get-RelaySessionId (Assert-RelayOk $res 'session-create'))
}

function Send-RelayDesktopMessage {
  param([string]$DesktopBase, [string]$DirEsc, [string]$SessionId, [string]$Prompt,
    [array]$ToolIds, [string]$AuthValue, [int]$TimeoutSec, [scriptblock]$HttpHandler = $null)
  $tools = @{}
  foreach ($id in $ToolIds) { $tools[$id] = $false }
  $res = Invoke-RelayHttpJson -Method 'POST' `
    -Url ("$DesktopBase/session/$([uri]::EscapeDataString($SessionId))/message?directory=$DirEsc") `
    -Headers (New-RelayHeaders $AuthValue) `
    -Body @{
      model = @{ providerID = $script:RelayProviderId; modelID = $script:RelayModelId }
      variant = $script:RelayVariant
      tools = $tools
      parts = @(@{ type = 'text'; text = $Prompt })
    } -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
  return (Assert-RelayOk $res 'session-message')
}

function Remove-RelaySession {
  param([string]$DesktopBase, [string]$DirEsc, [string]$SessionId, [string]$AuthValue, [int]$CleanupTimeoutSec, [scriptblock]$HttpHandler = $null)
  # DELETE borne, best-effort : retourne $true/$false, ne leve jamais.
  try {
    $res = Invoke-RelayHttpJson -Method 'DELETE' `
      -Url ("$DesktopBase/session/$([uri]::EscapeDataString($SessionId))?directory=$DirEsc") `
      -Headers (New-RelayHeaders $AuthValue) -Body $null -TimeoutSec $CleanupTimeoutSec -HttpHandler $HttpHandler
    $st = 0
    try { $st = [int]$res.Status } catch { $st = 0 }
    return ($st -ge 200 -and $st -lt 300)
  } catch { return $false }
}

function Stop-RelaySession {
  param([string]$DesktopBase, [string]$DirEsc, [string]$SessionId, [string]$AuthValue, [int]$CleanupTimeoutSec, [scriptblock]$HttpHandler = $null)
  # POST abort borne, best-effort (annulation/interruption), ne leve jamais.
  try {
    $res = Invoke-RelayHttpJson -Method 'POST' `
      -Url ("$DesktopBase/session/$([uri]::EscapeDataString($SessionId))/abort?directory=$DirEsc") `
      -Headers (New-RelayHeaders $AuthValue) -Body $null -TimeoutSec $CleanupTimeoutSec -HttpHandler $HttpHandler
    $st = 0
    try { $st = [int]$res.Status } catch { $st = 0 }
    return ($st -ge 200 -and $st -lt 300)
  } catch { return $false }
}

function Invoke-RelayInference {
  param(
    [string]$System = '', [string]$User = '',
    [string]$DesktopBase = '', [string]$Directory = '',
    [string]$AuthValue = '', [int]$TimeoutSec = 60, [int]$CleanupTimeoutSec = 3,
    [scriptblock]$HttpHandler = $null
  )
  if ($script:RelayStopRequested) { Throw-Relay 'appel annule' 'RELAY_ABORTED' }
  $prompt = (([string]$System) + "`n`n" + ([string]$User)).Trim()
  if ([string]::IsNullOrWhiteSpace($prompt)) { Throw-Relay 'prompt vide' 'RELAY_BAD_REQUEST' }
  $dirEsc = [uri]::EscapeDataString($Directory)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $sessionId = $null
  $record = $null
  try {
    $toolIds = Get-RelayToolIds (Assert-RelayOk (
      Invoke-RelayHttpJson -Method 'GET' -Url ("$DesktopBase/experimental/tool/ids?directory=$dirEsc") `
        -Headers (New-RelayHeaders $AuthValue) -Body $null -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler) 'tool-ids')
    $sessionId = New-RelaySession -DesktopBase $DesktopBase -DirEsc $dirEsc -AuthValue $AuthValue -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
    $answer = Send-RelayDesktopMessage -DesktopBase $DesktopBase -DirEsc $dirEsc -SessionId $sessionId `
      -Prompt $prompt -ToolIds $toolIds -AuthValue $AuthValue -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
    Assert-RelayNoModelError $answer
    $content = Get-RelayText $answer
    $record = @{
      Content = $content; Usage = (Get-RelayUsage $answer); Ms = $sw.ElapsedMilliseconds
      CleanupFailed = $false; SessionId = $null
    }
  } catch {
    $record = $_
  }
  $cleanupOk = $true
  if ($sessionId) {
    if ($record -is [System.Management.Automation.ErrorRecord]) {
      [void](Stop-RelaySession -DesktopBase $DesktopBase -DirEsc $dirEsc -SessionId $sessionId `
        -AuthValue $AuthValue -CleanupTimeoutSec $CleanupTimeoutSec -HttpHandler $HttpHandler)
    }
    $cleanupOk = Remove-RelaySession -DesktopBase $DesktopBase -DirEsc $dirEsc -SessionId $sessionId `
      -AuthValue $AuthValue -CleanupTimeoutSec $CleanupTimeoutSec -HttpHandler $HttpHandler
  }
  if ($record -is [System.Management.Automation.ErrorRecord]) {
    $ex = $record.Exception
    if ($null -eq $ex) { Throw-Relay ("inference echec : {0}" -f (Redact-RelaySecret ([string]$record))) 'RELAY_DESKTOP_ERROR' }
    if ([string]::IsNullOrWhiteSpace((Get-RelayCode $record))) {
      $wrapped = New-Object System.Exception(("inference echec : {0}" -f (Redact-RelaySecret $ex.Message)))
      $wrapped.Data['RelayCode'] = 'RELAY_DESKTOP_ERROR'
      $wrapped.Data['CleanupFailed'] = -not $cleanupOk
      $wrapped.Data['SessionId'] = $(if ($cleanupOk) { $null } else { $sessionId })
      throw $wrapped
    }
    $ex.Data['CleanupFailed'] = -not $cleanupOk
    $ex.Data['SessionId'] = $(if ($cleanupOk) { $null } else { $sessionId })
    throw $record
  }
  $record.CleanupFailed = -not $cleanupOk
  $record.SessionId = $(if ($cleanupOk) { $null } else { $sessionId })
  return $record
}

function Test-RelayJob {
  param($Job, [int]$MaxMessageBytes = 1048576)
  if ($null -eq $Job) { return $null }
  $id = [string](Get-RelayProp $Job 'id')
  $lease = [string](Get-RelayProp $Job 'leaseId')
  if ([string]::IsNullOrWhiteSpace($id) -or [string]::IsNullOrWhiteSpace($lease)) {
    Throw-Relay 'job sans id/lease' 'RELAY_BAD_JOB'
  }
  if ($id -notmatch '^[A-Za-z0-9_-]{1,128}$' -or $lease -notmatch '^[A-Za-z0-9_-]{1,128}$') {
    Throw-Relay 'job id/lease invalide (ni URL ni chemin)' 'RELAY_BAD_JOB'
  }
  $sys = [string](Get-RelayProp $Job 'system')
  $usr = [string](Get-RelayProp $Job 'user')
  if ([string]::IsNullOrWhiteSpace($sys) -and [string]::IsNullOrWhiteSpace($usr)) {
    Throw-Relay 'job sans contenu' 'RELAY_BAD_JOB'
  }
  if (([Text.Encoding]::UTF8.GetByteCount($sys) + [Text.Encoding]::UTF8.GetByteCount($usr)) -gt $MaxMessageBytes) {
    Throw-Relay 'job trop gros (>1 Mo)' 'RELAY_JOB_TOO_LARGE'
  }
  $exp = $null
  $rawExp = Get-RelayProp $Job 'expiresAt'
  if ($null -ne $rawExp -and -not [string]::IsNullOrWhiteSpace([string]$rawExp)) {
    try { $exp = [datetimeoffset]::Parse([string]$rawExp) }
    catch { Throw-Relay 'job expiresAt illisible' 'RELAY_BAD_JOB' }
  }
  # NOTE : Job.model / Job.variant / Job.directory (s'ils existent) sont
  # IGNORES : l'hote est non fiable, seuls comptent le fixe Astra High et le
  # -Directory hote.
  return @{ Id = $id; LeaseId = $lease; System = $sys; User = $usr; ExpiresAt = $exp }
}

function Request-RelayClaim {
  param([string]$QueueBase, [string]$QueueToken, [string]$WorkerId, [int]$TimeoutSec,
    [int]$MaxMessageBytes = 1048576, [scriptblock]$HttpHandler = $null)
  $res = Invoke-RelayHttpJson -Method 'POST' -Url ("$QueueBase/relay/jobs/claim") `
    -Headers (New-RelayHeaders ("Bearer $QueueToken")) -Body @{ workerId = $WorkerId } `
    -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
  $payload = Assert-RelayOk $res 'claim'
  $raw = Get-RelayProp $payload 'job'
  if ($null -eq $raw) { return $null }
  return (Test-RelayJob $raw $MaxMessageBytes)
}

function Send-RelayResult {
  param([string]$QueueBase, [string]$QueueToken, [string]$JobId, [string]$LeaseId,
    [hashtable]$Result, [int]$TimeoutSec, [scriptblock]$HttpHandler = $null)
  $res = Invoke-RelayHttpJson -Method 'POST' `
    -Url ("$QueueBase/relay/jobs/$([uri]::EscapeDataString($JobId))/result") `
    -Headers (New-RelayHeaders ("Bearer $QueueToken")) `
    -Body @{
      leaseId = $LeaseId; content = [string]$Result['Content']
      usage = $Result['Usage']; ms = [long]$Result['Ms']
      cleanupFailed = [bool]$Result['CleanupFailed']; sessionId = $Result['SessionId']
    } -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
  [void](Assert-RelayOk $res 'result')
}

function Send-RelayFail {
  param([string]$QueueBase, [string]$QueueToken, [string]$JobId, [string]$LeaseId,
    [string]$Code, [string]$Message, [bool]$CleanupFailed = $false, [string]$SessionId = $null,
    [int]$TimeoutSec = 10, [scriptblock]$HttpHandler = $null)
  # Message redacte + borne : aucun secret ne remonte a la file.
  $safe = Redact-RelaySecret $Message
  if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
  try {
    $res = Invoke-RelayHttpJson -Method 'POST' `
      -Url ("$QueueBase/relay/jobs/$([uri]::EscapeDataString($JobId))/fail") `
      -Headers (New-RelayHeaders ("Bearer $QueueToken")) `
      -Body @{ leaseId = $LeaseId; code = $Code; message = $safe; cleanupFailed = $CleanupFailed; sessionId = $SessionId } `
      -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
    [void](Assert-RelayOk $res 'fail')
    return $true
  } catch { return $false }
}

function Send-RelayCancel {
  param([string]$QueueBase, [string]$QueueToken, [string]$JobId, [string]$LeaseId,
    [int]$TimeoutSec = 10, [scriptblock]$HttpHandler = $null)
  try {
    $res = Invoke-RelayHttpJson -Method 'POST' `
      -Url ("$QueueBase/relay/jobs/$([uri]::EscapeDataString($JobId))/cancel") `
      -Headers (New-RelayHeaders ("Bearer $QueueToken")) `
      -Body @{ leaseId = $LeaseId } -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
    [void](Assert-RelayOk $res 'cancel')
    return $true
  } catch { return $false }
}

function Send-RelayResultRetry {
  param([string]$QueueBase, [string]$QueueToken, [string]$JobId, [string]$LeaseId,
    [hashtable]$Result, [int]$TimeoutSec, [int]$MaxUploadAttempts = 3, [int]$RetryDelayMs = 500,
    [scriptblock]$HttpHandler = $null)
  # Idempotence : meme lease + meme contenu a chaque tentative, JAMAIS de
  # nouvelle inference ici.
  $attempt = 0
  $lastErr = $null
  while ($attempt -lt $MaxUploadAttempts) {
    $attempt++
    try {
      Send-RelayResult -QueueBase $QueueBase -QueueToken $QueueToken -JobId $JobId `
        -LeaseId $LeaseId -Result $Result -TimeoutSec $TimeoutSec -HttpHandler $HttpHandler
      return @{ Ok = $true; Attempts = $attempt; Error = $null }
    } catch { $lastErr = $_ }
    if ($attempt -lt $MaxUploadAttempts -and $RetryDelayMs -gt 0) {
      Start-Sleep -Milliseconds $RetryDelayMs
    }
  }
  return @{ Ok = $false; Attempts = $attempt; Error = $lastErr }
}

function Start-OpenCodeRelay {
  param(
    [string]$QueueBaseUrl = '', [string]$DesktopBaseUrl = '', [string]$Directory = '',
    [string]$WorkerId = '', [int]$PollIntervalSec = 5, [int]$ClaimTimeoutSec = 10,
    [int]$DesktopTimeoutSec = 60, [int]$CleanupTimeoutSec = 3, [int]$MaxMessageBytes = 1048576,
    [int]$JobMaxAgeSec = 300, [int]$MaxUploadAttempts = 3, [int]$RetryDelayMs = 500,
    [int]$MaxIterations = 0, [switch]$Once, [scriptblock]$HttpHandler = $null
  )
  $cfg = Assert-RelayConfig $QueueBaseUrl $DesktopBaseUrl $Directory $PollIntervalSec `
    $ClaimTimeoutSec $DesktopTimeoutSec $CleanupTimeoutSec $MaxMessageBytes $JobMaxAgeSec $MaxUploadAttempts
  $queueBase = $cfg.QueueBase
  $desktopBase = $cfg.DesktopBase
  $queueToken = Get-RelayQueueToken
  $cred = Get-RelayDesktopCredential
  $basic = New-RelayBasicAuthValue $cred.UserName $cred.GetNetworkCredential().Password
  $cred = $null
  $wid = $WorkerId
  if ([string]::IsNullOrWhiteSpace($wid)) { $wid = ("{0}-{1}" -f $env:COMPUTERNAME, $PID) }
  Write-RelayLog ("worker={0} queue={1} desktop=loopback directory=[hote]" -f $wid, $queueBase)

  $cancelSub = $null
  try {
    try {
      $cancelSub = Register-ObjectEvent -InputObject ([Console]) -EventName CancelKeyPress `
        -SourceIdentifier 'OpenCodeRelayCancel' -Action { $script:RelayStopRequested = $true } -ErrorAction Stop
    } catch { $cancelSub = $null }
    $iter = 0
    while ($true) {
      if ($script:RelayStopRequested) { Write-RelayLog 'arret demande (CTRL+C)'; break }
      $iter++
      try {
        # 1. Flush du resultat en cache (upload echoue precedemment) : meme
        #    lease, meme contenu, aucune inference.
        if ($null -ne $script:RelayLastResult -and -not $script:RelayLastResult.Uploaded) {
          $cached = $script:RelayLastResult
          Write-RelayLog ("re-upload job={0} (meme lease, sans re-inference)" -f $cached.JobId)
          $up = Send-RelayResultRetry -QueueBase $queueBase -QueueToken $queueToken `
            -JobId $cached.JobId -LeaseId $cached.LeaseId -Result $cached.Result `
            -TimeoutSec $ClaimTimeoutSec -MaxUploadAttempts $MaxUploadAttempts `
            -RetryDelayMs $RetryDelayMs -HttpHandler $HttpHandler
          $cached.Uploaded = $up.Ok
          if (-not $up.Ok) { Write-RelayLog ("re-upload echoue job={0} (conserve en cache)" -f $cached.JobId) }
        } else {
          # 2. Claim : null = file vide, on attend le prochain poll.
          $job = $null
          try {
            $job = Request-RelayClaim -QueueBase $queueBase -QueueToken $queueToken -WorkerId $wid `
              -TimeoutSec $ClaimTimeoutSec -MaxMessageBytes $MaxMessageBytes -HttpHandler $HttpHandler
          } catch {
            Write-RelayLog ("claim echec : {0}" -f (Redact-RelaySecret $_.Exception.Message))
            $job = 'claim-error'
          }
          if ($job -is [string] -and $job -eq 'claim-error') {
            # File injoignable : backoff borne, resultat en cache preserve.
          } elseif ($null -eq $job) {
            Write-RelayLog 'file vide'
          } elseif ($null -ne $script:RelayLastResult -and $script:RelayLastResult.Uploaded `
              -and $script:RelayLastResult.LeaseId -eq $job.LeaseId) {
            # Meme lease deja traite : re-emission idempotente, sans inference.
            Write-RelayLog ("lease connu job={0} : re-emission sans inference" -f $job.Id)
            $up = Send-RelayResultRetry -QueueBase $queueBase -QueueToken $queueToken `
              -JobId $job.Id -LeaseId $job.LeaseId -Result $script:RelayLastResult.Result `
              -TimeoutSec $ClaimTimeoutSec -MaxUploadAttempts $MaxUploadAttempts `
              -RetryDelayMs $RetryDelayMs -HttpHandler $HttpHandler
            if (-not $up.Ok) { $script:RelayLastResult.Uploaded = $false }
          } elseif ($null -ne $job.ExpiresAt -and $job.ExpiresAt -le [datetimeoffset]::UtcNow) {
            # Expire : dead-letter, jamais d'inference.
            Write-RelayLog ("job={0} expire : dead-letter sans inference" -f $job.Id)
            [void](Send-RelayFail -QueueBase $queueBase -QueueToken $queueToken -JobId $job.Id `
              -LeaseId $job.LeaseId -Code 'JOB_EXPIRED' -Message 'job expire avant inference (dead-letter)' `
              -TimeoutSec $ClaimTimeoutSec -HttpHandler $HttpHandler)
          } else {
            $deadline = [datetimeoffset]::UtcNow.AddSeconds($JobMaxAgeSec)
            if ($null -ne $job.ExpiresAt -and $job.ExpiresAt -lt $deadline) { $deadline = $job.ExpiresAt }
            $remaining = [Math]::Max(1, [int]($deadline - [datetimeoffset]::UtcNow).TotalSeconds)
            $budget = [Math]::Min($DesktopTimeoutSec, $remaining)
            Write-RelayLog ("job={0} inference (budget {1} s)" -f $job.Id, $budget)
            try {
              $inf = Invoke-RelayInference -System $job.System -User $job.User `
                -DesktopBase $desktopBase -Directory $Directory -AuthValue $basic `
                -TimeoutSec $budget -CleanupTimeoutSec $CleanupTimeoutSec -HttpHandler $HttpHandler
              $result = @{
                Content = $inf.Content; Usage = $inf.Usage; Ms = [long]$inf.Ms
                CleanupFailed = [bool]$inf.CleanupFailed; SessionId = $inf.SessionId
              }
              if ($deadline -le [datetimeoffset]::UtcNow) {
                # Inference terminee APRES expiration : dead-letter, le
                # resultat perime n'est pas uploade comme success.
                Write-RelayLog ("job={0} expire pendant inference : dead-letter" -f $job.Id)
                [void](Send-RelayFail -QueueBase $queueBase -QueueToken $queueToken -JobId $job.Id `
                  -LeaseId $job.LeaseId -Code 'JOB_EXPIRED' -Message 'job expire pendant inference (dead-letter)' `
                  -CleanupFailed $result.CleanupFailed -SessionId $result.SessionId `
                  -TimeoutSec $ClaimTimeoutSec -HttpHandler $HttpHandler)
                $script:RelayLastResult = @{ JobId = $job.Id; LeaseId = $job.LeaseId; Result = $result; Uploaded = $true }
              } else {
                $up = Send-RelayResultRetry -QueueBase $queueBase -QueueToken $queueToken `
                  -JobId $job.Id -LeaseId $job.LeaseId -Result $result `
                  -TimeoutSec $ClaimTimeoutSec -MaxUploadAttempts $MaxUploadAttempts `
                  -RetryDelayMs $RetryDelayMs -HttpHandler $HttpHandler
                $script:RelayLastResult = @{ JobId = $job.Id; LeaseId = $job.LeaseId; Result = $result; Uploaded = $up.Ok }
                Write-RelayLog ("job={0} termine (upload ok={1}, tentatives={2})" -f $job.Id, $up.Ok, $up.Attempts)
              }
            } catch {
              $code = Get-RelayCode $_
              if ([string]::IsNullOrWhiteSpace($code)) { $code = 'RELAY_DESKTOP_ERROR' }
              $cf = $false
              $sid = $null
              try {
                if ($null -ne $_.Exception.Data -and $_.Exception.Data.Contains('CleanupFailed')) {
                  $cf = [bool]$_.Exception.Data['CleanupFailed']
                }
                if ($null -ne $_.Exception.Data -and $_.Exception.Data.Contains('SessionId')) {
                  $sid = $_.Exception.Data['SessionId']
                }
              } catch { $cf = $false; $sid = $null }
              Write-RelayLog ("job={0} echec {1} : {2}" -f $job.Id, $code, (Redact-RelaySecret $_.Exception.Message))
              [void](Send-RelayFail -QueueBase $queueBase -QueueToken $queueToken -JobId $job.Id `
                -LeaseId $job.LeaseId -Code $code -Message $_.Exception.Message `
                -CleanupFailed $cf -SessionId $sid -TimeoutSec $ClaimTimeoutSec -HttpHandler $HttpHandler)
            }
          }
        }
      } catch {
        # Garde-fou de boucle : une iteration ne tue jamais le worker.
        # STOP (CTRL+C) reste prioritaire au tour suivant.
        Write-RelayLog ("iteration echec : {0}" -f (Redact-RelaySecret $_.Exception.Message))
      }
      if ($Once) { break }
      if ($MaxIterations -gt 0 -and $iter -ge $MaxIterations) { break }
      if ($script:RelayStopRequested) { Write-RelayLog 'arret demande (CTRL+C)'; break }
      if ($PollIntervalSec -gt 0) { Start-Sleep -Seconds $PollIntervalSec }
    }
  } finally {
    if ($null -ne $cancelSub) {
      try { Unregister-Event -SourceIdentifier 'OpenCodeRelayCancel' -ErrorAction SilentlyContinue } catch {}
    }
    $basic = $null
    $queueToken = $null
    $script:RelayStopRequested = $false
  }
}

# Main : invocation directe uniquement. En dot-sourcing ('.'), on expose les
# fonctions pour les tests sans rien executer.
if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  Start-OpenCodeRelay -QueueBaseUrl $QueueBaseUrl -DesktopBaseUrl $DesktopBaseUrl `
    -Directory $Directory -WorkerId $WorkerId -PollIntervalSec $PollIntervalSec `
    -ClaimTimeoutSec $ClaimTimeoutSec -DesktopTimeoutSec $DesktopTimeoutSec `
    -CleanupTimeoutSec $CleanupTimeoutSec -MaxMessageBytes $MaxMessageBytes `
    -JobMaxAgeSec $JobMaxAgeSec -MaxUploadAttempts $MaxUploadAttempts `
    -RetryDelayMs $RetryDelayMs -MaxIterations $MaxIterations -Once:$Once -HttpHandler $HttpHandler
}
