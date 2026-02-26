import { env } from '$env/dynamic/public';

const API_BASE = env.PUBLIC_BACKEND_ORIGIN || '';

export async function createRoom(roundCount: number): Promise<{ roomId: string }> {
  const res = await fetch(`${API_BASE}/api/lobby/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roundCount }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listRooms(): Promise<{ rooms: { roomId: string; roundCount: number; playerCount: number; playerNames?: string[] }[] }> {
  const res = await fetch(`${API_BASE}/api/lobby/rooms`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function joinRoom(roomId: string, playerName?: string): Promise<{ ok: true; wsUrl: string }> {
  const res = await fetch(`${API_BASE}/api/lobby/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, playerName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json();
}
