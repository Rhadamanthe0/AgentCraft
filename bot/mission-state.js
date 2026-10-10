'use strict'

// Etat persiste d une mission, declare une seule fois.
//
// Un champ qui doit survivre a une revision ou a un redemarrage est declare
// ici, avec sa lecture (validation d une valeur venue du disque ou d une
// mission precedente) et son ecriture (forme JSON simple). Le descripteur de
// reprise (progressSnapshot) et la restauration (revision, rehydrate)
// derivent tous deux de ce schema : un champ ajoute ici est persiste ET
// restaure, sans deuxieme liste a tenir (vu le 2026-10-01 :
// arbreInventaireDepart ajoute au descripteur et oublie a la restauration,
// la reprise perdait la preuve de collecte).

const Vec3 = require('vec3').Vec3

// Plain integer coordinates only; anything else is dropped.
function celluleValide (c) {
  return c && [c.x, c.y, c.z].every(Number.isInteger) ? { x: c.x, y: c.y, z: c.z } : null
}
const cellules = value => Array.isArray(value) ? value.map(celluleValide).filter(Boolean) : []

// Types de champs : lire(valeur, source, dejaLus) -> valeur de mission ;
// ecrire(valeur) -> JSON. `dejaLus` donne les champs precedents du schema
// (ordre de declaration), pour une validation qui depend d un autre champ.
const T = {
  cellule: { lire: v => celluleValide(v), ecrire: v => celluleValide(v) },
  cellulesOuNull: { lire: v => Array.isArray(v) ? cellules(v) : null, ecrire: v => v ?? null },
  vecteurs: {
    lire: v => cellules(v).map(c => new Vec3(c.x, c.y, c.z)),
    ecrire: v => (v ?? []).map(celluleValide).filter(Boolean)
  },
  ids: { lire: v => Array.isArray(v) ? v.filter(id => typeof id === 'string') : [], ecrire: v => v ?? [] },
  compte: { lire: v => Math.max(0, Number(v) || 0), ecrire: v => v ?? 0 },
  finiOuNull: { lire: v => Number.isFinite(v) ? v : null, ecrire: v => v ?? null },
  // Etat de travail jamais persiste : remis a neuf a chaque restauration.
  vide: { lire: () => ({}), persiste: false }
}

// Coupes de l arbre. Les anciens descripteurs ajoutaient une source seulement
// apres une coupe mesuree : leur identifiant stable permet de reprendre sans
// inventer un spawn.
const sourcesArbre = {
  lire: (value, source) => Array.isArray(value) ? value
    .filter(c => celluleValide(c) && typeof c.objet === 'string')
    .map((c, index) => ({ ...celluleValide(c), objet: c.objet,
      id: typeof c.id === 'string' ? c.id : `legacy-cut:${index}`,
      confirmee: c.confirmee === true || (c.confirmee === undefined && c.id === undefined && index < Number(source?.arbreCoupes)),
      ouverte: false, ambigu: c.ambigu === true, drop: typeof c.drop === 'string' ? c.drop : null })) : [],
  ecrire: v => v
}

// Objets tombes de l arbre ; une ancienne entree sans source se rattache a la
// seule coupe confirmee qui lui correspond.
const spawnsArbre = {
  lire: (value, _source, lus) => {
    const sources = lus.arbreSources ?? []
    return Array.isArray(value) ? value
      .filter(c => typeof c.id === 'string' && [c.x, c.y, c.z].every(Number.isFinite))
      .map(c => {
        const legacy = sources.filter(cut => cut.confirmee &&
          (cut.drop === c.id || (!cut.drop && (!c.objet || c.objet === cut.objet) &&
            Math.hypot(c.x - cut.x - 0.5, c.y - cut.y - 0.5, c.z - cut.z - 0.5) <= 0.9)))
        return { id: c.id, x: c.x, y: c.y, z: c.z, objet: typeof c.objet === 'string' ? c.objet : null,
          source: typeof c.source === 'string' ? c.source : (legacy.length === 1 ? legacy[0].id : null),
          collectedByBot: c.collectedByBot === true, collectCount: Number.isFinite(c.collectCount) ? c.collectCount : null,
          collectPosition: c.collectPosition ? { ...c.collectPosition } : null,
          gone: c.gone === true, tiers: c.tiers === true,
          fin: c.fin && [c.fin.x, c.fin.y, c.fin.z].every(Number.isFinite) ? { ...c.fin } : null }
      }) : []
  },
  ecrire: v => v
}

