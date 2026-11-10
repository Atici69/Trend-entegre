import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { marketplaceStatus } from './src/marketplaces/index.js';
import { testHepsiburadaConnection } from './src/marketplaces/hepsiburada.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Same-origin/server-to-server is allowed; browser origins must be allowlisted.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'trend-entegre-api', timestamp: new Date().toISOString() });
});

// This endpoint reveals only whether credentials are configured, never their values.
app.get('/api/v1/marketplaces/status', (_req, res) => {
  res.json({ marketplaces: marketplaceStatus() });
});

// Performs a read-only authentication handshake; credentials are read only from server env.
app.post('/api/v1/marketplaces/hepsiburada/test', async (_req, res) => {
  const result = await testHepsiburadaConnection();
  res.status(result.ok ? 200 : result.status === 'not_configured' ? 424 : 502).json(result);
});

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin is not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error('API error:', err?.message || 'Unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Trend-Entegre API listening on port ${port}`);
});
