import type { SpendLedger } from "./spend";
import { withinStop } from "./spend";

export function createFakeLedger(init: { recordedMicroUsd?: number; reservedMicroUsd?: number; unavailable?: boolean; settleFails?: boolean } = {}) {
  const state = { recordedMicroUsd: init.recordedMicroUsd ?? 0, reservedMicroUsd: init.reservedMicroUsd ?? 0 };
  const calls: Array<{ kind: "reserve"; request: Parameters<SpendLedger["reserve"]>[0] } | { kind: "settle"; reservationId: string; actualMicroUsd: number }> = [];
  const holds = new Map<string, number>();
  let serial = 0;
  const ledger: SpendLedger = {
    async reserve(request) {
      calls.push({ kind: "reserve", request });
      if (init.unavailable) throw new Error("unavailable");
      if (!withinStop(state, request.estimateMicroUsd, request.stopMicroUsd)) return { status: "refused" };
      const reservationId = `hold-${++serial}`;
      holds.set(reservationId, request.estimateMicroUsd);
      state.reservedMicroUsd += request.estimateMicroUsd;
      return { status: "held", reservationId };
    },
    async settle(reservationId, actualMicroUsd) {
      calls.push({ kind: "settle", reservationId, actualMicroUsd });
      if (init.settleFails) throw new Error("unavailable");
      const estimateMicroUsd = holds.get(reservationId);
      if (estimateMicroUsd === undefined) throw new Error("unknown or settled reservation");
      holds.delete(reservationId);
      state.reservedMicroUsd -= estimateMicroUsd;
      state.recordedMicroUsd += actualMicroUsd;
    },
  };
  return Object.assign(ledger, { state, calls });
}
