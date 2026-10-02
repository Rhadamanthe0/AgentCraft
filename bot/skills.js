'use strict'

// Catalogue unique de tout ce que le bot sait faire.
//
// Surfaces qui lisent cette table :
//   - index.js : un handler par commande canonique (prefixe `!`) ;
//   - mission.js : un handler par action de mission (ACTIONS) ;
//   - planner.js : le catalogue d actions du prompt (intent, parametres
//     bornes, exemples), filtre par type de mission et interrupteurs A/B ;
//   - /api/commands et /api/actions : la table exposee telle quelle.
//
// audit() compare la table aux handlers reellement branches et verifie la
// documentation native (champs d etat cites, bornes des extraits JSON).
// index.js l appelle au demarrage : une divergence apparait dans les logs au
// lieu de se decouvrir en jeu.
//
// Peu d actions, chacune PARAMETREE (duree, distance, quantite...) : la liste
// des actions est l espace de decision du modele, et chaque action coute des
// jetons dans le prompt mis en cache. Le planificateur compose ses
// enchainements a partir de ces actions natives, guide par leur documentation
// et des EXEMPLES concrets (ACTION_EXEMPLES plus bas) ; il n y a pas d actions
// apprises.


// ---------------------------------------------------------------------------
// Commandes : la surface visible par le joueur (chat et API)
// ---------------------------------------------------------------------------

