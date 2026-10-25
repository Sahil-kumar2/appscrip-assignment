FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN npm ci --include-workspace-root --workspace=@aps/shared --workspace=@aps/api
RUN npm run --workspace=@aps/shared build
RUN npm run --workspace=@aps/api build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app
COPY migrations ./migrations

EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
