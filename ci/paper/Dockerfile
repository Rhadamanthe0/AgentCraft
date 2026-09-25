# Serveur du banc CI avec Paper deja telecharge et deja patche.
#
# Sans cette image, chaque demarrage (volume /data anonyme, vide) telechargeait
# le jar Paper, quatre fichiers de config par defaut depuis GitHub, puis
# mojang_26.1.2.jar, et appliquait les patchs (~15-20 s de reseau et de CPU).
# Ici tout est fait une fois a la construction (cache de couches Docker) ; au
# demarrage, Docker copie ce /data dans le volume anonyme neuf du conteneur,
# et `TYPE=CUSTOM` lance le jar sans aucun acces reseau.
# Le monde, lui, reste cree a neuf a chaque banc.
ARG BASE=itzg/minecraft-server:2026.9.1-java25
FROM ${BASE}
ARG PAPER_VERSION=26.1.2
ARG PAPER_BUILD=74
RUN set -eux; mkdir -p /data; cd /data; \
    mc-image-helper install-paper --version="${PAPER_VERSION}" --build="${PAPER_BUILD}" --output-directory=/data; \
    test -f "/data/paper-${PAPER_VERSION}-${PAPER_BUILD}.jar"; \
    java -Dpaperclip.patchonly=true -jar "paper-${PAPER_VERSION}-${PAPER_BUILD}.jar"; \
    test -d /data/versions; test -d /data/libraries; \
    rm -rf /data/logs; chown -R 1000:1000 /data
