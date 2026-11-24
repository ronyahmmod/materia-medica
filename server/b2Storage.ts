import crypto from 'node:crypto';

export interface B2Config {
  keyId: string;
  applicationKey: string;
  bucketName: string;
  bucketId: string;
  keyPrefix: string;
}

interface B2AuthSession {
  accountId: string;
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  bucketId: string;
  bucketName: string;
  expiresAt: number;
}

export interface B2StorageStats {
  totalFiles: number;
  totalBytes: number;
}

export interface B2StorageBreakdown {
  totalFiles: number;
  totalBytes: number;
  byClinic: Record<string, B2StorageStats>;
  legacyStats: B2StorageStats;
}

interface B2ObjectEntry {
  fileName: string;
  size: number;
}

const AUTH_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (B2 tokens remain valid up to 24 hours)
const STATS_CACHE_TTL_MS = 120 * 1000; // 2 minutes to conserve free Class C transactions

let cachedAuthSession: B2AuthSession | null = null;
let pendingAuthPromise: Promise<B2AuthSession> | null = null;
let cachedObjectList: { expiresAt: number; entries: B2ObjectEntry[] } | null = null;
let pendingStatsPromise: Promise<B2ObjectEntry[]> | null = null;

function sanitizePrefix(raw: string | undefined): string {
  const cleaned = (raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!cleaned || cleaned.includes('..')) return '';
  return `${cleaned}/`;
}

export function getB2Config(): B2Config | null {
  const keyId = (process.env.B2_KEY_ID || '').trim();
  const applicationKey = (process.env.B2_APPLICATION_KEY || '').trim();
  const bucketName = (process.env.B2_BUCKET_NAME || '').trim();
  const bucketId = (process.env.B2_BUCKET_ID || '').trim();
  const keyPrefix = sanitizePrefix(process.env.B2_KEY_PREFIX);

  if (!keyId || !applicationKey || !bucketName) {
    return null;
  }

  return {
    keyId,
    applicationKey,
    bucketName,
    bucketId,
    keyPrefix,
  };
}

export function isB2Configured(): boolean {
  return getB2Config() !== null;
}

export function getB2BucketNameForHealth(): string | null {
  return getB2Config()?.bucketName || null;
}

export function buildTenantObjectKey(clinicId: string, patientId: string, fileName: string): string {
  const prefix = getB2Config()?.keyPrefix || '';
  return `${prefix}tenant_${clinicId}/${patientId}/${fileName}`;
}

export function buildLegacyObjectKey(patientId: string, fileName: string): string {
  const prefix = getB2Config()?.keyPrefix || '';
  return `${prefix}${patientId}/${fileName}`;
}

