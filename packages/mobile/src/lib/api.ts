/**
 * API client.
 *
 * Handles token refresh transparently and treats network failure as an
 * expected condition rather than an error state — offline is the normal
 * operating mode, so callers get a typed result instead of an exception.
 */

import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'dp.accessToken';
const REFRESH_KEY = 'dp.refreshToken';

export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ?? 'http://10.0.2.2:3000'; // Android emulator host

export interface ApiOk<T> { ok: true; data: T }
export interface ApiErr { ok: false; offline: boolean; status?: number; code?: string; message: string }
export type ApiResult<T> = ApiOk<T> | ApiErr;

export async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_KEY);
}

export async function setTokens(accessToken: string, refreshToken: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

async function refreshTokens(): Promise<boolean> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;

    const data = await response.json();
    await setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  retrying = false,
): Promise<ApiResult<T>> {
  const token = await getAccessToken();

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // No signal. Expected — the caller falls back to cache and the queue.
    return {
      ok: false,
      offline: true,
      message: error instanceof Error ? error.message : 'Network unavailable',
    };
  }

  if (response.status === 401 && !retrying) {
    if (await refreshTokens()) return call<T>(method, path, body, true);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    return {
      ok: false,
      offline: false,
      status: response.status,
      code: payload?.error?.code,
      message: payload?.error?.message ?? `Request failed (${response.status})`,
    };
  }

  return { ok: true, data: payload as T };
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; fullName: string; email: string; role: string; orgId: string };
  deviceStatus: 'approved' | 'pending_approval' | 'not_registered';
  locations: { id: string; code: string; name: string }[];
}

export async function login(
  email: string,
  password: string,
  deviceId: string,
  appVersion: string,
): Promise<ApiResult<LoginResponse>> {
  const result = await call<LoginResponse>('POST', '/v1/auth/login', {
    email, password, deviceId, platform: 'android', appVersion,
  });
  if (result.ok) await setTokens(result.data.accessToken, result.data.refreshToken);
  return result;
}

export interface SyncReportsResponse {
  report: {
    id: string;
    reference_no: string;
    version: number;
    valid_from: string;
    valid_to: string;
  } | null;
  lines: Record<string, unknown>[];
  loadedVins: string[];
}

export const fetchReport = (locationId: string) =>
  call<SyncReportsResponse>('GET', `/v1/sync/reports?locationId=${encodeURIComponent(locationId)}`);

export interface SyncScansResponse {
  sessions: {
    id: string;
    status: string;
    outcome?: string;
    severity?: string;
    message?: string;
    detail?: string;
    outcomeDiffers?: boolean;
    containerComplete?: boolean;
  }[];
}

export const uploadSessions = (sessions: unknown[]) =>
  call<SyncScansResponse>('POST', '/v1/sync/scans', { sessions });
