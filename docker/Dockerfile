FROM oven/bun:1-alpine
WORKDIR /app
COPY packages/server/server.ts ./packages/server/
ENV MESH_PORT=4200
ENV MESH_STORE=/data/mesh-store.json
EXPOSE 4200
VOLUME /data
CMD ["bun", "run", "packages/server/server.ts"]