const COMMANDS = {
  aide: {
    aliases: ['help'],
    usage: '!aide',
    summary: 'liste les commandes',
    intent: 'Le joueur demande la liste des commandes disponibles ou de l aide'
  },

  avance: {
    aliases: ['forward'],
    usage: '!avance',
    summary: 'avance tout droit jusqu a !stop',
    intent: "Le joueur demande au bot d avancer, d aller devant, de se mettre en marche"
  },

  recule: {
    aliases: ['back'],
    usage: '!recule',
    summary: 'recule jusqu a !stop',
    intent: 'Le joueur demande au bot de reculer, de faire marche arriere'
  },

  gauche: {
    aliases: ['left'],
    usage: '!gauche',
    summary: 'pas de cote a gauche',
    intent: 'Le joueur demande au bot de se deplacer vers la gauche'
  },

  droite: {
    aliases: ['right'],
    usage: '!droite',
    summary: 'pas de cote a droite',
    intent: 'Le joueur demande au bot de se deplacer vers la droite'
  },

  saute: {
    aliases: ['jump'],
    usage: '!saute [nombre]',
    summary: 'un saut, ou plusieurs (« saute 3 fois »)',
    intent: 'Le joueur demande au bot de sauter, seul ou plusieurs fois de suite'
  },

  stop: {
    aliases: ['halte'],
    usage: '!stop',
    summary: 'arrete tout, y compris la mission en cours',
    // Le seul ordre de controle qui reste routable en langage naturel : un bot
    // qu on ne peut pas arreter a la voix est dangereux.
    chat: true,
    intent: {
      what: "Le joueur demande au bot de s arreter, de ne plus bouger, d abandonner ce qu il fait",
      examples: ['stop', 'ne bouge plus', 'arrete tout', 'laisse tomber', 'annule ce que tu fais']
    }
  },

  va: {
    aliases: ['goto'],
    usage: '!va <x> <y> <z>',
    summary: 'pathfinding vers des coordonnees precises',
    // Coordonnees : forme explicite seulement, jamais routee par le chat.
    intent: null
  },

  viens: {
    aliases: ['come'],
    usage: '!viens',
    summary: 'suit le joueur qui a parle',
    intent: {
      what: 'Le joueur demande au bot de venir le rejoindre ou de le suivre',
      examples: ['viens me voir', 'rejoins moi', 'suis moi', 'tu peux venir ici ?']
    }
  },

  sors: {
    aliases: ['unstuck'],
    usage: '!sors',
    summary: 'se degage d un liquide ou d un blocage',
    intent: {
      what: "Le joueur demande au bot de se degager d un endroit ou il est bloque, notamment de l eau",
      examples: ["remonte de l eau", 'sors de la', 'tu es coince, degage toi', 'nage vers la surface']
    }
  },

  ou: {
    aliases: ['where'],
    usage: '!ou',
    summary: 'annonce sa position',
    intent: {
      what: 'Le joueur demande ou se trouve le bot, ses coordonnees, sa position',
      examples: ['ou es-tu ?', 'tu es ou ?', 'donne moi tes coordonnees']
    }
  },

  vois: {
    aliases: ['see'],
    usage: '!vois',
    summary: 'dit si le bot voit le joueur',
    intent: {
      what: "Le joueur demande au bot s il le voit, s il l a en vue, s il sait ou il est par rapport a lui",
      not_for: "Une demande de venir le rejoindre ou de le suivre (c est « viens »), ou une question sur la position du bot lui-meme (c est « ou »)",
      examples: ['tu me vois ?', 'tu me vois la ?', 'est-ce que tu me vois', 'tu me vois depuis la ?']
    }
  },

  mission: {
    aliases: ['objectif'],
    usage: '!mission <objectif>',
    summary: 'objectif continu : le bot decompose en actions jusqu au bout',
    // Le seul autre choix offert au routeur de chat. Tout ce qui n est pas un
    // ordre de controle devient une mission : le bot ne devine pas une commande
    // ponctuelle, il compose lui-meme les actions (voir AGENTS.md).
    chat: true,
    intent: {
      what: "Le joueur adresse au bot une demande : il veut qu il FASSE quelque chose ou qu il lui REPONDE. Le bot en fait une mission et compose lui-meme les actions, qu il s agisse de recolter, construire, se deplacer, faire un geste (sauter, danser, se tourner, venir) ou repondre a une question (tu me vois ?, tu es ou ?)",
      not_for: "Un simple bavardage qui ne s adresse pas au bot, une remarque sur le paysage ou entre deux autres joueurs",
      examples: [
        "ramasse de l herbe",
        'coupe du bois',
        'fais une maison en terre de 5 par 5 par 5 avec une porte',
        'viens me voir',
        'fais deux allers retours vers moi',
        'danse',
        'tourne sur toi',
        'saute trois fois',
        'tu me vois ?',
        'tu es ou ?',
        'regarde le ciel',
        'salut ca va ?',
        'wesh bien ?'
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Types de mission : ce que la lecture d objectif (readBrief) determine une fois
// ---------------------------------------------------------------------------

const KINDS = {
  recolte: {
    intent: {
      what: "Le joueur demande d obtenir une matiere OU de fabriquer un objet : recolter, accumuler, miner, couper, fabriquer un outil ou un objet (hache, planches, batons, etabli, porte, torche...) a partir de l inventaire. Une demande de fabrication (craft) est une recolte outillee, jamais un simple geste",
      examples: ['ramasse de l herbe', 'coupe du bois', 'mine dix charbons', 'fabrique une hache', 'fais-moi des planches']
    }
  },
  construction: {
    intent: {
      what: "Le joueur demande de BATIR quelque chose : une maison, un abri, un mur, une tour. Il y a un objet a faire exister, pas seulement une matiere a obtenir",
      examples: [
        'fais une maison en terre',
        'construis un abri de 5 par 5',
        'bâtis moi une tour en pierre',
        'monte un mur ici'
      ]
    }
  },
  deplacement: {
    intent: {
      what: "Le joueur demande d aller aupres d un BLOC ou d un lieu (un arbre, l eau, une colline), sans rien recolter ni batir",
      not_for: "Rejoindre un joueur, faire un geste ou repondre a une question : c est le type geste",
      examples: ['va a cote d un arbre', 'rejoins le bord de l eau', 'monte sur la colline']
    }
  },
  // Ni matiere a recolter, ni objet a batir : un geste a faire, une question a
  // laquelle repondre, une demonstration. Le bot n a pas de commande pour cela,
  // il compose les gestes de base lui-meme. C est le type qui repond au « s il
  // ne sait pas comment faire, qu il reflechisse aux actions unitaires ».
  geste: {
    intent: {
      what: "Le joueur demande au bot de FAIRE quelque chose qui n est ni une recolte ni une construction : se deplacer, venir, sauter, danser, se tourner, regarder, repondre a une question sur lui. Le bot compose lui-meme les gestes de base",
      examples: [
        'viens me voir',
        'fais deux allers retours vers moi',
        'danse',
        'tourne sur toi',
        'saute trois fois',
        'tu me vois ?',
        'tu es ou ?',
        'regarde le ciel',
        'dis moi bonjour'
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Actions : la surface interne, choisie par le planificateur a chaque plan
//
// `kinds` restreint le catalogue au type de mission en cours : un chantier ne
// voit pas « ramasser », une recolte ne voit pas « poser_porte ». Moins
// d actions, meilleur choix et prompt plus court.
//
// `params` : chaque parametre porte un descripteur `json` (bornes reelles,
// rendues dans le prompt) et une `question` (ce que la valeur veut dire). Le
// code borne la valeur, il ne la rabote jamais. Un parametre omis prend la
// valeur mediane de sa plage (`scaled(0.5, ...)` dans mission.js).
// `scale` et `secondes` documentent l unite et le cout moyen (budget de plan).
// `feature` : interrupteur A/B qui retire l action du catalogue.
// ---------------------------------------------------------------------------

// Niveaux de l ampleur par defaut (0 a SCALE_LEVELS) : un parametre omis vaut
// le niveau median.
const SCALE_LEVELS = 4

const ACTIONS = {
  casser: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    summary: 'casser les blocs a portee, en rafale',
    scale: 'duree de la rafale, en secondes',
    secondes: 0.45,
    intent: "Un bloc de la matiere visee est a portee de main : le casser maintenant, et enchainer sur les suivants a portee. C est la seule facon d obtenir de la matiere en survie. En mission bois, si environnement.dirt_secondaire_admise est vrai, casser de la dirt au sol a portee est autorise pour alimenter un pilier (comptee a part, quota bois inchange) ; sinon, ne casser que la matiere visee",
    // Le planificateur donne une valeur NUMERIQUE : il dit « casse pendant 5
    // secondes » et le code execute exactement cela.
    params: {
      duree: {
        json: { kind: 'number', min: 1, max: 15 },
        question: 'Combien de secondes casser sans relacher ?'
      }
    }
  },

  // Chaine complete d une recolte en UNE action (revue de performance du
  // 2026-09-27) : avancer / casser / ramasser coutaient un appel au modele par
  // geste et la plupart des echecs (« bloc trop loin », « aucun objet »).
  // Le code enchaine les memes gestes jusqu a la quantite, et rend la main au
  // premier obstacle qu il ne sait pas lever (outil, cible haute, aucun
  // chemin). Interrupteur A/B `recolter` (featureOn).
  recolter: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    feature: 'recolter',
    summary: 'aller a la matiere visee, la casser et ramasser, jusqu a la quantite',
    scale: 'nombre d objets de la matiere a obtenir, de 1 a 16',
    secondes: 3,
    intent: "Obtenir N objets de la matiere visee en une seule action : le code rejoint le bloc le plus proche, le casse, ramasse ce qui tombe et recommence jusqu a N (60 s au plus). Rend la main au premier obstacle (outil manquant, cible trop haute, aucun chemin) en le disant : piler, fabriquer ou avancer ensuite. Prefere-la a avancer + casser + ramasser pour toute recolte",
    params: {
      quantite: {
        json: { kind: 'number', min: 1, max: 16 },
        question: 'Combien d objets de la matiere obtenir ?'
      }
    }
  },

  ramasser: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    summary: 'marcher sur les objets au sol',
    scale: 'nombre d objets vises, de 1 a 6',
    secondes: 0.8,
    intent: "Des objets sont tombes au sol a proximite : aller marcher dessus pour les mettre dans l inventaire. Un bloc casse n entre pas tout seul en inventaire s il est tombe plus loin. En mission bois, la dirt cassee pour un pilier compte aussi : si elle entre en inventaire, c est un succes, pas un echec",
    params: {
      quantite: {
        json: { kind: 'number', min: 1, max: 6 },
        question: 'Combien d objets au sol aller chercher ?'
      }
    }
  },

  // Depot mesure aux pieds du BON joueur (`bot/delivery.js`). Succes = depot
  // mesure (inventaire -N) + annonce, jamais un ramassage suppose. Refuse si
  // le joueur n a pas demande de don (mission.livraisonDemandee).
  donner: {
    kinds: ['recolte', 'construction', 'geste'],
    summary: 'deposer des objets aux pieds du joueur nomme et l en avertir',
    scale: 'nombre d objets deposes, de 1 a 64',
    secondes: 0.8,
    intent: "Deposer la quantite demandee d un objet d inventaire aux pieds du BON joueur (destinataire nomme) puis l en avertir : le succes vaut depot mesure (inventaire -N), jamais un ramassage suppose. Ne donner qu au joueur nomme et a portee (regard vers ses pieds) ; si absent, eloigne ou stock insuffisant, le dire sans pretendre un depot",
    params: {
      objet: {
        json: { kind: 'text', max: 40 },
        question: 'Quel objet d inventaire deposer ? (nom d objet Minecraft)'
      },
      quantite: {
        json: { kind: 'number', min: 1, max: 64 },
        question: 'Combien d exemplaires deposer aux pieds du joueur ?'
      },
      destinataire: {
        json: { kind: 'text', max: 16 },
        question: 'A quel joueur deposer (pseudo exact) ?'
      }
    }
  },

  // Cuisson au four (craft.smelt) : lingots depuis le minerai cru, charbon
  // de bois, verre, pierre... Four pose ou en inventaire, combustible pris
  // en poche (charbon, puis buches, planches).
  cuire: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    summary: 'cuire au four : minerai cru en lingot, buche en charbon de bois, sable en verre',
    scale: 'nombre d objets a cuire, de 1 a 16',
    secondes: 10,
    intent: "Transformer au four ce qui ne se fabrique pas : raw_iron en iron_ingot, raw_gold en gold_ingot, une buche en charcoal, sand en glass, cobblestone en stone. Il faut un four (pose a 24 blocs ou en inventaire : fabriquer furnace avec 8 cobblestone) et du combustible en poche (charbon, buches ou planches). 10 s par objet. objet = ce qu on veut obtenir ; sans objet, la prochaine cuisson du plan (environnement.prerequis)",
    params: {
      objet: {
        json: { kind: 'text', max: 40 },
        question: 'Quel objet obtenir par cuisson ?'
      },
      quantite: {
        json: { kind: 'number', min: 1, max: 16 },
        question: 'Combien en cuire ?'
      }
    }
  },

  fabriquer: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    summary: 'transformer l inventaire : planches, batons, etabli, porte, outils',
    scale: 'nombre d exemplaires, de 1 a 16',
    secondes: 1.2,
    intent: {
      what: "Transformer ce qui est en inventaire en quelque chose d utilisable : des buches en planches, des planches en batons, en etabli, en porte, ou fabriquer un outil ou tout objet valide au registre (recettes du jeu font foi, alias FR gardes : batons=stick, etabli=crafting_table). A choisir quand il manque un objet fabricable plutot que de la matiere brute. En mission bois, environnement.hache_recommandee est une optimisation facultative : la coupe a main nue reste productive si environnement.outil_necessaire n impose aucun outil. Apres un echec de cette fabrication facultative, ne pas repeter la meme chaine sans changement observe ; poursuivre l arbre commence par un moyen faisable. Une consigne explicite de fabrication garde son objet cible obligatoire",
      examples: [
        'il y a des buches mais pas de planches pour construire',
        'le joueur veut une porte et il n y en a pas en inventaire',
        'casser de la pierre ne lache rien faute de pioche',
        'couper du bois a la main est lent, une hache irait plus vite'
      ]
    },
    params: {
      objet: {
        question: 'Que faut-il fabriquer maintenant ?',
        // Nom LIBRE : tout item Minecraft valide (torch, stick, oak_planks...)
        // ou alias FR (batons, planches...) ; les recettes du jeu font foi,
        // fabrications_possibles n est qu une suggestion.
        json: { kind: 'text', max: 40 }
      },
      quantite: {
        json: { kind: 'number', min: 1, max: 16 },
        question: 'Combien d exemplaires fabriquer ?'
      }
    }
  },

  // Avec une cible de ressource, le navigateur rejoint une position visible
  // a portee d interaction dans le budget de distance demande. Sans cible,
  // avancer conserve le geste manuel dans le cap du regard.
  avancer: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'rejoindre un bloc cible par un chemin, ou avancer sans cible',
    scale: 'budget de trajet, de 1 a 40 blocs',
    secondes: 0.15,
    intent: "Avec un bloc cible repere, calculer automatiquement un chemin autour des obstacles vers une position visible a portee de ce bloc. Distance est le budget du trajet : arret possible avant le budget si la cible est accessible, ou progression partielle a poursuivre apres lecture du resultat. Aucun pivoter ou appuyer prealable. Sur no_path ou stuck, signale le blocage ou change d objectif autorise, sans repeter aveuglement ni improviser des touches. Sans cible, avancer droit devant dans le cap actuel. Le resultat mesure le deplacement reel",
    params: {
      distance: {
        json: { kind: 'number', min: 1, max: 40 },
        question: 'Quel budget de distance parcourir en blocs ?'
      }
    }
  },

  // Recherche de la matiere hors de vue, pilotee par le code (huit caps,
  // points debout rejoignables, jamais deux fois la meme zone). Interrupteur
  // A/B `explorer`.
  explorer: {
    kinds: ['recolte', 'deplacement', 'construction'],
    feature: 'explorer',
    summary: 'chercher la matiere visee hors de vue, par trajets calcules',
    scale: 'longueur d un trajet de recherche, de 8 a 32 blocs',
    secondes: 0.4,
    intent: "Rien de la matiere visee n est en vue (regarder_autour ou recolter disent « rien ») : le code choisit le cap le moins explore, y va par un chemin calcule, regarde, et recommence (4 trajets, 45 s au plus) jusqu a voir la matiere ou le repere. Remplace pivoter + avancer sans cible pour chercher",
    params: {
      distance: {
        json: { kind: 'number', min: 8, max: 32 },
        question: 'Longueur de chaque trajet de recherche, en blocs ?'
      }
    }
  },

  choisir_terrain: {
    kinds: ['construction'],
    summary: 'reperer un emplacement plat pour le chantier',
    scale: 'sans effet',
    secondes: 1,
    intent: "Le chantier n a pas encore d emplacement : en choisir un, plat et degage, a cote du repere demande par le joueur"
  },

  // Monter en pilier : poser des blocs sous soi en sautant, pour atteindre des
  // blocs hors de portee verticale (MISSION_MAX_REACH_UP). C est la reponse a
  // « monte a cote de l arbre avec de la dirt » : le deplacement de mission ne
  // grimpe pas (gestes au sol, pas de pathfinder), donc un tronc haut restait
  // incassable depuis le sol. La dirt vient de l inventaire REEL : sans elle,
  // l action echoue en le disant et le planificateur en casse au sol d abord.
  // Jamais de creatif ni de /tp : le bot monte avec ce qu il a ramasse.
  piler: {
    kinds: ['recolte', 'construction'],
    summary: 'monter en pilier avec dirt prioritaire puis planches solides',
    scale: 'hauteur du pilier, de 1 a 6 blocs',
    secondes: 1.5,
    intent: "Une cible proche est TROP HAUTE (environnement.cible_haute), ou environnement.acces_par_montee mesure une hauteur_min qui rend la cible masquee accessible : monter en pilier avec dirt/coarse_dirt en priorite puis planches solides du registre. Utiliser hauteur_min pour acces_par_montee, sinon denivele - 1 au plus ; inventaire.echafaudage.materiaux detaille le stock. Stock court : l action obtient elle-meme la terre manquante (pilier defait puis refait, terre prise a cote), meme perche. Sable, gravier et feuilles exclus. Chaque montee impose une reobservation avant la suite ; une pose partielle reste un echec mesure. Ne pile pas quand bloc_cible_a_portee est vrai (casse directement), ni dans un liquide, ni sans cible_haute ou acces_par_montee. Cet indice n autorise pas a casser des feuilles",
    params: {
      hauteur: {
        json: { kind: 'number', min: 1, max: 6 },
        question: 'De combien de blocs monter en pilier ?'
      }
    }
  },

  construire: {
    kinds: ['construction'],
    summary: 'poser les blocs prevus par le plan',
    scale: 'nombre de blocs poses, de 4 a 40',
    secondes: 0.6,
    intent: "L emplacement est choisi, il reste des blocs a poser ET le materiau est en inventaire : en poser maintenant, du bas vers le haut",
    params: {
      quantite: {
        json: { kind: 'number', min: 1, max: 40 },
        question: 'Combien de blocs poser avant de faire le point ?'
      },
      // Quand le chantier doit etre bati dans une matiere precise (« une maison
      // en pierre »), le planificateur peut nommer l objet a poser. Le code
      // verifie qu il est bien en inventaire avant de le prendre.
      objet: {
        json: { kind: 'text', max: 40 },
        question: 'Quel materiau poser (nom d objet Minecraft, optionnel) ?'
      }
    }
  },

  // Sous-buts (A/B `sous_buts`, eteint par defaut) : le modele choisit le but,
  // le code le conduit jusqu au bout avec les actions ci-dessus, guide par ce
  // qu il mesure (besoins du chantier, plan du solveur), et ne rend la main
  // qu a la fin ou au premier echec (code et remedes).
  batir: {
    kinds: ['construction'],
    feature: 'sous_buts',
    featureDefault: false,
    summary: 'conduire tout le chantier : terrain, bois, planches, pose, porte',
    scale: 'sans effet',
    secondes: 60,
    intent: "Le chantier est le but : le code choisit le terrain, finit un arbre commence, recolte les buches qui manquent, fabrique les planches, pose les blocs puis la porte demandee, en relisant besoins a chaque geste. Rend la main chantier fini, ou au premier echec avec son code et ses remedes (decider alors de la suite)"
  },
  obtenir: {
    kinds: ['recolte', 'construction'],
    feature: 'sous_buts',
    featureDefault: false,
    summary: 'obtenir l objet du solveur (fabrication demandee ou outil manquant)',
    scale: 'sans effet',
    secondes: 45,
    intent: "prerequis (etat) liste une chaine (recolter, fabriquer, cuire) : le code la deroule jusqu a l objet, sur l inventaire reel. Rend la main objet en poche, ou au premier echec avec son code et ses remedes"
  },

  poser_porte: {
    kinds: ['construction'],
    summary: 'poser la porte dans l ouverture',
    scale: 'sans effet',
    secondes: 2,
    intent: "Les murs sont montes, le joueur a demande une porte et une porte est en inventaire : la poser dans l ouverture laissee a cet effet"
  },

  sortir: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'se degager',
    scale: 'sans effet',
    secondes: 3,
    intent: 'Le bot est dans un liquide ou coince : se degager avant de reprendre le travail'
  },

  // Porte en bois : l ouvrir et passer de l autre cote, comme un joueur (bot
  // ferme dans la cabane qu il vient de batir, composite/cabin-from-scratch
  // 7d76b18). Interrupteur A/B `ouvrir_porte`.
  ouvrir_porte: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    feature: 'ouvrir_porte',
    summary: 'ouvrir la porte en bois la plus proche et la franchir',
    scale: 'sans effet',
    secondes: 3,
    intent: "Le bot est dans une piece fermee par une porte en bois (par exemple la cabane qu il vient de construire) ou une porte barre son chemin : la rejoindre, l ouvrir et passer de l autre cote (porte a 8 blocs au plus). Une porte de fer ne s ouvre pas a la main"
  },

  attendre: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'laisser finir',
    scale: 'duree de l attente, de 1 a 5 secondes',
    secondes: 1,
    intent: 'Une action est deja en cours et progresse : la laisser se terminer sans rien changer',
    params: {
      duree: {
        json: { kind: 'number', min: 1, max: 10 },
        question: 'Combien de secondes laisser filer ?'
      }
    }
  },

  terminer: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'clore la mission',
    scale: 'sans effet',
    secondes: 0,
    intent: "Rien d utile ne peut plus etre fait, ou l objectif est atteint : clore la mission"
  },

  // -------------------------------------------------------------------------
  // Actions de bas niveau
  //
  // Les huit actions au-dessus sont des **intentions** : « approche-toi »,
  // « construis ». Celles-ci sont des **gestes** : regarder quelque part,
  // sauter, tenir deux touches. Elles ne savent rien du jeu, et c est exactement
  // leur interet : elles donnent au planificateur de quoi composer ce que le
  // catalogue n a pas prevu, au lieu de le laisser sans rien faire.
  // -------------------------------------------------------------------------

  dire: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'ecrire une phrase dans le chat du serveur',
    scale: 'sans effet',
    secondes: 0.3,
    intent: "Dire quelque chose au joueur dans le chat : rendre compte d une avancee, signaler un blocage, repondre a une question. A utiliser sobrement, une ou deux fois par mission, pas a chaque etape. Style chat court : quelques mots utiles, pas de phrase complete si elle n ajoute rien (« bloque : plus de terre »)",
    params: {
      texte: {
        json: { kind: 'text', max: 120 },
        question: 'Que dire au joueur ?'
      }
    }
  },

  regarder: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'tourner la tete vers un angle donne',
    scale: 'sans effet',
    secondes: 0.4,
    intent: "Tourner la tete pour voir ailleurs : balayer les alentours avant de choisir une direction, ou viser une case en hauteur. Les blocs ne sont trouves que dans les chunks charges, et regarder ne charge rien — cela sert a viser, pas a explorer",
    params: {
      horizontal: {
        json: { kind: 'number', min: -180, max: 180 },
        question: 'Angle horizontal en degres : 0 = nord, 90 = ouest, 180 = sud, -90 = est'
      },
      vertical: {
        json: { kind: 'number', min: -90, max: 90 },
        question: 'Angle vertical en degres : 0 = horizon, 90 = le ciel, -90 = ses pieds'
      }
    }
  },

  sauter: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'sauter sur place',
    scale: 'sans effet',
    secondes: 0.6,
    intent: "Sauter sur place pour un geste demande par le joueur. Le resultat dit de combien le bot a decolle ; un decollage nul peut venir d un plafond ou d un coincement. Le navigateur gere les marches pendant avancer vers un bloc cible : aucun saut manuel prealable",
    params: {
      duree: {
        json: { kind: 'number', min: 0.2, max: 2 },
        question: 'Combien de secondes maintenir le saut ?'
      }
    }
  },

  appuyer: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'tenir une ou plusieurs touches ensemble',
    scale: 'sans effet',
    secondes: 1,
    intent: "Tenir des touches directement, plusieurs a la fois si besoin : avancer en sautant, reculer en courant, se decaler d un pas. Sert aux gestes explicitement demandes par le joueur (reculer, se decaler de cote, sprinter). Pour rejoindre un bloc cible, avancer calcule deja le chemin : ne remplace pas ce trajet par une suite de touches",
    params: {
      touches: {
        json: { kind: 'list', of: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'], max: 3 },
        question: 'Quelles touches tenir en meme temps ? (forward, back, left, right, jump, sprint, sneak)'
      },
      duree: {
        json: { kind: 'number', min: 0.2, max: 2 },
        question: 'Combien de secondes les tenir ?'
      }
    }
  },

  // Le defaut du planificateur quand il ne voit rien d utile a faire. Il avait
  // `attendre` pour cela, qui ne rend aucune information : deux tours plus tard
  // il ne savait pas plus quoi faire et rappelait `attendre`. Un balayage coute
  // le meme temps et **rend de l information** — ce qui est visible, et dans
  // quelle direction — donc le tour suivant n est pas identique au precedent.
  regarder_autour: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'balayer les alentours du regard',
    scale: 'sans effet',
    secondes: 1.2,
    intent: "Tourner sur soi-meme et rendre compte de ce qui est visible dans chaque direction, avec le cap a prendre. C est l action a choisir quand tu ne sais pas quoi faire : elle ne change rien au monde, mais elle te donne de quoi decider au tour suivant, ce qu attendre ne fait pas"
  },

  // `regarder` demande un cap absolu (0 = nord), que le modele place mal une
  // fois sur deux. Un angle relatif n a pas ce probleme : « un quart de tour a
  // gauche » ne depend d aucune convention.
  pivoter: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'tourner d un angle relatif',
    scale: 'sans effet',
    secondes: 0.4,
    intent: "Tourner d un angle RELATIF a l orientation actuelle : un angle POSITIF tourne a GAUCHE, un negatif a DROITE (90 = quart de tour a gauche, -90 = a droite, 180 = demi-tour). Sert a une rotation demandee par le joueur ou a orienter une exploration sans cible. Pour un bloc cible repere, avancer gere seul la direction du trajet",
    params: {
      angle: {
        json: { kind: 'number', min: -180, max: 180 },
        question: 'De combien de degres tourner ? positif = vers la gauche, negatif = vers la droite'
      }
    }
  },

  // Memoire du modele : la seule action qui ne touche ni au jeu ni au
  // vocabulaire, mais a son propre fil de raisonnement. La memoire long terme
  // vit dans le prompt systeme (couche 3, mise en cache), la memoire de
  // mission dans la couche volatile recollee a chaque appel (voir memory.js).
  memoriser: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'noter une information pour les tours suivants',
    scale: 'sans effet',
    secondes: 0.3,
    intent: "Ecrire dans ta memoire pour garder une information d un tour a l autre : une position de gisement, une intention, ce que tu as appris du terrain. `portee` vaut travail (valable pour la mission en cours, efface au prochain objectif) ou long_terme (survit aux missions et au redemarrage ; elle n est ecrite qu a la fin de la mission, en attendant elle apparait sous a_retenir). Chaque portee a son plafond, visible dans etat.memoire.plafonds, et etat.memoire.restants dit ce qui reste par portee. Une ecriture qui depasserait est REFUSEE : le resultat te dit combien il reste, et il faut alors oublier ou resumer avant d ecrire. Ecris court et utile, jamais un journal de tes actions.",
    params: {
      texte: {
        json: { kind: 'text', max: 2000 },
        question: 'Que noter, en une ou deux phrases ?'
      },
      portee: {
        json: { kind: 'list', of: ['travail', 'long_terme'], max: 1 },
        question: 'Pour combien de temps ? travail = la mission en cours, long_terme = au-dela'
      }
    }
  },

  oublier: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'effacer une partie de sa memoire',
    scale: 'sans effet',
    secondes: 0.2,
    intent: "Effacer ta memoire, en tout ou en partie : `tout`, la portee travail (fin de mission) ou la portee long_terme (information devenue fausse). A faire quand une note t egare ou que la memoire approche de sa limite, pour liberer des jetons avant d ecrire.",
    params: {
      portee: {
        json: { kind: 'list', of: ['travail', 'long_terme', 'tout'], max: 1 },
        question: 'Quelle memoire effacer ?'
      }
    }
  },

  // Aller vers le joueur qui a parle, ou se tourner vers lui. La geometrie est
  // mesuree par le code, le modele se contente de dire « vers lui » : c est la
  // reponse directe a « viens me voir » et « fais des allers-retours vers moi ».
  rejoindre_demandeur: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'marcher jusqu au joueur qui a parle',
    scale: 'sans effet',
    secondes: 2.5,
    intent: "Aller jusqu au joueur qui a donne la consigne, quand la demande parle de « moi », de « me rejoindre » ou d un aller-retour vers lui. Pour une remise, indique objet sur ce trajet, meme si donner vient dans un autre plan. Le code mesure ou il est, tu ne donnes aucune coordonnee",
    params: {
      objet: {
        json: { kind: 'text', max: 40 },
        question: 'Quel objet remettre apres ce trajet (nom Minecraft, optionnel ; omettre pour simplement rejoindre) ?'
      }
    }
  },

  tourner_vers_demandeur: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'se tourner vers le joueur qui a parle',
    scale: 'sans effet',
    secondes: 0.4,
    intent: "Faire face au joueur qui a donne la consigne, avant de lui repondre ou de marcher vers lui"
  }
}

