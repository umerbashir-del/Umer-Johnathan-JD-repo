import type { DemoStep } from "./demo-runner";

/** One recorded stretch of the UR-1042 story, seen by one signed-in account. Recorded in this order on one database. */
export type DemoSegment = { id: SegmentId; account: string; roleLabel: string; start: string; steps: DemoStep[] };
export const SEGMENT_IDS = ["clinician-review", "coordinator", "clinician-signoff", "packet", "manager"] as const;
export type SegmentId = typeof SEGMENT_IDS[number];

/** The main parts of the process, shown in order along the bottom of the replay. */
export const STAGES = [
  { id: "draft", label: "Agents draft the packet" },
  { id: "flag", label: "Code flags the gaps" },
  { id: "gather", label: "Coordinator gets the note" },
  { id: "verify", label: "Clinician verifies and re-runs" },
  { id: "signoff", label: "Clinician signs off" },
  { id: "locked", label: "Locked packet and oversight" },
] as const;
export type StageId = typeof STAGES[number]["id"];
const stage = (id: StageId): DemoStep => ({ do: "stage", stage: id });

const heading = (text: string | RegExp) => ({ text, tag: "h1,h2,h3" });
const notice = (text: string | RegExp) => ({ text, tag: "p,div,strong" });
const tab = (text: string) => ({ text, tag: "a" });

