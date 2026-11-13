import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { bridgeRouter } from './routes/bridge.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---- Bridge routes (mimic api.heypanda.org paths Panda expects) ----
app.use('/v1', bridgeRouter);

// ---- Health / liveness (for Render + UptimeRobot) ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'gemini-bridge',
    pid: process.pid
  });
});

// ---- Wake-up ping (extra safety on top of UptimeRobot) ----
app.get('/ping', (req, res) => {
  res.json({ pong: true, ts: Date.now() });
});

app.listen(PORT, () => {
  console.log(`Gemini bridge listening on :${PORT}`);
  console.log(`  /health   - liveness probe`);
  console.log(`  /ping     - wake-up ping`);
  console.log(`  /v1/*     - Panda API paths proxied to Gemini`);
});
