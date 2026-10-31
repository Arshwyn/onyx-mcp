FROM node:24.22.2-trixie-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js daily-override.js security.js ./

EXPOSE 10000

CMD ["node", "index.js"]
