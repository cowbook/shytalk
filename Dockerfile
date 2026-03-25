FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
RUN npm install --omit=dev
COPY --from=build /app/client/dist ./client/dist
COPY server ./server
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "server"]
