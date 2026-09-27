'use strict'

// Catalogue unique de tout ce que le bot sait faire.
//
// Trois surfaces lisent cette table :
//   - index.js : un handler par commande canonique ;
//   - jev.js   : les descriptions deviennent les options des questions typees ;
//   - /api/commands : la table exposee telle quelle pour verification.
//
// audit() compare la table aux handlers reellement branches. index.js l appelle
// au demarrage : une commande declaree ici mais pas implementee (ou l inverse)
// apparait dans les logs au lieu de se decouvrir en jeu.
//
// Pourquoi peu d actions plutot que beaucoup : les options de la question
// `etape` **sont** l espace d action de Jev. Une liste de 200 verbes ferait
// s effondrer la classification et couterait des jetons a chaque tour. On garde
// donc une dizaine d actions pertinentes, chacune **parametree**.
//
// Classification en DEUX etages (voir jev.planMission / jev.planParams) :
//
//   1. « est-ce fini ? » + « quelle action ? » — l espace d action complet ;
//   2. seulement si l action choisie declare `params` : un second appel qui ne
//      pose que **ses** parametres, formules dans son unite a elle.
//
// Ce que le second etage apporte : l ampleur n est plus demandee a l aveugle
// avant de savoir de quoi on parle (« beaucoup » ne veut pas dire la meme chose
// pour une rafale de casse et pour une attente), et une question qui n a de sens
// que pour une action — « fabriquer quoi ? » — n est jamais posee aux autres
// tours ni comptee dans l espace d action. Les actions sans parametre ne coutent
// toujours qu un seul appel.
//
// Il n y a PAS d actions apprises : le planificateur compose lui-meme ses
// enchainements a partir des actions natives ci-dessous. Ce qu il lit pour bien
// composer, c est leur documentation (intent + parametres) et des EXEMPLES
// concrets (table ACTION_EXEMPLES plus bas), qu une aide distante peut enrichir.

const fs = require('fs')
const path = require('path')

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
    // Jev classe, il n extrait pas de nombres. Des coordonnees ne peuvent donc
    // venir que de la forme explicite : pas d option Jev pour cette commande.
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
    // ponctuelle, il compose lui-meme les actions (voir CLAUDE.md).
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
// Types de mission : ce que Jev determine une fois, au lancement
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
// Actions : la surface interne, choisie par Jev a chaque tour
//
// `kinds` restreint les options proposees au type de mission en cours : un
// chantier n a pas a se voir proposer « ramasser », et une recolte n a pas a se
// voir proposer « poser la porte ». Moins d options, meilleure classification.
//
// `scale` documente ce que l ampleur signifie pour cette action-la.
// ---------------------------------------------------------------------------

// Rubrique generique, gardee pour les appels qui n ont pas d unite propre.
const SCALE_RUBRIC = [
  'Un geste minimal, juste pour verifier ou ajuster',
  'Peu : de quoi avancer un peu sans s engager',
  'Une quantite normale de travail',
  'Beaucoup : l essentiel de ce qui reste a faire',
  'A fond : tout ce qui est possible en une fois'
]

// Rubrique d ampleur declinee dans l unite de l action. C est tout l interet du
// second etage : « beaucoup » ne veut pas dire la meme chose pour une rafale de
// casse et pour une attente, et le modele repond mieux quand la question parle
// de ce qu il vient de choisir.
function amountRubric (levels) {
  return [
    `Le strict minimum : ${levels[0]}`,
    `Peu : ${levels[1]}`,
    `Une quantite normale : ${levels[2]}`,
    `Beaucoup : ${levels[3]}`,
    `Le maximum possible : ${levels[4]}`
  ]
}

