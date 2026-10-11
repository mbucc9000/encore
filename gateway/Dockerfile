# Encore gateway: Node 22 (no npm packages) + ffmpeg for AAC + qrencode for the Jam QR code
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini qrencode \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src/ /app/src/
ENV NODE_ENV=production
EXPOSE 8095
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/src/main.js"]
