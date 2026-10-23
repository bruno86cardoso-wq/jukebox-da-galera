FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3456
CMD ["node", "server.js"]
