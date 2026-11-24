import { auth } from '../firebase';
import { buildApiUrl, getActiveClinicHeaderId } from './tenantPaths';

export interface UploadedPhotoResponse {
  photoId: string;
  fileName: string;
  url: string;
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
}

export interface StorageStatsResponse {
  totalFiles: number;
  totalBytes: number;
}

export interface SaasPlatformHealthResponse {
  ok: boolean;
  nodeVersion: string;
  environment: string;
  port: number;
  uptimeSeconds: number;
  geminiConfigured: boolean;
  firebaseConfigured: boolean;
  firebaseProjectId: string | null;
  firestoreDatabaseId: string | null;
  uploadRootWritable: boolean;
  storageBackend?: 'backblaze_b2' | 'local_disk';
  b2Configured?: boolean;
  b2BucketName?: string | null;
  storage: {
    totalFiles: number;
    totalBytes: number;
    byClinic: Record<string, { totalFiles: number; totalBytes: number }>;
    legacyStats: { totalFiles: number; totalBytes: number };
  };
}

async function getAdminToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Admin sign-in is required.');
  }
  return user.getIdToken();
}

function buildTenantHeaders(token: string, clinicIdOverride?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const cid = clinicIdOverride ?? getActiveClinicHeaderId();
  if (cid) {
    headers['x-clinic-id'] = cid;
  }
  return headers;
}

async function parseJsonOrApiError(response: Response, fallbackMsg: string): Promise<unknown> {
  const text = await response.text().catch(() => '');
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    throw new Error(
      'Photo/API server is not attached to this static hosting deployment. Set VITE_API_BASE_URL or host with server.ts.'
    );
  }
  let parsed: unknown = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(fallbackMsg);
    }
  }
  if (!response.ok) {
    const errMsg =
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : fallbackMsg;
    throw new Error(errMsg);
  }
  return parsed;
}

export async function uploadClinicalPhoto(
  patientId: string,
  dataBase64: string,
  clinicIdOverride?: string | null
): Promise<UploadedPhotoResponse> {
  const token = await getAdminToken();
  const cid = clinicIdOverride ?? getActiveClinicHeaderId();
  const response = await fetch(buildApiUrl('/api/photos/upload'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildTenantHeaders(token, cid),
    },
    body: JSON.stringify({ patientId, dataBase64, clinicId: cid || undefined }),
  });

  return (await parseJsonOrApiError(
    response,
    'Failed to upload clinical photo.'
  )) as UploadedPhotoResponse;
}

export async function deleteServerPhoto(
  patientId: string,
  fileName: string,
  photoUrl?: string,
  clinicIdOverride?: string | null
): Promise<void> {
  const token = await getAdminToken();
  const cid = clinicIdOverride ?? getActiveClinicHeaderId();

  let deleteUrl: string;
  if (photoUrl && photoUrl.startsWith('/api/photos/')) {
    deleteUrl = buildApiUrl(photoUrl);
  } else if (cid) {
    deleteUrl = buildApiUrl(
      `/api/photos/${encodeURIComponent(cid)}/${encodeURIComponent(patientId)}/${encodeURIComponent(fileName)}`
    );
  } else {
    deleteUrl = buildApiUrl(
      `/api/photos/${encodeURIComponent(patientId)}/${encodeURIComponent(fileName)}`
    );
  }

  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: buildTenantHeaders(token, cid),
  });

  if (!response.ok && response.status !== 404) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to delete clinical photo from server.');
  }
}

export async function fetchStorageStats(
  clinicIdOverride?: string | null
): Promise<StorageStatsResponse> {
  const token = await getAdminToken();
  const cid = clinicIdOverride ?? getActiveClinicHeaderId();
  const querySuffix = cid ? `?clinicId=${encodeURIComponent(cid)}` : '';
  const response = await fetch(buildApiUrl(`/api/storage/stats${querySuffix}`), {
    headers: buildTenantHeaders(token, cid),
  });

  return (await parseJsonOrApiError(
    response,
    'Unable to retrieve storage metrics.'
  )) as StorageStatsResponse;
}

export async function fetchSaasPlatformHealth(): Promise<SaasPlatformHealthResponse> {
  const token = await getAdminToken();
  const response = await fetch(buildApiUrl('/api/saas/health'), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return (await parseJsonOrApiError(
    response,
    'Unable to inspect SaaS hosting diagnostics.'
  )) as SaasPlatformHealthResponse;
}

export async function fetchProtectedPhotoBlobUrl(photoUrl: string): Promise<string> {
  const token = await getAdminToken();
  const targetUrl = photoUrl.startsWith('/api/') ? buildApiUrl(photoUrl) : photoUrl;
  const response = await fetch(targetUrl, {
    headers: buildTenantHeaders(token),
  });

  if (!response.ok) {
    throw new Error('Photo unavailable');
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
