# syntax=docker/dockerfile:1
# Shipfig: Next.js standalone server. The job runner is in-process and the
# job database is SQLite on a volume at /data, so run exactly one machine.

FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:26-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:26-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SHIPFIG_DB_PATH=/data/shipfig.db
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Fly volumes mount root-owned; the VM runs only this process.
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "server.js"]
