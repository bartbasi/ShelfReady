// Uploads in progress, per person and in all, shared by invoice runs and old invoices, so the two
// upload routes together never hold more than the configured slots. In memory: a restart ends
// every upload anyway.

export interface SlotLimits {
  maxInFlightPerUser: number;
  maxInFlight: number;
}

export interface UploadSlots {
  /** Takes a slot for this person. Returns the release function, or null when none is free. Release is safe to call twice. */
  take(userId: number, limits: SlotLimits): (() => void) | null;
  /** Slots held now, for tests. */
  held(): number;
}

export function createUploadSlots(): UploadSlots {
  const perUser = new Map<number, number>();
  let total = 0;
  return {
    take(userId, limits) {
      if ((perUser.get(userId) ?? 0) >= limits.maxInFlightPerUser || total >= limits.maxInFlight) return null;
      perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
      total++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        total--;
        const n = (perUser.get(userId) ?? 1) - 1;
        if (n <= 0) perUser.delete(userId);
        else perUser.set(userId, n);
      };
    },
    held: () => total,
  };
}
