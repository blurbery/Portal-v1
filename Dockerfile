FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PORTAL_BUILD_ID=portal-v1-public

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends calibre \
  && rm -rf /var/lib/apt/lists/* \
  && npm install \
  && npm cache clean --force

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/portal-v1-public

RUN npm run build \
  && npm prune --omit=dev \
  && chmod 0555 /usr/local/bin/portal-v1-public \
  && chown -R node:node /app

USER node

EXPOSE 3000

LABEL org.opencontainers.image.title="Portal-v1 public build" \
      org.opencontainers.image.description="Provider-neutral public-safe Portal deployment" \
      com.portal.build="public-safe"

ENTRYPOINT ["/usr/local/bin/portal-v1-public"]
