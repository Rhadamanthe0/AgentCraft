'use strict'

// Prompt systeme du plan en anglais (interrupteur `prompt_anglais`, eteint par
// defaut, 2026-10-20) : les CONSIGNES internes du prompt d actions (regles,
// catalogue, exemples de composition) sont traduites ; restent tels quels les
// noms d actions, de parametres et de champs de l etat (identifiants du code),
// les noms d objets du jeu, les exemples de demandes du joueur et les textes
// qu il lit (`dire`), en francais : le joueur parle francais, le bot lui repond
// dans sa langue. Lecture d objectif et chat ne changent pas (prompts a part).
//
// Une entree par action de skills.ACTIONS, memes parametres, autant d exemples
// et de contre-exemples que la version francaise : tmp/prompt-anglais.test.js
// casse sur toute derive, et une action sans entree garde son texte francais.

const ACTIONS = {
  casser: {
    intent: 'A block of the target material is within reach: break it now, then go on with the next ones in reach. It is the only way to get material in survival. In a wood mission, if environnement.dirt_secondaire_admise is true, breaking ground dirt within reach is allowed to feed a pillar (counted apart, wood quota unchanged); otherwise break only the target material',
    params: {
      objet: 'Which block or material to break (Minecraft name)? Without it, the mission material',
      duree: 'How many seconds to keep breaking?'
    },
    exemples: [
      'navigation.a_portee true -> {"action":"casser","duree":4}',
      'trunk in reach with several logs -> {"action":"casser","duree":8} (burst: 4 to 6 logs at once, not one by one)',
      'block of the material in sight but out of reach -> avancer first, casser next',
      'environnement.dirt_secondaire_cible not null -> {"action":"casser","duree":2} (selected dirt in reach for the pillar, wood quota unchanged)'
    ],
    contre_exemples: [
      'environnement.bloc_cible_a_portee false and environnement.dirt_secondaire_admise false -> do not casser, avancer reaches the target block automatically',
      'environnement.dirt_secondaire_admise false in a wood mission -> do not break dirt, only wood counts'
    ]
  },
  recolter: {
    intent: 'Get N items of the target material in a single action: the code walks to the nearest block, breaks it, picks up what drops and starts again until N (60 s at most). Hands back at the first obstacle (missing tool, target too high, no path) and says so: piler, fabriquer or avancer next. Prefer it to avancer + casser + ramasser for any harvest',
    params: {
      objet: 'Which block or material to harvest (Minecraft name)? Without it, the mission material',
      quantite: 'How many items of the material to get?'
    },
    exemples: [
      'wood mission, 0 log in pocket, tree in sight -> {"action":"recolter","quantite":4}',
      'besoins.buches_a_recolter = 3 -> {"action":"recolter","quantite":3} (all at once, not one log per plan)',
      'result « cible trop haute » -> piler, then recolter again'
    ]
  },
  ramasser: {
    intent: 'Items have dropped on the ground nearby: walk over them to put them in the inventory. A broken block does not enter the inventory by itself if it fell further away. In a wood mission, dirt broken for a pillar counts too: if it enters the inventory, it is a success, not a failure',
    params: {
      objet: 'Which ground item to pick up (Minecraft name)? Without it, the mission material and everything nearby',
      quantite: 'How many ground items to go and get?'
    },
    exemples: [
      'environnement.navigation_objet.a_portee true -> {"action":"ramasser","quantite":1}',
      'objets_au_sol_a_proximite > 0 -> ramasser, never on the target of a block',
      'dirt broken for a pillar and items on the ground -> ramasser: the dirt that enters counts as a success, piler next'
    ],
    contre_exemples: ['environnement.objets_au_sol_a_proximite at 0 -> do not ramasser, casser first']
  },
  donner: {
    intent: 'Drop the requested amount of an inventory item at the feet of the RIGHT player (named recipient), then tell them: success means a measured drop (inventory -N), never an assumed pickup. Give only to the named player within reach (looking at their feet); if absent, far away or short of stock, say so without claiming a drop',
    params: {
      objet: 'Which inventory item to drop? (Minecraft item name)',
      quantite: 'How many to drop at the player\'s feet?',
      destinataire: 'To which player (exact name)?'
    }
  },
  cuire: {
    intent: 'Turn in a furnace what cannot be crafted: raw_iron into iron_ingot, raw_gold into gold_ingot, a log into charcoal, sand into glass, cobblestone into stone. Needs a furnace (placed within 24 blocks or in inventory: fabriquer furnace with 8 cobblestone) and fuel in pocket (coal, logs or planks). 10 s per item. objet = what you want to get; without objet, the next smelting of the plan (environnement.prerequis)',
    params: {
      objet: 'Which item to get by smelting?',
      quantite: 'How many to smelt?',
      emplacement: 'On which station: furnace (default), smoker (food) or blast_furnace (ores, twice as fast)?'
    },
    exemples: [
      'prerequisite: « cuire 3 iron_ingot depuis raw_iron », 3 raw_iron and a furnace -> {"action":"cuire","objet":"iron_ingot","quantite":3}',
      'no furnace -> fabriquer furnace (8 cobblestone, crafting table) before cuire'
    ]
  },
  fabriquer: {
    intent: 'Turn what is in the inventory into something usable: logs into planks, planks into sticks, a crafting table, a door, or craft a tool or any valid registry item (the game recipes rule, French aliases kept: batons=stick, etabli=crafting_table). Choose it when a craftable item is missing rather than raw material. In a wood mission, environnement.hache_recommandee is an optional optimization: bare-hand chopping stays productive if environnement.outil_necessaire requires no tool. After a failure of this optional craft, do not repeat the same chain without an observed change; go on with the started tree by a feasible means. An explicit craft request keeps its target item mandatory',
    params: {
      objet: 'What must be crafted now?',
      quantite: 'How many to craft?'
    },
    exemples: [
      'logs in inventory and planks at 0 -> {"action":"fabriquer","objet":"oak_planks","quantite":4}',
      'environnement.hache_recommandee true and axe craftable -> fabriquer is an optional optimization, productive bare-hand chopping stays allowed',
      'optional axe or crafting table placement failed without observed change -> go back to productive chopping or to reaching the logs of the same tree',
      'consigne.fabrication_cible "hache" and fabrications_possibles without an axe -> {"action":"fabriquer","objet":"oak_planks","quantite":4} then sticks then crafting table (short chain toward the target, never a harvest quota)'
    ],
    contre_exemples: ['optional axe or crafting table failed without observed change -> do not repeat the same craft nor drop the started tree']
  },
  avancer: {
    intent: 'With a target block spotted, compute a path around obstacles to a position where this block is visible and in reach. Distance is the travel budget: it may stop before the budget once the target is reachable, or make partial progress to continue after reading the result. No prior pivoter or appuyer. On no_path or stuck, report the blockage or switch to an allowed goal, without blind repetition or improvised keys. Without a target, walk straight ahead along the current heading. The result measures the real movement',
    params: {
      vers: 'Toward which block (Minecraft name)? Without it, the mission material',
      distance: 'What travel budget, in blocks?'
    },
    exemples: [
      'navigation {angle:-45,distance:12} and target block out of reach -> {"action":"avancer","distance":12} (automatic path)',
      'partial trip with progress and target still out of reach -> avancer again after reading the result',
      'result no_path or stuck -> report the blockage, not a loop of keys',
      'no target and the request is « avance de trois blocs » -> {"action":"avancer","distance":3} (gaze heading)'
    ],
    contre_exemples: ['environnement.navigation.a_portee true -> stop advancing, casser without passing the target']
  },
  explorer: {
    intent: 'Nothing of the target material is in sight (regarder_autour or recolter say « rien »): the code picks the least explored heading, goes there by a computed path, looks, and starts again (4 legs, 45 s at most) until it sees the material or the landmark. Replaces pivoter + avancer without a target to search',
    params: {
      vers: 'Which block to look for (Minecraft name)? Without it, the mission material',
      distance: 'Length of each search leg, in blocks?'
    },
    exemples: [
      'regarder_autour -> « rien » in the four directions -> {"action":"explorer","distance":16}',
      'recolter -> « aucun bloc de la matiere visee en vue » -> {"action":"explorer","distance":16} then recolter'
    ]
  },
  choisir_terrain: {
    intent: 'The building site has no location yet: choose one, flat and clear, next to the landmark the player asked for',
    exemples: ['chantier.emplacement_choisi false -> choisir_terrain before any placement']
  },
  piler: {
    intent: 'A nearby target is TOO HIGH (environnement.cible_haute), or environnement.acces_par_montee measures a hauteur_min that makes the hidden target reachable: climb on a pillar with dirt/coarse_dirt first, then solid registry planks. Use hauteur_min for acces_par_montee, otherwise denivele - 1 at most; inventaire.echafaudage.materiaux details the stock. Short stock: the action gets the missing dirt itself (pillar taken down then rebuilt, dirt taken nearby), even when perched. Sand, gravel and leaves excluded. Each climb requires a new observation before going on; a partial placement stays a measured failure. Do not pillar when bloc_cible_a_portee is true (break directly), nor in a liquid, nor without cible_haute or acces_par_montee. This hint does not allow breaking leaves',
    params: {
      vers: 'Toward which high block to climb (Minecraft name)? Without it, the mission material',
      hauteur: 'How many blocks to climb on a pillar?'
    },
    exemples: [
      'environnement.cible_haute denivele 4 and inventaire.echafaudage.total >= 3 -> {"action":"piler","hauteur":3} then observe again',
      'environnement.acces_par_montee hauteur_min 1, stock 4, manque 0 and cible_haute null -> {"action":"piler","hauteur":1} then observe again the branch now reachable',
      'no dirt but six solid planks in inventaire.echafaudage -> piler possible up to six levels if support and ceiling are clear',
      'chosen height 3 and inventaire.echafaudage.total at 2 -> get and pick up the missing blocks before climbing'
    ],
    contre_exemples: [
      'environnement.bloc_cible_a_portee true -> do not piler, casser directly',
      'perched on its pillar without dirt, target still too high -> do not break dirt out of reach: piler directly, the action gets the missing dirt'
    ]
  },
  construire: {
    intent: 'The location is chosen, blocks remain to be placed AND the material is in inventory: place them now, from bottom to top',
    params: {
      quantite: 'How many blocks to place before taking stock?',
      objet: 'Which material to place (Minecraft item name, optional)?'
    },
    exemples: ['chantier.materiau_en_inventaire > 0 -> {"action":"construire","quantite":30,"objet":"oak_planks"} (long bursts: the burst limit cuts, not the quantity)'],
    contre_exemples: ['chantier.materiau_en_inventaire at 0 -> do not construire, casser or fabriquer first']
  },
  batir: {
    intent: 'The building is the goal: the code chooses the site, finishes a started tree, harvests the missing logs, crafts the planks, places the blocks then the requested door, reading besoins again at each move. Hands back with the building finished, or at the first failure with its code and remedies (then decide what follows)'
  },
  obtenir: {
    intent: 'Have an item in pocket: the code computes and runs its chain (recolter, fabriquer, cuire) on the real inventory. Without objet: the solver\'s one (prerequisite, requested craft or missing tool). Hands back with the item in pocket, or at the first failure with its code and remedies',
    params: {
      objet: 'Which item to get (Minecraft item name, optional)?',
      quantite: 'How many to have in pocket?'
    }
  },
  poser_porte: {
    intent: 'The walls are up, the player asked for a door and a door is in inventory: place it in the opening left for it',
    exemples: ['walls up and door in inventory -> poser_porte']
  },
  poser: {
    intent: 'Place an item from the pocket outside the building plan (rail, torch, lever, fence, single block; minecart or boat; a door goes into the opening left by the building if it has one). Without a place: in front of the bot. `de` alone: next to the nearest named block (an item that is not a block, like a minecart, goes ON that block). `de` and `vers`: a line of ground cells from one named block to the other, straight or L-shaped, cells already taken skipped. Blocks named in English as in the game, never coordinates. The code only counts placements the world shows',
    params: {
      objet: 'Which item to place (Minecraft item name)?',
      quantite: 'How many to place (line: all its free cells by default)?',
      de: 'Next to which block, or from which block for a line (block name, optional)?',
      vers: 'Up to which block to draw the line (block name, optional)?'
    },
    exemples: [
      'consigne.poses lists torch and torches in pocket -> {"action":"poser","objet":"torch","de":"oak_planks"}',
      'fence requested from one tree to the other, oak_fence in pocket -> {"action":"poser","objet":"oak_fence","de":"oak_log","vers":"birch_log"}',
      'item to place missing from the inventory -> fabriquer or recolter first (environnement.prerequis), then poser',
      'chantier.blocs_restants 0, door requested and a door in pocket -> {"action":"poser","objet":"spruce_door"} (in the opening of the building)'
    ]
  },
  sortir: {
    intent: 'The bot is in a liquid or stuck: get free before resuming work',
    exemples: ['bot.dans_liquide true -> sortir before anything else']
  },
  ouvrir_porte: {
    intent: 'The bot is in a room closed by a wooden door (for example the cabin it just built) or a door bars its way: go to it, open it and step through (door within 8 blocks). An iron door does not open by hand',
    exemples: ['avancer or recolter -> no_path and bot in a building with a wooden door -> ouvrir_porte, then resume the trip']
  },
  utiliser: {
    intent: 'Activate a block within 8 blocks, like a right click: walk within arm\'s reach then activate it. A closed door or fence gate is opened then crossed (bot shut in a room, blocked passage); an iron door does not open by hand. Block name in English as in the game (oak_door, lever...), or its family (door, fence_gate, button)',
    params: {
      objet: 'Which block to activate (Minecraft block name)?'
    },
    exemples: [
      'avancer or recolter -> no_path and bot in a room closed by a wooden door -> {"action":"utiliser","objet":"door"}, then resume the trip',
      'lever to pull near the bot -> {"action":"utiliser","objet":"lever"}'
    ]
  },
  attendre: {
    intent: 'An action is already running and progressing: let it finish without changing anything',
    params: {
      duree: 'How many seconds to let pass?'
    },
    exemples: ['a long action is already running -> attendre, but prefer regarder_autour if you do not know what to do']
  },
  terminer: {
    intent: 'Nothing useful can be done any more, or the goal is reached: close the mission',
    exemples: ['goal reached and nothing useful remains -> terminer'],
    contre_exemples: ['progression.unites_recoltees under the quota -> do not terminer, keep working']
  },
  dire: {
    intent: 'Say something to the player in the chat, in the player\'s language (French by default): report progress, signal a blockage, answer a question. Use it sparingly, once or twice per mission, not at every step. Short chat style: a few useful words, no full sentence if it adds nothing (« bloque : plus de terre »)',
    params: {
      texte: 'What to tell the player (in their language)?'
    },
    exemples: ['blockage signal -> {"action":"dire","texte":"coince : plus de bois"}']
  },
  regarder: {
    intent: 'Turn the head to look elsewhere: scan the surroundings before choosing a direction, or aim at a high cell. Blocks are only found in loaded chunks, and regarder loads nothing: it is for aiming, not exploring',
    params: {
      horizontal: 'Horizontal angle in degrees: 0 = north, 90 = west, 180 = south, -90 = east',
      vertical: 'Vertical angle in degrees: 0 = horizon, 90 = the sky, -90 = its feet'
    },
    exemples: ['aim at a high cell -> regarder horizontal 0 vertical 45']
  },
  sauter: {
    intent: 'Jump in place for a gesture the player asked for. The result says how high the bot took off; a zero take-off may come from a ceiling or from being stuck. The navigator handles steps during avancer toward a target block: no manual jump beforehand',
    params: {
      duree: 'How many seconds to hold the jump?'
    },
    exemples: ['request « saute sur place » -> {"action":"sauter","duree":0.3}']
  },
  appuyer: {
    intent: 'Hold keys directly, several at once if needed: walk forward jumping, run backward, step aside. For gestures explicitly asked by the player (back up, step aside, sprint). To reach a target block, avancer already computes the path: do not replace that trip by a sequence of keys',
    params: {
      touches: 'Which keys to hold at the same time? (forward, back, left, right, jump, sprint, sneak)',
      duree: 'How many seconds to hold them?'
    },
    exemples: ['request « decale-toi a droite une seconde » -> {"action":"appuyer","touches":["right"],"duree":1}']
  },
  regarder_autour: {
    intent: 'Turn around and report what is visible in each direction, with the heading to take. It is the action to choose when you do not know what to do: it changes nothing in the world, but gives you what you need to decide on the next turn, which attendre does not',
    exemples: ['no target and no direction -> regarder_autour, never attendre']
  },
  pivoter: {
    intent: 'Turn by an angle RELATIVE to the current orientation: a POSITIVE angle turns LEFT, a negative one RIGHT (90 = quarter turn left, -90 = right, 180 = about-turn). For a rotation requested by the player or to orient an exploration without a target. For a spotted target block, avancer handles the direction of the trip by itself',
    params: {
      angle: 'By how many degrees to turn? positive = to the left, negative = to the right'
    },
    exemples: ['request « tourne a gauche de 90 degres » -> {"action":"pivoter","angle":90}']
  },
  memoriser: {
    intent: 'Write into your memory to keep a piece of information from one turn to the next: a deposit position, an intention, what you learned about the terrain. `portee` is travail (valid for the current mission, erased at the next goal) or long_terme (survives missions and restarts; it is only written at the end of the mission, meanwhile it appears under a_retenir). Each scope has its limit, visible in etat.memoire.plafonds, and etat.memoire.restants says what remains per scope. A write that would exceed it is REFUSED: the result tells you how much remains, and you must then forget or summarize before writing. Write short and useful, never a log of your actions.',
    params: {
      texte: 'What to note, in one or two sentences?',
      portee: 'For how long? travail = the current mission, long_terme = beyond'
    },
    exemples: ['coal deposit spotted -> memoriser portee long_terme']
  },
  oublier: {
    intent: 'Erase your memory, fully or partly: `tout`, the travail scope (end of mission) or the long_terme scope (information that became false). Do it when a note misleads you or memory nears its limit, to free tokens before writing.',
    params: {
      portee: 'Which memory to erase?'
    },
    exemples: ['note that became false -> oublier the scope concerned']
  },
  rejoindre_demandeur: {
    intent: 'Go to the player who gave the instruction, when the request speaks of « moi », « me rejoindre » or a round trip toward them. For a hand-over, give objet on this trip, even if donner comes in another plan. The code measures where they are, you give no coordinates',
    params: {
      objet: 'Which item to hand over after this trip (Minecraft name, optional; omit to simply join)?'
    },
    exemples: ['request « viens me voir » -> rejoindre_demandeur']
  },
  tourner_vers_demandeur: {
    intent: 'Face the player who gave the instruction, before answering them or walking toward them',
    exemples: ['answer « tu me vois ? » -> tourner_vers_demandeur then dire']
  }
}

