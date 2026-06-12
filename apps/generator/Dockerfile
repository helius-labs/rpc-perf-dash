FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/generator ./apps/generator
RUN pnpm install --frozen-lockfile --filter generator...
RUN pnpm --filter generator typecheck

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY --from=builder /repo /repo
ENV NODE_ENV=production
WORKDIR /repo/apps/generator
CMD ["pnpm", "start"]
