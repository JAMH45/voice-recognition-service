//Posibles correciones
function corregirErrores(texto) {
  return texto
     .replace(/\bcasa\s?innato\b/gi, "caseinato")
    .replace(/\bchase\s?innato\b/gi, "caseinato")
    .replace(/\bcasey\s?nato\b/gi, "caseinato")
    .replace(/\bcasey\s?nacho\b/gi, "caseinato")
    .replace(/\bcasey\s?innato\b/gi, "caseinato")
    .replace(/\bcasi\s?innato\b/gi, "caseinato")
    .replace(/\bcase\s?innato\b/gi, "caseinato")
    .replace(/\bcasi\s?nato\b/gi, "caseinato")
     // ensure advance
    .replace(/\b(en su advance|en sur advance|en short advance|en chur advance)\b/gi, "ensure advance")
    .replace(/\b(en su\b.+\badvance)\b/gi, "ensure advance")
    .replace(/\b(en shur advance)\b/gi, "ensure advance")
    .replace(/\bensure\b/gi, "ensure") // por si sola
    .replace(/\badvance\b/gi, "advance");
}

//Carga de dependencias de entorno
require("dotenv").config();

const express = require("express");
const vosk = require("vosk");
const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");
//Palabras especiales
const PHARMA_GRAMMAR = [
  "caseinato",
  "casec",
  "ensure",
  "proteína",
  "nutrición",
  "músculo",
  "paciente",
];

// ============================
//  CONFIGURACIÓN VOSK
// ============================

const modelPath = process.env.MODEL_PATH || "model";
if (!fs.existsSync(modelPath)) {
  console.error("Modelo Vosk no encontrado en:", modelPath);
  process.exit(1);
}

vosk.setLogLevel(0); // opcional: menos ruido en consola

// Cargar modelo una sola vez
const model = new vosk.Model(modelPath);
const SAMPLE_RATE = 16000;

// ============================
//  UPSAMPLE 8kHz -> 16kHz (para HTTP)
// ============================

const upsampleAudio = (audioBuffer) => {
  if (!audioBuffer || audioBuffer.length === 0) {
    console.warn("Empty or null audio buffer received");
    return Buffer.alloc(0);
  }

  if (audioBuffer.length % 2 !== 0) {
    console.warn("Audio buffer length is odd, truncating last byte");
    audioBuffer = audioBuffer.slice(0, audioBuffer.length - 1);
  }

  const inputSamples = audioBuffer.length / 2;
  if (inputSamples === 0) return Buffer.alloc(0);

  const outputSamples = inputSamples * 2;
  const outputBuffer = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    if (i % 2 === 0) {
      const originalIndex = i / 2;
      if (originalIndex < inputSamples) {
        const sample = audioBuffer.readInt16LE(originalIndex * 2);
        outputBuffer.writeInt16LE(sample, i * 2);
      }
    } else {
      const prevIndex = Math.floor(i / 2);
      const nextIndex = Math.ceil(i / 2);

      if (prevIndex < inputSamples && nextIndex < inputSamples) {
        const prevSample = audioBuffer.readInt16LE(prevIndex * 2);
        const nextSample = audioBuffer.readInt16LE(nextIndex * 2);
        const interpolatedSample = Math.round((prevSample + nextSample) / 2);
        outputBuffer.writeInt16LE(interpolatedSample, i * 2);
      } else if (prevIndex < inputSamples) {
        const sample = audioBuffer.readInt16LE(prevIndex * 2);
        outputBuffer.writeInt16LE(sample, i * 2);
      }
    }
  }

  return outputBuffer;
};

// ============================
//  RESAMPLE PCM16 (sourceRate -> 16kHz) PARA WS
// ============================

/**
 * Re-muestrea un buffer PCM16LE de sourceRate a targetRate.
 * @param {Buffer} buffer - Buffer con datos Int16LE
 * @param {number} sourceRate - Frecuencia de muestreo de entrada (ej. 44100)
 * @param {number} targetRate - Frecuencia de salida (ej. 16000)
 * @returns {Buffer} - Nuevo buffer Int16LE re-muestreado
 */
function resamplePcm16(buffer, sourceRate, targetRate) {
  if (sourceRate === targetRate) return buffer;

  const sampleCount = buffer.length / 2;
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, sampleCount);

  const ratio = targetRate / sourceRate; // ej. 16000 / 44100
  const outSamples = Math.floor(sampleCount * ratio);
  const output = Buffer.alloc(outSamples * 2);

  const invRatio = sourceRate / targetRate; // ej. 44100 / 16000

  for (let i = 0; i < outSamples; i++) {
    const srcIndex = i * invRatio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, sampleCount - 1);
    const t = srcIndex - i0;

    const s0 = input[i0];
    const s1 = input[i1];
    const sample = s0 + (s1 - s0) * t;

    output.writeInt16LE(Math.round(sample), i * 2);
  }

  return output;
}