function encodeB2Path(objectKey: string): string {
  return objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function clearAuthCache(): void {
  cachedAuthSession = null;
}

export function invalidateB2StatsCache(): void {
  cachedObjectList = null;
}

async function authorizeB2Account(forceRefresh = false): Promise<B2AuthSession> {
  const cfg = getB2Config();
  if (!cfg) {
    throw new Error('Backblaze B2 credentials are not configured on the server.');
  }

  if (!forceRefresh && cachedAuthSession && cachedAuthSession.expiresAt > Date.now()) {
    return cachedAuthSession;
  }

  if (pendingAuthPromise && !forceRefresh) {
    return pendingAuthPromise;
  }

  const runAuth = async (): Promise<B2AuthSession> => {
    const basicCreds = Buffer.from(`${cfg.keyId}:${cfg.applicationKey}`).toString('base64');
    const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basicCreds}`,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!authRes.ok) {
      throw new Error(`Backblaze B2 authentication failed (HTTP ${authRes.status}).`);
    }

    const authJson = (await authRes.json()) as {
      accountId: string;
      authorizationToken: string;
      apiUrl: string;
      downloadUrl: string;
      allowed?: {
        bucketId?: string | null;
        bucketName?: string | null;
      };
    };

    let resolvedBucketId = cfg.bucketId || authJson.allowed?.bucketId || '';
    const resolvedBucketName = authJson.allowed?.bucketName || cfg.bucketName;

    if (!resolvedBucketId) {
      const listBucketsRes = await fetch(`${authJson.apiUrl}/b2api/v2/b2_list_buckets`, {
        method: 'POST',
        headers: {
          Authorization: authJson.authorizationToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accountId: authJson.accountId,
          bucketName: cfg.bucketName,
        }),
        signal: AbortSignal.timeout(12_000),
      });

      if (!listBucketsRes.ok) {
        throw new Error(`Unable to resolve Backblaze B2 bucket ID (HTTP ${listBucketsRes.status}).`);
      }

      const bucketsJson = (await listBucketsRes.json()) as {
        buckets?: Array<{ bucketId: string; bucketName: string }>;
      };
      const match = bucketsJson.buckets?.find((b) => b.bucketName === cfg.bucketName);
      if (!match) {
        throw new Error(`Backblaze B2 bucket "${cfg.bucketName}" was not found for this key.`);
      }
      resolvedBucketId = match.bucketId;
    }

    const session: B2AuthSession = {
      accountId: authJson.accountId,
      authorizationToken: authJson.authorizationToken,
      apiUrl: authJson.apiUrl.replace(/\/+$/, ''),
      downloadUrl: authJson.downloadUrl.replace(/\/+$/, ''),
      bucketId: resolvedBucketId,
      bucketName: resolvedBucketName,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    };

    cachedAuthSession = session;
    return session;
  };

  pendingAuthPromise = runAuth().finally(() => {
    pendingAuthPromise = null;
  });

  return pendingAuthPromise;
}

async function fetchUploadUrl(session: B2AuthSession): Promise<{
  uploadUrl: string;
  authorizationToken: string;
}> {
  const res = await fetch(`${session.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: {
      Authorization: session.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bucketId: session.bucketId }),
    signal: AbortSignal.timeout(12_000),
  });

  if (res.status === 401) {
    clearAuthCache();
    const freshSession = await authorizeB2Account(true);
    const retryRes = await fetch(`${freshSession.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: 'POST',
      headers: {
        Authorization: freshSession.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bucketId: freshSession.bucketId }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!retryRes.ok) {
      throw new Error(`Backblaze B2 upload URL request failed (HTTP ${retryRes.status}).`);
    }
    return (await retryRes.json()) as { uploadUrl: string; authorizationToken: string };
  }

  if (!res.ok) {
    throw new Error(`Backblaze B2 upload URL request failed (HTTP ${res.status}).`);
  }

  return (await res.json()) as { uploadUrl: string; authorizationToken: string };
}

export async function uploadBufferToB2(
  objectKey: string,
  buffer: Buffer,
  mimeType: string
): Promise<void> {
  const sha1Hex = crypto.createHash('sha1').update(buffer).digest('hex');
  const encodedKey = encodeB2Path(objectKey);
  const bodyBytes = new Uint8Array(buffer);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const session = await authorizeB2Account(attempt > 0);
      const uploadTarget = await fetchUploadUrl(session);

      const uploadRes = await fetch(uploadTarget.uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: uploadTarget.authorizationToken,
          'X-Bz-File-Name': encodedKey,
          'Content-Type': mimeType,
          'Content-Length': String(buffer.length),
          'X-Bz-Content-Sha1': sha1Hex,
        },
        body: bodyBytes,
        signal: AbortSignal.timeout(25_000),
      });

      if (uploadRes.ok) {
        if (cachedObjectList) {
          cachedObjectList.entries.push({ fileName: objectKey, size: buffer.length });
        }
        return;
      }

      if (uploadRes.status === 401) {
        clearAuthCache();
      }
      if ([401, 408, 429, 500, 503].includes(uploadRes.status) && attempt < 2) {
        lastError = new Error(`Backblaze B2 upload transient HTTP ${uploadRes.status}`);
        continue;
      }
      throw new Error(`Backblaze B2 upload failed (HTTP ${uploadRes.status}).`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 2) break;
    }
  }

  throw lastError || new Error('Backblaze B2 upload failed.');
}

export async function downloadBufferFromB2(
  objectKey: string
): Promise<{ buffer: Buffer; contentType: string | null } | null> {
  const encodedKey = encodeB2Path(objectKey);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await authorizeB2Account(attempt > 0);
    const targetUrl = `${session.downloadUrl}/file/${encodeURIComponent(session.bucketName)}/${encodedKey}`;

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: session.authorizationToken,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401 && attempt === 0) {
      clearAuthCache();
      continue;
    }

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new Error(`Backblaze B2 download failed (HTTP ${res.status}).`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type'),
    };
  }

  return null;
}

export async function deleteObjectFromB2(objectKey: string): Promise<void> {
  let session = await authorizeB2Account();

  const listVersions = async (activeSession: B2AuthSession) => {
    return fetch(`${activeSession.apiUrl}/b2api/v2/b2_list_file_versions`, {
      method: 'POST',
      headers: {
        Authorization: activeSession.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bucketId: activeSession.bucketId,
        startFileName: objectKey,
        prefix: objectKey,
        maxFileCount: 50,
      }),
      signal: AbortSignal.timeout(12_000),
    });
  };

  let listRes = await listVersions(session);
  if (listRes.status === 401) {
    clearAuthCache();
    session = await authorizeB2Account(true);
    listRes = await listVersions(session);
  }

  if (!listRes.ok) {
    throw new Error(`Backblaze B2 list versions failed (HTTP ${listRes.status}).`);
  }

  const listJson = (await listRes.json()) as {
    files?: Array<{ fileId: string; fileName: string; action?: string }>;
  };

  const exactMatches = (listJson.files || []).filter((file) => file.fileName === objectKey);
  for (const match of exactMatches) {
    await fetch(`${session.apiUrl}/b2api/v2/b2_delete_file_version`, {
      method: 'POST',
      headers: {
        Authorization: session.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fileName: match.fileName,
        fileId: match.fileId,
      }),
      signal: AbortSignal.timeout(12_000),
    });
  }

  if (cachedObjectList) {
    cachedObjectList.entries = cachedObjectList.entries.filter((entry) => entry.fileName !== objectKey);
  }
}

async function listAllB2Objects(forceRefresh = false): Promise<B2ObjectEntry[]> {
  const cfg = getB2Config();
  if (!cfg) return [];

  if (!forceRefresh && cachedObjectList && cachedObjectList.expiresAt > Date.now()) {
    return cachedObjectList.entries;
  }

  if (pendingStatsPromise && !forceRefresh) {
    return pendingStatsPromise;
  }

  const runList = async (): Promise<B2ObjectEntry[]> => {
    let session = await authorizeB2Account();
    const collected: B2ObjectEntry[] = [];
    let nextFileName: string | null = null;
    const maxPages = 20;

    for (let page = 0; page < maxPages; page += 1) {
      const payload: Record<string, unknown> = {
        bucketId: session.bucketId,
        maxFileCount: 1000,
      };
      if (cfg.keyPrefix) {
        payload.prefix = cfg.keyPrefix;
      }
      if (nextFileName) {
        payload.startFileName = nextFileName;
      }

      let res = await fetch(`${session.apiUrl}/b2api/v2/b2_list_file_names`, {
        method: 'POST',
        headers: {
          Authorization: session.authorizationToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 401) {
        clearAuthCache();
        session = await authorizeB2Account(true);
        res = await fetch(`${session.apiUrl}/b2api/v2/b2_list_file_names`, {
          method: 'POST',
          headers: {
            Authorization: session.authorizationToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
      }

      if (!res.ok) {
        throw new Error(`Backblaze B2 list files failed (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as {
        files?: Array<{ fileName: string; contentLength?: number; size?: number; action?: string }>;
        nextFileName?: string | null;
      };

      for (const file of data.files || []) {
        if (file.action && file.action !== 'upload') continue;
        const sizeBytes = Number(file.contentLength ?? file.size ?? 0);
        collected.push({
          fileName: file.fileName,
          size: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
        });
      }

      if (!data.nextFileName) break;
      nextFileName = data.nextFileName;
    }

    cachedObjectList = {
      expiresAt: Date.now() + STATS_CACHE_TTL_MS,
      entries: collected,
    };
    return collected;
  };

  pendingStatsPromise = runList().finally(() => {
    pendingStatsPromise = null;
  });

  return pendingStatsPromise;
}

