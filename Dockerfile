FROM node:14-alpine as build

WORKDIR /app

RUN apk add --no-cache git=2.34.2-r0
COPY package.json yarn.lock ./
RUN yarn
COPY . .
RUN cd apps/voting/app && yarn

# final image
FROM node:14-alpine as base

WORKDIR /app
COPY --from=build /app /app
RUN apk add --no-cache curl=7.80.0-r1 rsync=3.2.3-r5 && chown -R node /app/apps/voting/app

USER node
EXPOSE 3001

# HEALTHCHECK --interval=10s --timeout=3s \
#     CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["yarn", "--cwd", "apps/voting/app", "start", "--public-url", "/voting"]
