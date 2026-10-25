FROM node:22-alpine AS build

RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY prisma ./prisma
RUN npm exec prisma generate

COPY --from=build /app/build ./build

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000

CMD ["npm", "run", "docker-start"]