export const SEGMENTS: Record<SegmentId, DemoSegment> = {
  "clinician-review": { id: "clinician-review", account: "clinician_a", roleLabel: "Clinician", start: "/", steps: [
    stage("draft"),
    { do: "say", caption: "Clinician A opens the work queue. UR-1042's concurrent review is due today." },
    { do: "click", target: { text: "Explore the case" }, caption: "Opens UR-1042's case file." },
    { do: "waitFor", target: heading("Case summary") },
    { do: "say", caption: "No packet yet. The three review agents haven't run on this case." },
    { do: "click", target: tab("Recheck"), caption: "Opens the tab where the review agents are run." },
    { do: "click", target: { text: "Start review run", tag: "button" }, caption: "Starts the three agents: one pulls facts from the chart, one drafts the packet, one checks the draft against the sources." },
    { do: "waitFor", target: heading(/Latest run · (Complete|Incomplete)/), timeoutMs: 90000, caption: "The agents draft from the chart. Code checks every claim's quote against its source." },
    { do: "say", caption: "The run is done. Each agent's result stays visible." },
    { do: "click", target: tab("Summary"), caption: "Opens the drafted packet." },
    { do: "click", target: { text: "Inspect claim and source", tag: "a" }, caption: "Opens one claim next to the record it came from." },
    { do: "point", target: { text: /\S/, tag: "mark" }, caption: "The quoted passage is highlighted in the original record." },
    { do: "say", caption: "The quoted passage is highlighted in the original record.", ms: 2000 },
    stage("flag"),
    { do: "click", target: tab("Issues"), caption: "Opens the blockers that code, not the AI, found in the packet." },
    { do: "waitFor", target: heading(/^Missing Nov 2, 2026 progress note/) },
    { do: "point", target: heading(/^Missing Nov 2, 2026 progress note/), caption: "Two blockers: the Nov 2 progress note is missing, and the requested dates go past the authorization." },
    { do: "click", target: tab("Sign-off"), caption: "Checks whether the packet can be signed off yet." },
    { do: "waitFor", target: heading("Sign-off blocked") },
    { do: "say", caption: "No. Sign-off stays locked until both blockers are resolved.", ms: 3200 },
    { do: "say", caption: "Clinician A asks the coordinator for the missing note." },
  ] },
  coordinator: { id: "coordinator", account: "coordinator_a", roleLabel: "Coordinator", start: "/roles/coordinator", steps: [
    stage("gather"),
    { do: "say", caption: "The coordinator collects original records. They can't verify a source or close a clinical issue." },
    { do: "waitFor", target: heading("Open issues") },
    { do: "point", target: heading("Open issues"), caption: "UR-1042 is waiting on the Nov 2 progress note." },
    { do: "click", target: { text: "Read original source", tag: "button" }, caption: "Opens a record already on file to compare against." },
    { do: "upload", target: { text: "Attach synthetic note", tag: "input" }, file: "late-note", name: "note-2026-11-02.md", caption: "Uploads the late Nov 2 note exactly as received." },
    { do: "waitFor", target: notice("Original source attached") },
    { do: "say", caption: "It's attached but unverified. Only the clinician can verify it.", ms: 3000 },
  ] },
  "clinician-signoff": { id: "clinician-signoff", account: "clinician_a", roleLabel: "Clinician", start: "/cases/UR-1042/issues", steps: [
    stage("verify"),
    { do: "say", caption: "Back with Clinician A. The note has arrived." },
    { do: "click", target: { text: "Attach original note", tag: "a" }, caption: "Opens the missing-note issue." },
    { do: "click", target: { text: "Attach, verify and resolve", tag: "button" }, caption: "Marks the uploaded note as verified and closes the missing-note issue with it." },
    { do: "waitFor", target: heading("Missing note attached") },
    { do: "click", target: { text: "Verify dates", tag: "a" }, caption: "Opens the second blocker: requested Nov 4–6 against the Nov 1–3 authorization." },
    { do: "type", target: { text: "Reason for the difference", tag: "label" }, text: "Request is for Nov 4–6; the current authorization remains Nov 1–3.", caption: "Records why the dates differ. Neither date is changed." },
    { do: "click", target: { text: "Record verification", tag: "button" }, caption: "Saves the explanation and closes the date blocker." },
    { do: "waitFor", target: notice("Requested dates verified by the clinician") },
    { do: "click", target: { text: "Recheck packet", tag: "a" }, caption: "Opens the fresh run that verifying the note started. The agents re-read every source, now including the note." },
    { do: "waitFor", target: heading(/Latest run · (Complete|Incomplete)/), timeoutMs: 90000 },
    { do: "click", target: tab("Sign-off"), caption: "Checks sign-off again." },
    { do: "repeat", while: { text: "A material claim has no verified source", tag: "p" }, max: 6, steps: [
      { do: "click", target: { text: "Review blocker", tag: "a" }, caption: "Opens a claim that has no verified source." },
      { do: "click", target: { text: "Unsupported · review", tag: "button" }, caption: "Selects the unsupported claim to review." },
      { do: "click", target: { text: "Reject claim", tag: "button" }, caption: "Removes it from the packet, because nothing in the record backs it." },
      { do: "click", target: tab("Sign-off"), caption: "Checks sign-off again." },
    ] },
    { do: "waitFor", target: heading("Ready for sign-off") },
    stage("signoff"),
    { do: "click", target: { text: "I reviewed the clinical statements", tag: "label" }, caption: "Confirms the clinician reviewed this exact packet version." },
    { do: "click", target: { text: /Sign off packet v\d+/, tag: "button" }, caption: "Signs off. The approval is tied to this version's fingerprint." },
    { do: "waitFor", target: heading("Packet signed off") },
    { do: "say", caption: "Signed off. Any later change to a source, date or statement needs a fresh sign-off. Nothing is sent to a payer.", ms: 3500 },
    { do: "click", target: { text: /^Activity$/, tag: "a" }, caption: "Opens the activity log, the record of what happened." },
    { do: "waitFor", target: heading("Case activity") },
    { do: "point", target: heading("Case activity"), caption: "Each source received and each packet version, with its time." },
  ] },
  packet: { id: "packet", account: "packet_a", roleLabel: "Packet preparation", start: "/roles/submission", steps: [
    stage("locked"),
    { do: "say", caption: "Packet preparation sees only signed-off packets, read-only." },
    { do: "point", target: notice("Packet fingerprint"), caption: "The fingerprint ties this view to the exact version the clinician signed." },
    { do: "say", caption: "If anything changes, the packet leaves this queue until a clinician signs off again.", ms: 3000 },
  ] },
  manager: { id: "manager", account: "manager_a", roleLabel: "Manager", start: "/roles/manager", steps: [
    stage("locked"),
    { do: "say", caption: "The manager watches the team queue and routes work." },
    { do: "waitFor", target: heading(/Your team cases/) },
    { do: "point", target: heading(/Your team cases/), caption: "Each case shows its status, deadline and blockers." },
    { do: "select", target: { text: "Assigned clinician", tag: "select" }, option: "Clinician B", caption: "Reassigning would move the case to Clinician B and cancel the current sign-off." },
    { do: "select", target: { text: "Assigned clinician", tag: "select" }, option: "Demo Clinician (fictional)", caption: "Puts it back: UR-1042 stays with Clinician A." },
    { do: "say", caption: "That's the full UR-1042 review, from first run to sign-off." },
  ] },
};

export type StoryId = "clinician" | "coordinator" | "manager" | "packet" | "full";
export const STORIES: { id: StoryId; title: string; description: string; segments: SegmentId[] }[] = [
  { id: "full", title: "The whole review", description: "Every account in order: clinician, coordinator, clinician sign-off, packet preparation, manager.", segments: ["clinician-review", "coordinator", "clinician-signoff", "packet", "manager"] },
  { id: "clinician", title: "Clinician", description: "Runs the agents, checks sources, resolves blockers and signs off.", segments: ["clinician-review", "clinician-signoff"] },
  { id: "coordinator", title: "Coordinator", description: "Finds the missing record and attaches it, without verifying it.", segments: ["coordinator"] },
  { id: "packet", title: "Packet preparation", description: "Reads the signed-off packet and its fingerprint.", segments: ["packet"] },
  { id: "manager", title: "Manager", description: "Watches the team queue and routes work.", segments: ["manager"] },
];
