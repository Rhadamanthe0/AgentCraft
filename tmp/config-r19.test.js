'use strict'
// R19 : le parsing central (bot/config.js) ne laisse jamais passer un
// NaN / infini silencieux vers les garde-fous.
// Cas couverts : valeur normale, zero, negatif, 'abc', Infinity, decimal pour
// un entier attendu, tres grande valeur. + refus de demarrage (OrThrow) sur
// garde-fou critique invalide, repli + warning sinon, config effective sans
// secrets.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const config = require('../bot/config')

function silence () {
  const warnings = []
  const errors = []
  const logs = []
  const origWarn = console.warn
  const origLog = console.log
  console.warn = msg => warnings.push(String(msg))
  console.log = msg => logs.push(String(msg))
  return {
    warnings,
    logs,
    errors,
    restore () { console.warn = origWarn; console.log = origLog }
  }
}

test('finiteNumber : normale, zero, negatif, invalides', () => {
  const s = silence()
  try {
    config._clearRegistry()
    assert.equal(config.finiteNumber('12', 60, 'T_FIN_NORM'), 12)
    assert.equal(config.finiteNumber('0', 60, 'T_FIN_ZERO'), 0)
    assert.equal(config.finiteNumber('-3', 60, 'T_FIN_NEG'), -3)
    assert.equal(config.finiteNumber('abc', 60, 'T_FIN_ABC'), 60)
    assert.equal(config.finiteNumber('Infinity', 60, 'T_FIN_INF'), 60)
    assert.equal(config.finiteNumber(Infinity, 60, 'T_FIN_INF2'), 60)
    assert.equal(config.finiteNumber(NaN, 60, 'T_FIN_NAN'), 60)
    assert.equal(config.finiteNumber(undefined, 60, 'T_FIN_UNSET'), 60)
    assert.equal(config.finiteNumber('', 60, 'T_FIN_EMPTY'), 60)
    assert.equal(config.finiteNumber(null, 60, 'T_FIN_NULL'), 60)
    assert.equal(config.finiteNumber(true, 60, 'T_FIN_BOOL'), 60)
    // 'abc' / 'Infinity' replient avec warning, l absence sans warning.
    assert.ok(s.warnings.some(w => w.includes('T_FIN_ABC')), 'warning abc')
    assert.ok(s.warnings.some(w => w.includes('T_FIN_INF')), 'warning Infinity')
    assert.ok(!s.warnings.some(w => w.includes('T_FIN_UNSET')), 'pas de warning si absent')
    assert.ok(!s.warnings.some(w => w.includes('T_FIN_EMPTY')), 'pas de warning si vide')
  } finally {
    s.restore()
  }
})

test('positiveInt : decimal et zero/negatif replient, jamais de NaN', () => {
  const s = silence()
  try {
    config._clearRegistry()
    assert.equal(config.positiveInt('5', 60, 'T_INT_NORM'), 5)
    assert.equal(config.positiveInt('0', 60, 'T_INT_ZERO'), 60)
    assert.equal(config.positiveInt('-2', 60, 'T_INT_NEG'), 60)
    assert.equal(config.positiveInt('abc', 60, 'T_INT_ABC'), 60)
    assert.equal(config.positiveInt('2.5', 60, 'T_INT_DEC'), 60)
    assert.equal(config.positiveInt('Infinity', 60, 'T_INT_INF'), 60)
    for (const raw of ['abc', '0', '-2', '2.5', 'Infinity', '', null, undefined, true, NaN]) {
      const got = config.positiveInt(raw, 60, 'T_INT_SWEEP')
      assert.ok(Number.isFinite(got), `fini pour ${String(raw)}`)
      assert.ok(!Number.isNaN(got), `pas NaN pour ${String(raw)}`)
    }
  } finally {
    s.restore()
  }
})

test('boundedNumber : bornes et entier exiges', () => {
  const s = silence()
  try {
    config._clearRegistry()
    assert.equal(config.boundedNumber('0.75', 0.6, 0, 1, 'T_SEUIL'), 0.75)
    assert.equal(config.boundedNumber('2', 0.6, 0, 1, 'T_SEUIL_HAUT'), 0.6)
    assert.equal(config.boundedNumber('-1', 0.6, 0, 1, 'T_SEUIL_BAS'), 0.6)
    assert.equal(config.boundedNumber('abc', 0.6, 0, 1, 'T_SEUIL_ABC'), 0.6)
    assert.equal(config.boundedNumber('1e30', 60, 1, 100, 'T_BORNE_GRANDE'), 60)
    assert.equal(config.boundedNumber('2.5', 3, 1, 10, 'T_BORNE_DEC', { integer: true }), 3)
    assert.equal(config.boundedNumber('4', 3, 1, 10, 'T_BORNE_INT', { integer: true }), 4)
  } finally {
    s.restore()
  }
})

