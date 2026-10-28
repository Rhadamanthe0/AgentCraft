"""Barriere de synchronisation entre un `clear` RCON et l'inventaire Mineflayer.

Un `clear` execute cote serveur n'est pas la preuve que le client a recu ses
changements de cases. Un niveau ne commence qu'apres la confirmation du bot.
"""

import time


def attendre_inventaire_vide(lire_statut, *, delai_s=8, intervalle_s=0.1,
                              horloge=time.monotonic, attendre=time.sleep):
    """Attend la disparition de toutes les piles cote bot, sinon echoue franchement.

    Le statut doit exposer `inventoryStacks`, nombre de piles renvoye par
    Mineflayer (`bot.inventory.items()`), sans divulguer les noms des objets.
    Les commandes RCON et toute mutation appartiennent a l'appelant.
    """
    debut = horloge()
    precedent = None
    while True:
        statut = lire_statut()
        piles = statut.get('inventoryStacks') if isinstance(statut, dict) else None
        if type(piles) is not int or piles < 0:
            raise RuntimeError(f'inventaire client non observable apres clear RCON (inventoryStacks={piles!r})')
        if precedent is None:
            precedent = piles
        if piles == 0:
            return {'avant': precedent, 'apres': 0, 'attente_s': round(horloge() - debut, 2)}
        ecoule = horloge() - debut
        if ecoule >= delai_s:
            raise RuntimeError(f'inventaire client non synchronise apres clear RCON : {piles} pile(s) encore visibles apres {ecoule:.1f} s')
        attendre(min(intervalle_s, max(0, delai_s - ecoule)))
