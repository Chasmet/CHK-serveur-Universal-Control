FROM node:22-alpine
WORKDIR /srv
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_FILE=/srv/data/server.json
EXPOSE 8787
RUN mkdir -p /srv/data && chown -R node:node /srv
USER node
CMD ["node", "src/server.mjs"]