export async function getB2PerClinicBreakdown(): Promise<B2StorageBreakdown> {
  const cfg = getB2Config();
  if (!cfg) {
    return {
      totalFiles: 0,
      totalBytes: 0,
      byClinic: {},
      legacyStats: { totalFiles: 0, totalBytes: 0 },
    };
  }

  const entries = await listAllB2Objects();
  const prefix = cfg.keyPrefix;
  let totalFiles = 0;
  let totalBytes = 0;
  let legacyFiles = 0;
  let legacyBytes = 0;
  const byClinic: Record<string, B2StorageStats> = {};

  for (const entry of entries) {
    const relPath =
      prefix && entry.fileName.startsWith(prefix)
        ? entry.fileName.slice(prefix.length)
        : entry.fileName;

    totalFiles += 1;
    totalBytes += entry.size;

    const firstSlash = relPath.indexOf('/');
    const topFolder = firstSlash > 0 ? relPath.slice(0, firstSlash) : '';
    if (topFolder.startsWith('tenant_')) {
      const clinicId = topFolder.slice('tenant_'.length);
      if (clinicId) {
        if (!byClinic[clinicId]) {
          byClinic[clinicId] = { totalFiles: 0, totalBytes: 0 };
        }
        byClinic[clinicId].totalFiles += 1;
        byClinic[clinicId].totalBytes += entry.size;
        continue;
      }
    }

    legacyFiles += 1;
    legacyBytes += entry.size;
  }

  return {
    totalFiles,
    totalBytes,
    byClinic,
    legacyStats: { totalFiles: legacyFiles, totalBytes: legacyBytes },
  };
}

export async function getB2StorageStats(clinicId?: string): Promise<B2StorageStats> {
  const breakdown = await getB2PerClinicBreakdown();
  if (!clinicId || clinicId === 'all') {
    return { totalFiles: breakdown.totalFiles, totalBytes: breakdown.totalBytes };
  }
  return breakdown.byClinic[clinicId] || { totalFiles: 0, totalBytes: 0 };
}
