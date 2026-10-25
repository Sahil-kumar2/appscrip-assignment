FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY packages/shared ./packages/shared
COPY apps/simulator ./apps/simulator

RUN npm ci --include-workspace-root --workspace=@aps/shared --workspace=@aps/simulator
RUN npm run --workspace=@aps/shared build
RUN npm run --workspace=@aps/simulator build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

CMD ["node", "apps/simulator/dist/index.js"]
