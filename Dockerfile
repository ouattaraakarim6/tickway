FROM node:20-alpine

WORKDIR /app

# 1. Copier tous les fichiers du dépôt
COPY . .

# 2. Si les fichiers sont rangés dans un sous-dossier (tickway ou tickway-backend), les remonter à la racine
RUN if [ -f "tickway/package.json" ]; then cp -r tickway/* . ; fi \
 && if [ -f "tickway-backend/package.json" ]; then cp -r tickway-backend/* . ; fi

# 3. Installer les dépendances
RUN npm install --production

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
