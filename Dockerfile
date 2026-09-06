FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json server.build.mjs ./
COPY src ./src
RUN npm run build:server

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist/server ./dist/server
RUN mkdir /data && chown node:node /data
USER node
ENV RECALL_HOST=0.0.0.0 RECALL_DB=/data/recall.sqlite RECALL_AUDIO_DIR=/data/audio TZ=Europe/Madrid
EXPOSE 27124
CMD ["node", "dist/server/main.cjs"]
