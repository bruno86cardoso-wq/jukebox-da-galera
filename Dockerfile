FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0 AS token-provider
FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=token-provider /app /opt/token-provider
RUN mkdir -p /opt/ytdlp-plugins && curl -fL --retry 3 https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.0/bgutil-ytdlp-pot-provider.zip -o /opt/ytdlp-plugins/bgutil.zip
ENV YTDLP_PLUGIN_DIR=/opt/ytdlp-plugins
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/docker-start.js"]
