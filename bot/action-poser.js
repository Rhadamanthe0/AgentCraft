'use strict'

// Poser un objet dans le monde (interrupteur A/B `poser`, demande du
// proprietaire 2026-10-10 : « c est surtout poser un objet, le type d objet
// doit etre un parametre »). Une seule action pour tout ce qui se pose sans
// plan de chantier : rail, torche, levier, cloture, bloc isole, et les objets
// qui ne sont pas des blocs (minecart, bateau) poses SUR un bloc.
//
// Le modele nomme l objet, et ou : rien (devant le bot), `de` (a cote d un
// bloc nomme, ou dessus pour un objet-entite), `de` et `vers` (une ligne de
// cases au sol d un bloc nomme a l autre). Le code trouve les blocs, calcule
// les cases, rejoint un poste a portee, pose depuis l inventaire reel, et ne
// compte une pose que si le monde la montre ensuite (bloc de l objet dans la
// case, ou entite apparue). Jamais de coordonnees du modele (prompt du plan).

const { Vec3 } = require('vec3')
const build = require('./build')
const { awaitPhysicalWithTimeout } = require('./executor')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const LIGNE_MAX = 64
const QUANTITE_MAX = 40
const ANCRE_RAYON = 48
const CASE_TIMEOUT_MS = 15000
const ENTITE_ATTENTE_MS = 2000
const ESSAIS_AUTOUR = 4
// Case ou l on peut poser : air, ou plante qu une pose remplace.
const LIBRE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$/

const nomPropre = texte => String(texte ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
const libre = block => Boolean(block && LIBRE.test(block.name))
const solide = block => Boolean(block && block.boundingBox === 'block')
const cle = p => `${p.x},${p.y},${p.z}`

// Le bloc pose par l objet : meme nom au registre (rail, torch, lever), ou
// rien (minecart, bateau : une entite ; redstone : un autre nom de bloc).
function blocDeLObjet (registry, objet) {
  return registry?.blocksByName?.[objet] ? objet : null
}

// Le bloc en place est-il l objet ? Les variantes murales comptent
// (torch -> wall_torch, redstone_torch -> redstone_wall_torch).
function correspond (nomBloc, objet) {
  if (!nomBloc || !objet) return false
  return nomBloc === objet || nomBloc.replace('wall_', '') === objet || nomBloc.replace('_wall', '') === objet
}

// Le bloc nomme le plus proche du bot, ou null. Nom de bloc du registre
// (anglais, comme dans le jeu), jamais une coordonnee.
function trouverAncre (bot, nom) {
  const id = bot.registry?.blocksByName?.[nom]?.id
  if (id === undefined) return { erreur: `« ${nom} » n est pas un bloc du jeu (nom anglais du registre attendu)`, code: 'ancre_inconnue' }
  const positions = bot.findBlocks({ matching: id, maxDistance: ANCRE_RAYON, count: 32 }) ?? []
  if (positions.length === 0) return { erreur: `aucun bloc ${nom} a moins de ${ANCRE_RAYON} blocs`, code: 'ancre_absente' }
  const ici = bot.entity.position
  const p = [...positions].sort((a, b) => a.distanceTo(ici) - b.distanceTo(ici))[0]
  return { bloc: bot.blockAt(p) }
}

// Case de pose pour une extremite de ligne : le bloc lui-meme s il ne bouche
// pas (rail, plante), sinon la case juste au-dessus.
function caseDepuis (bot, bloc) {
  return solide(bloc) ? bloc.position.offset(0, 1, 0) : bloc.position.clone()
}

// Une case de ligne en (x, z) : la hauteur la plus proche de `yPrec` (a un
// bloc pres) ou la case est libre ou deja occupee par un objet non plein,
// avec un appui plein dessous.
function caseAuSol (bot, x, z, yPrec) {
  for (const dy of [0, 1, -1]) {
    const p = new Vec3(x, yPrec + dy, z)
    const ici = bot.blockAt(p)
    if (ici && !solide(ici) && solide(bot.blockAt(p.offset(0, -1, 0)))) return p
  }
  return null
}

// Cases d une ligne au sol de `a` a `b` (cases de pose) : droite si alignees,
// sinon en L (x d abord, puis z). Rend { cases } ou { erreur } a la premiere
// case sans appui (trou, mur).
function casesLigne (bot, a, b) {
  const cases = []
  let y = a.y
  const pas = (de, vers) => Math.sign(vers - de)
  const points = []
  let x = a.x
  let z = a.z
  points.push([x, z])
  while (x !== b.x && points.length <= LIGNE_MAX) { x += pas(x, b.x); points.push([x, z]) }
  while (z !== b.z && points.length <= LIGNE_MAX) { z += pas(z, b.z); points.push([x, z]) }
  if (points.length > LIGNE_MAX) return { erreur: `ligne de ${points.length} cases : ${LIGNE_MAX} au plus` }
  for (const [px, pz] of points) {
    const p = caseAuSol(bot, px, pz, y)
    if (!p) return { erreur: `ligne coupee en ${px} ${pz} : ni sol ni place (trou ou mur)`, cases }
    cases.push(p)
    y = p.y
  }
  return { cases }
}

// Cases voisines d un bloc, a sa hauteur s il ne bouche pas (rail), sinon a
// celle d au-dessus, puis le dessus lui-meme : libres et appuyees.
function casesVoisines (bot, bloc) {
  const base = solide(bloc) ? bloc.position.offset(0, 1, 0) : bloc.position
  const cases = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => base.offset(dx, 0, dz))
  if (solide(bloc)) cases.push(base.clone())
  const ici = bot.entity.position
  return cases
    .filter(p => libre(bot.blockAt(p)) && solide(bot.blockAt(p.offset(0, -1, 0))))
    .sort((p, q) => p.offset(0.5, 0.5, 0.5).distanceTo(ici) - q.offset(0.5, 0.5, 0.5).distanceTo(ici))
}

