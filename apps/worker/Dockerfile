FROM node:22-alpine AS builder
# corepack prepare activates the exact pnpm version baked into the image so
# runtime never has to fetch from the npm registry (which fails inside CF
# Containers' network namespace and silently crashes the container before
# Node ever starts).
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile --filter worker...
RUN pnpm --filter worker typecheck

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY --from=builder /repo /repo
ENV NODE_ENV=production
# Health-check HTTP listener (used by Cloudflare Containers; idle on AWS/TSW).
EXPOSE 8080
WORKDIR /repo/apps/worker
CMD ["pnpm", "start"]
