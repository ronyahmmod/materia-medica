import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { getApp, getApps, initializeApp, type App as FirebaseAdminApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import dotenv from 'dotenv';
import {
  buildLegacyObjectKey,
  buildTenantObjectKey,
  deleteObjectFromB2,
  downloadBufferFromB2,
  getB2BucketNameForHealth,
  getB2PerClinicBreakdown,
  getB2StorageStats,
  isB2Configured,
  uploadBufferToB2,
} from './server/b2Storage';

dotenv.config();

interface FirebaseAppletConfig {
  projectId?: string;
  firestoreDatabaseId?: string;
}

interface AuthenticatedRequest extends Request {
  adminUser?: DecodedIdToken;
  isSuperAdmin?: boolean;
  clinicId?: string;
  storageLimitMb?: number;
}

function resolveListenPort(): number {
  const portFlagIdx = process.argv.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (portFlagIdx !== -1) {
    const arg = process.argv[portFlagIdx];
    const raw = arg.startsWith('--port=') ? arg.slice('--port='.length) : process.argv[portFlagIdx + 1];
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  if (
    process.env.NODE_ENV !== 'production' &&
    nginxPort > 0 &&
    envPort === nginxPort
  ) {
    return Number(process.env.DEFAULT_APP_PORT) || 3000;
  }
  return Number.isInteger(envPort) && envPort > 0 ? envPort : 3000;
}

const PORT = resolveListenPort();
const ROOT_DIR = process.cwd();
const UPLOAD_ROOT = path.resolve(ROOT_DIR, process.env.UPLOAD_STORAGE_DIR || 'data/uploads');
const MAX_DECODED_BYTES = 1_572_864; // 1.5 MB per compressed clinical image
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_FILENAME_REGEX = /^[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)$/;
const REPERTORY_CHAPTERS = [
  'Mind',
  'Head & Vertigo',
  'Respiratory',
  'Gastrointestinal',
  'Skin',
  'Musculoskeletal',
  'Sleep & Dreams',
  'Generalities',
] as const;

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function loadFirebaseAppletConfig(): FirebaseAppletConfig {
  const configPath = path.resolve(ROOT_DIR, 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as FirebaseAppletConfig;
    if (!parsed.projectId || parsed.projectId === 'remixed-project-id') {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function getAdminApp(): FirebaseAdminApp | null {
  const { projectId } = loadFirebaseAppletConfig();
  if (!projectId) return null;
  return getApps().length ? getApp() : initializeApp({ projectId });
}

function getAllowedSuperAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS || 'rony.jib@gmail.com';
  return new Set(
    raw
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

interface CachedClinicMembership {
  expiresAt: number;
  subscriptionStatus: string;
  storageLimitMb: number;
}

const clinicMembershipCache = new Map<string, CachedClinicMembership>();
const CLINIC_MEMBERSHIP_TTL_MS = 15_000;

function extractStringArrayField(
  field?: { arrayValue?: { values?: Array<{ stringValue?: string }> } }
): string[] {
  const values = field?.arrayValue?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => (typeof v?.stringValue === 'string' ? v.stringValue.trim() : ''))
    .filter(Boolean);
}

async function verifyClinicMembershipViaUserToken(
  token: string,
  clinicId: string,
  uid: string,
  email: string
): Promise<{ allowed: boolean; suspended?: boolean; storageLimitMb?: number; reason?: string }> {
  const cacheKey = `${clinicId}:${uid}:${email}`;
  const cached = clinicMembershipCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.subscriptionStatus === 'suspended') {
      return {
        allowed: false,
        suspended: true,
        reason: 'This clinic subscription is currently suspended. Please contact the platform administrator.',
      };
    }
    return { allowed: true, storageLimitMb: cached.storageLimitMb };
  }

  const { projectId, firestoreDatabaseId } = loadFirebaseAppletConfig();
  if (!projectId) {
    return { allowed: false, reason: 'Firebase project is not configured on the server.' };
  }
  const dbId = firestoreDatabaseId || '(default)';
  const endpoint = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(dbId)}/documents/clinics/${encodeURIComponent(clinicId)}`;

  try {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) {
      return {
        allowed: false,
        reason: 'You do not have access to this clinic workspace.',
      };
    }

    const docJson = (await resp.json()) as {
      fields?: Record<
        string,
        {
          stringValue?: string;
          integerValue?: string;
          doubleValue?: number;
          arrayValue?: { values?: Array<{ stringValue?: string }> };
        }
      >;
    };
    const fields = docJson.fields || {};
    const authorizedUids = extractStringArrayField(fields.authorizedUids);
    const accessEmails = extractStringArrayField(fields.accessEmails).map((e) => e.toLowerCase());
    if (!authorizedUids.includes(uid) || !accessEmails.includes(email.toLowerCase())) {
      return {
        allowed: false,
        reason: 'Your assigned account credentials do not match this clinic.',
      };
    }

    const status = fields.subscriptionStatus?.stringValue || 'active';
    const rawLimit =
      fields.storageLimitMb?.doubleValue ??
      (fields.storageLimitMb?.integerValue ? Number(fields.storageLimitMb.integerValue) : 100);
    const storageLimitMb = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100;

    clinicMembershipCache.set(cacheKey, {
      expiresAt: Date.now() + CLINIC_MEMBERSHIP_TTL_MS,
      subscriptionStatus: status,
      storageLimitMb,
    });

    if (status === 'suspended') {
      return {
        allowed: false,
        suspended: true,
        reason: 'This clinic subscription is currently suspended. Please contact the platform administrator.',
      };
    }

    return { allowed: true, storageLimitMb };
  } catch {
    return {
      allowed: false,
      reason: 'Unable to verify clinic subscription permissions.',
    };
  }
}

async function authenticateBearerUser(
  req: AuthenticatedRequest,
  res: Response
): Promise<{
  decoded: DecodedIdToken;
  token: string;
  uid: string;
  email: string;
  signInProvider: string;
} | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing bearer authorization token.' });
    return null;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Empty authorization token.' });
    return null;
  }

  const adminApp = getAdminApp();
  if (!adminApp) {
    res.status(500).json({ error: 'Firebase project is not configured on the server.' });
    return null;
  }

  try {
    const decoded = await getAuth(adminApp).verifyIdToken(token);
    const email = (decoded.email || '').toLowerCase();
    const uid = decoded.uid || '';
    const signInProvider = decoded.firebase?.sign_in_provider || '';
    if (!uid || !email) {
      res.status(401).json({ error: 'Authenticated user credentials required.' });
      return null;
    }
    return { decoded, token, uid, email, signInProvider };
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
    return null;
  }
}

function isVerifiedSuperAdminToken(verified: {
  decoded: DecodedIdToken;
  email: string;
  signInProvider: string;
}): boolean {
  return (
    verified.signInProvider === 'google.com' &&
    verified.decoded.email_verified === true &&
    getAllowedSuperAdminEmails().has(verified.email)
  );
}

async function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const verified = await authenticateBearerUser(req, res);
  if (!verified) return;

  if (!isVerifiedSuperAdminToken(verified)) {
    res.status(401).json({ error: 'Super Admin privileges required.' });
    return;
  }

  req.adminUser = verified.decoded;
  req.isSuperAdmin = true;
  next();
}

async function requireClinicOrSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const verified = await authenticateBearerUser(req, res);
  if (!verified) return;

  const isSuperAdmin = isVerifiedSuperAdminToken(verified);
  const rawClinicId =
    (typeof req.params?.clinicId === 'string' ? req.params.clinicId : '') ||
    (typeof req.headers['x-clinic-id'] === 'string' ? req.headers['x-clinic-id'] : '') ||
    (typeof req.query?.clinicId === 'string' ? req.query.clinicId : '') ||
    (typeof (req.body as { clinicId?: unknown } | undefined)?.clinicId === 'string'
      ? ((req.body as { clinicId?: string }).clinicId || '')
      : '');
  const trimmedClinicId = rawClinicId.trim();

  if (isSuperAdmin) {
    if (trimmedClinicId && !SAFE_ID_REGEX.test(trimmedClinicId)) {
      res.status(400).json({ error: 'Invalid clinicId parameter.' });
      return;
    }
    req.adminUser = verified.decoded;
    req.isSuperAdmin = true;
    req.clinicId = trimmedClinicId || 'default';
    next();
    return;
  }

  if (verified.signInProvider !== 'password') {
    res.status(401).json({
      error: 'Client access requires assigned email and password authentication.',
    });
    return;
  }

  if (!trimmedClinicId || !SAFE_ID_REGEX.test(trimmedClinicId)) {
    res.status(401).json({ error: 'Active clinic workspace identifier is required.' });
    return;
  }

  const membership = await verifyClinicMembershipViaUserToken(
    verified.token,
    trimmedClinicId,
    verified.uid,
    verified.email
  );
  if (!membership.allowed) {
    res.status(401).json({ error: membership.reason || 'Clinic access denied.' });
    return;
  }

  req.adminUser = verified.decoded;
  req.isSuperAdmin = false;
  req.clinicId = trimmedClinicId;
  req.storageLimitMb = membership.storageLimitMb;
  next();
}

function detectImageType(buffer: Buffer): { mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' } | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: 'png' };
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }

  return null;
}

function resolveConfinedPath(patientId: string, fileName?: string): string | null {
  if (!SAFE_ID_REGEX.test(patientId)) return null;
  const patientDir = path.resolve(UPLOAD_ROOT, patientId);
  if (!patientDir.startsWith(UPLOAD_ROOT + path.sep)) return null;

  if (!fileName) return patientDir;
  if (!SAFE_FILENAME_REGEX.test(fileName)) return null;

  const targetPath = path.resolve(patientDir, fileName);
  if (!targetPath.startsWith(patientDir + path.sep)) return null;
  return targetPath;
}

function resolveTenantPhotoPath(clinicId: string, patientId: string, fileName?: string): string | null {
  if (!SAFE_ID_REGEX.test(clinicId) || !SAFE_ID_REGEX.test(patientId)) return null;
  const clinicDir = path.resolve(UPLOAD_ROOT, `tenant_${clinicId}`);
  if (!clinicDir.startsWith(UPLOAD_ROOT + path.sep)) return null;
  const patientDir = path.resolve(clinicDir, patientId);
  if (!patientDir.startsWith(clinicDir + path.sep)) return null;

  if (!fileName) return patientDir;
  if (!SAFE_FILENAME_REGEX.test(fileName)) return null;

  const targetPath = path.resolve(patientDir, fileName);
  if (!targetPath.startsWith(patientDir + path.sep)) return null;
  return targetPath;
}

function walkStorageDir(dirPath: string): { totalFiles: number; totalBytes: number } {
  if (!fs.existsSync(dirPath)) {
    return { totalFiles: 0, totalBytes: 0 };
  }

  let totalFiles = 0;
  let totalBytes = 0;

  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.resolve(currentDir, entry.name);
      if (!fullPath.startsWith(UPLOAD_ROOT + path.sep)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stats = fs.statSync(fullPath);
        totalFiles += 1;
        totalBytes += stats.size;
      }
    }
  };

  walk(dirPath);
  return { totalFiles, totalBytes };
}

function computeLocalStorageStats(clinicId?: string): { totalFiles: number; totalBytes: number } {
  if (!clinicId || clinicId === 'all') {
    return walkStorageDir(UPLOAD_ROOT);
  }
  if (!SAFE_ID_REGEX.test(clinicId)) {
    return { totalFiles: 0, totalBytes: 0 };
  }
  const tenantDir = path.resolve(UPLOAD_ROOT, `tenant_${clinicId}`);
  if (!tenantDir.startsWith(UPLOAD_ROOT + path.sep)) {
    return { totalFiles: 0, totalBytes: 0 };
  }
  return walkStorageDir(tenantDir);
}

function computeLocalPerClinicStorageBreakdown(): {
  totalFiles: number;
  totalBytes: number;
  byClinic: Record<string, { totalFiles: number; totalBytes: number }>;
  legacyStats: { totalFiles: number; totalBytes: number };
} {
  if (!fs.existsSync(UPLOAD_ROOT)) {
    return {
      totalFiles: 0,
      totalBytes: 0,
      byClinic: {},
      legacyStats: { totalFiles: 0, totalBytes: 0 },
    };
  }

  let totalFiles = 0;
  let totalBytes = 0;
  let legacyFiles = 0;
  let legacyBytes = 0;
  const byClinic: Record<string, { totalFiles: number; totalBytes: number }> = {};

  const topEntries = fs.readdirSync(UPLOAD_ROOT, { withFileTypes: true });
  for (const entry of topEntries) {
    const fullPath = path.resolve(UPLOAD_ROOT, entry.name);
    if (!fullPath.startsWith(UPLOAD_ROOT + path.sep)) continue;
    if (entry.isDirectory() && entry.name.startsWith('tenant_')) {
      const clinicId = entry.name.slice('tenant_'.length);
      const stats = walkStorageDir(fullPath);
      byClinic[clinicId] = stats;
      totalFiles += stats.totalFiles;
      totalBytes += stats.totalBytes;
    } else if (entry.isDirectory()) {
      const stats = walkStorageDir(fullPath);
      legacyFiles += stats.totalFiles;
      legacyBytes += stats.totalBytes;
      totalFiles += stats.totalFiles;
      totalBytes += stats.totalBytes;
    } else if (entry.isFile()) {
      const stats = fs.statSync(fullPath);
      legacyFiles += 1;
      legacyBytes += stats.size;
      totalFiles += 1;
      totalBytes += stats.size;
    }
  }

  return {
    totalFiles,
    totalBytes,
    byClinic,
    legacyStats: { totalFiles: legacyFiles, totalBytes: legacyBytes },
  };
}

async function computeStorageStatsAsync(
  clinicId?: string
): Promise<{ totalFiles: number; totalBytes: number }> {
  const local = computeLocalStorageStats(clinicId);
  if (!isB2Configured()) return local;

  try {
    const b2 = await getB2StorageStats(clinicId);
    return {
      totalFiles: local.totalFiles + b2.totalFiles,
      totalBytes: local.totalBytes + b2.totalBytes,
    };
  } catch (err) {
    console.error('Backblaze B2 storage stats failed:', err instanceof Error ? err.message : err);
    return local;
  }
}

async function computePerClinicStorageBreakdownAsync(): Promise<{
  totalFiles: number;
  totalBytes: number;
  byClinic: Record<string, { totalFiles: number; totalBytes: number }>;
  legacyStats: { totalFiles: number; totalBytes: number };
}> {
  const local = computeLocalPerClinicStorageBreakdown();
  if (!isB2Configured()) return local;

  try {
    const b2 = await getB2PerClinicBreakdown();
    const mergedByClinic: Record<string, { totalFiles: number; totalBytes: number }> = {};

    for (const [cid, stats] of Object.entries(local.byClinic)) {
      mergedByClinic[cid] = { ...stats };
    }
    for (const [cid, stats] of Object.entries(b2.byClinic)) {
      const existing = mergedByClinic[cid] || { totalFiles: 0, totalBytes: 0 };
      mergedByClinic[cid] = {
        totalFiles: existing.totalFiles + stats.totalFiles,
        totalBytes: existing.totalBytes + stats.totalBytes,
      };
    }

    return {
      totalFiles: local.totalFiles + b2.totalFiles,
      totalBytes: local.totalBytes + b2.totalBytes,
      byClinic: mergedByClinic,
      legacyStats: {
        totalFiles: local.legacyStats.totalFiles + b2.legacyStats.totalFiles,
        totalBytes: local.legacyStats.totalBytes + b2.legacyStats.totalBytes,
      },
    };
  } catch (err) {
    console.error('Backblaze B2 breakdown failed:', err instanceof Error ? err.message : err);
    return local;
  }
}

function getGenAiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error(
      'Gemini API key is not configured on the server. Add GEMINI_API_KEY in server environment configuration.'
    ) as Error & { statusCode?: number };
    err.statusCode = 500;
    throw err;
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'materia-medica-clinic/1.0',
      },
    },
  });
}

function normalizeChapter(rawChapter: unknown): (typeof REPERTORY_CHAPTERS)[number] {
  if (typeof rawChapter === 'string') {
    const exact = REPERTORY_CHAPTERS.find(
      (chap) => chap.toLowerCase() === rawChapter.trim().toLowerCase()
    );
    if (exact) return exact;
  }
  return 'Generalities';
}

function extractBalancedJson(input: string): string | null {
  const startObj = input.indexOf('{');
  const startArr = input.indexOf('[');
  let start = -1;
  if (startObj !== -1 && startArr !== -1) {
    start = Math.min(startObj, startArr);
  } else {
    start = Math.max(startObj, startArr);
  }
  if (start === -1) return null;

  const openChar = input[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseGeminiJsonResponse<T>(rawText: string | undefined): T {
  const cleaned = (rawText ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!cleaned) {
    const err = new Error('AI service returned an empty response. Please try again.') as Error & {
      statusCode?: number;
    };
    err.statusCode = 422;
    throw err;
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const extracted = extractBalancedJson(cleaned);
    if (extracted) {
      const noTrailingCommas = extracted.replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(noTrailingCommas) as T;
      } catch {
        // Fall through to structured error
      }
    }
    console.error('Failed to parse Gemini JSON payload:', cleaned.slice(0, 300));
    const err = new Error(
      'Received an unexpected response format from the clinical AI service. Please try searching again.'
    ) as Error & { statusCode?: number };
    err.statusCode = 422;
    throw err;
  }
}

interface CachedQuickSearchEntry {
  expiresAt: number;
  interpretedSymptoms: string;
  suggestions: Array<{
    chapter: (typeof REPERTORY_CHAPTERS)[number];
    rubric: string;
    primaryRemedy: string;
    primaryGrade: 1 | 2 | 3;
    differentialRemedies: string[];
    remedyGrades: Record<string, 1 | 2 | 3>;
    modalities: string;
    rationale: string;
  }>;
}

const quickSearchCache = new Map<string, CachedQuickSearchEntry>();
const QUICK_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error(timeoutMessage) as Error & { statusCode?: number };
          err.statusCode = 408;
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapGeminiError(error: unknown): { status: number; message: string } {
  const errObj = error as { status?: number; statusCode?: number; message?: string };
  const rawMessage = errObj?.message || 'Unable to complete repertory Quick Search.';
  const status = errObj?.statusCode || errObj?.status;

  // Never emit 403/502/503/504 from /api/* because the container proxy intercepts those codes with HTML pages.
  if (status === 408 || status === 504) {
    return { status: 408, message: rawMessage };
  }
  if (status === 422) {
    return { status: 422, message: rawMessage };
  }
  if (status === 503 || status === 500) {
    return { status: 500, message: rawMessage };
  }
  if (
    status === 403 ||
    rawMessage.includes('PERMISSION_DENIED') ||
    status === 400 ||
    rawMessage.includes('API_KEY_INVALID')
  ) {
    return {
      status: 400,
      message:
        'Gemini API authentication failed. Check your GEMINI_API_KEY in server environment configuration.',
    };
  }
  if (status === 429 || rawMessage.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Gemini API rate limit or quota reached. Please try again shortly or review your server environment configuration.',
    };
  }
  if (status === 404 || rawMessage.includes('NOT_FOUND')) {
    return {
      status: 500,
      message: 'Configured Gemini model is currently unavailable.',
    };
  }
  if (rawMessage.includes('Unexpected token') || rawMessage.includes('is not valid JSON')) {
    return {
      status: 422,
      message:
        'The AI service returned an incomplete or malformed response. Please retry your search.',
    };
  }

  return { status: 500, message: rawMessage };
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2.5mb' }));

  const { projectId: configuredFirebaseProjectId } = loadFirebaseAppletConfig();
  const allowedOrigins = new Set<string>(
    [
      ...(configuredFirebaseProjectId
        ? [
            `https://${configuredFirebaseProjectId}.web.app`,
            `https://${configuredFirebaseProjectId}.firebaseapp.com`,
          ]
        : []),
      (process.env.APP_URL || '').trim().replace(/\/+$/, ''),
      ...(process.env.CORS_ALLOW_ORIGINS || '')
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ].filter(Boolean)
  );

  app.use('/api', (req, res, next) => {
    const origin = (req.headers.origin || '').trim().replace(/\/+$/, '');
    if (origin && (allowedOrigins.has(origin) || origin.startsWith('http://localhost:'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-clinic-id');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/saas/health', requireSuperAdmin, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      const geminiConfigured = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
      const { projectId, firestoreDatabaseId } = loadFirebaseAppletConfig();
      const b2Configured = isB2Configured();
      let uploadRootWritable = false;
      try {
        fs.accessSync(UPLOAD_ROOT, fs.constants.W_OK);
        uploadRootWritable = true;
      } catch {
        uploadRootWritable = false;
      }
      const breakdown = await computePerClinicStorageBreakdownAsync();

      res.json({
        ok: true,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development',
        port: PORT,
        uptimeSeconds: Math.round(process.uptime()),
        geminiConfigured,
        firebaseConfigured: Boolean(projectId),
        firebaseProjectId: projectId || null,
        firestoreDatabaseId: firestoreDatabaseId || null,
        uploadRootWritable,
        storageBackend: b2Configured ? 'backblaze_b2' : 'local_disk',
        b2Configured,
        b2BucketName: getB2BucketNameForHealth(),
        storage: breakdown,
      });
    } catch {
      res.status(500).json({ error: 'Unable to inspect SaaS platform health.' });
    }
  });

  app.get('/api/storage/stats', requireClinicOrSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const targetClinic =
        req.isSuperAdmin && req.query.clinicId === 'all' ? 'all' : req.clinicId;
      const stats = await computeStorageStatsAsync(targetClinic);
      res.json(stats);
    } catch {
      res.status(500).json({ error: 'Unable to calculate storage usage.' });
    }
  });

  app.post('/api/photos/upload', requireClinicOrSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as { patientId?: unknown; dataBase64?: unknown };
    const clinicId = req.clinicId || 'default';
    if (typeof body?.patientId !== 'string' || !SAFE_ID_REGEX.test(body.patientId)) {
      res.status(400).json({ error: 'Invalid patientId.' });
      return;
    }
    if (typeof body?.dataBase64 !== 'string' || body.dataBase64.length === 0) {
      res.status(400).json({ error: 'Missing image payload.' });
      return;
    }

    const strippedBase64 = body.dataBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    if (strippedBase64.length > 2_400_000) {
      res.status(413).json({ error: 'Compressed image exceeds 1.5 MB upload cap.' });
      return;
    }

    const buffer = Buffer.from(strippedBase64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_DECODED_BYTES) {
      res.status(413).json({ error: 'Image size must be between 1 byte and 1.5 MB.' });
      return;
    }

    if (!req.isSuperAdmin && req.storageLimitMb) {
      const currentUsage = await computeStorageStatsAsync(clinicId);
      const limitBytes = req.storageLimitMb * 1024 * 1024;
      if (currentUsage.totalBytes + buffer.length > limitBytes) {
        res.status(413).json({
          error: `Clinic photo storage quota (${req.storageLimitMb} MB) reached. Contact platform admin to upgrade.`,
        });
        return;
      }
    }

    const detected = detectImageType(buffer);
    if (!detected) {
      res.status(400).json({ error: 'Only valid JPEG, PNG, or WebP images are permitted.' });
      return;
    }

    const photoId = crypto.randomUUID().replace(/-/g, '');
    const fileName = `${photoId}.${detected.ext}`;

    if (isB2Configured()) {
      const objectKey = buildTenantObjectKey(clinicId, body.patientId, fileName);
      try {
        await uploadBufferToB2(objectKey, buffer, detected.mimeType);
        res.status(201).json({
          photoId,
          fileName,
          url: `/api/photos/${clinicId}/${body.patientId}/${fileName}`,
          mimeType: detected.mimeType,
          sizeBytes: buffer.length,
        });
      } catch (err) {
        console.error('Backblaze B2 upload error:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'Failed to store image in Backblaze B2 storage.' });
      }
      return;
    }

    const patientDir = resolveTenantPhotoPath(clinicId, body.patientId);
    if (!patientDir) {
      res.status(400).json({ error: 'Invalid storage path.' });
      return;
    }

    const targetPath = resolveTenantPhotoPath(clinicId, body.patientId, fileName);
    if (!targetPath) {
      res.status(400).json({ error: 'Invalid target filename.' });
      return;
    }

    try {
      fs.mkdirSync(patientDir, { recursive: true });
      fs.writeFileSync(targetPath, buffer);
      res.status(201).json({
        photoId,
        fileName,
        url: `/api/photos/${clinicId}/${body.patientId}/${fileName}`,
        mimeType: detected.mimeType,
        sizeBytes: buffer.length,
      });
    } catch {
      res.status(500).json({ error: 'Failed to store image on upload server.' });
    }
  });

  app.get('/api/photos/:clinicId/:patientId/:fileName', requireClinicOrSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const { clinicId, patientId, fileName } = req.params;
    if (!req.isSuperAdmin && req.clinicId !== clinicId) {
      res.status(401).json({ error: 'Cross-clinic photo access denied.' });
      return;
    }
    const targetPath = resolveTenantPhotoPath(clinicId, patientId, fileName);
    if (!targetPath) {
      res.status(400).json({ error: 'Invalid photo path.' });
      return;
    }

    const ext = path.extname(fileName).toLowerCase();
    const contentType =
      ext === '.webp'
        ? 'image/webp'
        : ext === '.png'
          ? 'image/png'
          : 'image/jpeg';

    if (isB2Configured()) {
      try {
        const objectKey = buildTenantObjectKey(clinicId, patientId, fileName);
        const b2Result = await downloadBufferFromB2(objectKey);
        if (b2Result) {
          res.setHeader('Content-Type', contentType);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.send(b2Result.buffer);
          return;
        }
      } catch (err) {
        console.error('Backblaze B2 download error:', err instanceof Error ? err.message : err);
        if (!fs.existsSync(targetPath)) {
          res.status(500).json({ error: 'Unable to retrieve clinical photo from Backblaze B2.' });
          return;
        }
      }
    }

    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Clinical photo not found.' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(targetPath).pipe(res);
  });

  app.delete('/api/photos/:clinicId/:patientId/:fileName', requireClinicOrSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const { clinicId, patientId, fileName } = req.params;
    if (!req.isSuperAdmin && req.clinicId !== clinicId) {
      res.status(401).json({ error: 'Cross-clinic photo deletion denied.' });
      return;
    }
    const targetPath = resolveTenantPhotoPath(clinicId, patientId, fileName);
    if (!targetPath) {
      res.status(400).json({ error: 'Invalid photo path.' });
      return;
    }

    try {
      if (isB2Configured()) {
        const objectKey = buildTenantObjectKey(clinicId, patientId, fileName);
        await deleteObjectFromB2(objectKey);
      }
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      res.json({ deleted: true });
    } catch {
      res.status(500).json({ error: 'Unable to delete photo from storage.' });
    }
  });

  // Legacy 2-segment photo routes (Super Admin backwards compatibility)
  app.get('/api/photos/:patientId/:fileName', requireSuperAdmin, async (req, res) => {
    const { patientId, fileName } = req.params;
    const targetPath = resolveConfinedPath(patientId, fileName);
    if (!targetPath) {
      res.status(400).json({ error: 'Invalid photo path.' });
      return;
    }

    const ext = path.extname(fileName).toLowerCase();
    const contentType =
      ext === '.webp'
        ? 'image/webp'
        : ext === '.png'
          ? 'image/png'
          : 'image/jpeg';

    if (isB2Configured()) {
      try {
        const objectKey = buildLegacyObjectKey(patientId, fileName);
        const b2Result = await downloadBufferFromB2(objectKey);
        if (b2Result) {
          res.setHeader('Content-Type', contentType);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.send(b2Result.buffer);
          return;
        }
      } catch (err) {
        console.error('Backblaze B2 legacy download error:', err instanceof Error ? err.message : err);
        if (!fs.existsSync(targetPath)) {
          res.status(500).json({ error: 'Unable to retrieve clinical photo from Backblaze B2.' });
          return;
        }
      }
    }

    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Clinical photo not found.' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(targetPath).pipe(res);
  });

  app.delete('/api/photos/:patientId/:fileName', requireSuperAdmin, async (req, res) => {
    const { patientId, fileName } = req.params;
    const targetPath = resolveConfinedPath(patientId, fileName);
    if (!targetPath) {
      res.status(400).json({ error: 'Invalid photo path.' });
      return;
    }

    try {
      if (isB2Configured()) {
        const objectKey = buildLegacyObjectKey(patientId, fileName);
        await deleteObjectFromB2(objectKey);
      }
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      res.json({ deleted: true });
    } catch {
      res.status(500).json({ error: 'Unable to delete photo from storage.' });
    }
  });

  app.post('/api/repertory/quick-search', requireClinicOrSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as {
      query?: unknown;
      savedEntries?: unknown;
      language?: unknown;
    };

    const lang = body?.language === 'bn' ? 'bn' : 'en';
    const rawQuery = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!rawQuery || rawQuery.length > 400) {
      res.status(400).json({
        error:
          lang === 'bn'
            ? 'অনুগ্রহ করে ১ থেকে ৪০০ অক্ষরের মধ্যে লক্ষণের বিবরণ লিখুন।'
            : 'Please enter between 1 and 400 characters of symptom keywords.',
      });
      return;
    }

    const sanitizedSavedEntries = Array.isArray(body?.savedEntries)
      ? body.savedEntries
          .slice(0, 40)
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const rec = item as Record<string, unknown>;
            const id = typeof rec.id === 'string' ? rec.id.trim().slice(0, 128) : '';
            const rubric = typeof rec.rubric === 'string' ? rec.rubric.trim().slice(0, 200) : '';
            const primaryRemedy =
              typeof rec.primaryRemedy === 'string' ? rec.primaryRemedy.trim().slice(0, 120) : '';
            const chapter = normalizeChapter(rec.chapter);
            if (!id || !rubric || !primaryRemedy) return null;
            return { id, chapter, rubric, primaryRemedy };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
      : [];

    const validSavedIds = new Set(sanitizedSavedEntries.map((item) => item.id));

    // Fast deterministic keyword overlap against saved clinic rubrics
    const queryTokens = rawQuery
      .toLowerCase()
      .split(/[\s,.;:!?/()]+/)
      .filter((tok) => tok.length >= 2);
    const scoredSavedEntries = sanitizedSavedEntries
      .map((entry) => {
        const haystack = `${entry.rubric} ${entry.primaryRemedy} ${entry.chapter}`.toLowerCase();
        let score = 0;
        for (const tok of queryTokens) {
          if (haystack.includes(tok)) score += 1;
        }
        return { entry, score };
      })
      .sort((a, b) => b.score - a.score);

    const localMatchedIds = scoredSavedEntries
      .filter((item) => item.score > 0)
      .slice(0, 5)
      .map((item) => item.entry.id);

    const compactPromptEntries = scoredSavedEntries
      .slice(0, 15)
      .map((item) => ({
        id: item.entry.id,
        rubric: item.entry.rubric,
        primaryRemedy: item.entry.primaryRemedy,
      }));

    const cacheKey = `${lang}:${rawQuery.toLowerCase()}`;
    const cached = quickSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({
        interpretedSymptoms: cached.interpretedSymptoms,
        matchedSavedEntryIds: localMatchedIds,
        suggestions: cached.suggestions,
      });
      return;
    }

    try {
      const ai = getGenAiClient();

      const languageInstruction =
        lang === 'bn'
          ? 'Write interpretedSymptoms, rubric, modalities, and rationale in clear natural Bengali (বাংলা) clinical homeopathic language. Keep primaryRemedy and differentialRemedies as exact standard Latin remedy names (e.g. Arsenicum album), and keep chapter strictly as one of the exact English enum values.'
          : 'Write all descriptive fields in concise clinical English, keeping primaryRemedy and differentialRemedies as exact standard Latin remedy names.';

      const prompt = [
        `Query (English or Bangla): "${rawQuery}"`,
        `Output language: ${lang === 'bn' ? 'Bengali (বাংলা)' : 'English'}`,
        compactPromptEntries.length > 0
          ? `Clinic rubrics:\n${JSON.stringify(compactPromptEntries)}`
          : '',
        'Return:',
        '1. interpretedSymptoms: 1 short sentence.',
        '2. matchedSavedEntryIds: matching clinic rubric IDs (up to 4).',
        '3. suggestions: up to 3 classical repertory rubrics with exact Latin primaryRemedy, primaryGrade (1-3), up to 3 differentialItems ({remedy, grade}), concise modalities (< / >), and 1-sentence rationale.',
        languageInstruction,
      ]
        .filter(Boolean)
        .join('\n');

      const timeoutMessage =
        lang === 'bn'
          ? 'রেপার্টরি অনুসন্ধানে বেশি সময় লাগছে। অনুগ্রহ করে আবার চেষ্টা করুন অথবা সংক্ষিপ্ত লক্ষণ লিখুন।'
          : 'Repertory search timed out. Please try again with shorter symptom keywords.';

      const response = await withTimeout(
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              `You are a fast chairside homeopathic repertory assistant. Map symptom queries (in English or Bangla) to up to 3 concise classical repertory rubrics, Latin remedies with Kent grade (1-3), < / > modalities, and 1-sentence differentiation. Keep chapter strictly one of: Mind, Head & Vertigo, Respiratory, Gastrointestinal, Skin, Musculoskeletal, Sleep & Dreams, Generalities. Plain text inside JSON without markdown. ${languageInstruction}`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                interpretedSymptoms: {
                  type: Type.STRING,
                  description:
                    'One concise sentence translating the search keywords into classical clinical repertory concepts.',
                },
                matchedSavedEntryIds: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    'IDs from the provided clinic repertory rubrics that match the query clinically, ordered by relevance.',
                },
                suggestions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      chapter: {
                        type: Type.STRING,
                        description:
                          'One of: Mind, Head & Vertigo, Respiratory, Gastrointestinal, Skin, Musculoskeletal, Sleep & Dreams, Generalities.',
                      },
                      rubric: {
                        type: Type.STRING,
                        description: 'Concise classical repertory symptom rubric under 180 characters.',
                      },
                      primaryRemedy: {
                        type: Type.STRING,
                        description: 'Primary indicated classical Latin remedy name.',
                      },
                      primaryGrade: {
                        type: Type.INTEGER,
                        description:
                          'Classical repertory severity/potency grade for primaryRemedy: 3 (highest keynote), 2 (moderate), or 1 (mild).',
                      },
                      differentialItems: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            remedy: {
                              type: Type.STRING,
                              description: 'Classical Latin differential remedy name.',
                            },
                            grade: {
                              type: Type.INTEGER,
                              description:
                                'Classical repertory grade for this symptom: 3 (high), 2 (moderate), or 1 (mild).',
                            },
                          },
                        },
                        description: 'Up to 3 closely indicated differential remedies with their repertory grade (1-3).',
                      },
                      modalities: {
                        type: Type.STRING,
                        description: 'Modalities formatted concisely with < worse and > better.',
                      },
                      rationale: {
                        type: Type.STRING,
                        description: 'One concise sentence explaining why these remedies match.',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        25_000,
        timeoutMessage
      );

      const parsed = parseGeminiJsonResponse<{
        interpretedSymptoms?: unknown;
        matchedSavedEntryIds?: unknown;
        suggestions?: unknown[];
      }>(response.text);

      const interpretedSymptoms =
        typeof parsed.interpretedSymptoms === 'string' && parsed.interpretedSymptoms.trim()
          ? parsed.interpretedSymptoms.trim().slice(0, 400)
          : `Clinical repertory matches for "${rawQuery}"`;

      const aiMatchedIds = Array.isArray(parsed.matchedSavedEntryIds)
        ? parsed.matchedSavedEntryIds.filter(
            (id): id is string => typeof id === 'string' && validSavedIds.has(id)
          )
        : [];
      const matchedSavedEntryIds = Array.from(
        new Set([...aiMatchedIds, ...localMatchedIds])
      ).slice(0, 5);

      const clampGrade = (val: unknown, fallback: 1 | 2 | 3): 1 | 2 | 3 => {
        if (typeof val === 'number' && Number.isFinite(val)) {
          const rounded = Math.round(val);
          if (rounded >= 3) return 3;
          if (rounded === 2) return 2;
          if (rounded <= 1) return 1;
        }
        return fallback;
      };

      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions
            .slice(0, 3)
            .map((raw) => {
              if (!raw || typeof raw !== 'object') return null;
              const s = raw as Record<string, unknown>;
              const rubric = typeof s.rubric === 'string' ? s.rubric.trim().slice(0, 240) : '';
              const primaryRemedy =
                typeof s.primaryRemedy === 'string' ? s.primaryRemedy.trim().slice(0, 160) : '';
              if (!rubric || !primaryRemedy) return null;

              const primaryGrade = clampGrade(s.primaryGrade, 3);
              const remedyGrades: Record<string, 1 | 2 | 3> = {
                [primaryRemedy.toLowerCase()]: primaryGrade,
              };

              const rawDiffItems = Array.isArray(s.differentialItems)
                ? s.differentialItems
                : Array.isArray(s.differentialRemedies)
                  ? s.differentialRemedies
                  : [];
              const seenRem = new Set<string>([primaryRemedy.toLowerCase()]);
              const differentialRemedies: string[] = [];

              for (const item of rawDiffItems) {
                let remName = '';
                let remGrade: 1 | 2 | 3 = 2;

                if (typeof item === 'string') {
                  remName = item.trim().slice(0, 160);
                } else if (item && typeof item === 'object') {
                  const obj = item as Record<string, unknown>;
                  if (typeof obj.remedy === 'string') {
                    remName = obj.remedy.trim().slice(0, 160);
                  }
                  remGrade = clampGrade(obj.grade, 2);
                }

                if (!remName || seenRem.has(remName.toLowerCase())) continue;
                seenRem.add(remName.toLowerCase());
                differentialRemedies.push(remName);
                remedyGrades[remName.toLowerCase()] = remGrade;
                if (differentialRemedies.length >= 4) break;
              }

              const modalities =
                typeof s.modalities === 'string' ? s.modalities.trim().slice(0, 500) : '';
              const rationale =
                typeof s.rationale === 'string' ? s.rationale.trim().slice(0, 600) : '';

              return {
                chapter: normalizeChapter(s.chapter),
                rubric,
                primaryRemedy,
                primaryGrade,
                differentialRemedies,
                remedyGrades,
                modalities,
                rationale,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
        : [];

      if (suggestions.length > 0) {
        if (quickSearchCache.size >= 100) {
          const firstKey = quickSearchCache.keys().next().value;
          if (firstKey) quickSearchCache.delete(firstKey);
        }
        quickSearchCache.set(cacheKey, {
          expiresAt: Date.now() + QUICK_SEARCH_CACHE_TTL_MS,
          interpretedSymptoms,
          suggestions,
        });
      }

      res.json({
        interpretedSymptoms,
        matchedSavedEntryIds,
        suggestions,
      });
    } catch (error) {
      const mapped = mapGeminiError(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post('/api/repertory/compare', requireClinicOrSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as {
      remedyA?: unknown;
      remedyB?: unknown;
      clinicalContext?: unknown;
      language?: unknown;
    };

    const lang = body?.language === 'bn' ? 'bn' : 'en';
    const remedyA = typeof body?.remedyA === 'string' ? body.remedyA.trim().slice(0, 160) : '';
    const remedyB = typeof body?.remedyB === 'string' ? body.remedyB.trim().slice(0, 160) : '';
    const clinicalContext =
      typeof body?.clinicalContext === 'string' ? body.clinicalContext.trim().slice(0, 300) : '';

    if (!remedyA || !remedyB) {
      res.status(400).json({
        error:
          lang === 'bn'
            ? 'তুলনা করার জন্য দুটি হোমিওপ্যাথিক রেমেডি নির্বাচন বা লিখুন।'
            : 'Please select or enter two homeopathic remedies to compare.',
      });
      return;
    }

    if (remedyA.toLowerCase() === remedyB.toLowerCase()) {
      res.status(400).json({
        error:
          lang === 'bn'
            ? 'পাশাপাশি তুলনার জন্য দুটি ভিন্ন রেমেডি নির্বাচন করুন।'
            : 'Please choose two different remedies for a side-by-side comparison.',
      });
      return;
    }

    try {
      const ai = getGenAiClient();

      const languageInstruction =
        lang === 'bn'
          ? 'Write differentiationSummary, dimension, remedyAValue, remedyBValue, and keyContrast in clear natural Bengali (বাংলা) clinical homeopathic language. Keep remedyA and remedyB in canonical Latin remedy names.'
          : 'Write all clinical differentiation fields in concise clinical English, keeping remedyA and remedyB in canonical Latin remedy names.';

      const prompt = [
        `Compare these two classical homeopathic remedies side by side:`,
        `Remedy A: "${remedyA}"`,
        `Remedy B: "${remedyB}"`,
        `Preferred output language: ${lang === 'bn' ? 'Bengali (বাংলা)' : 'English'}`,
        clinicalContext
          ? `Clinical focus / presenting complaint: "${clinicalContext}"`
          : 'Clinical focus: General constitutional and acute Materia Medica differentiation.',
        '',
        'Provide 6 structured side-by-side rows covering:',
        '1. Thermal State & Pace',
        '2. Mental & Emotional Picture',
        '3. Key Modalities (< Worse / > Better)',
        '4. Physical Generals & Cravings',
        '5. Characteristic Pathology & Tissue Affinity',
        '6. Decisive Guiding Keynote',
        languageInstruction,
      ].join('\n');

      const response = await withTimeout(
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              `You are a classical homeopathic Materia Medica differentiation assistant for a licensed practitioner. Produce an accurate, concise side-by-side clinical comparison between two homeopathic remedies, emphasizing practical chairside differences rather than generic overlap. Output plain text inside JSON fields without markdown formatting. ${languageInstruction}`,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                remedyA: {
                  type: Type.STRING,
                  description: 'Canonical classical Latin name for the first remedy.',
                },
                remedyB: {
                  type: Type.STRING,
                  description: 'Canonical classical Latin name for the second remedy.',
                },
                differentiationSummary: {
                  type: Type.STRING,
                  description:
                    'Concise 1-2 sentence clinical summary explaining the core dividing line between the two remedies.',
                },
                rows: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      dimension: {
                        type: Type.STRING,
                        description: 'The clinical comparison axis name.',
                      },
                      remedyAValue: {
                        type: Type.STRING,
                        description: 'Concise presentation for Remedy A on this dimension (1-2 sentences).',
                      },
                      remedyBValue: {
                        type: Type.STRING,
                        description: 'Concise presentation for Remedy B on this dimension (1-2 sentences).',
                      },
                      keyContrast: {
                        type: Type.STRING,
                        description: 'Short 4-10 word takeaway contrasting the two remedies on this row.',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        20_000,
        lang === 'bn'
          ? 'রেমেডি তুলনায় বেশি সময় লাগছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
          : 'Remedy comparison timed out. Please try again.'
      );

      const parsed = parseGeminiJsonResponse<{
        remedyA?: unknown;
        remedyB?: unknown;
        differentiationSummary?: unknown;
        rows?: unknown[];
      }>(response.text);

      const normalizedA =
        typeof parsed.remedyA === 'string' && parsed.remedyA.trim()
          ? parsed.remedyA.trim().slice(0, 160)
          : remedyA;
      const normalizedB =
        typeof parsed.remedyB === 'string' && parsed.remedyB.trim()
          ? parsed.remedyB.trim().slice(0, 160)
          : remedyB;
      const differentiationSummary =
        typeof parsed.differentiationSummary === 'string' && parsed.differentiationSummary.trim()
          ? parsed.differentiationSummary.trim().slice(0, 600)
          : `Clinical differentiation between ${normalizedA} and ${normalizedB}.`;

      const rows = Array.isArray(parsed.rows)
        ? parsed.rows
            .slice(0, 8)
            .map((raw) => {
              if (!raw || typeof raw !== 'object') return null;
              const r = raw as Record<string, unknown>;
              const dimension = typeof r.dimension === 'string' ? r.dimension.trim().slice(0, 120) : '';
              const remedyAValue =
                typeof r.remedyAValue === 'string' ? r.remedyAValue.trim().slice(0, 450) : '';
              const remedyBValue =
                typeof r.remedyBValue === 'string' ? r.remedyBValue.trim().slice(0, 450) : '';
              const keyContrast =
                typeof r.keyContrast === 'string' ? r.keyContrast.trim().slice(0, 180) : '';
              if (!dimension || !remedyAValue || !remedyBValue) return null;
              return { dimension, remedyAValue, remedyBValue, keyContrast };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
        : [];

      if (rows.length === 0) {
        res.status(422).json({
          error: 'Unable to parse structured comparison rows from Gemini response.',
        });
        return;
      }

      res.json({
        remedyA: normalizedA,
        remedyB: normalizedB,
        differentiationSummary,
        rows,
      });
    } catch (error) {
      const mapped = mapGeminiError(error);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post(
    '/api/patients/constitutional-map',
    requireClinicOrSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as {
        patientContext?: unknown;
        clinicalNotes?: unknown;
        consultationNotes?: unknown;
        language?: unknown;
      };

      const lang = body?.language === 'bn' ? 'bn' : 'en';

      const ctxRaw =
        body?.patientContext && typeof body.patientContext === 'object'
          ? (body.patientContext as Record<string, unknown>)
          : {};

      const patientContext = {
        age: typeof ctxRaw.age === 'number' && Number.isFinite(ctxRaw.age) ? ctxRaw.age : undefined,
        gender: typeof ctxRaw.gender === 'string' ? ctxRaw.gender.trim().slice(0, 32) : '',
        chiefComplaint:
          typeof ctxRaw.chiefComplaint === 'string'
            ? ctxRaw.chiefComplaint.trim().slice(0, 500)
            : '',
        thermalState:
          typeof ctxRaw.thermalState === 'string' ? ctxRaw.thermalState.trim().slice(0, 32) : '',
        constitutionNotes:
          typeof ctxRaw.constitutionNotes === 'string'
            ? ctxRaw.constitutionNotes.trim().slice(0, 2000)
            : '',
        allergies:
          typeof ctxRaw.allergies === 'string' ? ctxRaw.allergies.trim().slice(0, 500) : '',
      };

      const sanitizedClinicalNotes = Array.isArray(body?.clinicalNotes)
        ? body.clinicalNotes
            .slice(0, 40)
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const rec = item as Record<string, unknown>;
              const observedDate =
                typeof rec.observedDate === 'string' ? rec.observedDate.trim().slice(0, 32) : '';
              const focusArea =
                typeof rec.focusArea === 'string' ? rec.focusArea.trim().slice(0, 64) : '';
              const content =
                typeof rec.content === 'string' ? rec.content.trim().slice(0, 2000) : '';
              if (!content) return null;
              return { observedDate, focusArea, content };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
        : [];

      const sanitizedConsultations = Array.isArray(body?.consultationNotes)
        ? body.consultationNotes
            .slice(0, 15)
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const rec = item as Record<string, unknown>;
              const visitDate =
                typeof rec.visitDate === 'string' ? rec.visitDate.trim().slice(0, 32) : '';
              const presentingSymptoms =
                typeof rec.presentingSymptoms === 'string'
                  ? rec.presentingSymptoms.trim().slice(0, 800)
                  : '';
              const mentalGenerals =
                typeof rec.mentalGenerals === 'string'
                  ? rec.mentalGenerals.trim().slice(0, 600)
                  : '';
              const physicalGenerals =
                typeof rec.physicalGenerals === 'string'
                  ? rec.physicalGenerals.trim().slice(0, 600)
                  : '';
              const modalitiesWorse =
                typeof rec.modalitiesWorse === 'string'
                  ? rec.modalitiesWorse.trim().slice(0, 300)
                  : '';
              const modalitiesBetter =
                typeof rec.modalitiesBetter === 'string'
                  ? rec.modalitiesBetter.trim().slice(0, 300)
                  : '';
              const clinicalNotes =
                typeof rec.clinicalNotes === 'string'
                  ? rec.clinicalNotes.trim().slice(0, 800)
                  : '';
              const remedyName =
                typeof rec.remedyName === 'string' ? rec.remedyName.trim().slice(0, 160) : '';
              if (
                !presentingSymptoms &&
                !mentalGenerals &&
                !physicalGenerals &&
                !clinicalNotes
              ) {
                return null;
              }
              return {
                visitDate,
                remedyName,
                presentingSymptoms,
                mentalGenerals,
                physicalGenerals,
                modalitiesWorse,
                modalitiesBetter,
                clinicalNotes,
              };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
        : [];

      if (
        sanitizedClinicalNotes.length === 0 &&
        sanitizedConsultations.length === 0 &&
        !patientContext.constitutionNotes
      ) {
        res.status(400).json({
          error:
            lang === 'bn'
              ? 'ধাতুগত থিম বিশ্লেষণের জন্য অনুগ্রহ করে অন্তত একটি ক্লিনিক্যাল নোট বা ভিজিট পর্যবেক্ষণ যুক্ত করুন।'
              : 'Please record at least one clinical note or consultation observation before mapping constitutional themes.',
        });
        return;
      }

      const VALID_CATEGORIES = [
        'Mental & Emotional',
        'Thermal & Physical',
        'Miasmatic Tendency',
        'Modality & Rhythm',
      ] as const;

      const normalizeCategory = (val: unknown): (typeof VALID_CATEGORIES)[number] => {
        if (typeof val === 'string') {
          const match = VALID_CATEGORIES.find(
            (cat) => cat.toLowerCase() === val.trim().toLowerCase()
          );
          if (match) return match;
        }
        return 'Mental & Emotional';
      };

      const normalizeConfidence = (val: unknown): 'high' | 'moderate' | 'emerging' => {
        if (typeof val === 'string') {
          const lower = val.trim().toLowerCase();
          if (lower === 'high') return 'high';
          if (lower === 'emerging') return 'emerging';
        }
        return 'moderate';
      };

      try {
        const ai = getGenAiClient();

        const languageInstruction =
          lang === 'bn'
            ? 'Write overallSummary, theme, supportingEvidence, keyTendencies, and recommendedQuestions in clear, natural Bengali (বাংলা) homeopathic clinical language. Keep category strictly as one of the exact English enum values ("Mental & Emotional", "Thermal & Physical", "Miasmatic Tendency", "Modality & Rhythm"), confidence strictly as "high" | "moderate" | "emerging", and candidateRemedies in standard Latin names (e.g. Natrum muriaticum).'
            : 'Write all clinical text in concise classical homeopathic English, keeping candidateRemedies in standard Latin names and category/confidence strictly as the specified enum values.';

        const prompt = [
          'Analyze the following anonymized patient clinical notes, baseline constitutional state, and case observations to map likely classical homeopathic constitutional themes and tendencies.',
          `Preferred output language: ${lang === 'bn' ? 'Bengali (বাংলা)' : 'English'}`,
          '',
          `Patient Baseline Context (JSON):\n${JSON.stringify(patientContext)}`,
          '',
          sanitizedClinicalNotes.length > 0
            ? `Dated Clinical Notes (JSON):\n${JSON.stringify(sanitizedClinicalNotes)}`
            : 'Dated Clinical Notes: none recorded yet.',
          '',
          sanitizedConsultations.length > 0
            ? `Consultation Case-Taking Observations (JSON):\n${JSON.stringify(sanitizedConsultations)}`
            : 'Consultation Case-Taking Observations: none included.',
          '',
          'Task:',
          '1. Synthesize an overallSummary (2-3 sentences) highlighting the dominant constitutional axis, temperament, and thermal/miasmatic pattern.',
          '2. Identify 3 to 6 distinct constitutionalThemes supported by the notes, classifying each into one of: "Mental & Emotional", "Thermal & Physical", "Miasmatic Tendency", or "Modality & Rhythm", with confidence ("high", "moderate", or "emerging"), specific supportingEvidence from the notes, 2-4 concise keyTendencies, and 1-3 classical Latin candidateRemedies.',
          '3. Suggest 2-4 targeted follow-up case-taking questions (recommendedQuestions) to verify or refine the constitutional totality on the next visit.',
          languageInstruction,
        ].join('\n');

        const response = await withTimeout(
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: prompt,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              systemInstruction:
                `You are a classical homeopathic case-analysis assistant supporting a licensed homeopathic practitioner. Analyze unstructured clinical notes and case-taking records to extract underlying constitutional themes, miasmatic tendencies, thermal/modality patterns, and candidate constitutional remedies. Never invent observations not grounded in the provided notes; clearly mark less corroborated hypotheses as "emerging". Output plain text inside JSON fields without markdown symbols. ${languageInstruction}`,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  overallSummary: {
                    type: Type.STRING,
                    description:
                      'Concise 2-3 sentence synthesis of the patient constitutional picture.',
                  },
                  constitutionalThemes: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        theme: {
                          type: Type.STRING,
                          description:
                            'Concise title of the constitutional theme or tendency (under 100 chars).',
                        },
                        category: {
                          type: Type.STRING,
                          description:
                            'Strictly one of: Mental & Emotional, Thermal & Physical, Miasmatic Tendency, Modality & Rhythm.',
                        },
                        confidence: {
                          type: Type.STRING,
                          description: 'Strictly one of: high, moderate, emerging.',
                        },
                        supportingEvidence: {
                          type: Type.STRING,
                          description:
                            '1-2 sentences referencing specific cues or patterns from the clinical notes.',
                        },
                        keyTendencies: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                          description: '2-4 short clinical tendency phrases.',
                        },
                        candidateRemedies: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                          description:
                            '1-3 classical Latin homeopathic remedies associated with this constitutional pattern.',
                        },
                      },
                    },
                  },
                  recommendedQuestions: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description:
                      '2-4 clarifying follow-up questions for the practitioner to ask on the next visit.',
                  },
                },
              },
            },
          }),
          22_000,
          lang === 'bn'
            ? 'ধাতুগত বিশ্লেষণে বেশি সময় লাগছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
            : 'Constitutional analysis timed out. Please try again.'
        );

        const parsed = parseGeminiJsonResponse<{
          overallSummary?: unknown;
          constitutionalThemes?: unknown[];
          recommendedQuestions?: unknown[];
        }>(response.text);

        const overallSummary =
          typeof parsed.overallSummary === 'string' && parsed.overallSummary.trim()
            ? parsed.overallSummary.trim().slice(0, 1000)
            : lang === 'bn'
              ? 'উপলব্ধ ক্লিনিক্যাল নোটের ভিত্তিতে ধাতুগত প্রবণতা বিশ্লেষণ সম্পন্ন হয়েছে।'
              : 'Constitutional pattern synthesis completed from available clinical observations.';

        const constitutionalThemes = Array.isArray(parsed.constitutionalThemes)
          ? parsed.constitutionalThemes
              .slice(0, 6)
              .map((raw) => {
                if (!raw || typeof raw !== 'object') return null;
                const item = raw as Record<string, unknown>;
                const theme =
                  typeof item.theme === 'string' ? item.theme.trim().slice(0, 160) : '';
                const supportingEvidence =
                  typeof item.supportingEvidence === 'string'
                    ? item.supportingEvidence.trim().slice(0, 600)
                    : '';
                if (!theme || !supportingEvidence) return null;

                const keyTendencies = Array.isArray(item.keyTendencies)
                  ? item.keyTendencies
                      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                      .slice(0, 5)
                      .map((t) => t.trim().slice(0, 120))
                  : [];

                const candidateRemedies = Array.isArray(item.candidateRemedies)
                  ? item.candidateRemedies
                      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
                      .slice(0, 4)
                      .map((r) => r.trim().slice(0, 160))
                  : [];

                return {
                  theme,
                  category: normalizeCategory(item.category),
                  confidence: normalizeConfidence(item.confidence),
                  supportingEvidence,
                  keyTendencies,
                  candidateRemedies,
                };
              })
              .filter((item): item is NonNullable<typeof item> => item !== null)
          : [];

        const recommendedQuestions = Array.isArray(parsed.recommendedQuestions)
          ? parsed.recommendedQuestions
              .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
              .slice(0, 5)
              .map((q) => q.trim().slice(0, 300))
          : [];

        if (constitutionalThemes.length === 0) {
          res.status(422).json({
            error:
              lang === 'bn'
                ? 'ক্লিনিক্যাল নোট থেকে ধাতুগত থিম তৈরি করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।'
                : 'Unable to extract structured constitutional themes from the response. Please try again.',
          });
          return;
        }

        res.json({
          overallSummary,
          constitutionalThemes,
          recommendedQuestions,
        });
      } catch (error) {
        const mapped = mapGeminiError(error);
        res.status(mapped.status).json({ error: mapped.message });
      }
    }
  );

  app.post(
    '/api/repertory/note-suggestions',
    requireClinicOrSuperAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as {
        text?: unknown;
        focusArea?: unknown;
        language?: unknown;
      };

      const lang = body?.language === 'bn' ? 'bn' : 'en';
      const rawText = typeof body?.text === 'string' ? body.text.trim() : '';
      const focusArea =
        typeof body?.focusArea === 'string' ? body.focusArea.trim().slice(0, 64) : 'General Observation';

      if (rawText.length < 8 || rawText.length > 4000) {
        res.status(400).json({
          error:
            lang === 'bn'
              ? 'রেপার্টরি পরামর্শের জন্য অন্তত ৮টি অক্ষরের পর্যবেক্ষণ লিখুন।'
              : 'Enter at least 8 characters of clinical observation text for repertory suggestions.',
        });
        return;
      }

      // Focus on the most recent ~800 characters being typed so suggestions stay relevant to current thought
      const activeExcerpt = rawText.length > 800 ? rawText.slice(-800) : rawText;

      try {
        const ai = getGenAiClient();

        const languageInstruction =
          lang === 'bn'
            ? 'Write rubric (you may include brief Bengali clinical clarifier alongside classical phrasing) and matchReason in natural Bengali (বাংলা). Keep chapter strictly one of the 8 exact English enum values and keyRemedies strictly in standard Latin remedy names.'
            : 'Write rubric and matchReason in concise classical English repertory style, keeping chapter one of the 8 exact enum values and keyRemedies in standard Latin remedy names.';

        const prompt = [
          `Observation focus area: ${focusArea}`,
          `Preferred output language: ${lang === 'bn' ? 'Bengali (বাংলা)' : 'English'}`,
          `Live clinical note text currently being typed by practitioner:\n"""\n${activeExcerpt}\n"""`,
          '',
          'Task:',
          'Suggest 3 to 5 potential classical homeopathic repertory symptom rubrics that correspond directly to cues in the text currently being typed (even if written informally or partially).',
          'For each suggestion provide:',
          '- chapter: strictly one of Mind, Head & Vertigo, Respiratory, Gastrointestinal, Skin, Musculoskeletal, Sleep & Dreams, Generalities',
          '- rubric: concise Kent/Synthesis-style repertory rubric (under 140 chars)',
          '- keyRemedies: 1 to 3 canonical Latin remedies strongly indicated for that rubric',
          '- matchReason: brief 4-10 word cue linking the typed note to the rubric',
          languageInstruction,
        ].join('\n');

        const response = await withTimeout(
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: prompt,
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              systemInstruction:
                `You are a fast chairside homeopathic repertory auto-suggestion assistant. As the practitioner types unstructured clinical notes (in English or Bengali), suggest matching classical repertory symptom rubrics and top Latin remedies concisely without extra prose. Output plain text inside JSON fields without markdown symbols. ${languageInstruction}`,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  suggestions: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        chapter: {
                          type: Type.STRING,
                          description:
                            'Strictly one of: Mind, Head & Vertigo, Respiratory, Gastrointestinal, Skin, Musculoskeletal, Sleep & Dreams, Generalities.',
                        },
                        rubric: {
                          type: Type.STRING,
                          description: 'Classical homeopathic repertory symptom rubric.',
                        },
                        keyRemedies: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                          description: '1 to 3 canonical Latin remedies for this rubric.',
                        },
                        matchReason: {
                          type: Type.STRING,
                          description: 'Short cue explaining why this rubric matches the typed note.',
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
          15_000,
          lang === 'bn'
            ? 'নোট পরামর্শে সময় বেশি লাগছে।'
            : 'Note suggestion request timed out.'
        );

        const parsed = parseGeminiJsonResponse<{ suggestions?: unknown[] }>(response.text);

        const suggestions = Array.isArray(parsed.suggestions)
          ? parsed.suggestions
              .slice(0, 5)
              .map((raw) => {
                if (!raw || typeof raw !== 'object') return null;
                const item = raw as Record<string, unknown>;
                const rubric =
                  typeof item.rubric === 'string' ? item.rubric.trim().slice(0, 200) : '';
                if (!rubric) return null;

                const keyRemedies = Array.isArray(item.keyRemedies)
                  ? item.keyRemedies
                      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
                      .slice(0, 4)
                      .map((r) => r.trim().slice(0, 120))
                  : [];

                const matchReason =
                  typeof item.matchReason === 'string'
                    ? item.matchReason.trim().slice(0, 160)
                    : '';

                return {
                  chapter: normalizeChapter(item.chapter),
                  rubric,
                  keyRemedies,
                  matchReason,
                };
              })
              .filter((item): item is NonNullable<typeof item> => item !== null)
          : [];

        res.json({ suggestions });
      } catch (error) {
        const mapped = mapGeminiError(error);
        res.status(mapped.status).json({ error: mapped.message });
      }
    }
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      const errObj = err as { status?: number; statusCode?: number; message?: string };
      const status = errObj?.statusCode || errObj?.status || 500;
      res.status(status).json({
        error: errObj?.message || 'Unexpected server error while processing API request.',
      });
      return;
    }
    next(err);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Materia Medica Clinic server listening on port ${PORT}`);
  });
}

startServer();
