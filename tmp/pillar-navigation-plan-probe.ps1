param([switch]$Run, [switch]$V2)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
if (-not $Run) { Write-Output 'Prepared only; requires source-frozen orchestrator GO.'; exit 0 }
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$name='pillar-plan-probe'
$volume='pillar-plan-probe-data'
$variant=if($V2){'v2'}else{'v1'}
$proofFile=if($V2){'pillar-navigation-plan-proof-v2.json'}else{'pillar-navigation-plan-proof.json'}
if(Test-Path (Join-Path $PSScriptRoot $proofFile)){throw 'Proof exists: never overwrite an earlier remote result'}
if (@(& docker ps -a --format '{{.Names}}') -contains $name) { throw 'Probe container exists' }
if (@(& docker volume ls --format '{{.Name}}') -contains $volume) { throw 'Probe volume exists' }
$js=@'
'use strict'
const fs=require('node:fs')
const planner=require('/candidate/planner.js')
const skills=require('/candidate/skills.js')
const memory=require('/candidate/memory.js')
const proof=JSON.parse(fs.readFileSync('/proof/tmp/pillar-navigation-final-pause.json','utf8').replace(/^\uFEFF/,''))
const oldGuidance=JSON.parse(fs.readFileSync('/proof/tmp/pillar-navigation-old-guidance.json','utf8').replace(/^\uFEFF/,''))
const s=proof.after
const state={
  consigne:{texte:s.objectifs.current.texte,precisions:[],demandeur:'Rhadamanthe0',type:'recolte',matiere:'bois',repere:'ici',porte_demandee:false,dimensions:'5 x 5 x 5',fabrication_cible:null,fabrication_quantite:null},
  quota_par_defaut:16,quota_vise:16,
  progression:{etapes_effectuees:s.mission.etapes,blocs_casses:s.mission.blocs_casses,objets_recoltes:s.mission.objets_recoltes,unites_recoltees:Math.max(s.mission.blocs_casses,s.mission.objets_recoltes),dirt_secondaire:s.mission.dirt_secondaire,fabrication_produits:0,fabrication_visee:null},
  bot:{position:s.position,vie:20,dans_liquide:false,en_deplacement:false},
  environnement:{bloc_cible_le_plus_proche:null,distance_du_bloc_cible:null,bloc_cible_a_portee:false,navigation:null,objets_au_sol_a_proximite:0,navigation_objet:null,bloc_regarde:null,cible_haute:{cible:'oak_log',denivele:7,distance:1.3},hache_recommandee:true,dirt_secondaire_admise:true,outil_necessaire:null,casse_productive:true},
  inventaire:{materiau_de_construction:'oak_planks',materiau_en_inventaire:6,matiere_brute_en_inventaire:1,dirt_en_inventaire:2,buches:1,planches:6,batons:4,etablis:1,porte_en_inventaire:0,outils:{hache:null,pioche:null,pelle:null}},
  dernieres_etapes:[
    {action:'fabriquer',resultat:'fabrication de hache impossible : Server refused to place crafting_table at (43, 66, -104): the block is still air',echec:true},
    {action:'fabriquer',resultat:'fabrication de hache impossible : Server refused to place crafting_table at (44, 65, -105): the block is still air',echec:true},
    {action:'fabriquer',resultat:'fabrication de hache impossible : wooden_axe non fabrique (echec silencieux sans consommation)',echec:true},
    {action:'fabriquer',resultat:'fabrication de hache impossible : wooden_axe non fabrique (echec silencieux sans consommation)',echec:true}
  ],chat_recent:[],livraison:{engagements:[],blocage_don:null}
}
const extra={fabrications_possibles:['planches','batons','etabli','porte','hache','pioche','pelle']}
if(process.env.PROBE_VARIANT==='v2'){
  const measured=JSON.parse(fs.readFileSync('/proof/tmp/pillar-navigation-secondary-dirt.json','utf8').replace(/^\uFEFF/,''))
  const b=measured.nearestEligible
  state.environnement.dirt_secondaire_cible=b?{nom:b.name.replace(/^minecraft:/,''),position:{x:b.x,y:b.y,z:b.z},distance:Number(b.reach.toFixed(2)),a_portee:true}:null
}
async function main(){
  for(const doc of oldGuidance.docs) skills.documentAction(doc.action,doc)
  await memory.write('travail',oldGuidance.memory.travail)
  const metadata={model:planner.MODEL,maxTokens:planner.EFFECTIVE_MAX_TOKENS,timeoutMs:Number(process.env.PLANNER_TIMEOUT_MS),limitation:'Reconstructed state from measured paused inventory/position/remaining logs and actual crafting failures; four relevant failure entries grouped, not a verbatim buildState snapshot. Candidate real catalogue plus captured production guidance overlay and contradictory work memory, and real remote planner.plan. No world connection or actions.',oldGuidanceDocs:oldGuidance.docs.length,oldWorkMemory:memory.snapshot().travail,state,extra}
  console.log('PILLAR_PLAN_INPUT '+JSON.stringify(metadata))
  const response=await planner.plan(state,'recolte','harvest',extra,null,{signal:AbortSignal.timeout(60000)})
  const checks={notFinished:!response.finished,noAxePrerequisite:!response.steps.some(step=>step.action==='fabriquer' && /hache|axe/.test(String(step.choices?.objet))),pillarWithinCurrentStock:response.steps.filter(step=>step.action==='piler').every(step=>Number(step.choices?.hauteur)<=2),nonempty:response.steps.length>0}
  console.log('PILLAR_PLAN_RESULT '+JSON.stringify({response,checks}))
}
main().catch(err=>{console.log('PILLAR_PLAN_ERROR '+JSON.stringify({error:err.message}));process.exitCode=1})
'@
$output=@();$exitStatus=1
try {
  & docker volume create $volume|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Volume creation failed'}
  $argsRun=@('compose','run','--rm','--no-deps','-T','--name',$name,'--volume',"${repo}/bot:/candidate:ro",'--volume',"${repo}:/proof:ro",'--volume',"${volume}:/data",'-e',"PROBE_VARIANT=$variant",'-e','NODE_PATH=/app/node_modules','--entrypoint','node','bot','-')
  $saved=$ErrorActionPreference;$ErrorActionPreference='Continue'
  try{$output=@($js|& docker @argsRun 2>&1|ForEach-Object{"$_"});$exitStatus=$LASTEXITCODE}finally{$ErrorActionPreference=$saved}
}finally{
  if(@(& docker ps -a --format '{{.Names}}') -contains $name){& docker rm -f $name|Out-Null}
  & docker volume rm $volume|Out-Null
  $removed=($LASTEXITCODE -eq 0)
  $inputProof=@($output|Where-Object{$_.StartsWith('PILLAR_PLAN_INPUT ')}|ForEach-Object{$_.Substring(18)|ConvertFrom-Json})
  $result=@($output|Where-Object{$_.StartsWith('PILLAR_PLAN_RESULT ')}|ForEach-Object{$_.Substring(19)|ConvertFrom-Json})
  [ordered]@{at=[DateTime]::UtcNow.ToString('o');variant=$variant;exitStatus=$exitStatus;input=$inputProof;result=$result;logs=$output;volumeRemoved=$removed}|ConvertTo-Json -Depth 65|Set-Content (Join-Path $PSScriptRoot $proofFile) -Encoding utf8
}
$output|Write-Output
if($exitStatus -ne 0){exit 1}