test('variantes OrThrow : refus clair si renseigne-invalide, defaut si absent', () => {
  const s = silence()
  try {
    config._clearRegistry()
    assert.equal(config.positiveIntOrThrow('60', 60, 'T_CRIT_OK'), 60)
    assert.equal(config.positiveIntOrThrow(undefined, 60, 'T_CRIT_ABSENT'), 60)
    assert.throws(() => config.positiveIntOrThrow('abc', 60, 'T_CRIT_ABC'), /T_CRIT_ABC.*demarrage refuse/)
    assert.throws(() => config.positiveIntOrThrow('0', 60, 'T_CRIT_ZERO'), /demarrage refuse/)
    assert.throws(() => config.positiveIntOrThrow('2.5', 60, 'T_CRIT_DEC'), /demarrage refuse/)
    assert.throws(() => config.positiveIntOrThrow('Infinity', 60, 'T_CRIT_INF'), /demarrage refuse/)
    assert.throws(
      () => config.boundedNumberOrThrow('99', 12, 0, 16, 'T_CRIT_BORNE', { integer: true }),
      /T_CRIT_BORNE.*demarrage refuse/
    )
    assert.equal(config.boundedNumberOrThrow('0', 1, 0, 16, 'T_CRIT_ZERO_OK', { integer: true }), 0)
  } finally {
    s.restore()
  }
})

test('parseEnum : hors liste replie, jamais la valeur brute', () => {
  const s = silence()
  try {
    config._clearRegistry()
    assert.equal(config.parseEnum('question', ['remplacement', 'question'], 'remplacement', 'T_ENUM_OK'), 'question')
    assert.equal(config.parseEnum('n importe quoi', ['remplacement', 'question'], 'remplacement', 'T_ENUM_HS'), 'remplacement')
    assert.equal(config.parseEnum(undefined, ['remplacement', 'question'], 'remplacement', 'T_ENUM_ABSENT'), 'remplacement')
    assert.equal(config.parseEnum(' Question ', ['remplacement', 'question'], 'remplacement', 'T_ENUM_CASE', { lower: true }), 'question')
  } finally {
    s.restore()
  }
})

test('strictBoolean : table explicite, jamais Boolean()', () => {
  assert.equal(config.strictBoolean(true), true)
  assert.equal(config.strictBoolean('true'), true)
  assert.equal(config.strictBoolean(1), true)
  assert.equal(config.strictBoolean('1'), true)
  assert.equal(config.strictBoolean(false), false)
  assert.equal(config.strictBoolean('false'), false)
  assert.equal(config.strictBoolean(0), false)
  assert.equal(config.strictBoolean('0'), false)
  for (const raw of [null, undefined, '', 'oui', 'non', 2, -1, [], {}, 'True', 'FALSE']) {
    assert.equal(config.strictBoolean(raw), null, `null pour ${JSON.stringify(String(raw))}`)
  }
})

test('config effective : affichee sans secrets', () => {
  const s = silence()
  try {
    config._clearRegistry()
    config.positiveInt('60', 60, 'T_EFF_STEPS')
    config.positiveInt('abc', 60, 'T_EFF_REPLI')
    config.finiteNumber('x', 0, 'T_EFF_FAKE_API_KEY')
    const effective = config.effectiveConfig()
    assert.equal(effective.T_EFF_STEPS.valeur, 60)
    assert.equal(effective.T_EFF_STEPS.statut, 'env')
    assert.equal(effective.T_EFF_REPLI.statut, 'repli-invalide')
    assert.ok(!('T_EFF_FAKE_API_KEY' in effective), 'secret exclu de la config effective')
    config.logEffectiveConfig()
    const out = s.logs.join('\n')
    assert.ok(out.includes('T_EFF_STEPS=60'), 'valeur affichee')
    assert.ok(out.includes('repli-invalide'), 'repli signale')
    assert.ok(!out.includes('T_EFF_FAKE_API_KEY'), 'secret non journalise')
  } finally {
    s.restore()
  }
})

test('secrets invalides : valeur masquee dans warnings et refus', () => {
  const s = silence()
  try {
    config._clearRegistry()
    const secret = 's3cr3t-zzz-12345'
    assert.equal(config.finiteNumber(secret, 60, 'T_SEC_API_KEY'), 60)
    assert.equal(config.parseEnum(secret, ['a', 'b'], 'a', 'T_SEC_TOKEN'), 'a')
    const warnOut = s.warnings.join('\n')
    assert.ok(warnOut.includes('T_SEC_API_KEY'), 'warning nomme la var secrete')
    assert.ok(warnOut.includes('<redacted>'), 'warning masque la valeur secrete')
    assert.ok(!warnOut.includes(secret), 'warning ne fuite pas la valeur secrete')
    assert.throws(
      () => config.positiveIntOrThrow(secret, 60, 'T_SEC_PASSWORD'),
      err => {
        const msg = String(err && err.message)
        return /T_SEC_PASSWORD.*demarrage refuse/.test(msg) &&
          msg.includes('<redacted>') &&
          !msg.includes(secret)
      },
      'refus masque la valeur secrete'
    )
    // Non-secret : message inchange, valeur brute visible.
    config._clearRegistry()
    s.warnings.length = 0
    assert.equal(config.finiteNumber('abc', 60, 'T_SEC_PLAIN'), 60)
    assert.ok(s.warnings.some(w => w.includes('T_SEC_PLAIN') && w.includes('abc')), 'non-secret inchange')
  } finally {
    s.restore()
  }
})

