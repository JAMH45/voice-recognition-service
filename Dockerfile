# Etapa 1: Builder
FROM node:16-bullseye AS builder

WORKDIR /usr/src/app

# Dependencias de build para vosk
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Descargar modelo small de español
RUN wget https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip \
    && unzip vosk-model-small-es-0.42.zip \
    && mv vosk-model-small-es-0.42 model \
    && rm vosk-model-small-es-0.42.zip

# Instalar dependencias
COPY package*.json ./
RUN npm ci && npm cache clean --force

# Copiar aplicación
COPY index.js ./

# Etapa 2: Runtime
FROM node:16-bullseye-slim AS production

WORKDIR /usr/src/app

# Instalar dependencias de runtime
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/index.js ./index.js
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/model ./model

ENV NODE_ENV=production
ENV MODEL_PATH=/usr/src/app/model

EXPOSE 6010

USER node

CMD ["node", "index.js"]
