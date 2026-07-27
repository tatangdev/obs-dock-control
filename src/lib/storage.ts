// localStorage can throw — Safari private mode, quota exhaustion, embedded
// browsers with storage disabled. A settings write must never crash a click
// handler mid-show, so every access goes through these best-effort wrappers.

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // best-effort: the app works without persistence, just forgets on reload
  }
}

export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // best-effort
  }
}