// R19 (suite) : les modules migres ne laissent jamais passer un NaN
// silencieux. Les lectures se font au require : on recharge le module avec un
// cache vide sous un env controle, puis on restaure (env + cache).
function freshRequire (rel) {
  const resolved = require.resolve(rel)
  delete require.cache[resolved]
  return require(rel)
}

function withEnv (vars, fn) {
  const saved = new Map()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined)
    process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
  }
}

function dropCache (...rels) {
  for (const rel of rels) {
    try { delete require.cache[require.resolve(rel)] } catch (_) {}
  }
}

test('R19 modules non-critiques : invalide -> defaut fini, jamais NaN', () => {
  const s = silence()
  const mods = ['../bot/action-gestes', '../bot/craft', '../bot/logger']
  try {
    config._clearRegistry()
    withEnv({
      MISSION_DIRE_COOLDOWN_MS: 'abc',
      CRAFT_TABLE_REUSE_RADIUS: 'abc',
      CRAFT_TABLE_KNOWN_MAX: 'Infinity',
      LOG_DEDUP_MS: 'abc',
      LOG_CHAT_MAX_PER_MIN: '0',
      LOG_CHAT_MAX_LEN: '2.5',
      // Chaine vide = absent => defaut silencieux, sans warning.
      LOG_CRASH_DRAIN_MS: ''
    }, () => {
      dropCache(...mods)
      const gestes = freshRequire('../bot/action-gestes')
      const craft = freshRequire('../bot/craft')
      const logger = freshRequire('../bot/logger')
      assert.equal(gestes.DIRE_COOLDOWN_MS, 20000)
      assert.equal(craft.TABLE_REUSE_RADIUS, 24)
      assert.equal(craft.TABLE_KNOWN_MAX, 64)
      assert.equal(logger.DEDUP_MS, 30000)
      assert.equal(logger.CHAT_MAX_PER_MIN, 5)
      assert.equal(logger.CHAT_MAX_LEN, 200)
      assert.equal(logger.CRASH_DRAIN_MS, 250)
      for (const v of [gestes.DIRE_COOLDOWN_MS, craft.TABLE_REUSE_RADIUS, craft.TABLE_KNOWN_MAX,
        logger.DEDUP_MS, logger.CHAT_MAX_PER_MIN, logger.CHAT_MAX_LEN, logger.CRASH_DRAIN_MS]) {
        assert.ok(Number.isFinite(v), `defaut fini, pas NaN (${String(v)})`)
      }
    })
    assert.ok(s.warnings.some(w => w.includes('MISSION_DIRE_COOLDOWN_MS')), 'warning dire')
    assert.ok(s.warnings.some(w => w.includes('CRAFT_TABLE_REUSE_RADIUS')), 'warning reuse')
    assert.ok(s.warnings.some(w => w.includes('CRAFT_TABLE_KNOWN_MAX')), 'warning known')
    assert.ok(!s.warnings.some(w => w.includes('LOG_CRASH_DRAIN_MS')), 'pas de warning si absent')
  } finally {
    dropCache(...mods)
    s.restore()
  }
})

test('R19 modules critiques : renseigne-invalide -> refus de demarrage', () => {
  const s = silence()
  try {
    config._clearRegistry()
    // Defauts intacts quand rien n est renseigne.
    dropCache('../bot/action-sous-buts', '../bot/perception')
    assert.equal(freshRequire('../bot/action-sous-buts').TOURS_MAX, 30)
    dropCache('../bot/action-sous-buts')
    assert.equal(freshRequire('../bot/perception').PILER_MAX, 6)
    assert.equal(require('../bot/perception').MAX_REACH_UP, 3)
    dropCache('../bot/perception')
    // Renseigne-invalide => le require jette et refuse le demarrage.
    for (const [variable, module] of [
      ['MISSION_SOUS_BUT_TOURS', '../bot/action-sous-buts'],
      ['MISSION_SOUS_BUT_MAX_MS', '../bot/action-sous-buts'],
      ['MISSION_PILER_MAX', '../bot/perception'],
      ['MISSION_MAX_REACH_UP', '../bot/perception']
    ]) {
      dropCache(module)
      assert.throws(
        () => withEnv({ [variable]: 'abc' }, () => freshRequire(module)),
        new RegExp(`${variable}.*demarrage refuse`),
        `refus pour ${variable}`
      )
      dropCache(module)
    }
    // Zero, decimal et infini aussi refuses sur les bornes critiques.
    assert.throws(() => withEnv({ MISSION_PILER_MAX: '0' }, () => freshRequire('../bot/perception')), /demarrage refuse/)
    dropCache('../bot/perception')
    assert.throws(() => withEnv({ MISSION_MAX_REACH_UP: '2.5' }, () => freshRequire('../bot/perception')), /demarrage refuse/)
    dropCache('../bot/perception')
  } finally {
    dropCache('../bot/action-sous-buts', '../bot/perception')
    s.restore()
  }
})
