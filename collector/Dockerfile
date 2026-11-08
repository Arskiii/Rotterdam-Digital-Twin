FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-openpyxl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY collector ./collector
COPY scripts ./scripts
COPY server/transit-catalog.mjs ./server/transit-catalog.mjs
COPY city.config.json collection.config.json ./
COPY data/gtfs-routes.json data/gtfs-stops.json data/ret-timetable.bin data/luchtmeetnet-stations.json ./data/
COPY public/data/ndw.json public/data/graph.bin public/data/meta.json public/data/traffic-history.json public/data/rotterdam-snapshot.json public/data/cbs-neighborhoods.json ./public/data/
ENV NODE_ENV=production PORT=8080 ARCHIVE_DATA_DIR=/data
CMD ["node", "collector/main.mjs"]
