import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { streamFromDb, restoreBrandingCache } from './lib/fileStore';
import { startFmsReverseSyncPoll } from './services/sheetsSync';
import { startApprovalReminderPoll } from './services/approvalChain';
import { startPackingListReminderPoll } from './services/grnReminders';
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './lib/errors';
import { prisma } from './lib/prisma';
import { UPLOADS_PATH } from './middleware/upload';

import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import projectRoutes from './routes/projects';
import boqRoutes from './routes/boq';
import quotationRoutes from './routes/quotations';
import budgetRoutes from './routes/budget';
import progressRoutes from './routes/progress';
import drawingRoutes from './routes/drawings';
import dashboardRoutes from './routes/dashboard';
import reportRoutes from './routes/reports';
import masterReportRoutes from './routes/masterReports';
import vendorRoutes from './routes/vendors';
import procurementRoutes from './routes/procurement';
import brandingRoutes from './routes/branding';
import notificationRoutes from './routes/notifications';
import approvalRoutes from './routes/approvals';
import pettyCashRoutes from './routes/pettyCash';
import approvalChainRoutes from './routes/approvalChains';
import machineModelRoutes from './routes/machineModels';
import boqEnhanceRoutes from './routes/boqEnhance';
import ganttRoutes from './routes/gantt';
import changeOrderRoutes from './routes/changeOrders';
import syncRoutes from './routes/sync';
import dprRoutes from './routes/dpr';
import approvalRuleRoutes from './routes/approvalRules';
import fmsRoutes from './routes/fms';
import apiKeyRoutes from './routes/apiKeys';
import publicApiRoutes from './routes/publicApi';
import publicGrnRoutes from './routes/publicGrn';
import paymentApprovalRoutes from './routes/paymentApproval';
import invoiceApprovalRoutes from './routes/invoiceApproval';
import travelRoutes from './routes/travel';
import travelApprovalRoutes from './routes/travelApproval';
import depositRoutes from './routes/deposits';

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN.split(','), credentials: true }));
app.use(express.json({ limit: '5mb' }));

// Serve uploaded files (drawings + progress photos).
// Serve uploads from local disk when present, else stream from MongoDB (GridFS)
// — so files remain available even if the local cache is wiped on redeploy.
app.get('/uploads/:filename', async (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const local = path.join(UPLOADS_PATH, filename);
  if (fs.existsSync(local)) return res.sendFile(local);
  const served = await streamFromDb(filename, res);
  if (!served) next();
});
app.use('/uploads', express.static(UPLOADS_PATH));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'CRMCTS', time: new Date().toISOString() }));

// Auth + users (global scope)
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/petty-cash', pettyCashRoutes);
app.use('/api/travel', travelRoutes);
app.use('/api/approval-chains', approvalChainRoutes);
app.use('/api/machine-models', machineModelRoutes);
app.use('/api/sync-sheets', syncRoutes);
app.use('/api/approval-rules', approvalRuleRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/v1', publicApiRoutes);
// Public no-login site-engineer GRN form (token is the credential; no requireAuth).
app.use('/api/public/grn', publicGrnRoutes);
// Public no-login payment-release "Approval Form" linked from the FMS sheet.
app.use('/api/public/payment-approval', paymentApprovalRoutes);
app.use('/api/public/invoice-approval', invoiceApprovalRoutes);
// Public no-login Travel "Approval Form" (request + expense), linked from the email.
app.use('/api/public/travel-approval', travelApprovalRoutes);

// Projects + nested project-scoped modules
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/boq', boqRoutes);
app.use('/api/projects/:projectId/budget', budgetRoutes);
app.use('/api/projects/:projectId/quotations', quotationRoutes);
app.use('/api/projects/:projectId/progress', progressRoutes);
app.use('/api/projects/:projectId/drawings', drawingRoutes);
app.use('/api/projects/:projectId/dashboard', dashboardRoutes);
app.use('/api/projects/:projectId/reports', reportRoutes);
app.use('/api/reports', masterReportRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/projects/:projectId/procurement', procurementRoutes);
app.use('/api/projects/:projectId/boq-items', boqEnhanceRoutes);
app.use('/api/projects/:projectId/gantt', ganttRoutes);
app.use('/api/projects/:projectId/change-orders', changeOrderRoutes);
app.use('/api/projects/:projectId/dpr', dprRoutes);
app.use('/api/projects/:projectId/fms', fmsRoutes);

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
  // Pull the branding logo/signature back from Atlas if the disk cache is cold
  // (e.g. after a redeploy), so generated PO/GRN PDFs keep their logo.
  restoreBrandingCache(path.resolve(process.cwd(), 'assets')).catch(() => {});
  // The API-key audit log is a CAPPED collection: its size cap IS the retention
  // policy, so a chatty/abusive integration can never grow it unbounded. Convert
  // it once (idempotent); recreate the secondary index convert() drops.
  ensureCappedApiLog().catch((e) => console.warn('[api-key-log] cap ensure skipped:', (e as Error)?.message));
  // Poll the accounts FMS sheet so UTRs Accounts enter there flow back into the
  // Payment Pipeline (milestone → PAID). No-op when Sheets sync is disabled.
  startFmsReverseSyncPoll();
  // Nudge approvers whose documents have waited 24h+. Off when APPROVAL_REMINDERS=off.
  startApprovalReminderPoll();
  // Nudge site engineers whose signed packing list is still pending. Off when GRN_REMINDERS=off.
  startPackingListReminderPoll();
});

async function ensureCappedApiLog() {
  const SIZE = 50 * 1024 * 1024; // 50 MB
  let capped = false;
  try {
    const stats = (await prisma.$runCommandRaw({ collStats: 'ApiKeyCall' })) as { capped?: boolean };
    capped = !!stats.capped;
  } catch { /* collection absent — created on first insert; convert on next boot */ return; }
  if (capped) return;
  await prisma.$runCommandRaw({ convertToCapped: 'ApiKeyCall', size: SIZE });
  // convertToCapped keeps only the _id index — recreate the query index.
  await prisma.$runCommandRaw({ createIndexes: 'ApiKeyCall', indexes: [{ key: { keyId: 1, at: -1 }, name: 'keyId_at_capped' }] }).catch(() => {});
  console.log('  API-key audit log → converted to capped (50 MB)');
}