// ---------------------------------------------------------------------------
// Ressources : ce qu une mission peut viser
//
// Les noms de blocs sont ceux de minecraft-data en 26.1 (protocole 775).
// mission.js filtre ceux que le registre du serveur ne connait pas, donc une
// entree en trop est inoffensive.
//
// `build` est le bloc pose en construction : on batit en terre, pas en bloc
// d herbe, et en planches plutot qu en tronc.
// ---------------------------------------------------------------------------

const RESOURCES = {
  herbe: {
    intent: 'herbe, hautes herbes, fougeres, la vegetation basse que l on casse a la main',
    blocks: ['short_grass', 'tall_grass', 'fern', 'large_fern'],
    items: /^(wheat_seeds|short_grass|tall_grass|fern|large_fern)$/,
    // On ne batit pas en herbe : en survie elle ne lache que des graines. Une
    // construction demandee « en herbe » se fait donc en terre.
    build: 'dirt',
    buildMatch: /^(dirt|coarse_dirt|grass_block)$/,
    raw: /^(dirt|coarse_dirt)$/
  },
  // Fix 2 : « ramasse 5 graines » nomme le PRODUIT (wheat_seeds), pas la source.
  // Sans cette entree, le brief tombait sur 'aucune' : aucun bloc a casser, un
  // compteur d inventaire toujours a zero, et `ramasser` qui annoncait un succes
  // sans rien collecter. Les blocs sources sont ceux de l herbe : casser de
  // l herbe fait tomber des graines. On ne batit pas en graines, comme en herbe.
  graines: {
    intent: 'graines, wheat_seeds : les graines que l herbe cassee lache au sol, a ramasser (ex : ramasse 5 graines)',
    blocks: ['short_grass', 'tall_grass', 'fern', 'large_fern'],
    items: /^wheat_seeds$/,
    build: 'dirt',
    buildMatch: /^(dirt|coarse_dirt|grass_block)$/,
    raw: /^(dirt|coarse_dirt)$/
  },
  bois: {
    intent: {
      what: 'arbres, buches, troncs, bois, planches',
      examples: ['coupe du bois', 'va a cote d un arbre', 'une cabane en bois', 'abats un chene']
    },
    blocks: [
      'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
      'cherry_log', 'dark_oak_log', 'pale_oak_log', 'mangrove_log'
    ],
    items: /_log$|_planks$|^stick$/,
    build: 'oak_planks',
    // L essence depend de l arbre coupe : on accepte n importe quelles planches,
    // et mission.js choisit celles qui sont reellement en inventaire.
    buildMatch: /_planks$/,
    raw: /_log$|_wood$|_stem$|_hyphae$/,
    // Une buche donne quatre planches : c est ce rapport qui dit combien de
    // buches il faut couper pour une maison.
    craft: { from: 'buches', to: 'planches', ratio: 4 }
  },
  feuilles: {
    intent: 'feuillages, feuilles d arbres',
    blocks: [
      'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves',
      'acacia_leaves', 'cherry_leaves', 'dark_oak_leaves', 'pale_oak_leaves',
      'mangrove_leaves', 'azalea_leaves', 'flowering_azalea_leaves'
    ],
    items: /_leaves$|_sapling$|^(apple|stick)$/,
    // Les feuilles ne tombent qu a la cisaille : on batit en terre a la place.
    build: 'dirt',
    buildMatch: /^(dirt|coarse_dirt|grass_block)$/,
    raw: /^(dirt|coarse_dirt)$/
  },
  fleur: {
    intent: 'fleurs de toutes couleurs',
    blocks: [
      'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
      'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
      'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'torchflower', 'pink_petals'
    ],
    items: /^(dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|pink_petals)$/,
    build: 'dirt',
    buildMatch: /^(dirt|coarse_dirt|grass_block)$/,
    raw: /^(dirt|coarse_dirt)$/
  },
  pierre: {
    intent: 'pierre, roche, cobblestone, granite, diorite, andesite',
    blocks: ['stone', 'cobblestone', 'granite', 'diorite', 'andesite', 'tuff', 'deepslate'],
    items: /^(stone|cobblestone|granite|diorite|andesite|tuff|deepslate|cobbled_deepslate)$/,
    // La pierre cassee lache du cobblestone, et seulement avec une pioche.
    build: 'cobblestone',
    buildMatch: /^(cobblestone|stone|granite|diorite|andesite|cobbled_deepslate)$/,
    raw: /^(cobblestone|stone|granite|diorite|andesite|cobbled_deepslate)$/
  },
  terre: {
    intent: 'terre, bloc d herbe, sol, boue',
    blocks: ['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud'],
    items: /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|hanging_roots)$/,
    // Un bloc d herbe casse lache de la terre : c est elle qu on pose.
    build: 'dirt',
    buildMatch: /^(dirt|coarse_dirt|grass_block)$/,
    raw: /^(dirt|coarse_dirt|rooted_dirt)$/
  },
  sable: {
    intent: 'sable, gravier',
    blocks: ['sand', 'red_sand', 'gravel'],
    items: /^(sand|red_sand|gravel|flint)$/,
    build: 'sand',
    buildMatch: /^(sand|red_sand|gravel)$/,
    raw: /^(sand|red_sand|gravel)$/
  },
  minerai: {
    intent: 'minerais : charbon, fer, cuivre, or, diamant, redstone, lapis, emeraude',
    blocks: [
      'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
      'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
      'diamond_ore', 'deepslate_diamond_ore', 'redstone_ore', 'deepslate_redstone_ore',
      'lapis_ore', 'deepslate_lapis_ore', 'emerald_ore', 'deepslate_emerald_ore'
    ],
    items: /^(coal|raw_iron|raw_copper|raw_gold|diamond|redstone|lapis_lazuli|emerald|.*_ore)$/,
    // Un minerai ne se repose pas : un chantier « en minerai » se fait en pierre.
    build: 'cobblestone',
    buildMatch: /^(cobblestone|cobbled_deepslate)$/,
    raw: /^(cobblestone|cobbled_deepslate)$/
  },
  aucune: {
    // Un objectif de deplacement vise quand meme une matiere quand il en nomme
    // une : "va a cote d un arbre" vise le bois. 'aucune' est reserve aux
    // objectifs qui ne nomment ni matiere ni type de bloc.
    intent: {
      what: "L objectif ne nomme aucune matiere ni aucun type de bloc : il parle d un lieu, d un joueur, d une direction ou d une distance",
      not_for: "Tout objectif qui nomme une matiere, meme s il s agit seulement d aller aupres d elle plutot que de la recolter",
      examples: ['reviens au point de depart', 'suis moi pendant cinq minutes', 'monte sur la colline']
    },
    blocks: [],
    items: /^$/,
    build: 'dirt',
    buildMatch: /^(dirt|coarse_dirt|grass_block)$/,
    raw: /^(dirt|coarse_dirt)$/
  }
}

