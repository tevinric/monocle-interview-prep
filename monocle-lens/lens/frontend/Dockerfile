FROM node:20-alpine AS build

WORKDIR /app

# Manifests first, so a dependency-only change is the only thing that busts the
# install layer. `npm ci` installs exactly what package-lock.json pins, which is
# what makes the image reproducible — `npm install` would silently re-resolve.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf

EXPOSE 80

# The container is a static file server; if nginx cannot answer, it is not ready.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