// La case devant le bot, au niveau des pieds (ou une marche plus bas).
function caseDevant (bot) {
  const p = bot.entity.position
  const yaw = bot.entity.yaw ?? 0
  const x = Math.floor(p.x - Math.sin(yaw) * 1.5)
  const z = Math.floor(p.z - Math.cos(yaw) * 1.5)
  return caseAuSol(bot, x, z, Math.floor(p.y))
}

// Sans lieu nomme : la case devant le bot d abord, puis les cases au sol
// autour de lui (deux blocs au plus), les plus proches d abord, jamais celle
// de son corps. Face a un mur (cabane finie, torche a poser), la seule case
// devant etait pleine : « aucune case » alors que le sol autour etait libre.
function casesAutour (bot) {
  const p = bot.entity.position
  const y = Math.floor(p.y)
  const vues = new Set()
  const cases = []
  const ajouter = c => {
    if (!c || vues.has(cle(c)) || build.bodyOverlaps(p, c)) return
    vues.add(cle(c))
    cases.push(c)
  }
  ajouter(caseDevant(bot))
  const autour = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx || dz) autour.push(caseAuSol(bot, Math.floor(p.x) + dx, Math.floor(p.z) + dz, y))
    }
  }
  autour.filter(Boolean)
    .sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(p) - b.offset(0.5, 0.5, 0.5).distanceTo(p))
    .forEach(ajouter)
  return cases
}