const ACTIONS = {
  casser: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    summary: 'casser les blocs a portee, en rafale',
    scale: 'duree de la rafale, en secondes',
    secondes: 0.45,
    parBloc: true,
    intent: "Un bloc de la matiere visee est a portee de main : le casser maintenant, et enchainer sur les suivants a portee. C est la seule facon d obtenir de la matiere en survie. En mission bois, si environnement.dirt_secondaire_admise est vrai, casser de la dirt au sol a portee est autorise pour alimenter un pilier (comptee a part, quota bois inchange) ; sinon, ne casser que la matiere visee",
    // Le planificateur JSON donne une valeur NUMERIQUE, pas une ampleur : il dit
    // « casse pendant 5 secondes » et le code execute exactement cela. `ampleur`
    // ne sert plus qu au repli Jev, qui ne sait repondre que sur une echelle 0-4.
    params: {
      duree: {
        json: { kind: 'number', min: 1, max: 15 },
        question: 'Combien de secondes casser sans relacher ?'
      },
      ampleur: {
        type: 'score',
        question: 'Combien de blocs enchainer sans relacher dans cette rafale ?',
        rubric: amountRubric([
          'deux blocs, juste pour verifier que la casse fonctionne',
          'quelques blocs',
          'une dizaine de blocs',
          "presque tout ce qui est a portee",
          'seize blocs : tout ce que la rafale autorise'
        ])
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
    parBloc: true,
    intent: "Obtenir N objets de la matiere visee en une seule action : le code rejoint le bloc le plus proche, le casse, ramasse ce qui tombe et recommence jusqu a N (60 s au plus). Rend la main au premier obstacle (outil manquant, cible trop haute, aucun chemin) en le disant : piler, fabriquer ou avancer ensuite. Prefere-la a avancer + casser + ramasser pour toute recolte",
    params: {
      quantite: {
        json: { kind: 'number', min: 1, max: 16 },
        question: 'Combien d objets de la matiere obtenir ?'
      },
      ampleur: {
        type: 'score',
        question: 'Combien d objets de la matiere obtenir ?',
        rubric: amountRubric([
          'un seul objet',
          'deux objets',
          'quatre objets',
          'huit objets',
          'seize objets'
        ])
      }
    }
  },

  ramasser: {
    kinds: ['recolte', 'construction'],
    harvesting: true,
    summary: 'marcher sur les objets au sol',
    scale: 'nombre d objets vises, de 1 a 6',
    secondes: 0.8,
    parBloc: true,
    intent: "Des objets sont tombes au sol a proximite : aller marcher dessus pour les mettre dans l inventaire. Un bloc casse n entre pas tout seul en inventaire s il est tombe plus loin. En mission bois, la dirt cassee pour un pilier compte aussi : si elle entre en inventaire, c est un succes, pas un echec",
    params: {
      quantite: {
        json: { kind: 'number', min: 1, max: 6 },
        question: 'Combien d objets au sol aller chercher ?'
      },
      ampleur: {
        type: 'score',
        question: 'Combien d objets au sol aller chercher avant de reprendre le travail ?',
        rubric: amountRubric([
          'un seul objet, le plus proche',
          'deux objets',
          'trois objets',
          'quatre ou cinq objets',
          'les six objets les plus proches'
        ])
      }
    }
  },

  // Depot mesure aux pieds du BON joueur (D20/C0) : capacite reutilisable
  // `bot/delivery.js` (non cable mission ici). Succes = depot mesure
  // (inventaire -N) + annonce, jamais un ramassage suppose. plannerOnly : Jev
  // ne sait pas produire un pseudo ni une quantite exacte.
  donner: {
    kinds: ['recolte', 'construction', 'geste'],
    plannerOnly: true,
    summary: 'deposer des objets aux pieds du joueur nomme et l en avertir',
    scale: 'nombre d objets deposes, de 1 a 64',
    secondes: 0.8,
    parBloc: true,
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
        type: 'choice',
        question: 'Que faut-il fabriquer maintenant ?',
        // Les options sont calculees a l execution a partir de l inventaire
        // reel : Jev ne choisit que parmi ce qui est reellement faisable, donc
        // il n a jamais a deviner l ordre des recettes. Le planificateur JSON
        // rend en plus un nom LIBRE (json text) : tout item Minecraft valide
        // (torch, stick, oak_planks...) ou alias FR (batons, planches...) ;
        // les recettes du jeu font foi, fabrications_possibles n est qu un hint.
        dynamic: 'fabrications',
        json: { kind: 'text', max: 40 }
      },
      quantite: {
        json: { kind: 'number', min: 1, max: 16 },
        question: 'Combien d exemplaires fabriquer ?'
      },
      ampleur: {
        type: 'score',
        question: 'Combien d exemplaires fabriquer ?',
        rubric: amountRubric([
          'un seul exemplaire',
          'deux exemplaires',
          'quatre exemplaires',
          'huit exemplaires',
          'seize exemplaires : tout ce que les ingredients permettent'
        ])
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
    parBloc: true,
    intent: "Avec un bloc cible repere, calculer automatiquement un chemin autour des obstacles vers une position visible a portee de ce bloc. Distance est le budget du trajet : arret possible avant le budget si la cible est accessible, ou progression partielle a poursuivre apres lecture du resultat. Aucun pivoter ou appuyer prealable. Sur no_path ou stuck, signale le blocage ou change d objectif autorise, sans repeter aveuglement ni improviser des touches. Sans cible, avancer droit devant dans le cap actuel. Le resultat mesure le deplacement reel",
    params: {
      distance: {
        json: { kind: 'number', min: 1, max: 40 },
        question: 'Quel budget de distance parcourir en blocs ?'
      },
      ampleur: {
        type: 'score',
        question: 'Jusqu ou avancer ?',
        rubric: amountRubric([
          'un bloc, un simple pas',
          'cinq blocs',
          'une dizaine de blocs',
          'une vingtaine de blocs',
          'quarante blocs de trajet au plus'
        ])
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
    parBloc: true,
    intent: "Rien de la matiere visee n est en vue (regarder_autour ou recolter disent « rien ») : le code choisit le cap le moins explore, y va par un chemin calcule, regarde, et recommence (4 trajets, 45 s au plus) jusqu a voir la matiere ou le repere. Remplace pivoter + avancer sans cible pour chercher",
    params: {
      distance: {
        json: { kind: 'number', min: 8, max: 32 },
        question: 'Longueur de chaque trajet de recherche, en blocs ?'
      },
      ampleur: {
        type: 'score',
        question: 'Jusqu ou chercher a chaque trajet ?',
        rubric: amountRubric([
          'huit blocs, tout pres',
          'douze blocs',
          'seize blocs',
          'vingt-quatre blocs',
          'trente-deux blocs'
        ])
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
    parBloc: true,
    intent: "Une cible proche est TROP HAUTE (environnement.cible_haute), ou environnement.acces_par_montee mesure une hauteur_min qui rend la cible masquee accessible : monter en pilier avec dirt/coarse_dirt en priorite puis planches solides du registre. Utiliser hauteur_min pour acces_par_montee, sinon denivele - 1 au plus ; inventaire.echafaudage.materiaux detaille le stock. Stock court : l action obtient elle-meme la terre manquante (pilier defait puis refait, terre prise a cote), meme perche. Sable, gravier et feuilles exclus. Chaque montee impose une reobservation avant la suite ; une pose partielle reste un echec mesure. Ne pile pas quand bloc_cible_a_portee est vrai (casse directement), ni dans un liquide, ni sans cible_haute ou acces_par_montee. Cet indice n autorise pas a casser des feuilles",
    params: {
      hauteur: {
        json: { kind: 'number', min: 1, max: 6 },
        question: 'De combien de blocs monter en pilier ?'
      },
      ampleur: {
        type: 'score',
        question: 'De combien de blocs monter en pilier ?',
        rubric: amountRubric([
          'un seul bloc, juste pour passer au-dessus',
          'deux blocs',
          'trois blocs, de quoi atteindre une buche haute',
          'quatre ou cinq blocs',
          'six blocs : tout ce que le pilier autorise'
        ])
      }
    }
  },

  construire: {
    kinds: ['construction'],
    summary: 'poser les blocs prevus par le plan',
    scale: 'nombre de blocs poses, de 4 a 40',
    secondes: 0.6,
    parBloc: true,
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
      },
      ampleur: {
        type: 'score',
        question: 'Combien de blocs poser avant de faire le point ?',
        rubric: amountRubric([
          'quatre blocs, juste pour verifier que la pose fonctionne',
          'une dizaine de blocs',
          'une vingtaine de blocs',
          'une trentaine de blocs',
          'quarante blocs : tout ce que la rafale autorise'
        ])
      }
    }
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

  attendre: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    summary: 'laisser finir',
    scale: 'duree de l attente, de 1 a 5 secondes',
    secondes: 1,
    parBloc: true,
    intent: 'Une action est deja en cours et progresse : la laisser se terminer sans rien changer',
    params: {
      duree: {
        json: { kind: 'number', min: 1, max: 10 },
        question: 'Combien de secondes laisser filer ?'
      },
      ampleur: {
        type: 'score',
        question: 'Combien de temps laisser filer avant de refaire le point ?',
        rubric: amountRubric([
          'une seconde',
          'deux secondes',
          'trois secondes',
          'quatre secondes',
          'cinq secondes'
        ])
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
  //
  // Elles portent `plannerOnly` : Jev ne les voit pas. Ses questions sont des
  // choix fermes, il ne sait pas produire un angle ni une phrase, et lui
  // proposer six options de plus degraderait sa classification pour rien.
  // -------------------------------------------------------------------------

  dire: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    plannerOnly: true,
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
    plannerOnly: true,
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
    plannerOnly: true,
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
    plannerOnly: true,
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
    plannerOnly: true,
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
    plannerOnly: true,
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
  //
  // `plannerOnly` : Jev ne la voit pas. Ses questions sont des choix fermes,
  // il ne sait pas produire une phrase libre ; lui proposer les deux portees
  // degraderait sa classification pour rien.
  memoriser: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    plannerOnly: true,
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
    plannerOnly: true,
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
    plannerOnly: true,
    summary: 'marcher jusqu au joueur qui a parle',
    scale: 'sans effet',
    secondes: 2.5,
    intent: "Aller jusqu au joueur qui a donne la consigne, quand la demande parle de « moi », de « me rejoindre » ou d un aller-retour vers lui. Le code mesure ou il est, tu ne donnes aucune coordonnee"
  },

  tourner_vers_demandeur: {
    kinds: ['recolte', 'deplacement', 'construction', 'geste'],
    plannerOnly: true,
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

// Options de la question d intention : les commandes routables depuis le chat.
// 'aucune' est l echappatoire, sans quoi une phrase anodine ferait bouger le bot.
function intentCriteria () {
  const criteria = {}
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (spec.chat) criteria[name] = spec.intent
  }
  criteria.aucune = {
    what: "Message qui ne s adresse pas au bot et ne lui demande rien : deux autres joueurs se parlent, remarque sur le paysage ou le clavier. C est le choix par defaut",
    not_for: "Toute phrase qui s adresse au bot, meme seulement pour le saluer ou lui poser une question : elle devient une mission",
    examples: ['joli paysage', 'je vais miner un peu', 'quelqu un a du fer ?', 'attends moi je reviens']
  }
  return criteria
}

// Les actions proposees pour ce type de mission seulement.
// `supply` vaut 'harvest' (le bot recolte et fabrique ce qu il pose) ou
// 'creative' (la main se remplit toute seule, pour une demonstration rapide).
// En creative, proposer « casser » ou « fabriquer » sur un chantier n aurait
// aucun sens : le materiau ne manque jamais.
// `lowLevel` decide si les gestes (dire, regarder, sauter, appuyer) font partie
// du lot. Jev ne les prend pas : ses questions sont des choix fermes, il ne
// sait produire ni un angle ni une phrase. Le planificateur JSON, si.
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

function availableFor (kind, supply = 'harvest', lowLevel = false) {
  return Object.entries(ACTIONS).filter(([, spec]) => {
    if (kind && !spec.kinds.includes(kind)) return false
    if (spec.feature && disabledFeatures.has(spec.feature)) return false
    if (supply === 'creative' && kind === 'construction' && spec.harvesting) return false
    if (spec.plannerOnly && !lowLevel) return false
    return true
  })
}

function actionCriteria (kind, supply) {
  const criteria = {}
  for (const [name, spec] of availableFor(kind, supply)) criteria[name] = spec.intent
  return criteria
}

function actionsFor (kind, supply, lowLevel = false) {
  return availableFor(kind, supply, lowLevel).map(([name]) => name)
}

// Les parametres declares par une action, ou null. C est ce que jev.planParams
// transforme en second appel ; null veut dire « un seul etage suffit ».
function paramsFor (action) {
  const params = ACTIONS[action]?.params
  if (!params) return null
  const typed = Object.entries(params).filter(([, d]) => d.type)
  return typed.length > 0 ? Object.fromEntries(typed) : null
}

// Les parametres **du planificateur JSON** : tout ce qui porte un descripteur
// `json`. L ampleur n en fait pas partie, elle a son propre champ.
function jsonParamsFor (action) {
  const params = ACTIONS[action]?.params
  if (!params) return null
  const jsonish = Object.entries(params).filter(([, d]) => d.json)
  return jsonish.length > 0 ? Object.fromEntries(jsonish) : null
}

// Duree indicative d une action, en secondes.
//
// Elle sert au budget de temps d un plan (voir planner.js) : le planificateur
// ne doit pas prevoir plus de travail qu il ne peut en replanifier pendant
// l execution. Ce n est pas une mesure mais un ordre de grandeur — le but est
// de distinguer un geste d une rafale de seize blocs, pas de predire la
// milliseconde.
//
// `parBloc` veut dire que la duree se multiplie par l ampleur : casser deux
// blocs et en casser seize ne comptent pas pareil.
const UNITES_PAR_AMPLEUR = {
  avancer: [1, 5, 10, 20, 40],
  casser: [2, 5, 9, 13, 16],
  recolter: [1, 2, 4, 8, 16],
  explorer: [8, 12, 16, 24, 32],
  ramasser: [1, 2, 3, 5, 6],
  construire: [4, 13, 22, 31, 40],
  attendre: [1, 2, 3, 4, 5],
  piler: [1, 2, 3, 4, 6]
}

function estimatedSeconds (action, { scaleLevel = null, duree = null } = {}) {
  const spec = ACTIONS[action]
  if (!spec) return 1

  // Une duree explicite gagne toujours : c est le cas de `sauter` et
  // `appuyer`, ou le planificateur dit lui-meme combien de temps tenir.
  if (typeof duree === 'number' && Number.isFinite(duree)) return duree

  const base = typeof spec.secondes === 'number' ? spec.secondes : 1
  const table = UNITES_PAR_AMPLEUR[action]
  if (!spec.parBloc || !table) return base

  const level = scaleLevel === null ? 2 : scaleLevel
  return base * table[Math.max(0, Math.min(table.length - 1, Math.round(level)))]
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
    .filter(([name]) => paramsFor(name))
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
// Une aide distante (repair.js) peut corriger ou enrichir cette documentation :
//   - `documenter` : creer/modifier le `quand` et les `exemples` d une action ;
//   - `fusionner`  : reverser les exemples d une action dans une autre ;
//   - `oublier`    : revenir a la documentation native d une action.
// Le code seul peut definir une ACTION : aucune operation venue du reseau ne
// cree, ne renomme ni ne supprime une action native. L overlay survit aux
// redemarrages dans ACTIONS_DOC_FILE.
// ---------------------------------------------------------------------------

const ACTION_EXEMPLES = {
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
// de mission.buildState() : ils passent le meme controle que l overlay.
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

// `/data` est le volume `bot-data` du conteneur (comme MEMORY_FILE) : la
// documentation enrichie par l'aide y survit aux recreations. `ACTIONS_DOC_FILE`
// permet de la deplacer ; hors conteneur, l'ecriture ratee est signalee sans
// jamais casser une mission.
const DOC_FILE = process.env.ACTIONS_DOC_FILE || '/data/actions-doc.json'
const DOC_QUAND_MAX = 200
const DOC_EXEMPLE_MAX = 160
const DOC_EXEMPLES_MAX = 4

const docOverlay = new Map()
let docGeneration = 0
let docPersistError = null

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
// Le code controle ce que l aide y ecrit, parce qu un exemple qui cite une
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
  blocage: new Set(['detecte', 'raison', 'reparations_restantes', 'reparateur_disponible']),
  memoire: new Set(['jetons', 'plafonds', 'restants', 'generation', 'jetons_utilises', 'jetons_max', 'jetons_restants'])
}

const ETAT_BOT_SOUS_SOUS_CHAMPS = {
  position: new Set(['x', 'y', 'z']),
  orientation: new Set(['cap', 'lacet', 'tangage'])
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
  if (racine === 'bot' && parts[2]) {
    const sous = ETAT_BOT_SOUS_SOUS_CHAMPS[parts[1]]
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

// La liste des champs d etat valides, a plat, pour audit et /api/actions.
function etatChamps () {
  const champs = [...ETAT_SINGLETONS]
  for (const champ of ETAT_ENV_CHAMPS) {
    champs.push(`environnement.${champ}`)
    if (champ === 'navigation' || champ === 'navigation_objet') {
      for (const sous of ETAT_NAV_SOUS_CHAMPS) champs.push(`environnement.${champ}.${sous}`)
    }
  }
  for (const [racine, sous] of Object.entries(ETAT_SOUS_CHAMPS)) {
    for (const s of sous) champs.push(`${racine}.${s}`)
  }
  return champs.sort()
}

// Documentation effective d une action : la native, ou celle ajoutee par l aide
// distante si elle existe. `source` dit d ou elle vient.
function actionDoc (name) {
  const over = docOverlay.get(name)
  return {
    action: name,
    quand: over?.quand ?? null,
    exemples: over?.exemples ?? nativeExemples(name),
    contre_exemples: over?.contre_exemples ?? nativeContreExemples(name),
    source: over ? 'aide' : 'native',
    maj: over?.maj ?? null
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

// Toutes les actions natives, avec leur documentation effective. C est ce que
// servent /api/actions, le prompt du planificateur et le vocabulaire du
// reparateur.
function documentedActions () {
  return Object.keys(ACTIONS).map(actionDoc)
}

// Valide et normalise une documentation d action. Rend { ok, error } ou
// { ok, value: { quand, exemples, contre_exemples } }. Outre les controles
// historiques (action connue, longueurs, `/` interdit), tout champ d etat cite
// doit exister dans mission.buildState() et toute valeur d extrait JSON doit
// tenir dans les bornes `json` du parametre.
function sanitizeDoc (name, quand, exemples, contreExemples = []) {
  const nom = String(name ?? '').trim().toLowerCase()
  if (!ACTIONS[nom]) return { ok: false, error: `action inconnue : ${nom || '(vide)'}` }

  let q = quand === null || quand === undefined ? null : String(quand).trim()
  if (q === '') q = null
  if (q && q.startsWith('/')) return { ok: false, error: 'quand ne peut pas commencer par /' }
  if (q && q.length > DOC_QUAND_MAX) {
    return { ok: false, error: `quand trop long (${q.length} caracteres, ${DOC_QUAND_MAX} au maximum)` }
  }
  if (q) {
    const inconnu = premierChampInconnu(q)
    if (inconnu) return { ok: false, error: `champ d'etat inconnu : ${inconnu} (voir mission.buildState)` }
    const bornes = premierParametreHorsBornes(nom, q)
    if (bornes) return { ok: false, error: bornes }
  }

  const raw = Array.isArray(exemples) ? exemples : (exemples === null || exemples === undefined ? [] : [exemples])
  const list = []
  for (const item of raw) {
    const text = String(item ?? '').trim()
    if (!text) continue
    if (text.startsWith('/')) return { ok: false, error: 'un exemple ne peut pas commencer par /' }
    if (text.length > DOC_EXEMPLE_MAX) {
      return { ok: false, error: `exemple trop long (${text.length} caracteres, ${DOC_EXEMPLE_MAX} au maximum)` }
    }
    const inconnu = premierChampInconnu(text)
    if (inconnu) return { ok: false, error: `champ d'etat inconnu : ${inconnu} (voir mission.buildState)` }
    const bornes = premierParametreHorsBornes(nom, text)
    if (bornes) return { ok: false, error: bornes }
    if (!list.includes(text)) list.push(text)
  }
  if (list.length > DOC_EXEMPLES_MAX) {
    return { ok: false, error: `${list.length} exemples, ${DOC_EXEMPLES_MAX} au maximum` }
  }

  const rawContre = Array.isArray(contreExemples)
    ? contreExemples
    : (contreExemples === null || contreExemples === undefined ? [] : [contreExemples])
  const contre = []
  for (const item of rawContre) {
    const text = String(item ?? '').trim()
    if (!text) continue
    if (text.startsWith('/')) return { ok: false, error: 'un contre-exemple ne peut pas commencer par /' }
    if (text.length > DOC_EXEMPLE_MAX) {
      return { ok: false, error: `contre-exemple trop long (${text.length} caracteres, ${DOC_EXEMPLE_MAX} au maximum)` }
    }
    const inconnu = premierChampInconnu(text)
    if (inconnu) return { ok: false, error: `champ d'etat inconnu : ${inconnu} (voir mission.buildState)` }
    const bornes = premierParametreHorsBornes(nom, text)
    if (bornes) return { ok: false, error: bornes }
    if (!contre.includes(text) && !list.includes(text)) contre.push(text)
  }
  // Le plafond borne le cout du prompt mis en cache : exemples et
  // contre-exemples partagent le meme budget.
  if (list.length + contre.length > DOC_EXEMPLES_MAX) {
    return { ok: false, error: `${list.length + contre.length} exemples au total (exemples + contre-exemples), ${DOC_EXEMPLES_MAX} au maximum` }
  }
  if (!q && list.length === 0 && contre.length === 0) {
    return { ok: false, error: 'rien a documenter (quand vide et aucun exemple)' }
  }

  return { ok: true, value: { action: nom, quand: q, exemples: list, contre_exemples: contre } }
}

function saveDocs () {
  try {
    fs.mkdirSync(path.dirname(DOC_FILE), { recursive: true })
    const documentation = [...docOverlay.entries()].map(([action, d]) => ({
      action, quand: d.quand, exemples: d.exemples, contre_exemples: d.contre_exemples ?? [], maj: d.maj
    }))
    // Ecriture atomique (temporaire + rename) : le rename ne demande que les
    // droits sur le repertoire, donc il survit a un fichier devenu root:root
    // dans le volume (EACCES sur l ecrasement direct). Le fichier recree
    // appartient alors a l utilisateur du bot et reste inscriptible.
    const tmp = `${DOC_FILE}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ documentation }, null, 2))
    fs.renameSync(tmp, DOC_FILE)
    docPersistError = null
    return true
  } catch (err) {
    docPersistError = err.message
    console.error(`[skills] ecriture impossible dans ${DOC_FILE} : ${err.message}`)
    return false
  }
}

// Cree ou remplace la documentation/les exemples d une action native. C est
// l unique porte d entree, pour le chargement comme pour l aide distante.
// `contre_exemples` (ou `contreExemples`) porte les contre-exemples du gabarit.
function documentAction (name, { quand = null, exemples = [], contre_exemples = [], contreExemples = [] } = {}, options = {}) {
  const { persist = true } = options
  const contre = (Array.isArray(contre_exemples) && contre_exemples.length > 0) ? contre_exemples : contreExemples
  const check = sanitizeDoc(name, quand, exemples, contre)
  if (!check.ok) return check

  docOverlay.set(check.value.action, {
    quand: check.value.quand,
    exemples: check.value.exemples,
    contre_exemples: check.value.contre_exemples,
    maj: new Date().toISOString()
  })
  docGeneration += 1
  // L overlay en memoire est conserve meme en cas d echec disque (la mission
  // en cours en profite), mais l appelant est prevenu : ok:false + error, et
  // GET /api/actions expose le detail via erreurEcriture.
  if (persist && !saveDocs()) {
    return { ok: false, error: `ecriture impossible dans ${DOC_FILE} : ${docPersistError}` }
  }
  return { ok: true, doc: actionDoc(check.value.action) }
}

// Fusionne la documentation ajoutee de `source` dans celle de `cible`, puis
// retire l entree de `source`. Seule une documentation AJOUTEE (par l aide) se
// fusionne : la documentation native d une action ne se deplacerait pas.
function mergeActionDocs (source, cible) {
  const src = String(source ?? '').trim().toLowerCase()
  const dst = String(cible ?? '').trim().toLowerCase()
  if (src === dst) return { ok: false, error: 'source et cible identiques' }
  if (!ACTIONS[src]) return { ok: false, error: `source inconnue : ${src || '(vide)'}` }
  if (!ACTIONS[dst]) return { ok: false, error: `cible inconnue : ${dst || '(vide)'}` }
  if (!docOverlay.has(src)) return { ok: false, error: `aucune documentation ajoutee pour "${src}"` }

  const from = docOverlay.get(src)
  const target = actionDoc(dst)
  const exemples = [...new Set([...target.exemples, ...from.exemples])].slice(0, DOC_EXEMPLES_MAX)
  // Les contre-exemples fusionnes partagent le budget restant du plafond.
  const reste = Math.max(0, DOC_EXEMPLES_MAX - exemples.length)
  const contre = [...new Set([...(target.contre_exemples ?? []), ...(from.contre_exemples ?? [])])].slice(0, reste)
  const quand = target.quand ?? from.quand ?? null

  const written = documentAction(dst, { quand, exemples, contre_exemples: contre })
  if (!written.ok) return written
  docOverlay.delete(src)
  docGeneration += 1
  if (!saveDocs()) {
    return { ok: false, error: `ecriture impossible dans ${DOC_FILE} : ${docPersistError}` }
  }
  return { ok: true, doc: actionDoc(dst) }
}

// Retire la documentation ajoutee d une action (retour a la native).
function forgetActionDoc (name) {
  const nom = String(name ?? '').trim().toLowerCase()
  if (!ACTIONS[nom]) return { ok: false, error: `action inconnue : ${nom || '(vide)'}` }
  if (!docOverlay.has(nom)) return { ok: false, error: `aucune documentation ajoutee pour "${nom}"` }

  docOverlay.delete(nom)
  docGeneration += 1
  if (!saveDocs()) {
    return { ok: false, error: `ecriture impossible dans ${DOC_FILE} : ${docPersistError}` }
  }
  return { ok: true, doc: actionDoc(nom) }
}

function clearActionDocs () {
  const before = docOverlay.size
  docOverlay.clear()
  docGeneration += 1
  if (!saveDocs()) {
    return { ok: false, error: `ecriture impossible dans ${DOC_FILE} : ${docPersistError}`, supprimees: before }
  }
  return { ok: true, supprimees: before }
}

// Recharge l overlay ecrit par l aide distante. Une entree invalide (action
// disparue, texte hors bornes) est ignoree : on repart de la documentation
// native pour celle-la, jamais d un catalogue casse.
function loadDocs () {
  try {
    if (!fs.existsSync(DOC_FILE)) return
    const raw = JSON.parse(fs.readFileSync(DOC_FILE, 'utf8'))
    const list = Array.isArray(raw?.documentation) ? raw.documentation : []
    for (const entry of list) {
      const result = documentAction(entry?.action, {
        quand: entry?.quand ?? null,
        exemples: entry?.exemples ?? [],
        contre_exemples: entry?.contre_exemples ?? entry?.contreExemples ?? []
      }, { persist: false })
      if (!result.ok) console.error(`[skills] documentation de "${entry?.action}" ignoree : ${result.error}`)
    }
    console.log(`[skills] ${docOverlay.size} documentation(s) d action rechargee(s) depuis ${DOC_FILE}`)
  } catch (err) {
    console.error(`[skills] lecture impossible (${err.message}) : documentation native seule`)
  }
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

  // 'aucune' est l echappatoire de Jev : en faire une commande la rendrait
  // executable, donc tout message anodin ferait agir le bot.
  if (COMMANDS.aucune) problems.push('"aucune" est reserve a l echappatoire Jev, pas a une commande')

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

  // Second etage de classification : un parametre mal declare ne se verrait
  // qu au moment de l appel, en pleine mission.
  for (const [name, spec] of Object.entries(ACTIONS)) {
    for (const [param, descriptor] of Object.entries(spec.params ?? {})) {
      if (!descriptor.question) {
        problems.push(`parametre sans question : ${name}.${param}`)
      }
      if (descriptor.type === 'score' && (descriptor.rubric ?? []).length < 2) {
        problems.push(`parametre score sans rubrique utilisable : ${name}.${param}`)
      }
      if (descriptor.type === 'choice' && !descriptor.criteria && !descriptor.dynamic) {
        problems.push(`parametre choice sans options : ${name}.${param}`)
      }
      // Un parametre sert soit a Jev (`type`), soit au planificateur JSON
      // (`json`), soit aux deux. N en avoir aucun le rend illisible des deux
      // cotes.
      if (!descriptor.type && !descriptor.json) {
        problems.push(`parametre sans type ni descripteur json : ${name}.${param}`)
      }
      if (descriptor.type && !['score', 'choice', 'noul'].includes(descriptor.type)) {
        problems.push(`type de parametre inconnu : ${name}.${param} (${descriptor.type})`)
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

  if (SCALE_RUBRIC.length < 2) problems.push('la rubrique d ampleur doit avoir au moins deux niveaux')

  const routable = Object.entries(COMMANDS).filter(([, s]) => s.chat).map(([n]) => n)
  const manual = Object.entries(COMMANDS).filter(([, s]) => !s.chat).map(([n]) => n)

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      commandes: Object.keys(COMMANDS).length,
      routables_par_jev: routable.length,
      prefixe_uniquement: manual.length,
      actions: Object.keys(ACTIONS).length,
      actions_parametrees: parameterized().length,
      types_de_mission: Object.keys(KINDS).length,
      ressources: Object.keys(RESOURCES).length - 1,
      reperes: Object.keys(LANDMARKS).length,
      niveaux_d_ampleur: SCALE_RUBRIC.length
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
  SCALE_RUBRIC,
  resolve,
  resolveResource,
  intentCriteria,
  actionCriteria,
  actionsFor,
  setFeatureEnabled,
  paramsFor,
  jsonParamsFor,
  estimatedSeconds,
  estimatedSecondsFromParams,
  parameterized,
  // Documentation et exemples des actions (overlay editable par l aide).
  ACTION_EXEMPLES,
  ACTION_CONTRE_EXEMPLES,
  actionDoc,
  documentedActions,
  describeAction,
  champsCites,
  etatChamps,
  sanitizeDoc,
  documentAction,
  mergeActionDocs,
  forgetActionDoc,
  clearActionDocs,
  loadDocs,
  DOC_FILE,
  DOC_QUAND_MAX,
  DOC_EXEMPLE_MAX,
  DOC_EXEMPLES_MAX,
  get docGeneration () { return docGeneration },
  get docPersistError () { return docPersistError },
  kindCriteria,
  resourceCriteria,
  landmarkCriteria,
  helpLines,
  audit
}
