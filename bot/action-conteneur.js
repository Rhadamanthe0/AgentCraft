'use strict'

// Deposer dans un conteneur et en retirer (A/B `coffres`, idee 5 de la revue
// du 2026-10-16). Deux gestes generaux (regle immuable, AGENTS.md) : l objet,
// la quantite et le conteneur sont des parametres. Le code trouve le
// conteneur nomme le plus proche (coffre, tonneau, boite de Shulker...), le
// rejoint a portee de main, l ouvre comme un joueur, deplace les objets puis
// le referme. Une quantite ne compte que si l inventaire la montre ensuite ;
// le contenu lu a l ouverture est retenu (un joueur se souvient de ce qu il a
// vu dans un coffre) et servi au modele dans l etat.

const skills = require('./skills')

function withTimeout (promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })
  ]).finally(() => clearTimeout(timer))
}

const RAYON = 24
const OUVERTURE_MS = 4000
const TRANSFERT_MS = 4000
const MESURE_MS = 1500
const MEMOIRE_MAX = 32
const CONTENEUR = /^(chest|trapped_chest|barrel|([a-z_]+_)?shulker_box)$/

const nomPropre = texte => String(texte ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
const cle = p => `${p.x},${p.y},${p.z}`

// Ids des conteneurs du registre, tous ou ceux d un nom (`chest`, `barrel`)
// ou d une famille (`shulker_box` : toutes les couleurs ; `chest` : coffre et
// coffre piege).
function idsConteneurs (registry, nom = null) {
  return Object.values(registry?.blocksByName ?? {})
    .filter(b => CONTENEUR.test(b.name) && (!nom || b.name === nom || b.name.endsWith(`_${nom}`) || b.name.startsWith(`${nom}_`) ||
      (nom === 'chest' && b.name === 'trapped_chest')))
    .map(b => b.id)
}

function contenuDe (fenetre) {
  const out = {}
  for (const item of fenetre?.containerItems?.() ?? []) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

function texteContenu (contenu) {
  const e = Object.entries(contenu ?? {})
  return e.length ? e.map(([n, k]) => `${k} ${n}`).join(', ') : 'vide'
}

// deps : { getBot, atteindre(bloc) -> { ok, raison }, signal,
//   resoudreObjet(texte) -> nom d objet du registre ou null,
//   correspond(objet, nomItem) -> bool (famille : planches, buches...),
//   defaut(sens) -> { objet, quantite } | null (but du brief en attente),
//   compter(sens, objet, n) }
function createConteneurs (deps) {
  // Contenu vu par position, le plus recent en dernier.
  const memoire = new Map()
  // Un transfert confirme d un cote mais non par la source ne doit pas etre
  // rejoue par le prochain appel avant resynchronisation.
  let depotEnAttente = null
  const retraitsEnAttente = new Map()
  function retenir (bloc, contenu) {
    memoire.delete(cle(bloc.position))
    memoire.set(cle(bloc.position), { nom: bloc.name, position: bloc.position.clone(), contenu, vuA: Date.now() })
    while (memoire.size > MEMOIRE_MAX) memoire.delete(memoire.keys().next().value)
  }

  // Conteneurs en vue, les plus proches d abord, avec leur contenu s il a ete
  // vu (null : jamais ouvert). Un conteneur casse sort de la memoire.
  function enVue (bot, { rayon = RAYON, count = 6 } = {}) {
    if (!bot?.entity) return []
    const ids = idsConteneurs(bot.registry)
    if (ids.length === 0) return []
    let positions = []
    try { positions = bot.findBlocks({ matching: ids, maxDistance: rayon, count }) ?? [] } catch (_) { return [] }
    for (const [k, m] of memoire) {
      const b = bot.blockAt(m.position)
      if (b && b.name !== m.nom) memoire.delete(k)
    }
    const ici = bot.entity.position
    return positions.map(p => ({ bloc: bot.blockAt(p), position: p, distance: Math.round(p.offset(0.5, 0.5, 0.5).distanceTo(ici)) }))
      .filter(x => x.bloc)
      .sort((a, b) => a.distance - b.distance)
      .map(x => ({ ...x, contenu: memoire.get(cle(x.position))?.contenu ?? null }))
  }

  // Le conteneur vise : nom (`dans`) ou le plus proche ; pour un retrait, un
  // conteneur dont le contenu vu a l objet passe avant les autres.
  function choisir (bot, dans, objet = null) {
    const nom = dans ? nomPropre(dans) : null
    if (nom && idsConteneurs(bot.registry, nom).length === 0) {
      return { erreur: `« ${nom} » n est pas un conteneur du jeu (chest, barrel, shulker_box...)${skills.suggestionNom(nom, bot.registry, { objets: false })}`, code: 'ancre_inconnue' }
    }
    const vus = enVue(bot, { count: 16 }).filter(x => !nom || idsConteneurs(bot.registry, nom).includes(x.bloc.type))
    if (vus.length === 0) return { erreur: `aucun ${nom ?? 'conteneur'} a moins de ${RAYON} blocs`, code: 'ancre_absente' }
    if (objet) {
      const avec = vus.find(x => x.contenu && Object.keys(x.contenu).some(n => deps.correspond(objet, n)))
      if (avec) return { cible: avec }
      // Contenu connu sans l objet : un conteneur jamais ouvert d abord.
      const inconnu = vus.find(x => !x.contenu)
      if (inconnu) return { cible: inconnu }
    }
    return { cible: vus[0] }
  }

  async function ouvrir (bot, bloc) {
    const atteint = await deps.atteindre(bloc)
    if (!atteint?.ok) return { erreur: `${bloc.name} en ${bloc.position.x} ${bloc.position.y} ${bloc.position.z} hors de portee (${atteint?.raison ?? 'trajet impossible'})`, code: 'pose_hors_portee' }
    if (deps.signal?.()?.aborted) return { erreur: 'interrompu', code: 'cancelled' }
    const live = deps.getBot()
    try {
      const fenetre = await withTimeout(live.openContainer(live.blockAt(bloc.position)), OUVERTURE_MS, 'ouverture trop longue')
      return { fenetre, bot: live }
    } catch (err) {
      return { erreur: `${bloc.name} refuse a l ouverture : ${err.message}`, code: 'conteneur_refuse' }
    }
  }

  const stock = (bot, objet) => (bot.inventory?.items() ?? []).filter(i => deps.correspond(objet, i.name)).reduce((n, i) => n + i.count, 0)
  const dedans = (fenetre, objet) => (fenetre.containerItems?.() ?? []).filter(i => deps.correspond(objet, i.name)).reduce((n, i) => n + i.count, 0)

  // Deplace jusqu a `voulu` objets entre la fenetre et l inventaire, une pile
  // a la fois. Le serveur confirme les cases apres coup : chaque transfert se
  // mesure sur l inventaire ET le conteneur, attendus jusqu a MESURE_MS (banc
  // 692d157, chest-pickaxe~aleatoire : pioche bien rangee, lue « sans effet »
  // aussitot, jamais comptee, la mission a tourne jusqu au plafond).
  async function transferer (bot, fenetre, sens, objet, voulu) {
    let fait = 0
    let derniere = null
    const avant = stock(bot, objet)
    const avantDedans = dedans(fenetre, objet)
    const mesurer = () => Math.max(
      sens === 'deposer' ? avant - stock(bot, objet) : stock(bot, objet) - avant,
      sens === 'deposer' ? dedans(fenetre, objet) - avantDedans : avantDedans - dedans(fenetre, objet))
    const source_ = () => sens === 'deposer' ? avant - stock(bot, objet) : avantDedans - dedans(fenetre, objet)
    for (let essai = 0; essai < 27 && fait < voulu; essai++) {
      if (deps.signal?.()?.aborted) { derniere = 'interrompu'; break }
      const source = sens === 'deposer' ? (bot.inventory?.items() ?? []) : (fenetre.containerItems?.() ?? [])
      const pile = source.find(i => deps.correspond(objet, i.name))
      if (!pile) break
      const n = Math.min(pile.count, voulu - fait)
      try {
        await withTimeout(sens === 'deposer' ? fenetre.deposit(pile.type, null, n) : fenetre.withdraw(pile.type, null, n), TRANSFERT_MS, 'transfert trop long')
      } catch (err) {
        derniere = err.message
        break
      }
      let mesure = mesurer()
      for (const fin = Date.now() + MESURE_MS; mesure <= fait && Date.now() < fin;) {
        await new Promise(resolve => setTimeout(resolve, 100))
        mesure = mesurer()
      }
      if (mesure <= fait) { derniere = 'transfert sans effet sur l inventaire ni le conteneur'; break }
      fait = mesure
      // La pile suivante se lit sur la source : attendre qu elle montre le
      // transfert, sinon un objet deja deplace repartirait une seconde fois.
      for (const fin = Date.now() + MESURE_MS; source_() < fait && Date.now() < fin;) await new Promise(resolve => setTimeout(resolve, 100))
      // Une source encore perimee risque de rejouer le meme geste au tour
      // suivant, alors que la destination l a deja confirme.
      if (source_() < fait) {
        derniere = 'source non synchronisee : arret pour eviter un transfert en double'
        break
      }
    }
    return { fait: Math.max(0, fait), derniere }
  }

  async function geste (sens, params = {}) {
    const bot = deps.getBot()
    if (!bot?.entity) return { resultat: 'bot absent', echec: true, code: 'unavailable' }
    if (sens === 'deposer' && depotEnAttente) {
      if (stock(bot, depotEnAttente.objet) > depotEnAttente.maximum) {
        return { resultat: 'deposer : source non synchronisee, attendre sa confirmation avant un nouveau depot', echec: true, code: 'conteneur_source_non_confirmee' }
      }
      depotEnAttente = null
    }
    const defaut = deps.defaut?.(sens) ?? null
    // Retrait sans objet : lire le contenu (le modele decide quoi prendre) ;
    // depot sans objet : celui que la consigne attend encore.
    const brut = params.objet ?? (sens === 'deposer' ? defaut?.objet : null) ?? null
    // Retrait sans objet : ouvrir et lire le contenu, rien ne bouge.
    if (!brut && sens === 'deposer') return { resultat: 'deposer : nommer l objet a deposer (objet)', echec: true, code: 'objet_inconnu' }
    const objet = brut ? deps.resoudreObjet(brut) : null
    if (brut && !objet) return { resultat: `objet inconnu : « ${brut} » (nom d objet Minecraft attendu)${skills.suggestionNom(brut, bot.registry, { blocs: false })}`, echec: true, code: 'objet_inconnu' }
    if (sens === 'deposer' && stock(bot, objet) === 0) return { resultat: `aucun ${objet} en inventaire : l obtenir d abord`, echec: true, code: 'objet_absent' }
    const choix = choisir(bot, params.dans, sens === 'retirer' ? objet : null)
    if (choix.erreur) return { resultat: choix.erreur, echec: true, code: choix.code }
    const bloc = choix.cible.bloc
    const o = await ouvrir(bot, bloc)
    if (o.erreur) return { resultat: o.erreur, echec: true, code: o.code }
    const { fenetre } = o
    const attenteRetrait = retraitsEnAttente.get(cle(bloc.position))
    if (sens === 'retirer' && objet && attenteRetrait) {
      if (dedans(fenetre, attenteRetrait.objet) > attenteRetrait.maximum) {
        try { fenetre.close() } catch (_) { /* deja fermee */ }
        return { resultat: 'retirer : source non synchronisee, attendre sa confirmation avant un nouveau retrait', echec: true, code: 'conteneur_source_non_confirmee' }
      }
      retraitsEnAttente.delete(cle(bloc.position))
    }
    let r = { fait: 0, derniere: null }
    const ou = `${bloc.name} en ${bloc.position.x} ${bloc.position.y} ${bloc.position.z}`
    try {
      if (objet) {
        const q = Number(params.quantite)
        const dite = Number.isFinite(q) ? Math.max(1, Math.min(256, Math.round(q))) : null
        const dispo = sens === 'deposer' ? stock(o.bot, objet)
          : Object.entries(contenuDe(fenetre)).filter(([n]) => deps.correspond(objet, n)).reduce((n, [, k]) => n + k, 0)
        // Sans quantite : le reste que la consigne attend pour cet objet,
        // sinon tout ce qui est disponible.
        const attendu = defaut && (defaut.objet === objet || deps.correspond(defaut.objet, objet)) ? defaut.quantite : null
        const voulu = Math.min(dispo, dite ?? attendu ?? dispo)
        if (voulu > 0) {
          r = await transferer(o.bot, fenetre, sens, objet, voulu)
          if (r.derniere?.startsWith('source non synchronisee')) {
            const attente = { objet, maximum: Math.max(0, dispo - r.fait) }
            if (sens === 'deposer') depotEnAttente = attente
            else retraitsEnAttente.set(cle(bloc.position), attente)
          }
        }
        else r.derniere = sens === 'retirer' ? `aucun ${objet} dans ce conteneur` : null
      }
      retenir(bloc, contenuDe(fenetre))
    } finally {
      try { fenetre.close() } catch (_) { /* deja fermee */ }
    }
    const contenu = texteContenu(memoire.get(cle(bloc.position))?.contenu)
    if (!objet) return { resultat: `${ou} ouvert : ${contenu}` }
    if (r.fait > 0) deps.compter?.(sens, objet, r.fait)
    const verbe = sens === 'deposer' ? 'depose(s) dans' : 'retire(s) de'
    const texte = `${r.fait} ${objet} ${verbe} ${ou} ; contenu : ${contenu}${r.derniere ? ` ; ${r.derniere}` : ''}`
    return r.fait > 0 ? { resultat: texte } : { resultat: texte, echec: true, code: sens === 'retirer' ? 'conteneur_sans_objet' : 'conteneur_refuse' }
  }

  return {
    deposer: params => geste('deposer', params),
    retirer: params => geste('retirer', params),
    enVue,
    oublier: () => { memoire.clear(); depotEnAttente = null; retraitsEnAttente.clear() }
  }
}

module.exports = { createConteneurs, idsConteneurs, contenuDe, texteContenu, CONTENEUR }