const baselineArbre = {
  lire: v => Array.isArray(v)
    ? v.filter(c => typeof c.id === 'string' && typeof c.objet === 'string' && Number.isFinite(c.count)).map(c => ({ ...c }))
    : [],
  ecrire: v => v
}

// Arbre commence (ou demande) et son echafaudage : porte a travers une
// revision ou un redemarrage (regle du joueur : arbre commence, arbre fini).
const SUIVI_ARBRE = {
  tree: T.cellule,
  buchesArbreDemande: T.cellulesOuNull,
  dropsArbreDemande: T.ids,
  arbreEntitiesInitial: T.ids,
  arbreSources: sourcesArbre,
  arbreSpawns: spawnsArbre,
  arbreBaseline: baselineArbre,
  arbreCoupes: T.compte,
  arbreCollectes: T.compte,
  arbreInventaireDepart: T.finiOuNull,
  arbreCollecteIds: T.ids,
  arbreEnCours: T.cellule,
  buchesArbre: T.cellulesOuNull,
  echafaudageEnAttente: T.vecteurs,
  echafaudageEssais: T.vide,
  echafaudagePose: T.vecteurs
}

// Ce que la reprise relit du descripteur, hors arbre, livraison, route et
// dimensions (validations propres dans rehydrate). Les bornes viennent de
// mission.js (quota par defaut, quantite de fabrication).
function schemaReprise ({ landmarks = {}, defaultQuota = 16, craftMin = 1, craftMax = 16 } = {}) {
  const texte = { lire: v => typeof v === 'string' ? v : null, ecrire: v => v ?? null }
  const vrai = { lire: v => v === true, ecrire: v => v }
  return {
    kind: { lire: v => v, ecrire: v => v },
    resource: { lire: v => v, ecrire: v => v },
    landmark: { lire: v => (v && Object.prototype.hasOwnProperty.call(landmarks, v)) ? v : 'ici', ecrire: v => v },
    quota: { lire: v => Number.isFinite(Number(v)) ? Number(v) : defaultQuota, ecrire: v => v },
    quotaExplicite: vrai,
    wholeTree: vrai,
    pendingJoin: vrai,
    fabricationCible: texte,
    fabricationQuantite: {
      lire: v => Number.isFinite(Number(v)) && v !== null ? Math.max(craftMin, Math.min(craftMax, Math.round(Number(v)))) : 1,
      ecrire: v => v ?? null
    },
    // Objets a poser (A/B `poser`) et poses verifiees par objet.
    poses: {
      lire: v => Array.isArray(v) ? v.filter(p => typeof p?.objet === 'string')
        .map(p => ({ objet: p.objet, quantite: Number.isInteger(p.quantite) ? p.quantite : null })) : [],
      ecrire: v => v ?? []
    },
    posesFaites: {
      lire: v => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).filter(([, n]) => Number.isFinite(n) && n >= 0))
        : {},
      ecrire: v => v ?? {}
    },
    fabricationInitial: {
      lire: v => Number.isFinite(Number(v)) && v !== null ? Math.max(0, Math.round(Number(v))) : 0,
      ecrire: v => v ?? 0
    }
  }
}

function restaurer (schema, source) {
  const lus = {}
  for (const [champ, type] of Object.entries(schema)) lus[champ] = type.lire(source?.[champ], source, lus)
  return lus
}

function serialiser (schema, mission) {
  const out = {}
  for (const [champ, type] of Object.entries(schema)) {
    if (type.persiste === false) continue
    out[champ] = type.ecrire(mission?.[champ])
  }
  return out
}

module.exports = { T, SUIVI_ARBRE, schemaReprise, celluleValide, restaurer, serialiser }