// ============================
//  EXPRESS: endpoint HTTP (tu código original)
// ============================

const app = express();

/**
 * Maneja un stream HTTP con audio (8kHz) y devuelve texto por SSE
 */
const handleAudioStream = async (req, res) => {
  try {
    const rec = new vosk.Recognizer({
      model,
      sampleRate: SAMPLE_RATE,
      grammar: PHARMA_GRAMMAR,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    req.on("data", (chunk) => {
      try {
        const upsampledChunk = upsampleAudio(chunk);
        if (upsampledChunk.length === 0) {
          console.warn("Warning: Upsampled chunk is empty");
          return;
        }

        if (rec.acceptWaveform(upsampledChunk)) {
          const result = rec.result();
          console.log("Resultado HTTP =", result);
          if (result.text) {
            res.write(result.text + "\n");
          }
        }
      } catch (error) {
        console.error("Error processing audio chunk:", error);
      }
    });

    req.on("end", () => {
      console.log("Audio stream ended");
      try {
        const final = rec.finalResult();
        console.log("Final HTTP =", final);
        if (final.text) {
          res.write(final.text + "\n");
        }
        rec.free();
        res.end();
      } catch (error) {
        console.error("Error getting final result:", error);
        rec.free();
        res.end();
      }
    });

    req.on("error", (err) => {
      console.error("Error receiving audio stream:", err);
      rec.free();
      try {
        res.status(500).json({ message: "Error receiving audio stream" });
      } catch (_) {}
    });
  } catch (err) {
    console.error("Error handling audio stream:", err);
    res.status(500).json({ message: err.message });
  }
};

app.post("/speech-to-text-stream", handleAudioStream);

// ============================
//  SERVIDOR HTTP + WEBSOCKET
// ============================

const port = process.env.PORT || 6010;
const server = http.createServer(app);

// Servidor WebSocket montado sobre el mismo server
const wss = new WebSocket.Server({ server, path: "/stt" });

wss.on("connection", (ws) => {
  console.log("Cliente WebSocket conectado");

  // Un recognizer POR conexión
  const rec = new vosk.Recognizer({ model, sampleRate: SAMPLE_RATE });

  // Para evitar spamear parciales iguales
  let lastPartial = "";
  // SampleRate real del cliente (Brave/Safari/Chrome)
  let clientSampleRate = SAMPLE_RATE; // por defecto, pero se sobrescribe

  ws.on("message", (data, isBinary) => {
    try {
      // Mensajes de texto: config (sampleRate, etc.)
      if (!isBinary) {
        const txt = data.toString();
        try {
          const msg = JSON.parse(txt);
          if (msg.type === "config" && msg.sampleRate) {
            clientSampleRate = Number(msg.sampleRate) || SAMPLE_RATE;
            console.log("SampleRate cliente =", clientSampleRate);
          } else {
            console.warn("Mensaje texto desconocido en WS:", txt);
          }
        } catch (e) {
          console.warn("Mensaje texto no JSON en WS:", txt);
        }
        return;
      }

      // Mensaje binario = audio PCM16LE
      let audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Resamplear si el sampleRate del cliente no es 16k
      if (clientSampleRate !== SAMPLE_RATE) {
        audioBuffer = resamplePcm16(audioBuffer, clientSampleRate, SAMPLE_RATE);
      }

      // Procesamos el chunk
      const isFinal = rec.acceptWaveform(audioBuffer);

      if (isFinal) {
        const result = rec.result();

        if (result && result.text && result.text.trim()) {
          const corregido = corregirErrores(result.text.trim());

          ws.send(
            JSON.stringify({
              type: "final",
              text: corregido,
            })
          );

          lastPartial = "";
        }
      } else {
        const partial = rec.partialResult();

        if (
          partial &&
          partial.partial &&
          partial.partial.trim() &&
          partial.partial !== lastPartial
        ) {
          const corregido = corregirErrores(partial.partial.trim());

          lastPartial = corregido;
          ws.send(
            JSON.stringify({
              type: "partial",
              text: corregido,
            })
          );
        }
      }
    } catch (err) {
      console.error("Error en mensaje WS:", err);
      try {
        ws.send(JSON.stringify({ type: "error", error: err.message }));
      } catch (_) {}
    }
  });

  ws.on("close", () => {
    console.log("Cliente WebSocket desconectado");
    try {
      const final = rec.finalResult();
      if (final && final.text && final.text.trim()) {
        console.log("FINAL AL CERRAR =", final);
      }
    } catch (e) {
      console.error("Error finalResult al cerrar:", e);
    }
    rec.free();
  });

  ws.on("error", (err) => {
    console.error("Error en WebSocket:", err);
    rec.free();
  });
});

server.listen(port, () => {
  console.log(`Servidor HTTP+WS escuchando en puerto ${port}`);
  console.log(`HTTP POST: /speech-to-text-stream`);
  console.log(`WS: ws://localhost:${port}/stt`);
});
