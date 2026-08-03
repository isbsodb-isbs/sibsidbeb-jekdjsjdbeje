FROM node:22-alpine

RUN apk add --no-cache bash chafa

WORKDIR /app

COPY package.json .

RUN npm install --omit=dev

COPY eval-server.js .
COPY eval-watchdog.sh .

RUN chmod +x eval-watchdog.sh

EXPOSE 3000

CMD ["./eval-watchdog.sh"]
