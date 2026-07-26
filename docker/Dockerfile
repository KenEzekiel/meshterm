FROM oven/bun:1.3.13-alpine
WORKDIR /app
COPY packages/server/server.ts packages/server/transport.ts ./packages/server/
RUN mkdir -p /data && chown -R bun:bun /data
ENV MESH_PORT=4200
ENV MESH_HOST=0.0.0.0
ENV MESH_DATABASE=/data/meshterm.sqlite
EXPOSE 4200
VOLUME /data
USER bun
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4200/readyz || exit 1
CMD ["bun", "run", "packages/server/server.ts"]
