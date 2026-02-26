import { goto } from '$app/navigation';

export function goToGame(roomId: string) {
  goto(`/game/${roomId}`);
}

export function goToLobby() {
  goto('/');
}
