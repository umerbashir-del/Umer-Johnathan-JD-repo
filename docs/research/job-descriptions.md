# Job description

## The JD we build around

**Authorization (UR) Specialist, Ritten.** Ritten makes an EHR and practice-management system for behavioral-health providers. The role sits on its Revenue Cycle Management team and is hybrid, based in Philadelphia.
https://www.ritten.io/jobs/authorization-ur-specialist (read Nov 3, 2026; summarized below in our words, so see the link for the exact wording) Saved copy: [ritten-authorization-ur-specialist-jd.pdf](ritten-authorization-ur-specialist-jd.pdf).

**The role.** The specialist gets and maintains prior authorizations and concurrent reviews across behavioral-health levels of care, payers and states. They are the **first line of defense against authorization-related denials**, and they coordinate with the intake, clinical and billing teams.

**Responsibilities**

1. Get and submit initial authorizations for IOP, PHP, residential and detox, with medical-necessity documentation (ASAM criteria).
2. Manage concurrent reviews and track expiration dates to prevent coverage gaps.
3. Keep authorization records accurate, monitor unit limits and handle retro-authorization requests.
4. Be the main contact with payer UR departments, including peer-to-peer reviews and appeals.
5. Find authorization gaps, support denial appeals and report denial trends to leadership.
6. Coordinate with the intake, clinical and billing teams so documentation is complete and claims are clean.

**Qualifications (summarized)**

- At least 3 years of behavioral-health UR or prior-authorization experience.
- Multiple levels of care.
- Commercial, Medicaid and Medicare payers across states.
- ASAM.
- Concurrent reviews, retro-auths and appeals.
- Preferred:
  - Multi-state Medicaid.
  - Peer-to-peer preparation.
  - ICD-10 codes and how they relate to level of care.
  - CBHCM.

## JD coverage: what the app does for each duty

This is the traceability table. Stories are in [user-stories.md](../product/user-stories.md), and FRs are in the [PRD](../product/prd.md).

| JD duty | How the app covers it | Stories | FRs | Status |
| --- | --- | --- | --- | --- |
| First line of defense against denials | The Insurer Reviewer agent lists the plan's 3 most likely objections, with evidence, before approval | US-07 | FR-08 | MVP |
| 1. Initial authorizations with ASAM documentation | The ASAM/LOCUS check exists for reviews and denials. A full pre-cert workflow comes later | US-04, US-18 | FR-06, FR-24 | Partial |
| 2. Concurrent reviews and expirations | Queue sorted by deadline; UR-1042 end to end; authorized and requested periods tracked separately | US-01, US-02, US-03, US-09 | FR-01–05, FR-11–12 | MVP |
| 3. Auth records and unit limits | The Authorization Tracking agent and code check dates and units against the request | US-06 | FR-07, FR-19 | MVP |
| 3. Retro-authorization requests | Not covered | none | none | Gap |
| 4. Payer contact, peer-to-peer, appeals | Denial parsing, similar real cases, next-step recommendation, appeal letter or P2P talking points. Payer contact itself is mocked | US-10–13, US-19 | FR-14–17, FR-23 | MVP (sending is Later) |
| 5. Find authorization gaps | Missing notes and conflicts become blocking issues | US-05, US-06 | FR-07, FR-11 | MVP |
| 5. Support denial appeals | As in row 4, plus procedural checks | US-10–14 | FR-14–17, FR-21 | MVP / Should |
| 5. Report denial trends | Trends by plan and care type from NY data | US-16 | FR-22 | Should |
| 6. Coordinate with intake and clinical | Coordinator document requests with due times | US-15 | FR-20 | Should |
| 6. Clean claims with billing | Not covered | none | none | Gap |
| Commercial, Medicaid, Medicare across states | NY and CA appeal data, commercial and Medicaid. Medicare is out (neither dataset covers it) | US-11 | FR-15 | Partial |
| ICD-10 and level of care | Diagnosis is shown in fixtures but not checked | none | none | Gap |

Retro-authorization, billing and ICD-10 checks are deliberate gaps. Say so in the demo rather than implying full coverage.

## Considered and dropped

| Source | Why it was dropped |
| --- | --- |
| TaraVista UR Clinician (builtin.com) | Posting removed Aug 5, 2026, and it mentions appeals and denials in only one line |
| Generations Behavioral Health Appeals Specialist | Closed Nov 1, 2026 |

## Insurer-side context (not a source)

- **Centene, Utilization Review Clinician, Behavioral Health (Texas).**
  - We read it to understand how a plan's reviewer works.
  - We don't use it as a source, because it's one company in one state.
  - The adversarial agent's four questions are standard review practice anyway. See [agents](../architecture/agents.md#insurer-reviewer-the-adversarial-agent).
- **Umpqua Health CE05, Utilization Review policy (Oregon Medicaid): excluded.**
  - It covers one plan and dates from 2022.
  - Our case data comes from NY and CA, so there would be nothing to match it against.
