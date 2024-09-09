FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps
COPY . .
EXPOSE 8080
CMD ["npm", "run", "start"]
# docker build -t interrapidisimo/api-public .
