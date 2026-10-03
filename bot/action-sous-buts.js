'use strict'

// Sous-buts (interrupteur sous_buts, eteint par defaut ; A/B sur les
// composites) : le modele choisit QUOI faire (batir, obtenir), le code le
// conduit jusqu au bout avec les actions existantes, guide par ce qu il mesure
// deja (besoins du chantier, plan du solveur de prerequis). Le modele n est
// rappele qu a la fin, ou au premier echec, qui remonte tel quel avec son code
// et ses remedes : le code ne decide jamais d un autre but a sa place.
//
// Chaque tour relit l etat mesure et joue UNE action ; trois tours sans le
// moindre changement mesure (blocs poses, inventaire, plan) arretent le
// sous-but, dit. Bornes : tours et duree.

// R19 : bornes de la boucle autonome (bot/config.js), garde-fous critiques
// comme GESTE_MAX_STEPS / MAX_DURATION_MS : valeur renseignee mais invalide
// => demarrage refuse, jamais de borne NaN qui desactiverait la boucle.
const config = require('./config')

const TOURS_MAX = config.positiveIntOrThrow(process.env.MISSION_SOUS_BUT_TOURS, 30, 'MISSION_SOUS_BUT_TOURS')
const DUREE_MAX_MS = config.positiveIntOrThrow(process.env.MISSION_SOUS_BUT_MAX_MS, 600000, 'MISSION_SOUS_BUT_MAX_MS')
const SANS_PROGRES_MAX = 3

// Le prochain geste d un chantier, d apres ce que le code mesure. Rend
// { action, params } ou { fini } ou { bloque }.
function prochainGesteChantier (e) {
  if (e.arbreInacheve) return { action: 'recolter', params: { quantite: 16 }, pourquoi: 'arbre commence a finir' }
  if (!e.planChoisi) return { action: 'choisir_terrain', params: {}, pourquoi: 'aucun emplacement' }
  const b = e.besoins ?? {}
  if (e.restants > 0) {
    if (e.stock > 0) return { action: 'construire', params: { quantite: Math.min(40, e.stock, e.restants) }, pourquoi: 'materiau en poche' }
    if ((b.planches_a_fabriquer ?? 0) > 0 && (b.buches_en_poche ?? 0) > 0) {
      return { action: 'fabriquer', params: { objet: 'planches', quantite: Math.min(b.planches_a_fabriquer, b.buches_en_poche * 4) }, pourquoi: 'planches a fabriquer' }
    }
    if ((b.buches_a_recolter ?? 0) > 0) return { action: 'recolter', params: { quantite: Math.min(16, b.buches_a_recolter) }, pourquoi: 'buches a recolter' }
    if (e.etapeSolveur) return { action: e.etapeSolveur.action, params: e.etapeSolveur.params, pourquoi: 'outil exige par la matiere' }
    if ((b.a_obtenir ?? 0) > 0) return { action: 'recolter', params: { quantite: Math.min(16, b.a_obtenir) }, pourquoi: 'materiau a obtenir' }
    return { bloque: `${e.restants} bloc(s) a poser, aucun materiau en poche ni moyen mesure d en obtenir` }
  }
  if (e.porteVoulue && !e.portePosee) {
    if (!e.porteEnPoche) {
      // besoins compte les planches de la porte : les murs ont pu prendre
      // celles en poche (vu au banc ec97eb4 : « buche x1 a recolter »).
      if ((b.planches_a_fabriquer ?? 0) > 0 && (b.buches_en_poche ?? 0) > 0) {
        return { action: 'fabriquer', params: { objet: 'planches', quantite: Math.min(b.planches_a_fabriquer, b.buches_en_poche * 4) }, pourquoi: 'planches de la porte' }
      }
      if ((b.buches_a_recolter ?? 0) > 0) return { action: 'recolter', params: { quantite: Math.min(16, b.buches_a_recolter) }, pourquoi: 'buches de la porte' }
      return { action: 'fabriquer', params: { objet: 'porte', quantite: 1 }, pourquoi: 'porte a fabriquer' }
    }
    return { action: 'poser_porte', params: {}, pourquoi: 'porte a poser' }
  }
  return { fini: true }
}

// Le prochain geste vers l objet du solveur : sa premiere etape faisable.
function prochainGesteSolveur (plan, faisable) {
  if (!plan) return { bloque: 'aucun objet a obtenir pour cette mission (ni fabrication demandee, ni outil manquant)', code: 'obtenir_sans_cible' }
  const etapes = plan.etapes ?? []
  if (etapes.length === 0) return { fini: true }
  const i = etapes.findIndex((s, k) => s.op !== 'recolter' || faisable(etapes, s, k))
  if (i < 0) return { bloque: `aucune etape faisable : ${plan.bloque?.map(b => b.objet).join(', ') || 'outil a obtenir ailleurs'}`, code: 'obtenir_bloque' }
  const s = etapes[i]
  if (s.op === 'recolter') return { action: 'recolter', params: { quantite: Math.max(1, Math.min(16, s.quantite ?? 1)) }, pourquoi: `${s.quantite ?? 1} ${s.objet ?? s.matiere}` }
  return { action: s.op, params: { objet: s.objet, quantite: s.quantite ?? 1 }, pourquoi: `${s.op} ${s.objet}` }
}