// Alias de matieres : le modele peut rendre le singulier, l anglais ou le nom
// d objet (« wheat_seeds ») la ou le catalogue attend le canonique (« graines »).
// Sans cette table, « ramasse 5 graines » tombait sur 'aucune' des que le modele
// ecrivait autre chose que le pluriel exact.
const RESOURCE_ALIASES = {
  graine: 'graines',
  graines: 'graines',
  wheat_seeds: 'graines',
  wheat_seed: 'graines',
  seed: 'graines',
  seeds: 'graines'
}

// Nom canonique d une matiere, ou null si elle n existe ni comme ressource ni
// comme alias. Insensible a la casse et aux espaces.
function resolveResource (input) {
  const key = String(input ?? '').trim().toLowerCase()
  if (!key) return null
  if (Object.prototype.hasOwnProperty.call(RESOURCES, key)) return key
  return RESOURCE_ALIASES[key] ?? null
}

// ---------------------------------------------------------------------------
// Matieres ouvertes au registre (A/B `buts_ouverts`, 2026-10-02).
//
// Le catalogue RESOURCES reste ferme (il nourrit les prompts mis en cache) ;
// une demande hors catalogue (« ramene-moi 3 citrouilles », « va jusqu au
// spawner ») nomme un bloc du registre Minecraft, que le MODELE traduit de la
// phrase du joueur et que le CODE valide et decrit ici depuis minecraft-data :
// objets lachees (ce qui se compte en inventaire), bloc incassable. La cle
// `libre:<bloc>` porte tout : une mission restauree la reconstruit sans etat.
// Aucun bloc nomme en dur : n importe quel bloc du registre vaut.
// ---------------------------------------------------------------------------

