"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { WorkflowNotice, WorkflowReveal } from "./workflow-motion";
import type { CaseData } from "./case-workspace";
import { formatDate, statusLabel } from "./case-workspace";
import { panelClass, mutedClass, buttonClass } from "./workspace-shell";
import { ApiError, demoActive, writeApi } from "@/lib/client/api";
import { canSignOff, isCurrentPacketValid } from "@/lib/client/review-state";
import { approvalRecordSchema, isReceiptCurrent, readApprovalReceipt, receiptStorageKey, type ApprovalReceipt } from "@/lib/client/approval-receipt";
import type { Blocker } from "@/lib/client/types";

const acknowledgement = "I reviewed the clinical statements and their sources in this exact packet version.";
function blockerDestination(blocker: Blocker, base: string): string {
  if (blocker.code === "run_incomplete") return `${base}/recheck`;
  if (blocker.code === "date_coverage_gap" || blocker.code === "required_document_missing") return `${base}/attachment`;
  if (blocker.objectType === "issue" && blocker.objectId) return `${base}/issues#${blocker.objectId}`;
  if (blocker.code === "hash_mismatch") return `${base}/recheck`;
  return `${base}/evidence${blocker.objectType === "claim" && blocker.objectId ? `?claim=${blocker.objectId}` : ""}`;
}
export function ClinicianApprovalPanel({ data, night, base, caseId, onChange }: { data: CaseData; night: boolean; base: string; caseId: string; onChange: () => Promise<void> }) {
  const { detail, claims, validation, clinician } = data;
  const [receipt, setReceipt] = useState<ApprovalReceipt | null>(null);
  const [acknowledgedPacket, setAcknowledgedPacket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const ready = canSignOff(data);
  const signed = detail.case.status === "approved_for_submission" && isCurrentPacketValid(data);
  const binding = `${validation.packetVersionId}:${validation.contentHash}`;
  const receiptCurrent = receipt !== null && isReceiptCurrent(receipt, data);
  const changed = !signed && receipt !== null && detail.latestPacketVersion !== null && receipt.record.packetVersionId !== detail.latestPacketVersion.id;
  const muted = mutedClass(night), panel = panelClass(night);

  // A replay keeps its receipt in memory only, so one viewing can't leave a stale receipt for the next or for the app.
  useEffect(() => {
    if (demoActive()) return;
    try { setReceipt(readApprovalReceipt(localStorage.getItem(receiptStorageKey(clinician.id, caseId)), clinician.id, caseId)); }
    catch { setStorageWarning(true); }
  }, [clinician.id, caseId]);

  async function signOff() {
    const packet = detail.latestPacketVersion;
    if (!ready || !packet || acknowledgedPacket !== binding || busy) return;
    setBusy(true); setError(null);
    try {
      const raw = await writeApi<unknown>(`/api/cases/${encodeURIComponent(caseId)}/approve`, "POST", { packetVersionId: validation.packetVersionId, contentHash: validation.contentHash, acknowledgement });
      const record = approvalRecordSchema.parse(raw);
      if (record.caseId !== caseId || record.approvedBy !== clinician.id || record.packetVersionId !== validation.packetVersionId || record.contentHash !== validation.contentHash || record.status !== "valid") throw new Error("approval_response_mismatch");
      const captured = { record, version: packet.version };
      setReceipt(captured);
      if (!demoActive()) try { localStorage.setItem(receiptStorageKey(clinician.id, caseId), JSON.stringify(captured)); } catch { setStorageWarning(true); }
    } catch (cause) {
      setError(cause instanceof ApiError
        ? ({ stale_hash: "The packet changed. Review the refreshed version and acknowledge it again.", run_incomplete: "The agent run is incomplete. Finish recheck before signing off.", blockers_open: "Server validation found a blocker. Resolve the refreshed blockers before signing off." } as Record<string, string>)[cause.code] ?? `The server refused sign-off: ${cause.code.replaceAll("_", " ")}.`
        : "The sign-off response could not be confirmed. Check the refreshed server state before trying again.");
    } finally {
      setAcknowledgedPacket(null);
      await onChange();
      setBusy(false);
    }
  }

  return <>
    <p className={`text-xs font-bold uppercase tracking-widest ${muted}`}>Human approval gate</p>
    <h1 className="mt-3 font-serif text-3xl sm:text-4xl">{signed ? "Packet signed off" : changed ? "Sign-off invalidated" : ready ? "Ready for sign-off" : "Sign-off blocked"}</h1>
    <p className={`mt-2 text-sm ${muted}`}>{changed ? "The current packet is a new version. The previous sign-off does not carry forward." : "Review the exact packet version and server validation before confirming."}</p>
    {changed && <WorkflowNotice name="approval-invalidated" eventKey={binding} className={`mt-6 rounded-lg border p-4 text-sm ${night ? "border-[#765c36] bg-[#493721]" : "border-[#e8d4ad] bg-[#fbf2e5]"}`}><strong>Fresh clinician review required</strong><p className="mt-2 leading-6">Your recorded sign-off belongs to packet v{receipt.version}. The current packet is v{detail.latestPacketVersion?.version}. Inspect the changed statements and complete a new acknowledgement.</p><Link href={`${base}/evidence`} className="mt-3 inline-block font-semibold underline underline-offset-4">Review changed claim and sources →</Link></WorkflowNotice>}
    <div className="mt-7 grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-5"><section className={panel}><div className="flex flex-wrap items-center justify-between gap-3 border-b border-current/10 pb-4"><h2 className="text-lg font-semibold">Packet {detail.latestPacketVersion ? `v${detail.latestPacketVersion.version}` : "pending"} · Read-only preview</h2><span className={`text-xs ${muted}`}>Exact current version</span></div><dl className="mt-5 space-y-3 text-sm"><div><dt className={muted}>Requested period</dt><dd className="mt-1">{formatDate(detail.reviewPeriod?.requestedStart ?? null)} – {formatDate(detail.reviewPeriod?.requestedEnd ?? null)}</dd></div><div><dt className={muted}>Existing authorization</dt><dd className="mt-1">{formatDate(detail.authorization?.approvedStart ?? null)} – {formatDate(detail.authorization?.approvedEnd ?? null)}</dd></div></dl><div className="mt-5 space-y-3">{claims.filter(claim => claim.status !== "rejected").map(claim => <section key={claim.id} className={`rounded-lg p-4 ${night ? "bg-[#13251d]" : "bg-[#f5f8f4]"}`}><h3 className={`text-xs font-semibold ${muted}`}>{claim.sectionHeading} · {statusLabel(claim.status)}</h3><p className="mt-2 text-sm leading-6">{claim.text}</p><Link href={`${base}/evidence?claim=${claim.id}`} className="mt-3 inline-block text-xs underline underline-offset-4">Inspect source →</Link></section>)}</div>{!claims.some(claim => claim.status !== "rejected") && <p className={`mt-5 rounded-lg bg-[#ba8735]/10 p-4 text-sm ${muted}`}>No included statements are available. Recheck the packet before sign-off.</p>}<p className={`mt-5 break-all font-mono text-xs leading-6 ${muted}`}>Packet ID: {validation.packetVersionId ?? "Not available"}<br />Packet hash: {validation.contentHash ?? "Not available"}</p><Link href={`${base}/evidence`} className={`${buttonClass} mt-5`}>Review evidence →</Link></section>
        {receipt && <WorkflowReveal name="signoff-receipt" eventKey={`${receipt.record.id}:${receiptCurrent}`} className={panel} label="Server sign-off receipt"><h2 className="text-lg font-semibold">{receiptCurrent ? "Sign-off receipt" : "Previous sign-off receipt"}</h2><p className={`mt-2 text-xs leading-5 ${muted}`}>Captured from the successful server response in this browser. Current server validation controls approval eligibility.</p><dl className="mt-5 space-y-3 text-sm"><div><dt className={muted}>Clinician</dt><dd className="mt-1">{clinician.name ?? receipt.record.approvedBy} · {receipt.record.role}</dd></div><div><dt className={muted}>Recorded time · System clock</dt><dd className="mt-1">{formatDate(receipt.record.createdAt, true)}</dd></div><div><dt className={muted}>Signed-off version</dt><dd className="mt-1">Version {receipt.version}</dd></div><div><dt className={muted}>Signed-off hash</dt><dd className="mt-1 break-all font-mono text-xs leading-6">{receipt.record.contentHash}</dd></div><div><dt className={muted}>Approval record</dt><dd className="mt-1 break-all text-xs">{receipt.record.id}</dd></div></dl><p className={`mt-5 text-sm font-semibold ${receiptCurrent ? "text-[#659b74]" : "text-[#ad7b36]"}`}>{receiptCurrent ? "Matches current signed-off packet" : "This receipt does not approve the current review state"}</p></WorkflowReveal>}
      </div>
      <aside className="space-y-5"><section className={panel}><h2 className="text-lg font-semibold">Validation result</h2><p className={`mt-3 text-sm font-semibold ${ready || signed ? "text-[#659b74]" : "text-[#ad7b36]"}`}>{ready || signed ? "All checks clear" : `${validation.blockers.length} server blocker${validation.blockers.length === 1 ? "" : "s"}`}</p><ul className="mt-5 space-y-3 text-sm">{validation.report.checks.map((check, index) => <li key={`${check.name}-${index}`} className="flex justify-between gap-3"><span>{check.name.replaceAll("_", " ")}</span><strong className={check.result === "pass" ? "text-[#659b74]" : "text-[#ad7b36]"}>{statusLabel(check.result)}</strong></li>)}</ul><ul className="mt-5 space-y-3">{validation.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`} className={`rounded-lg p-4 text-sm ${night ? "bg-[#493721]" : "bg-[#fbf2e5]"}`}><p>{blocker.code === "hash_mismatch" && !detail.latestPacketVersion ? "No prepared packet is available yet. Start a review run." : blocker.message}</p><Link href={blockerDestination(blocker, base)} className="mt-2 inline-block text-xs font-semibold underline underline-offset-4">Review blocker →</Link></li>)}</ul>
        {!ready && !signed && <><button type="button" disabled className={`${buttonClass} mt-5 w-full cursor-not-allowed opacity-50`}>Sign off unavailable</button>{!validation.blockers.length && <p className={`mt-3 text-xs ${muted}`}>The current version, hash, and completed run must agree. Refresh or recheck this packet.</p>}<Link href={`${base}/recheck`} className="mt-4 inline-block text-sm font-semibold underline underline-offset-4">Open packet recheck →</Link></>}
        {ready && <><label className="mt-6 flex items-start gap-3 text-sm"><input type="checkbox" disabled={busy} checked={acknowledgedPacket === binding} onChange={event => setAcknowledgedPacket(event.target.checked ? binding : null)} className="mt-1 size-4 shrink-0 accent-[#255e4b]" /><span>{acknowledgement}</span></label><button type="button" disabled={busy || acknowledgedPacket !== binding} onClick={() => { void signOff(); }} className={`${buttonClass} mt-5 w-full disabled:cursor-not-allowed disabled:opacity-50`}>{busy ? "Signing off…" : `Sign off packet v${detail.latestPacketVersion?.version}`}</button></>}
        {signed && <WorkflowNotice name="signoff-confirmed" eventKey={binding} className="mt-6 rounded-lg bg-[#649b72]/15 p-4 text-sm"><strong>Exact packet signed off</strong><p className="mt-2 leading-6">A source, date or statement change requires fresh review. Nothing was sent to a payer.</p>{!receiptCurrent && <p className={`mt-3 text-xs ${muted}`}>A receipt for this version was not captured in this browser. Full history is not available from the existing read API.</p>}<Link href="/" className={`${buttonClass} mt-4`}>Return to queue →</Link></WorkflowNotice>}
        {error && <p role="alert" className="mt-4 text-sm text-[#b45f4b]">{error}</p>}{storageWarning && <p role="status" className={`mt-4 text-xs ${muted}`}>The server stores sign-off, but this browser could not save its receipt.</p>}
      </section></aside>
    </div>
  </>;
}