// deps :
//   getMission() ; actions() -> table ACTIONS (lue a l appel : contrats compris) ;
//   etatChantier() -> { arbreInacheve, planChoisi, restants, stock, besoins,
//     porteVoulue, portePosee, porteEnPoche, etapeSolveur } ;
//   planSolveur() -> plan du solveur ; recolteFaisable(etapes, s, i) ;
//   empreinte() -> chaine qui change quand quelque chose de mesure change ;
//   reparation(code, action) -> [{ action, params, pourquoi }] ou null :
//     remedes mesures d un geste rate (mission.remedesMesures, la table de la
//     boucle de mission), joues UNE fois par code entre deux
//     progres mesures ; s ils reussissent tous, le sous-but reprend, sinon
//     l echec d origine remonte.
function createSousButs (deps) {
  const { getMission, actions, etatChantier, planSolveur, recolteFaisable, empreinte, reparation = () => null, now = () => Date.now() } = deps

  async function conduire (nom, prochain) {
    const mission = getMission()
    const debut = now()
    const journal = []
    let derniere = empreinte()
    let sansProgres = 0
    const repares = new Set()
    for (let tour = 0; tour < TOURS_MAX; tour += 1) {
      if (!mission || mission.cancelled || getMission() !== mission) return { resultat: `${nom} interrompu`, echec: true, code: 'cancelled' }
      if (now() - debut > DUREE_MAX_MS) break
      const g = prochain()
      if (g.fini) {
        return { resultat: `${nom} accompli en ${journal.length} geste(s)${journal.length ? ` : ${journal.slice(-6).join(', ')}` : ''}` }
      }
      if (g.bloque) {
        return { resultat: `${nom} : ${g.bloque}${journal.length ? ` (apres ${journal.slice(-6).join(', ')})` : ''}`, echec: true, code: g.code ?? `${nom}_bloque` }
      }
      const r = await actions()[g.action](null, g.params)
      journal.push(`${g.action}${g.params.quantite ? ` ${g.params.quantite}` : ''}${g.params.objet ? ` ${g.params.objet}` : ''}${r?.echec ? ' (echec)' : ''}`)
      const remedes = r?.echec && !repares.has(r.code) ? reparation(r.code, g.action) : null
      if (remedes?.length) {
        repares.add(r.code)
        let repare = true
        for (const remede of remedes) {
          if (mission.cancelled) break
          const rr = await actions()[remede.action](null, remede.params)
          journal.push(`${remede.action} (${remede.pourquoi})${rr?.echec ? ' (echec)' : ''}`)
          if (rr?.echec) { repare = false; break }
        }
        if (repare) continue
      }
      if (r?.echec) {
        // Le code de l action qui a echoue (ou son code generique) : ses
        // remedes sont ceux du geste rate, pas ceux du sous-but entier.
        return { ...r, code: r.code ?? `${g.action}_echec`,
          resultat: `${nom} arrete sur ${g.action} (${g.pourquoi}) : ${r.resultat}${journal.length > 1 ? ` ; avant : ${journal.slice(-6, -1).join(', ')}` : ''}` }
      }
      const apres = empreinte()
      // Un progres mesure rouvre les remedes (arbre suivant : nouveau tronc haut).
      if (apres !== derniere) repares.clear()
      sansProgres = apres === derniere ? sansProgres + 1 : 0
      derniere = apres
      if (sansProgres >= SANS_PROGRES_MAX) {
        return { resultat: `${nom} sans progres mesure apres ${journal.slice(-SANS_PROGRES_MAX).join(', ')}`, echec: true, code: `${nom}_sans_progres` }
      }
    }
    return { resultat: `${nom} inacheve (bornes atteintes) : ${journal.slice(-6).join(', ')}`, echec: journal.length === 0, code: `${nom}_borne` }
  }

  return {
    // Chantier du debut a la fin : terrain, arbre commence, buches, planches,
    // pose, porte.
    batir: () => conduire('batir', () => prochainGesteChantier(etatChantier())),
    // Objet du solveur (fabrication demandee, ou outil exige par la matiere).
    obtenir: () => conduire('obtenir', () => prochainGesteSolveur(planSolveur(), recolteFaisable))
  }
}

module.exports = { createSousButs, prochainGesteChantier, prochainGesteSolveur, TOURS_MAX }
