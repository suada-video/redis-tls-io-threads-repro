FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

CMD ["node", "--max-old-space-size=4096", "index.js"]
