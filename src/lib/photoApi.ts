import { auth } from '../firebase';

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

async function getAdminToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Admin sign-in is required.');
  }
  return user.getIdToken();
}

export async function uploadClinicalPhoto(
  patientId: string,
  dataBase64: string
): Promise<UploadedPhotoResponse> {
  const token = await getAdminToken();
  const response = await fetch('/api/photos/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ patientId, dataBase64 }),
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to upload clinical photo.');
  }

  return response.json() as Promise<UploadedPhotoResponse>;
}

export async function deleteServerPhoto(patientId: string, fileName: string): Promise<void> {
  const token = await getAdminToken();
  const response = await fetch(`/api/photos/${encodeURIComponent(patientId)}/${encodeURIComponent(fileName)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok && response.status !== 404) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || 'Failed to delete clinical photo from server.');
  }
}

export async function fetchStorageStats(): Promise<StorageStatsResponse> {
  const token = await getAdminToken();
  const response = await fetch('/api/storage/stats', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error('Unable to retrieve storage metrics.');
  }

  return response.json() as Promise<StorageStatsResponse>;
}

export async function fetchProtectedPhotoBlobUrl(photoUrl: string): Promise<string> {
  const token = await getAdminToken();
  const response = await fetch(photoUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error('Photo unavailable');
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
