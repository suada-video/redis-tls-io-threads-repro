FROM node:20-slim

RUN apt-get update && apt-get install -y iproute2 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY entrypoint.sh index.js ./
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