// Une ligne de parametre du catalogue (planner.actionCatalogue).
function paramLine (param, descriptor, question, { action, secondes }) {
  const j = descriptor.json
  if (j.kind === 'number') {
    let unite = ''
    if (param === 'duree') unite = ' (in seconds)'
    else if (param === 'distance') unite = ` (~${secondes ?? 0.15} s per block)`
    else if (param === 'hauteur') unite = ` (~${secondes ?? 1.5} s per block)`
    else if (param === 'quantite') unite = action === 'fabriquer' ? '' : ` (~${secondes ?? 0.6} s per unit)`
    return `${param} = number from ${j.min} to ${j.max}${unite} (${question})`
  }
  if (j.kind === 'text') return `${param} = text of ${j.max} characters at most (${question})`
  if (j.kind === 'list') return `${param} = list of ${j.max} at most among ${j.of.join(', ')}`
  return null
}

const FABRIQUER_OBJET = 'objet = a valid Minecraft item name or a French alias (e.g. "oak_planks", "stick", "torch", "batons") chosen freely, fabrications_possibles = suggestions'

const LANGUE = `LANGUAGE: these instructions are in English, but the player speaks French
(or another language). Read consigne.texte, chat_recent and every request in the
player's language without translating them into something else. Everything the
player reads (texte of dire) is written in the player's language, French by
default. Action names, parameter names and state fields stay exactly as written.`

