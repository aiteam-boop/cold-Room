import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './lib/errors';
import { UPLOADS_PATH } from './middleware/upload';

import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import projectRoutes from './routes/projects';
import boqRoutes from './routes/boq';
import progressRoutes from './routes/progress';
import drawingRoutes from './routes/drawings';
import dashboardRoutes from './routes/dashboard';
import reportRoutes from './routes/reports';
import vendorRoutes from './routes/vendors';
import procurementRoutes from './routes/procurement';
import brandingRoutes from './routes/branding';
import notificationRoutes from './routes/notifications';
import approvalRoutes from './routes/approvals';

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN.split(','), credentials: true }));
app.use(express.json({ limit: '5mb' }));

// Serve uploaded files (drawings + progress photos).
app.use('/uploads', express.static(UPLOADS_PATH));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'CRMCTS', time: new Date().toISOString() }));

// Auth + users (global scope)
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/approvals', approvalRoutes);

// Projects + nested project-scoped modules
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/boq', boqRoutes);
app.use('/api/projects/:projectId/progress', progressRoutes);
app.use('/api/projects/:projectId/drawings', drawingRoutes);
app.use('/api/projects/:projectId/dashboard', dashboardRoutes);
app.use('/api/projects/:projectId/reports', reportRoutes);
app.use('/api/projects/:projectId/procurement', procurementRoutes);

// 404
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Safety net: a transient DB/network blip (e.g. a momentary Atlas TLS hiccup in
// a fire-and-forget promise) should never kill the whole server. Log and stay up
// so the next request can succeed instead of the client getting ECONNREFUSED.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.listen(PORT, () => {
  console.log(`\n  CRMCTS API → http://localhost:${PORT}`);
  console.log(`  CORS origin → ${ORIGIN}`);
  const aiProv = process.env.GROQ_API_KEY ? `ENABLED (Groq · ${process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'})` : process.env.ANTHROPIC_API_KEY ? 'ENABLED (Claude)' : 'disabled (set GROQ_API_KEY or ANTHROPIC_API_KEY)';
  console.log(`  AI parsing → ${aiProv}\n`);
});
