FROM node:22-alpine

WORKDIR /app

COPY eval-server.js .
COPY package*.json .

RUN npm install --omit=dev

COPY eval-watchdog.sh .

RUN chmod +x eval-watchdog.sh

EXPOSE 3000

CMD ["./eval-watchdog.sh"]
