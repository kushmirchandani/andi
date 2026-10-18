FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
# Andi Gym: the scoreboard (/gym) reads gym/history.json and imports gym/lib.ts.
COPY gym ./gym
# Runs as root on purpose: Fly mounts the /data volume root-owned at runtime.
EXPOSE 8080
# tsx runs the TypeScript directly (it's a runtime dependency). Signals reach node for a clean shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]
