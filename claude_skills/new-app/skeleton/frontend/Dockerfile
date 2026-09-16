FROM node:20-alpine AS build

WORKDIR /app

# Copy manifests first for better layer caching, then install cleanly. There is
# no bundled lockfile, so `npm install` resolves fresh; a .dockerignore keeps the
# host's node_modules out of the build context.
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
