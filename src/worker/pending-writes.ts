// Registre des écritures en attente de confirmation : le worker garde la fonction qui écrit, le
// panneau ne reçoit que le récapitulatif et un jeton. Le registre vit en mémoire : un worker
// relancé repart de zéro, et un jeton devenu inconnu se dit `expired`.
import { CHANGES_RENDER_CAP, type ApiResult, type Committed, type FieldChange, type PreparedWrite } from '../protocol'

/** Durée de vie d'un récapitulatif non confirmé. */
export const PENDING_TTL_MS = 15 * 60_000

const EXPIRED_MESSAGE = 'This review expired: press Apply again.'

export type PendingWrites = {
  /** Met l'écriture en attente ; `changes` est plafonné à `CHANGES_RENDER_CAP`, `totalChanges` garde le compte réel. */
  stage(commit: (force: boolean) => Promise<ApiResult<Committed>>, changes: FieldChange[], creates: boolean): PreparedWrite
  /**
   * Lance l'écriture. Un succès consomme le jeton ; un échec le garde, pour « Apply anyway ».
   * Deux appels simultanés sur un jeton n'écrivent qu'une fois et partagent le résultat.
   */
  commit(token: string, force: boolean): Promise<ApiResult<Committed>>
}

type Entry = {
  commit: (force: boolean) => Promise<ApiResult<Committed>>
  expiresAt: number
  /** L'écriture en vol : un appel simultané en partage le résultat au lieu d'écrire une seconde fois. */
  inFlight?: Promise<ApiResult<Committed>>
}

export function createPendingWrites(now: () => number): PendingWrites {
  const entries = new Map<string, Entry>()

  const dropExpired = (): void => {
    const current = now()
    for (const [token, entry] of entries) {
      if (current > entry.expiresAt) {
        entries.delete(token)
      }
    }
  }

  return {
    stage(commit, changes, creates) {
      dropExpired()
      const token = crypto.randomUUID()
      entries.set(token, { commit, expiresAt: now() + PENDING_TTL_MS })
      return { token, changes: changes.slice(0, CHANGES_RENDER_CAP), totalChanges: changes.length, creates }
    },

    async commit(token, force) {
      const entry = entries.get(token)
      if (!entry || now() > entry.expiresAt) {
        entries.delete(token)
        return { ok: false, code: 'expired', error: EXPIRED_MESSAGE }
      }
      // Un second appel pendant le vol (double clic), quel que soit son `force`, rend le même résultat.
      if (entry.inFlight) {
        return entry.inFlight
      }
      const running = entry.commit(force)
      entry.inFlight = running
      try {
        const result = await running
        if (result.ok) {
          entries.delete(token)
        }
        return result
      } finally {
        entry.inFlight = undefined
      }
    }
  }
}