const LIBRE = 'libre:'
const libres = new Map()
const echapper = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function nomBlocRegistre (input) {
  const nom = String(input ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  return /^[a-z0-9_]{2,48}$/.test(nom) ? nom : null
}

// Cle `libre:<bloc>` d un bloc du registre, ou null (inconnu, air).
function ressourceLibre (input, registry) {
  const nom = nomBlocRegistre(input)
  const bloc = nom && registry?.blocksByName?.[nom]
  if (!bloc || /(^|_)air$/.test(nom)) return null
  return LIBRE + nom
}

// Description d une matiere : celle du catalogue, sinon celle d un bloc ouvert
// tiree du registre (null si inconnue). Meme forme que RESOURCES.
function resourceSpec (key, registry) {
  if (Object.prototype.hasOwnProperty.call(RESOURCES, key)) return RESOURCES[key]
  if (typeof key !== 'string' || !key.startsWith(LIBRE)) return null
  if (libres.has(key)) return libres.get(key)
  const nom = key.slice(LIBRE.length)
  const bloc = registry?.blocksByName?.[nom]
  if (!bloc) return null
  const lachees = (bloc.drops ?? [])
    .map(d => typeof d === 'number' ? d : d?.drop?.id ?? d?.drop ?? d?.id)
    .filter(Number.isInteger)
    .map(id => registry.items?.[id]?.name)
    .filter(Boolean)
  const objets = [...new Set(lachees)]
  // Se batit seulement s il se ramasse tel quel (une citrouille, pas un melon).
  const seRamasse = objets.includes(nom)
  const spec = {
    intent: bloc.displayName ?? nom,
    libre: true,
    blocks: [nom],
    // Rien ne se ramasse (spawner, bloc incassable) : on peut y aller, pas le recolter.
    items: objets.length ? new RegExp(`^(${objets.map(echapper).join('|')})$`) : null,
    incassable: bloc.diggable === false || !(bloc.hardness >= 0),
    build: seRamasse ? nom : 'dirt',
    buildMatch: seRamasse ? new RegExp(`^${echapper(nom)}$`) : /^(dirt|coarse_dirt|grass_block)$/,
    raw: seRamasse ? new RegExp(`^${echapper(nom)}$`) : /^(dirt|coarse_dirt)$/
  }
  libres.set(key, spec)
  return spec
}

// Ce que le bot ne sait pas encore faire (A/B `buts_ouverts`) : le brief en
// nomme un identifiant quand la demande l EXIGE, et le code refuse aussitot en
// le disant, au lieu de tourner jusqu au plafond. Le code ne retient qu un
// identifiant de cette liste (jamais un texte libre du modele). Retirer une
// entree des qu une action la couvre.
const CAPACITES_ABSENTES = {
  conteneur: 'ouvrir un coffre, un tonneau, un entonnoir ou un autre conteneur pour y deposer ou en retirer des objets (la cuisson au four, elle, existe)',
  animal: 'agir sur un animal : le nourrir, le faire se reproduire, le tondre, le traire, le mener en laisse, l attirer ou l enfermer',
  mecanisme: 'faire de la redstone ou des mecanismes : entonnoirs relies, pistons, rails, leviers, circuits, fermes automatiques',
  culture: 'semer, planter, labourer ou faire pousser des cultures',
  combat: 'combattre ou chasser des creatures',
  dimension: 'aller dans le Nether ou l End',
  echange: 'commercer avec des villageois'
}

// ---------------------------------------------------------------------------
// Cible de fabrication generique (sans regex de phrase).
//
// Le brief LLM rend un nom libre ("hache", "minecraft:torch", "batons"...).
// Cette normalisation est SYNTAXIQUE seulement (casse, namespace, alias FR,
// familles _planks/_door/_axe/_pickaxe/_shovel) : la validation registre
// (craft.TARGETS ou itemsByName) et le comptage restent dans mission.js via
// le code, jamais un compte du modele. Aucune phrase du joueur n est matchee
// ici : "fabrique une hache" et "fais-moi une hache en pierre" donnent le meme
// "hache" parce que le MODELE l a extrait, pas parce qu une regex l a vu.
// ---------------------------------------------------------------------------

const FABRICATION_ALIASES = {
  baton: 'batons',
  batons: 'batons',
  stick: 'batons',
  sticks: 'batons',
  planche: 'planches',
  planches: 'planches',
  etabli: 'etabli',
  etablis: 'etabli',
  crafting_table: 'etabli',
  porte: 'porte',
  portes: 'porte',
  door: 'porte',
  hache: 'hache',
  haches: 'hache',
  axe: 'hache',
  pioche: 'pioche',
  pioches: 'pioche',
  pickaxe: 'pioche',
  pelle: 'pelle',
  pelles: 'pelle',
  shovel: 'pelle'
}

// Noms francais d objets et d outils a matiere nommee. Vu en CI : « pioche en
// pierre », « torches », « four » n etaient pas reconnus, la mission tombait
// sans cible de fabrication (solveur inactif, bot visant la pierre enfouie).
const FR_TOOLS = { pioche: 'pickaxe', hache: 'axe', pelle: 'shovel', epee: 'sword', houe: 'hoe' }
const FR_MATERIALS = { bois: 'wooden', pierre: 'stone', fer: 'iron', or: 'golden', diamant: 'diamond' }
const FR_ITEMS = {
  four: 'furnace', torche: 'torch', coffre: 'chest', echelle: 'ladder', seau: 'bucket',
  bateau: 'oak_boat', barriere: 'oak_fence', bol: 'bowl', papier: 'paper', canne: 'fishing_rod',
  arc: 'bow', fleche: 'arrow', pain: 'bread', levier: 'lever', panneau: 'oak_sign'
}
const FR_STOP = new Set(['un', 'une', 'des', 'de', 'du', 'la', 'le', 'les', 'l', 'd', 'a', 'en', 'au'])

function singular (word) {
  if (FR_TOOLS[word] || FR_MATERIALS[word] || FR_ITEMS[word]) return word // « bois » n est pas un pluriel
  return word.length > 3 && /[sx]$/.test(word) ? word.slice(0, -1) : word
}

function frenchFabricationTarget (key) {
  const words = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  const content = words.map(singular)
  const tool = content.find(w => FR_TOOLS[w])
  if (tool) {
    const material = content.find(w => FR_MATERIALS[w])
    // Sans matiere : la famille (« une pioche » -> pioche, le code choisit).
    return material ? `${FR_MATERIALS[material]}_${FR_TOOLS[tool]}` : (FABRICATION_ALIASES[tool] ?? null)
  }
  const nouns = content.filter(w => !FR_STOP.has(w))
  if (nouns.length === 1 && FR_ITEMS[nouns[0]]) return FR_ITEMS[nouns[0]]
  return null
}

function normalizeFabricationTarget (input) {
  // Accents, articles et espaces pliés : le brief rend « établi », « une
  // hache en bois » (vu sur craft/table : « établi » inconnu, aucune cible,
  // batons fabriques et planches perdues).
  const key = String(input ?? '').trim().toLowerCase().replace(/^minecraft:/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^(?:(?:une?|des|les?|la)\s+|l['’]\s*)/, '').replace(/\s+/g, ' ').trim()
  if (!key) return null
  const french = frenchFabricationTarget(key)
  if (french) return french
  if (Object.prototype.hasOwnProperty.call(FABRICATION_ALIASES, key)) {
    return FABRICATION_ALIASES[key]
  }
  if (/_planks$/.test(key)) return 'planches'
  if (/_door$/.test(key)) return 'porte'
  // Un outil dont la matiere est nommee (wooden_axe) reste cet objet exact :
  // la famille « hache » essaie d abord la pierre (vu sur craft/axe : « hache
  // en bois » demandee, cobblestone reclamee, mission bloquee).
  if (/^(wooden|stone|iron|golden|diamond|netherite)_(axe|pickaxe|shovel)$/.test(key)) return key
  if (/_axe$/.test(key)) return 'hache'
  if (/_pickaxe$/.test(key)) return 'pioche'
  if (/_shovel$/.test(key)) return 'pelle'
  // Pluriel anglais (« torches ») : le registre tranchera sur le singulier.
  if (/^[a-z0-9_]+$/.test(key)) return key.slice(0, 40)
  return null
}

// Ou poser un chantier. Sert au type `construction` : « a cote d un arbre »
// doit envoyer le bot pres d un tronc, pas n importe ou.
const LANDMARKS = {
  arbre: {
    intent: "Le joueur situe la construction par rapport a un arbre, un bois, une foret",
    resource: 'bois'
  },
  eau: {
    intent: "Le joueur situe la construction par rapport a de l eau, un lac, une riviere",
    resource: null
  },
  ici: {
    intent: "Le joueur ne situe rien, ou dit « ici », « la ou tu es », « pres de moi » : batir sur place",
    resource: null
  }
}

// ---------------------------------------------------------------------------
// Acces
// ---------------------------------------------------------------------------

const ALIAS_TO_NAME = new Map()
for (const [name, spec] of Object.entries(COMMANDS)) {
  ALIAS_TO_NAME.set(name, name)
  for (const alias of spec.aliases) ALIAS_TO_NAME.set(alias, name)
}

// Nom canonique d une commande, ou null si elle n existe pas.
function resolve (input) {
  return ALIAS_TO_NAME.get(String(input || '').toLowerCase()) ?? null
}

// Les actions proposees pour ce type de mission seulement.
// `supply` vaut 'harvest' (le bot recolte et fabrique ce qu il pose) ou
// 'creative' (la main se remplit toute seule, pour une demonstration rapide).
// En creative, proposer « casser » ou « fabriquer » sur un chantier n aurait
// aucun sens : le materiau ne manque jamais.
// Actions coupees par leur interrupteur A/B (`spec.feature`, mission.js
// `featureOn`) : absentes du catalogue et refusees a la validation. Un
// changement incremente docGeneration, donc le prompt en cache est refait.
const disabledFeatures = new Set()
function setFeatureEnabled (feature, enabled) {
  const before = disabledFeatures.has(feature)
  if (enabled) disabledFeatures.delete(feature)
  else disabledFeatures.add(feature)
  if (before !== disabledFeatures.has(feature)) docGeneration += 1
}

function availableFor (kind, supply = 'harvest') {
  return Object.entries(ACTIONS).filter(([, spec]) => {
    if (kind && !spec.kinds.includes(kind)) return false
    if (spec.feature && disabledFeatures.has(spec.feature)) return false
    if (supply === 'creative' && kind === 'construction' && spec.harvesting) return false
    return true
  })
}

function actionsFor (kind, supply) {
  return availableFor(kind, supply).map(([name]) => name)
}

// Les parametres d une action : tout ce qui porte un descripteur `json`.
function jsonParamsFor (action) {
  const params = ACTIONS[action]?.params
  if (!params) return null
  const jsonish = Object.entries(params).filter(([, d]) => d.json)
  return jsonish.length > 0 ? Object.fromEntries(jsonish) : null
}

// Duree estimee a partir des parametres NUMERIQUES du planificateur JSON :
// `duree` (secondes) se prend telle quelle, `distance` et `quantite` se
// multiplient par la duree unitaire de l action. C est ce que le modele a
// reellement demande, donc on ne le rabote pas : on s en sert pour savoir si le
// plan tient dans le budget de temps, et pour l afficher.
function estimatedSecondsFromParams (action, params = {}) {
  const spec = ACTIONS[action]
  if (!spec) return 1

  const p = params ?? {}
  if (action === 'fabriquer') return typeof spec.secondes === 'number' ? spec.secondes : 1.2
  if (typeof p.duree === 'number' && Number.isFinite(p.duree)) return p.duree
  if (typeof p.distance === 'number' && Number.isFinite(p.distance)) {
    return (spec.secondes ?? 0.15) * p.distance
  }
  if (typeof p.hauteur === 'number' && Number.isFinite(p.hauteur)) {
    return (spec.secondes ?? 1.5) * p.hauteur
  }
  if (typeof p.quantite === 'number' && Number.isFinite(p.quantite)) {
    return (spec.secondes ?? 0.6) * p.quantite
  }
  return typeof spec.secondes === 'number' ? spec.secondes : 1
}

// Les actions parametrees, pour l audit et /api/commands.
function parameterized () {
  return Object.entries(ACTIONS)
    .filter(([name]) => jsonParamsFor(name))
    .map(([name, spec]) => ({ name, params: Object.keys(spec.params) }))
}

// ---------------------------------------------------------------------------
// Documentation et exemples des actions
//
// Il n y a plus d actions apprises. Le planificateur compose lui-meme ses
// enchainements a partir des actions natives ci-dessus : ce qu il lit pour bien
// composer, c est leur intent, leurs parametres, et les exemples concrets
// ci-dessous. Un exemple n est PAS du code et n est jamais execute : c est un
// modele de composition que le planificateur imite.
//
// La documentation est native seulement : l aide distante qui la reecrivait
// (repair.js, overlay /data/actions-doc.json) est retiree le 2026-09-27, et
// l overlay avec elle le 2026-09-28 (il n avait plus d auteur, et un vieux
// fichier du volume aurait continue d egarer le modele).
// ---------------------------------------------------------------------------

const ACTION_EXEMPLES = {
  cuire: [
    'prerequis : « cuire 3 iron_ingot depuis raw_iron », 3 raw_iron et un four -> {"action":"cuire","objet":"iron_ingot","quantite":3}',
    'pas de four -> fabriquer furnace (8 cobblestone, etabli) avant cuire'
  ],
  explorer: [
    'regarder_autour -> « rien » dans les quatre directions -> {"action":"explorer","distance":16}',
    'recolter -> « aucun bloc de la matiere visee en vue » -> {"action":"explorer","distance":16} puis recolter'
  ],
  recolter: [
    'mission bois, 0 buche en poche, arbre en vue -> {"action":"recolter","quantite":4}',
    'besoins.buches_a_recolter = 3 -> {"action":"recolter","quantite":3} (tout d un coup, pas une buche par plan)',
    'resultat « cible trop haute » -> piler, puis recolter de nouveau'
  ],
  casser: [
    'navigation.a_portee vrai -> {"action":"casser","duree":4}',
    'tronc a portee avec plusieurs buches -> {"action":"casser","duree":8} (rafale : 4 a 6 buches d un coup, pas une par une)',
    'bloc de la matiere en vue mais hors portee -> avancer d abord, casser ensuite',
    'environnement.dirt_secondaire_cible non null -> {"action":"casser","duree":2} (terre selectionnee a portee pour le pilier, quota bois inchange)'
  ],
  ramasser: [
    'environnement.navigation_objet.a_portee vrai -> {"action":"ramasser","quantite":1}',
    'objets_au_sol_a_proximite > 0 -> ramasser, jamais sur la cible d un bloc',
    'dirt cassee pour un pilier et objets au sol -> ramasser : la dirt entree compte comme un succes, piler ensuite'
  ],
  fabriquer: [
    'buches en inventaire et planches a 0 -> {"action":"fabriquer","objet":"oak_planks","quantite":4}',
    'environnement.hache_recommandee vrai et hache fabricable -> fabriquer est une optimisation facultative, la coupe productive a main nue reste permise',
    'hache facultative ou pose d etabli echouee sans changement observe -> reprendre la coupe productive ou l acces aux buches du meme arbre',
    'consigne.fabrication_cible "hache" et fabrications_possibles sans hache -> {"action":"fabriquer","objet":"oak_planks","quantite":4} puis batons puis etabli (chaine courte vers la cible, jamais un quota de recolte)'
  ],
  avancer: [
    'navigation {angle:-45,distance:12} et bloc cible hors portee -> {"action":"avancer","distance":12} (chemin automatique)',
    'trajet partiel avec progression et cible encore hors portee -> avancer de nouveau apres lecture du resultat',
    'resultat no_path ou stuck -> signaler le blocage, pas une boucle de touches',
    'aucune cible et demande avance de trois blocs -> {"action":"avancer","distance":3} (cap du regard)'
  ],
  piler: [
    'environnement.cible_haute denivele 4 et inventaire.echafaudage.total >= 3 -> {"action":"piler","hauteur":3} puis reobserver',
    'environnement.acces_par_montee hauteur_min 1, stock 4, manque 0 et cible_haute null -> {"action":"piler","hauteur":1} puis reobserver la branche devenue accessible',
    'aucune dirt mais six planches solides dans inventaire.echafaudage -> piler possible jusqu a six niveaux si appui et plafond libres',
    'hauteur choisie 3 et inventaire.echafaudage.total a 2 -> obtenir et ramasser le manque avant de monter'
  ],
  choisir_terrain: ['chantier.emplacement_choisi faux -> choisir_terrain avant toute pose'],
  construire: ['chantier.materiau_en_inventaire > 0 -> {"action":"construire","quantite":30,"objet":"oak_planks"} (rafales longues : la borne de rafale coupe, pas la quantite)'],
  poser_porte: ['murs montes et porte en inventaire -> poser_porte'],
  sortir: ['bot.dans_liquide vrai -> sortir avant tout le reste'],
  ouvrir_porte: ['avancer ou recolter -> no_path et bot dans un batiment a porte en bois -> ouvrir_porte, puis reprendre le trajet'],
  attendre: ['une action longue est deja en cours -> attendre, mais preferer regarder_autour si on ne sait pas quoi faire'],
  terminer: ['objectif atteint et rien d utile ne reste -> terminer'],
  dire: ['signal de blocage -> {"action":"dire","texte":"coince : plus de bois"}'],
  regarder: ['viser une case en hauteur -> regarder horizontal 0 vertical 45'],
  sauter: ['consigne saute sur place -> {"action":"sauter","duree":0.3}'],
  appuyer: ['consigne decale-toi a droite une seconde -> {"action":"appuyer","touches":["right"],"duree":1}'],
  regarder_autour: ['aucune cible et aucune direction -> regarder_autour, jamais attendre'],
  pivoter: ['consigne tourne a gauche de 90 degres -> {"action":"pivoter","angle":90}'],
  memoriser: ['gisement de charbon repere -> memoriser portee long_terme'],
  oublier: ['note devenue fausse -> oublier la portee concernee'],
  rejoindre_demandeur: ['consigne "viens me voir" -> rejoindre_demandeur'],
  tourner_vers_demandeur: ['repondre a "tu me vois ?" -> tourner_vers_demandeur puis dire'],
}

// Contre-exemples natifs : ce qu il ne faut PAS faire avec l action. Meme
// statut que ACTION_EXEMPLES (modele de composition, jamais execute), rendus
// dans le prompt sous la forme `ne pas : ...`. Courts et cites sur des champs
// de mission.buildState() : `audit` verifie ces champs et les bornes.
const ACTION_CONTRE_EXEMPLES = {
  casser: [
    'environnement.bloc_cible_a_portee faux et environnement.dirt_secondaire_admise faux -> ne pas casser, avancer rejoint automatiquement la portee du bloc cible',
    'environnement.dirt_secondaire_admise faux en mission bois -> ne pas casser de dirt, seul le bois compte'
  ],
  fabriquer: ['hache facultative ou etabli echoue sans changement observe -> ne pas repeter le meme craft ni abandonner l arbre commence'],
  ramasser: ['environnement.objets_au_sol_a_proximite a 0 -> ne pas ramasser, casser d abord'],
  avancer: ['environnement.navigation.a_portee vrai -> ne plus avancer, casser sans depasser la cible'],
  piler: [
    'environnement.bloc_cible_a_portee vrai -> ne pas piler, casser directement',
    'perche sur son pilier sans terre, cible encore trop haute -> ne pas casser de dirt hors de portee : piler directement, l action recupere la terre manquante'
  ],
  construire: ['chantier.materiau_en_inventaire a 0 -> ne pas construire, casser ou fabriquer d abord'],
  terminer: ['progression.unites_recoltees sous le quota -> ne pas terminer, continuer le travail'],
}

let docGeneration = 0

function nativeExemples (name) {
  return Array.isArray(ACTION_EXEMPLES[name]) ? ACTION_EXEMPLES[name] : []
}

function nativeContreExemples (name) {
  return Array.isArray(ACTION_CONTRE_EXEMPLES[name]) ? ACTION_CONTRE_EXEMPLES[name] : []
}

// ---------------------------------------------------------------------------
// Gabarit de documentation et controle des champs cites.
//
// Une documentation d action suit un gabarit fixe :
//   - role : l intent natif de l action (ce qu elle fait, jamais modifiable) ;
//   - params bornes : les descripteurs `json` de l action (min/max reels) ;
//   - preconditions : le `quand` (dans quelle situation l employer) ;
//   - exemples / contre-exemples : des compositions valides, ou ce qu il ne
//     faut pas faire, rendus tels quels dans le catalogue du prompt.
//
// `audit` controle la documentation native, parce qu un exemple qui cite une
// mesure inexistante fait raisonner le modele sur du vide :
//   - tout champ d etat cite doit exister dans mission.buildState() (sinon
//     refuse, en nommant le champ) ;
//   - toute valeur numerique proposee dans un extrait JSON doit tenir dans les
//     bornes `json` du parametre (sinon refusee, en nommant l ecart).
// ---------------------------------------------------------------------------

// Miroir des cles lues par mission.buildState() : l etat complet (recolte,
// construction, deplacement) et l etat reduit du type `geste`. Toute cle
// citée dans un `quand` ou un exemple qui n y figure pas est refusee.
// `navigation.X` et `navigation_objet.X` sans prefixe sont les raccourcis de
// `environnement.navigation.X` (c est ainsi que le prompt les nomme), et
// `etat.` est un alias de racine (ex : `etat.blocage.detecte`).
const ETAT_ENV_CHAMPS = new Set([
  'bloc_cible_le_plus_proche',
  'distance_du_bloc_cible',
  'bloc_cible_a_portee',
  'navigation',
  'objets_au_sol_a_proximite',
  'objets_au_sol',
  'navigation_objet',
  'bloc_regarde',
  'relief_local',
  'denivele_cible',
  'cible_haute',
  'acces_par_montee',
  'piste_recente',
  'boussole_secours',
  'outil_necessaire',
  'casse_productive',
  'hache_recommandee',
  'dirt_secondaire_admise',
  'dirt_secondaire_cible',
  'capture_presente'
])

// Sous-champs des deux indices de navigation (bloc a casser, objet a marcher
// dessus). Direction relative et distance HORIZONTALE informatives ; le
// navigateur choisit le chemin et ramasser gere les objets tombes.
const ETAT_NAV_SOUS_CHAMPS = new Set(['cible', 'distance', 'angle', 'a_portee', 'combien'])

const ETAT_SOUS_CHAMPS = {
  consigne: new Set(['texte', 'demandeur', 'type', 'matiere', 'repere', 'porte_demandee', 'dimensions', 'fabrication_cible', 'fabrication_quantite']),
  progression: new Set(['etapes_effectuees', 'blocs_casses', 'objets_recoltes', 'unites_recoltees', 'dirt_secondaire', 'temps_ecoule_s', 'fabrication_produits', 'fabrication_visee']),
  bot: new Set(['position', 'vie', 'dans_liquide', 'en_deplacement', 'orientation']),
  inventaire: new Set([
    'materiau_de_construction', 'materiau_en_inventaire', 'matiere_brute_en_inventaire',
    'buches', 'planches', 'batons', 'etablis', 'porte_en_inventaire', 'outils',
    'dirt_en_inventaire', 'echafaudage'
  ]),
  chantier: new Set([
    'emplacement_choisi', 'materiau', 'blocs_prevus', 'blocs_poses', 'blocs_restants',
    'porte_posee', 'repere_en_vue', 'materiau_en_inventaire', 'blocs_posables_maintenant',
    'materiau_manquant', 'porte_en_inventaire'
  ]),
  demandeur: new Set(['visible', 'distance']),
  blocage: new Set(['detecte', 'raison']),
  memoire: new Set(['jetons', 'plafonds', 'restants', 'generation', 'jetons_utilises', 'jetons_max', 'jetons_restants'])
}

const ETAT_SOUS_SOUS_CHAMPS = {
  bot: {
    position: new Set(['x', 'y', 'z']),
    orientation: new Set(['cap', 'lacet', 'tangage'])
  },
  inventaire: { echafaudage: new Set(['total', 'materiaux']) }
}

const ETAT_RACINES = new Set([
  'environnement', 'bot', 'consigne', 'progression', 'inventaire', 'chantier',
  'demandeur', 'blocage', 'memoire', 'navigation', 'navigation_objet'
])

const ETAT_SINGLETONS = new Set([
  'avancer_bloque', 'dernieres_etapes', 'chat_recent', 'arret_refuse', 'plan_ajuste',
  'quota_par_defaut', 'quota_vise', 'fabrications_possibles',
  'objets_au_sol_a_proximite', 'objets_au_sol'
])

// Tout `racine.sous[.sous-sous]` cite dans un texte de documentation, `etat.`
// retire et casse ignoree. Les mots isolés sans point ne sont pas des champs.
const CHAMP_CITE_RE = /\b((?:etat\.)?(?:environnement|bot|consigne|progression|inventaire|chantier|demandeur|blocage|memoire|navigation|navigation_objet)\.[a-z_0-9]+(?:\.[a-z_0-9]+)*(?:\.[a-z_0-9]+)?|avancer_bloque|dernieres_etapes|chat_recent|arret_refuse|plan_ajuste|fabrications_possibles|quota_par_defaut|quota_vise|objets_au_sol_a_proximite|objets_au_sol)\b/gi

function champConnu (brut) {
  let s = String(brut).toLowerCase()
  if (s.startsWith('etat.')) s = s.slice('etat.'.length)
  if (ETAT_SINGLETONS.has(s)) return true

  const parts = s.split('.')
  const racine = parts[0]

  // Raccourci du prompt : `navigation.distance` = `environnement.navigation.distance`.
  if (racine === 'navigation' || racine === 'navigation_objet') {
    if (parts.length === 1) return true
    return parts.length === 2 && ETAT_NAV_SOUS_CHAMPS.has(parts[1])
  }

  if (racine === 'environnement') {
    const champ = parts[1]
    if (!champ || !ETAT_ENV_CHAMPS.has(champ)) return false
    if ((champ === 'navigation' || champ === 'navigation_objet') && parts[2]) {
      return parts.length === 3 && ETAT_NAV_SOUS_CHAMPS.has(parts[2])
    }
    return parts.length <= 3
  }

  if (!ETAT_RACINES.has(racine)) return false
  if (parts.length === 1) return true
  const connus = ETAT_SOUS_CHAMPS[racine]
  if (!connus || !connus.has(parts[1])) return false
  if (parts[2]) {
    const sous = ETAT_SOUS_SOUS_CHAMPS[racine]?.[parts[1]]
    return Boolean(sous && sous.has(parts[2])) && parts.length === 3
  }
  return parts.length <= 2
}

// Tous les champs cites dans un texte, dans l ordre d apparition, dedoublonnes.
function champsCites (texte) {
  const trouves = String(texte ?? '').match(CHAMP_CITE_RE) ?? []
  return [...new Set(trouves)]
}

// Le premier champ cite qui n existe pas dans mission.buildState(), ou null.
function premierChampInconnu (texte) {
  for (const champ of champsCites(texte)) {
    if (!champConnu(champ)) return champ
  }
  return null
}

// Extrait JSON `{"action":"..."}` dans un texte de documentation : seule forme
// dont on peut verifier les bornes, le reste etant de la prose. Rend le
// premier ecart trouve, ou null.
const EXTRAIT_JSON_RE = /\{[^{}]*"action"[^{}]*\}/g

function premierParametreHorsBornes (action, texte) {
  const extraits = String(texte ?? '').match(EXTRAIT_JSON_RE) ?? []
  for (const extrait of extraits) {
    let parsed = null
    try {
      parsed = JSON.parse(extrait)
    } catch (_) {
      continue
    }
    const nom = String(parsed?.action ?? '').trim().toLowerCase()
    const declares = jsonParamsFor(nom)
    if (!ACTIONS[nom] || !declares) continue
    for (const [param, descriptor] of Object.entries(declares)) {
      const v = parsed[param]
      if (v === undefined || v === null) continue
      const j = descriptor.json
      if (j.kind === 'number' && typeof v === 'number' && Number.isFinite(v)) {
        if (v < j.min || v > j.max) {
          return `parametre hors bornes : ${nom}.${param}=${v} (attendu ${j.min} a ${j.max})`
        }
      }
      if (j.kind === 'text' && typeof v === 'string') {
        if (v.length > j.max) {
          return `parametre hors bornes : ${nom}.${param} trop long (${v.length} caracteres, ${j.max} au maximum)`
        }
      }
    }
  }
  return null
}

// Documentation d une action (native).
function actionDoc (name) {
  return {
    action: name,
    quand: null,
    exemples: nativeExemples(name),
    contre_exemples: nativeContreExemples(name),
    source: 'native'
  }
}

// Le gabarit rendu en texte : role (intent natif), params bornes, preconditions
// (quand), exemples et contre-exemples. C est ce que le prompt met en forme
// par action (voir planner.actionCatalogue).
function describeAction (name) {
  const nom = String(name ?? '').trim().toLowerCase()
  const spec = ACTIONS[nom]
  if (!spec) return null
  const doc = actionDoc(nom)
  const intent = typeof spec.intent === 'string' ? spec.intent : spec.intent.what
  const params = Object.entries(jsonParamsFor(nom) ?? {}).map(([param, descriptor]) => {
    const j = descriptor.json
    if (j.kind === 'number') return `${param} : nombre ${j.min}-${j.max}`
    if (j.kind === 'text') return `${param} : texte ${j.max} car. max`
    if (j.kind === 'list') return `${param} : ${j.max} max parmi ${j.of.join('/')}`
    return param
  })
  return [
    `role : ${intent}`,
    params.length > 0 ? `params : ${params.join(' ; ')}` : 'params : aucun',
    doc.quand ? `preconditions : ${doc.quand}` : 'preconditions : aucune documentee',
    ...doc.exemples.map(e => `ex : ${e}`),
    ...doc.contre_exemples.map(e => `ne pas : ${e}`)
  ].join('\n')
}

// Toutes les actions natives, avec leur documentation. C est ce que servent
// /api/actions et le prompt du planificateur.
function documentedActions () {
  return Object.keys(ACTIONS).map(actionDoc)
}

function kindCriteria () {
  const criteria = {}
  for (const [name, spec] of Object.entries(KINDS)) criteria[name] = spec.intent
  return criteria
}

function resourceCriteria () {
  const criteria = {}
  for (const [name, spec] of Object.entries(RESOURCES)) criteria[name] = spec.intent
  return criteria
}

function landmarkCriteria () {
  const criteria = {}
  for (const [name, spec] of Object.entries(LANDMARKS)) criteria[name] = spec.intent
  return criteria
}

// Lignes de !aide, decoupees pour tenir dans le chat Minecraft.
function helpLines (prefix) {
  const lines = []
  let current = ''

  for (const spec of Object.values(COMMANDS)) {
    const piece = spec.usage.replace(/^!/, prefix)
    if (current && (current + ' | ' + piece).length > 90) {
      lines.push(current)
      current = ''
    }
    current += (current ? ' | ' : '') + piece
  }

  if (current) lines.push(current)
  return lines
}

// ---------------------------------------------------------------------------
// Verification de coherence
// ---------------------------------------------------------------------------

// `implemented` : noms canoniques reellement branches dans index.js.
// `actionsImplemented` : actions reellement branchees dans mission.js.
function audit (implemented, actionsImplemented) {
  const problems = []
  const handlers = new Set(implemented)
  const steps = new Set(actionsImplemented)

  for (const name of Object.keys(COMMANDS)) {
    if (!handlers.has(name)) problems.push(`commande declaree sans handler : ${name}`)
  }
  for (const name of handlers) {
    if (!COMMANDS[name]) problems.push(`handler sans declaration dans skills.js : ${name}`)
  }
  for (const name of Object.keys(ACTIONS)) {
    if (!steps.has(name)) problems.push(`action de mission declaree sans handler : ${name}`)
  }
  for (const name of steps) {
    if (!ACTIONS[name]) problems.push(`action de mission sans declaration : ${name}`)
  }

  // Un alias qui recouvre une autre commande rendrait le routage ambigu.
  const seen = new Map()
  for (const [name, spec] of Object.entries(COMMANDS)) {
    for (const key of [name, ...spec.aliases]) {
      if (seen.has(key) && seen.get(key) !== name) {
        problems.push(`alias ambigu "${key}" : ${seen.get(key)} et ${name}`)
      }
      seen.set(key, name)
    }
  }

  // 'aucune' est l echappatoire du routage (bavardage) : en faire une commande
  // la rendrait executable, donc tout message anodin ferait agir le bot.
  if (COMMANDS.aucune) problems.push('"aucune" est reserve au bavardage, pas a une commande')

  // Documentation native : champs d etat cites connus, extraits JSON dans les
  // bornes des parametres (sinon le modele raisonne sur du vide).
  for (const name of Object.keys(ACTIONS)) {
    for (const texte of [...nativeExemples(name), ...nativeContreExemples(name)]) {
      const inconnu = premierChampInconnu(texte)
      if (inconnu) problems.push(`exemple de "${name}" : champ d etat inconnu ${inconnu}`)
      const bornes = premierParametreHorsBornes(name, texte)
      if (bornes) problems.push(`exemple de "${name}" : ${bornes}`)
    }
  }

  // Chaque type de mission doit garder de quoi finir et de quoi se degager,
  // **dans les deux modes d approvisionnement**, sinon une mission de ce type ne
  // peut jamais se clore proprement.
  for (const kind of Object.keys(KINDS)) {
    for (const supply of ['harvest', 'creative']) {
      const available = actionsFor(kind, supply)
      for (const required of ['terminer', 'sortir', 'attendre']) {
        if (!available.includes(required)) {
          problems.push(`le type "${kind}" (${supply}) n a pas acces a l action "${required}"`)
        }
      }
      if (available.length < 3) problems.push(`le type "${kind}" (${supply}) n a presque aucune action`)
    }
  }

  // Une construction en mode survie doit pouvoir s approvisionner elle-meme,
  // sans quoi elle s arrete des que l inventaire est vide.
  for (const required of ['casser', 'ramasser', 'fabriquer']) {
    if (!actionsFor('construction', 'harvest').includes(required)) {
      problems.push(`une construction en survie n a pas acces a l action "${required}"`)
    }
  }

  // Un parametre mal declare ne se verrait qu au moment de l appel, en pleine
  // mission.
  for (const [name, spec] of Object.entries(ACTIONS)) {
    for (const [param, descriptor] of Object.entries(spec.params ?? {})) {
      if (!descriptor.question) {
        problems.push(`parametre sans question : ${name}.${param}`)
      }
      if (!descriptor.json) {
        problems.push(`parametre sans descripteur json : ${name}.${param}`)
      }
      if (descriptor.json && !['text', 'number', 'list'].includes(descriptor.json.kind)) {
        problems.push(`descripteur json inconnu : ${name}.${param} (${descriptor.json.kind})`)
      }
    }
  }

  // Une ressource sans bloc ne peut jamais etre trouvee en jeu.
  for (const [name, spec] of Object.entries(RESOURCES)) {
    if (name !== 'aucune' && spec.blocks.length === 0) {
      problems.push(`ressource sans bloc associe : ${name}`)
    }
    if (!spec.build) problems.push(`ressource sans bloc de construction : ${name}`)
    // En survie, le bloc pose est reconnu par son motif : si le materiau par
    // defaut n y correspond pas, le chantier se croirait eternellement vide.
    if (!spec.buildMatch) problems.push(`ressource sans motif de materiau : ${name}`)
    else if (!spec.buildMatch.test(spec.build)) {
      problems.push(`le materiau "${spec.build}" de "${name}" ne correspond pas a son propre motif`)
    }
    if (!spec.raw) problems.push(`ressource sans motif de matiere brute : ${name}`)
  }

  // Un repere qui renvoie a une ressource inconnue ne trouverait jamais rien.
  for (const [name, spec] of Object.entries(LANDMARKS)) {
    if (spec.resource && !RESOURCES[spec.resource]) {
      problems.push(`repere "${name}" lie a une ressource inconnue : ${spec.resource}`)
    }
  }

  const routable = Object.entries(COMMANDS).filter(([, s]) => s.chat).map(([n]) => n)
  const manual = Object.entries(COMMANDS).filter(([, s]) => !s.chat).map(([n]) => n)

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      commandes: Object.keys(COMMANDS).length,
      routables_par_le_chat: routable.length,
      prefixe_uniquement: manual.length,
      actions: Object.keys(ACTIONS).length,
      actions_parametrees: parameterized().length,
      types_de_mission: Object.keys(KINDS).length,
      ressources: Object.keys(RESOURCES).length - 1,
      reperes: Object.keys(LANDMARKS).length
    },
    routable,
    manual,
    actionsParType: Object.fromEntries(
      Object.keys(KINDS).map(kind => [kind, actionsFor(kind, 'harvest')])
    ),
    actionsParTypeEnCreative: Object.fromEntries(
      Object.keys(KINDS).map(kind => [kind, actionsFor(kind, 'creative')])
    ),
    parametres: Object.fromEntries(parameterized().map(a => [a.name, a.params]))
  }
}

module.exports = {
  COMMANDS,
  ACTIONS,
  KINDS,
  RESOURCES,
  RESOURCE_ALIASES,
  FABRICATION_ALIASES,
  normalizeFabricationTarget,
  LANDMARKS,
  SCALE_LEVELS,
  resolve,
  resolveResource,
  resourceSpec,
  ressourceLibre,
  CAPACITES_ABSENTES,
  actionsFor,
  setFeatureEnabled,
  jsonParamsFor,
  estimatedSecondsFromParams,
  parameterized,
  // Documentation et exemples des actions (natifs).
  ACTION_EXEMPLES,
  ACTION_CONTRE_EXEMPLES,
  actionDoc,
  documentedActions,
  describeAction,
  champsCites,
  get docGeneration () { return docGeneration },
  kindCriteria,
  resourceCriteria,
  landmarkCriteria,
  helpLines,
  audit
}
