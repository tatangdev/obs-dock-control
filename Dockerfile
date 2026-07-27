FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Run tsx directly (not via npm) so SIGTERM reaches the server process and
# the graceful-shutdown handler can persist sessions before a deploy restart.
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