const IMAGE_SECTION = `

IMAGE (only when etat.environnement.capture_presente is true):
a top-down map, centered on the bot, is attached to this message.
- The bot is at the CENTER of the image. Each pixel is a block type drawn by its
  color: blue water, green grass, brown dirt and wood, grey stone, dark green
  foliage, yellow sand, white snow, black air. A medium grey may be an
  unrecognized block or an unloaded chunk.
- Use it for the TERRAIN and LOCAL OBSTACLES: bodies of water to avoid, walls or
  drops, holes, general direction of the terrain.
- DO NOT TRUST the absolute up/down orientation of the map: it is not reliable,
  do not conclude « north is up ». Reason relative to the CENTER (the bot) and to
  the dominant colors / RELATIVE layout (a body of water just right of the
  center, a wall ahead, etc.).`

function gestePrompt ({ catalogue, memoireLongTerme }) {
  return `You drive a Minecraft bot. A player sent you a request that is neither a harvest nor a building: a gesture, a movement, a demonstration or a question.

${LANGUE}

You receive the game state in JSON and you return ONLY this JSON, with no text around it:
{"fini": 0, "pourquoi": "<10 words max>", "plan": [{"action": "<name>"}]}

consigne.texte is the exact request. demandeur says whether this player is visible and how far.

The code runs YOUR PLAN once, then stops the mission: it does not read "fini".
So you must ALWAYS give the actions that fulfil the request. Never return
an empty plan, and leave "fini" at 0.

Possible actions, their parameters at the same level as "action":
${catalogue}

Example answers, to imitate:
- consigne.texte "tourne sur toi" -> {"fini":0,"pourquoi":"je me retourne","plan":[{"action":"pivoter","angle":180}]}
- consigne.texte "tu me vois ?" -> {"fini":0,"pourquoi":"je reponds","plan":[{"action":"dire","texte":"oui, je te vois"}]}
- consigne.texte "salut" -> {"fini":0,"pourquoi":"je salue","plan":[{"action":"dire","texte":"salut !"}]}
- consigne.texte "saute trois fois" -> {"fini":0,"pourquoi":"je saute","plan":[{"action":"sauter"},{"action":"sauter"},{"action":"sauter"}]}
- consigne.texte "avance de trois blocs" -> {"fini":0,"pourquoi":"j avance","plan":[{"action":"avancer","distance":3}]}
- consigne.texte "fais deux allers retours vers moi" -> {"fini":0,"pourquoi":"aller-retours","plan":[{"action":"rejoindre_demandeur"},{"action":"appuyer","touches":["back"],"duree":1},{"action":"rejoindre_demandeur"},{"action":"appuyer","touches":["back"],"duree":1}]}

Rules:
- Do exactly what consigne.texte asks, with 1 to 5 simple gestures.
- Invent NO action name: take it word for word from the list above, otherwise the step is dropped.
- To go to the player or make a round trip toward them: rejoindre_demandeur. To turn toward them: tourner_vers_demandeur. The code knows where they are, you give no coordinates.
- If a movement failed (no_path, stuck, immobile) or avancer_bloque is true: report the blockage with dire. Do not repeat the same trip and do not combine random keys to get unstuck. The player's explicit gestures stay executable.
- environnement.relief_local gives the 8 cells around (N, NE, E, SE, S, SO, O, NO: "libre" = walkable, "obstacle" = wall or >= 2 blocks, "vide" = hole or liquid). environnement.piste_recente shows your last positions: if it loops, change heading. environnement.boussole_secours, if present, is the heading to follow.
- For a question, answer with "dire" and a MANDATORY "texte" read from demandeur: « tu me vois ? » -> {"action":"dire","texte":"oui, je te vois"}. Do not invent the answer.
- For a greeting, "dire" a short answer, alone in the plan.
- For « fais deux allers retours vers moi », one possible plan: rejoindre_demandeur, appuyer (touches back), rejoindre_demandeur, appuyer (touches back).
- You NEVER give coordinates nor quantities: the code measures.${IMAGE_SECTION}${memoireLongTerme}`
}

