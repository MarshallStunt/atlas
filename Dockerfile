# Aura hub, for company infrastructure. Put it behind the company's TLS proxy / zero-trust network;
# it speaks plain HTTP inside the container. Each person's computer runs the agent, which dials out
# to this hub, so the computers never accept incoming connections.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production AURA_SERVER=1 AURA_HOST=0.0.0.0 AURA_PORT=8100 AURA_HUB_DATA=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY hub ./hub
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8100/healthz || exit 1
CMD ["node", "hub/server.js"]
