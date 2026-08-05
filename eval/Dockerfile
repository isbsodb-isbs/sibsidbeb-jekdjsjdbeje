FROM node:22-alpine

RUN apk add --no-cache bash chafa docker-cli \
    && addgroup -S appgroup \
    && adduser -S appuser -G appgroup

WORKDIR /app

COPY package.json .

RUN npm install --omit=dev \
    && npm cache clean --force

COPY eval-server.js .
COPY eval-watchdog.sh .
COPY Dockerfile.worker .

RUN chmod +x eval-watchdog.sh \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

CMD ["./eval-watchdog.sh"]
