FROM node:20-alpine

WORKDIR /app

# Only copy package files first (layer caching)
COPY package*.json ./
RUN npm install --production && npm cache clean --force

# Copy application
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://localhost:3000/health || exit 1

USER node

CMD ["node", "server.js"]
