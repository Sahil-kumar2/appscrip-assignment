FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY packages/shared ./packages/shared
COPY apps/notification-sink ./apps/notification-sink

RUN npm ci --include-workspace-root --workspace=@aps/shared --workspace=@aps/notification-sink
RUN npm run --workspace=@aps/shared build
RUN npm run --workspace=@aps/notification-sink build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 4000
CMD ["node", "apps/notification-sink/dist/index.js"]
