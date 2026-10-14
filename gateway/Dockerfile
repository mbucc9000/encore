# Encore gateway: Node 22 (no npm packages) + ffmpeg for AAC + qrencode for the Jam QR code
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini qrencode \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/share/encore \
 && dpkg-query -W -f='${Package} ${Version}\n' > /usr/share/encore/packages.txt
WORKDIR /app
COPY src/ /app/src/
ENV NODE_ENV=production
# Prebuilt images (.github/workflows/docker-images.yml, DESIGN-DOCKER-IMAGES 5) build with ENCORE_PREBUILT=1: the
# admin page then shows "docker compose pull" updates. A source build (gateway/compose.yaml) leaves it empty.
ARG ENCORE_PREBUILT=
ENV ENCORE_PREBUILT=${ENCORE_PREBUILT}
EXPOSE 8095
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/src/main.js"]
