FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

RUN npm ci --include-workspace-root --workspace=@aps/shared --workspace=@aps/web
RUN npm run --workspace=@aps/web build

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