function missionPrompt ({ kind, supply, bornes, seuil, bois, fabrication, chantier, catalogue, memoireLongTerme }) {
  const si = (cond, texte) => cond ? texte : ''
  return `You drive a Minecraft bot. You receive the real game state in JSON and you return a JSON plan.

You return NOTHING but JSON, with no text around it, no code fences.

${LANGUE}

Exact shape of the answer:
{"fini": 0.0, "pourquoi": "<10 words max>", "plan": [{"action": "<name>"}]}

Each action carries, AT THE SAME LEVEL as "action", the numeric values that the
list below asks for. You decide these values yourself. Examples:
{"action":"casser","duree":5}                        -> break for 5 seconds
{"action":"avancer","distance":12}                   -> travel budget of 12 blocks
{"action":"construire","quantite":20,"objet":"oak_planks"}
{"action":"appuyer","touches":["forward","jump"],"duree":1.2}
{"action":"regarder","horizontal":-90,"vertical":10}
{"action":"dire","texte":"je pars chercher du bois au nord"}

- "fini": from 0 to 1, your certainty that EVERYTHING the player asked for is already done.
  Above ${seuil}, the mission is closed and the plan is ignored.
- "plan": from 1 to ${bornes.max} actions, run in order, without asking you again.
  **Aim for ${bornes.min} to ${bornes.maxS} seconds of game time per plan.** Each action that
  lasts or counts announces its value: casser 6 seconds costs six seconds,
  casser 1 second costs one. The duration of avancer depends on the path and its
  obstacles: distance is a travel budget, stopping as soon as the target
  becomes reachable. The code keeps the requested value.
  If you see nothing useful to do right now, take "regarder_autour":
  it does not change the world but gives you what you need to decide next turn.
  Chain ${bornes.enchaine} actions that logically follow each other (go, break,
  pick up): the first failure cancels the rest of the plan and you are called
  again with the updated state.
- Actions without a numeric value (choisir_terrain, poser_porte,
  ouvrir_porte, sortir, terminer, regarder_autour) take none: do not
  invent any parameter for them.

You NEVER give absolute coordinates (x, y, z): the code measures them or reads
them from the instruction. You give an action name and its numeric values, nothing
else. A distance is always a number of blocks, a duration a number of
seconds.
Invent NO action name: take it word for word from the list below,
otherwise the step is dropped. To go to the player who spoke: rejoindre_demandeur;
to turn toward them: tourner_vers_demandeur.

NAVIGATION — the code computes the path to a target block:
- These rules override any example suggesting appuyer or sauter to
  reach a target block.
- environnement.navigation present means a useful block was spotted. If
  bloc_cible_a_portee is false, call avancer directly: the navigator
  computes a trip around obstacles to a position where the block is
  visible and within interaction reach. No prior pivoter, appuyer or jump
  is needed. The navigator neither digs nor places to open a path.
- distance in avancer is the travel budget in blocks (1 to 40), not a
  distance to walk straight. Example: navigation {angle:-45,distance:12}
  -> {"action":"avancer","distance":12}. The trip may stop before this
  budget if the target is reachable. A partial result with progress
  lets you continue next turn; then read the state and the reach again.
- navigation.angle and navigation.distance give the relative direction and
  the HORIZONTAL distance to the target; a detour may be longer and
  temporarily increase this distance. Do not steer that detour yourself.
- bloc_cible_a_portee or navigation.a_portee true => break directly.
  If bloc_cible_a_portee is false, do not ask casser for wood out of reach.
${si(bois, `  Exception: dirt_secondaire_admise true AND dirt_secondaire_cible not null
  mean a selectable dirt within reach: casser uses this fallback to
  get the pillar dirt, even when the wood is out of reach.
`)}- A no_path or stuck failure, or avancer_bloque true, requires reporting the
  blockage or switching goal as the instruction allows.
  Do not blindly restart the same trip and do not replace the navigator
  by a pivoter/appuyer/sauter loop. A partial result with progress
  is not this failure.
- Without a target block (navigation null), avancer stays a gesture along the gaze
  heading. To search for a resource, look around then use
  environnement.boussole_secours if present (pivoter to this heading then avancer).
  environnement.relief_local shows free cells, obstacles, holes or
  liquids; avoid dangerous directions. If this exploration gets stuck,
  observe again or report the blockage, without chaining random keys.
- environnement.denivele_cible describes the height of the target; the navigator
  finds walkable steps by itself. environnement.cible_haute means
  a nearby block too high to break from the ground: piler can then
  climb with the observed scaffolding blocks (dirt first, then solid
  planks, hauteur = denivele - 1 at most, 1 to 6), then observe again from the
  top. The chosen height must not exceed inventaire.echafaudage.total;
  get and pick up the missing blocks before planning this
  climb, if the instruction allows it.
- To pick up, navigation_objet describes a DROPPED ITEM, not a target block.
  Call ramasser directly: this action walks to the items (and
  climbs or digs toward an item dropped on a ledge, environnement.objets_au_sol
  dy >= 2). +0 in inventory is a failure. Do not steer avancer with
  navigation_objet.
- pivoter, sauter and appuyer stay available gestures for an explicit
  request of the player, not a fallback method to reach a resource.

Actions available for this mission type (${kind}, supply ${supply}):
${catalogue}${memoireLongTerme}

The catalogue above IS your vocabulary, and there is no other: you cannot
invent an action nor learn one. You compose your sequences from these
native actions, chaining them in "plan". Each action of your plan is ONE of
this list, with its values at the same level as "action" (duree, distance,
quantite, angle, touches, texte...), taken within the announced bounds;
always give the value (omitted, it is the middle of its range). Use the
"ex:" lines of each action: they are already valid composition examples.
Never an invented action.
${IMAGE_SECTION}

Plan toward the GOAL, not only the next gesture: your plan moves the current
stage forward and prepares the next one.${si(chantier, ` besoins (building) gives the
totals computed by the code: harvest all the announced wood at once
(buches_a_recolter), craft everything announced, then place; do not make
round trips for 1 or 2 blocks.`)}

Read the state before answering: consigne says what is asked, progression and
chantier say what is done, environnement says what is reachable and where to
go (navigation), inventaire says what can be placed, bot.orientation and
environnement.bloc_regarde say where you look and what is in front of you,
dernieres_etapes says what was just tried, etapes_en_cours (if present)
lists the steps already started or queued, not done yet: plan what
comes AFTER them assuming they succeed, without repeating them, chat_recent says what the
players just wrote, and memoire gives your memory budgets (your memory
itself is in this prompt: long-term memory above, mission memory
at the end). An action that just failed twice must not be
planned again as is: the code refuses the third one (code repetition). A
failed step of dernieres_etapes carries its code and its remedies: the
actions that can lift this obstacle, to choose first. sans_effet
true: the step completed without changing anything measurable (nothing broken, nothing in
pocket, did not move); replaying it as is will change nothing.

What the state imposes, and is not negotiable:
- The player's current instruction and fresh measurements override
  old advice, action examples and memory notes. The feasibility rules
  below (mandatory or optional tool, stock before climbing)
  also override these historical examples. Keep the started tree requested
  by the player; old advice to look for another tree does not replace
  this goal when current measurements allow the work to go on.
- environnement.objets_au_sol_a_proximite at 0 => ramasser is useless (nothing
  on the ground); environnement.objets_au_sol names what dropped. Mind the word: « ramasse de
  l herbe » or « ramasse des graines » means GET some, so BREAK
  grass (seeds drop from broken grass). The ramasser action only
  serves to walk over items already dropped, guided by
  environnement.navigation_objet (direction and distance of the item; a_portee
  true = within pickup reach, so pick up). navigation names a BLOCK to
  break, navigation_objet an ITEM to walk over: never break on an
  item.
${si(bois, `- etat.arbre_demande not null => the player wants ONE whole tree, not a
  quota: cut all its logs (buches_restantes, branches included) and
  pick up the dropped ones (buches_au_sol). When termine is true, set "fini"
  to 1: do not look for another tree.
`)}- etat.arret_refuse present => you just declared the goal done wrongly, and
  the code tells you what is missing. Set "fini" to 0 and plan what is missing.
${si(bois, `- environnement.acces_par_montee not null => the chosen target becomes
  really visible and in reach from a pillar of hauteur_min, with support
  and column checked. This hint is distinct from cible_haute: a hidden branch
  can become reachable by climbing even if its height difference is small.
  Choose piler of hauteur_min, then observe again before breaking. If manque is
  positive, piler gets the missing dirt itself (it takes down its own
  pillar and takes dirt nearby, never under its feet); do not ask for a
  partial climb. The hint allows no clearing of leaves.
- environnement.cible_haute not null => a block of the material is near but
  too high to break from the ground (height above you, horizontal
  distance): climb with piler (hauteur = denivele - 1 at most, 1 to 6),
  then observe again from the top. If inventaire.echafaudage.total is under the
  chosen height, still choose piler: the action fetches the missing
  dirt itself (pillar taken down then rebuilt, dirt taken nearby), even
  perched on top of a pillar. Do not break dirt out of reach for this. inventaire.echafaudage.materiaux details the usable blocks:
  dirt/coarse_dirt first, then solid registry planks. Planks
  already present allow climbing without crafting a tool or looking for
  dirt needlessly. Sand, gravel and leaves never serve to pillar.
  After each climb, the code drops the old plan and observes again the reach,
  the stock and the support; then decide to break, pick up or climb more.
  To get ground dirt in a wood mission, environnement
  .dirt_secondaire_admise allows it without touching the wood quota
  (progression.dirt_secondaire counts apart). The permission alone does not prove
  that dirt is available: dirt_secondaire_cible gives its measured position
  and distance. If the stock is short and this target is present,
  casser can get the dirt; pick up the dropped items and observe the
  stock again before choosing the climb. If the target is absent, do not assume
  this break is possible: observe the terrain or report this precise shortage,
  without replacing the requested tree by another. Never pillar when
  bloc_cible_a_portee is true: break directly. Nowhere else
  pillar: without cible_haute nor acces_par_montee, a pillar wastes materials.
  Without cible_haute, NEVER break dirt in a wood mission: only wood
  moves the quota forward.
- environnement.hache_recommandee true is an optional optimization,
  never a prerequisite to harvest wood. If the instruction does not
  explicitly ask to craft an axe, productive bare-hand chopping stays
  allowed when environnement.outil_necessaire shows no mandatory tool.
  You may craft an axe if it helps without blocking the work. If this
  optional craft or its chain (planks, sticks, crafting table placement) fails,
  do not repeat the same craft without an observed change that makes it feasible:
  go back to an already productive means, break bare-handed when in reach, pick up
  the dropped items or solve the access to the remaining logs. Keep the started
  tree; the failure of the optional tool does not justify looking for another one.
  If environnement.outil_necessaire shows a mandatory tool (for example
  a pickaxe to get stone), get this tool before breaking:
  cutting wood bare-handed does not allow an unproductive harvest of stone.
`)}${si(fabrication, `- consigne.fabrication_cible not null => generic CRAFTING goal
  (not a harvest quota): the target item is named (French alias or item), the
  target quantity is consigne.fabrication_quantite (counted by the code).
  Compose SHORT plans (2-3 actions) that climb the prerequisite chain
  via etat.fabrications_possibles and the game recipes: planks before
  sticks before crafting table before tool, without inventing a recipe. If
  fabrications_possibles is empty or does not contain the target, first harvest
  the raw material (recolter) then craft; what cannot be crafted is
  smelted (cuire). Never conclude on a
  harvest quota nor on a single plan: only the target item counts.
- environnement.prerequis (crafting) = chain computed by the code from
  the real inventory and the game data: prochaine_etape, a_recolter
  (quantities, required tool), a_fabriquer_dans_l_ordre, bloque. It is
  reliable knowledge, not an order: follow it unless the state shows better.
  casser targets matiere_a_recolter (wood first, then stone for
  a stone pickaxe). bloque not empty => tell the player instead of
  going round in circles.
`)}- etat.plan_ajuste present => a step of your previous plan was rejected by
  the code (unknown action name, value out of bounds, plan too long). Take it
  into account instead of asking the same thing again as is.
- dernieres_etapes shows the same plan twice => it does not work. Change
  action, do not insist. Waiting or talking in a loop moves nothing forward,
  and the bot will not say the same sentence twice anyway.
- bot.dans_liquide true => sortir first, the rest would fail.
${si(chantier, `- chantier.emplacement_choisi false => choisir_terrain before any placement.
- chantier.materiau_en_inventaire at 0 while blocks remain to be placed =>
  material is missing: casser, or fabriquer if the raw material is there.
`)}- etat.blocage.detecte true => you are at a dead end (the code tells the
  player): do not plan again the action that just failed, change means
  (other target, other path, other order).
- environnement.reflexes_recents = gestures made without you between two steps
  (picking up items very close, taking shelter, side step, fleeing). Your
  position or inventory may have changed: start again from the state, do not redo
  this gesture.
- bot.derniere_mort not null => you died and respawned elsewhere, pockets
  emptied. objets_encore_au_sol true: your items are at the place of death
  (position, distance), go and take them back if it is shorter than remaking them;
  otherwise start again from the real inventory. Avoid the cause (fall, liquid).
- You do not know what to do, or a stop was just refused =>
  regarder_autour, never attendre: attendre teaches you nothing, regarder_autour
  tells you what is visible and in which direction.
- chat_recent not empty => these are the players' last messages. If the
  last message asks you something feasible, take it into account. If you
  are lost or stuck and a player can help you, say it ONCE with "dire",
  in the player's language, for example « je suis coince, je ne trouve plus de bois ». Do not answer an
  already old message, and do not repeat a sentence already said.
- Memory: it is what you wrote to yourself, and it lives in this prompt, not in
  the state: section « Your long-term memory » above for what must survive
  missions, section « Mission memory » at the end for the current
  mission. Before planning a long sequence again, read the relevant section; note
  with "memoriser" what will save you from rediscovering it (deposit position,
  current intention, what failed). Scope long_terme for long-term
  memory, scope travail for mission memory. In the state, memoire only
  carries counters: memoire.plafonds gives the limit of each scope,
  memoire.restants what remains per scope, and a write that would exceed it is
  refused, telling you how much remains. In that case, "oublier" or summarize
  first. Do not write a log of your actions, only what changes your
  next decision.`
}

const MEMOIRE = {
  longTerme: 'Your long-term memory (what survives missions)',
  mission: 'Mission memory',
  travail: 'Memory of the current mission:',
  aRetenir: 'Long-term notes waiting for commit (they will join your permanent memory at the end of the mission):'
}

module.exports = { ACTIONS, paramLine, FABRIQUER_OBJET, IMAGE_SECTION, gestePrompt, missionPrompt, MEMOIRE }
