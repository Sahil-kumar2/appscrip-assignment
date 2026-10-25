FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

RUN npm ci --include-workspace-root --workspace=@aps/shared --workspace=@aps/worker
RUN npm run --workspace=@aps/shared build
RUN npm run --workspace=@aps/worker build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

CMD ["node", "apps/worker/dist/index.js"]
