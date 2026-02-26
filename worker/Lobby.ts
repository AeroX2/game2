/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from './types';

export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async createRoom(roundCount: number): Promise<{ roomId: string }> {
    const roomId = crypto.randomUUID().slice(0, 8);
    const room = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(roomId));
    await room.initialize(roundCount);
    await this.ctx.storage.put(`room:${roomId}`, { roomId, roundCount, playerCount: 0, playerNames: [] as string[] });
    const rooms = (await this.ctx.storage.get<string[]>('rooms')) ?? [];
    rooms.push(roomId);
    await this.ctx.storage.put('rooms', rooms);
    return { roomId };
  }

  async listRooms(): Promise<{ rooms: { roomId: string; roundCount: number; playerCount: number; playerNames: string[] }[] }> {
    const roomIds = (await this.ctx.storage.get<string[]>('rooms')) ?? [];
    const rooms = await Promise.all(
      roomIds.map(async (roomId) => {
        const room = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(roomId));
        let live: { roundCount: number; playerCount: number; playerNames: string[] } | null = null;
        try {
          live = await room.getRoomMeta();
        } catch {
          live = null;
        }
        const meta = await this.ctx.storage.get<{ roundCount: number; playerCount?: number; playerNames?: string[] }>(`room:${roomId}`);
        const nextMeta = {
          roomId,
          roundCount: live?.roundCount ?? meta?.roundCount ?? 0,
          playerCount: live?.playerCount ?? meta?.playerCount ?? 0,
          playerNames: live?.playerNames ?? meta?.playerNames ?? [],
        };
        await this.ctx.storage.put(`room:${roomId}`, nextMeta);
        return {
          roomId,
          roundCount: nextMeta.roundCount,
          playerCount: nextMeta.playerCount,
          playerNames: nextMeta.playerNames,
        };
      })
    );
    return { rooms };
  }

  async joinRoom(roomId: string, _playerName?: string): Promise<{ ok: true; wsUrl: string } | { error: string }> {
    const meta = await this.ctx.storage.get<{ roundCount: number }>(`room:${roomId}`);
    if (!meta) return { error: 'Room not found' };
    const playerName = (_playerName ?? '').trim();
    if (playerName) {
      const current = (await this.ctx.storage.get<{ roomId: string; roundCount: number; playerCount?: number; playerNames?: string[] }>(`room:${roomId}`)) ?? {
        roomId,
        roundCount: meta.roundCount,
        playerCount: 0,
        playerNames: [],
      };
      const nextNames = Array.from(new Set([...(current.playerNames ?? []), playerName]));
      await this.ctx.storage.put(`room:${roomId}`, {
        ...current,
        playerNames: nextNames,
        playerCount: Math.max(current.playerCount ?? 0, nextNames.length),
      });
    }
    const origin = 'https://game2.example.com'; // Will be replaced with request origin in Worker
    return { ok: true, wsUrl: `${origin}/room/${roomId}` };
  }

  async setRoomPlayerCount(roomId: string, count: number, playerNames: string[] = []): Promise<void> {
    const meta = (await this.ctx.storage.get<{ roomId: string; roundCount: number; playerCount?: number; playerNames?: string[] }>(`room:${roomId}`)) ?? { roomId, roundCount: 0 };
    await this.ctx.storage.put(`room:${roomId}`, { ...meta, playerCount: count, playerNames });
  }

  async deleteRoom(roomId: string): Promise<void> {
    const rooms = (await this.ctx.storage.get<string[]>('rooms')) ?? [];
    const nextRooms = rooms.filter((id) => id !== roomId);
    await this.ctx.storage.put('rooms', nextRooms);
    await this.ctx.storage.delete(`room:${roomId}`);
  }
}