// deps : { getBot, enInventaire(objet) -> item|null, rejoindre(stand) -> bool,
//   signal, resoudreObjet(texte) -> nom d objet du registre ou null,
//   reservee(case) -> bool : case qu un chantier doit encore remplir }
function createPoser (deps) {
  // Rejoint un poste d ou la case est a portee, corps hors de la case.
  async function aPortee (bot, cellule, verifier) {
    verifier()
    const centre = cellule.offset(0.5, 0.5, 0.5)
    const ici = bot.entity.position
    if (bot.entity.onGround !== false && !build.bodyOverlaps(ici, cellule) &&
      ici.offset(0, 1.62, 0).distanceTo(centre) <= build.PLACE_REACH) return true
    for (const v of build.findVantages(bot, cellule).filter(v => !v.perche).slice(0, 3)) {
      verifier()
      const rejoint = await deps.rejoindre(v.stand).catch(() => false)
      verifier()
      if (rejoint) return true
    }
    return false
  }

  // Pose un bloc-objet dans `cellule`, appuye sur le bloc du dessous.
  async function poserBloc (bot, cellule, item, objet, verifier) {
    if (correspond(bot.blockAt(cellule)?.name, objet)) return { deja: true }
    if (!libre(bot.blockAt(cellule))) return { erreur: `case ${cellule.x} ${cellule.y} ${cellule.z} occupee (${bot.blockAt(cellule)?.name})` }
    const appui = bot.blockAt(cellule.offset(0, -1, 0))
    if (!solide(appui)) return { erreur: 'aucun appui sous la case' }
    // Jamais s enfermer (piege 5) : un objet plein qui fermerait la derniere
    // sortie a pied n est pas pose.
    if (bot.registry?.blocksByName?.[objet]?.boundingBox === 'block' && build.enclosureBy(bot, cellule)) {
      return { erreur: 'cette pose enfermerait le bot', code: 'enfermement' }
    }
    if (!await aPortee(bot, cellule, verifier)) return { erreur: 'aucun poste a portee de la case n est rejoint', code: 'pose_hors_portee' }
    try {
      verifier()
      await bot.equip(item, 'hand')
      verifier()
      await bot.lookAt(cellule.offset(0.5, 0.2, 0.5), true)
      verifier()
      await bot.placeBlock(appui, new Vec3(0, 1, 0))
    } catch (err) {
      verifier()
      if (!correspond(bot.blockAt(cellule)?.name, objet)) return { erreur: `pose refusee : ${err.message}` }
    }
    return correspond(bot.blockAt(cellule)?.name, objet) ? { pose: true } : { erreur: 'pose refusee par le serveur (case toujours vide)' }
  }

  // Pose un objet-entite (minecart, bateau...) SUR `bloc` : clic droit, puis
  // une entite du type attendu et la consommation de cet objet font foi.
  async function poserEntite (bot, bloc, item, objet, verifier) {
    const centre = bloc.position.offset(0.5, 0.5, 0.5)
    const voisines = () => new Set(Object.values(bot.entities ?? {})
      .filter(e => e !== bot.entity && e.name === objet && bot.registry?.entitiesByName?.[objet] && e.position?.distanceTo(centre) <= 2)
      .map(e => e.id))
    if (!await aPortee(bot, bloc.position, verifier)) return { erreur: 'aucun poste a portee du bloc n est rejoint', code: 'pose_hors_portee' }
    const avant = voisines()
    const stock = () => bot.inventory.items().filter(i => i.name === objet).reduce((n, i) => n + i.count, 0)
    const stockAvant = stock()
    try {
      verifier()
      await bot.equip(item, 'hand')
      verifier()
      await bot.lookAt(centre, true)
      verifier()
      await bot.activateBlock(bloc, new Vec3(0, 1, 0))
    } catch (err) {
      verifier()
      return { erreur: `usage refuse : ${err.message}` }
    }
    const fin = Date.now() + ENTITE_ATTENTE_MS
    while (Date.now() < fin) {
      verifier()
      if ([...voisines()].some(id => !avant.has(id)) &&
          stock() < stockAvant) return { pose: true }
      await sleep(100)
    }
    return { erreur: 'aucune entite apparue : objet refuse par le serveur sur ce bloc' }
  }

  async function poser (params = {}) {
    const bot = deps.getBot()
    if (!bot?.entity) return { resultat: 'bot absent', echec: true, code: 'unavailable' }
    const objet = deps.resoudreObjet(params.objet)
    if (!objet) return { resultat: `objet inconnu : « ${params.objet ?? ''} » (nom d objet Minecraft attendu)`, echec: true, code: 'objet_inconnu' }
    if (!deps.enInventaire(objet)) return { resultat: `aucun ${objet} en inventaire : l obtenir d abord`, echec: true, code: 'objet_absent' }
    const blocObjet = blocDeLObjet(bot.registry, objet)

    let ancre = null
    if (params.de) {
      const r = trouverAncre(bot, nomPropre(params.de))
      if (r.erreur) return { resultat: r.erreur, echec: true, code: r.code }
      ancre = r.bloc
    }
    let cibles
    let ligne = false
    // Cases autour du bot : une case ratee (hors portee, refusee) passe a la
    // suivante, quelques-unes au plus.
    let autour = false
    if (!blocObjet) {
      // Objet-entite : pose SUR le bloc nomme, sinon sur l appui devant soi.
      const support = ancre ?? (() => { const c = caseDevant(bot); return c ? bot.blockAt(c.offset(0, -1, 0)) : null })()
      if (!support) return { resultat: 'aucun bloc ou poser l objet devant le bot', echec: true, code: 'aucune_case' }
      cibles = [support]
    } else if (ancre && params.vers) {
      const r = trouverAncre(bot, nomPropre(params.vers))
      if (r.erreur) return { resultat: r.erreur, echec: true, code: r.code }
      const l = casesLigne(bot, caseDepuis(bot, ancre), caseDepuis(bot, r.bloc))
      if (l.erreur && !(l.cases?.length)) return { resultat: l.erreur, echec: true, code: 'aucune_case' }
      cibles = l.cases
      ligne = true
    } else if (ancre) {
      cibles = casesVoisines(bot, ancre)
    } else {
      cibles = casesAutour(bot)
      autour = true
    }
    if (blocObjet) {
      // Cases deja faites ou prises par autre chose : sautees, jamais cassees.
      // Une case reservee (bloc ou porte d un chantier encore a poser) aussi :
      // une torche posee sur un mur, dans la case du toit, bloquait le toit
      // (composite/lit-cabin~avec-poser 86680bd : 25 min de « the block is
      // still torch »).
      cibles = cibles.filter(c => libre(bot.blockAt(c)) && !deps.reservee?.(c))
    }
    if (autour) cibles = cibles.slice(0, ESSAIS_AUTOUR)
    if (cibles.length === 0) {
      return ligne
        ? { resultat: `ligne deja couverte : aucune case libre entre ${params.de} et ${params.vers}`, code: 'plan' }
        : { resultat: 'aucune case libre et appuyee ou poser', echec: true, code: 'aucune_case' }
    }
    const demande = Number.isFinite(Number(params.quantite))
      ? Math.max(1, Math.min(QUANTITE_MAX, Math.round(Number(params.quantite))))
      : (ligne ? Math.min(QUANTITE_MAX, cibles.length) : 1)

    let poses = 0
    let derniere = null
    for (const cible of cibles) {
      if (poses >= demande || deps.signal?.()?.aborted) break
      const item = deps.enInventaire(objet)
      if (!item) { derniere = `plus de ${objet} en inventaire`; break }
      const controller = new AbortController()
      const signal = deps.signal?.()
      const verifier = () => {
        if (controller.signal.aborted || signal?.aborted) {
          const err = new Error('pose interrompue')
          err.code = 'cancelled'
          throw err
        }
      }
      let r
      try {
        r = await awaitPhysicalWithTimeout(
          blocObjet ? poserBloc(bot, cible, item, objet, verifier) : poserEntite(bot, cible, item, objet, verifier),
          CASE_TIMEOUT_MS, 'pose trop longue', { signal, onTimeout: () => controller.abort() })
      } catch (err) {
        derniere = err.message
        // Ne jamais lancer une autre case apres timeout/annulation. La vraie
        // operation est deja terminee : le writer peut maintenant etre rendu.
        break
      }
      if (r.pose) poses += 1
      else if (r.erreur) {
        derniere = r.erreur
        // Ligne ou cases autour du bot : une case ratee n arrete pas les
        // suivantes ; a cote d un bloc nomme, une seule case visee.
        if ((!ligne && !autour) || r.code === 'enfermement') break
      }
    }
    if (poses > 0) deps.compter?.(objet, poses)
    const reste = ligne ? cibles.length - poses : null
    const texte = `${poses} ${objet} pose(s)` + (ligne ? `, ${reste} case(s) de la ligne encore libre(s)` : '') +
      (derniere ? ` ; ${derniere}` : '')
    return poses > 0 ? { resultat: texte } : { resultat: texte, echec: true, code: 'pose_refusee' }
  }

  return { poser }
}

module.exports = {
  casesAutour, createPoser, casesLigne, casesVoisines, correspond, trouverAncre, caseDepuis, nomPropre }
