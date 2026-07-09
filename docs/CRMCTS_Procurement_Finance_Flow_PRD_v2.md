# CRMCTS — Procurement & Finance Flow PRD v2.0

**Source:** a working meeting with the actual end-user (Amisha — procurement/finance), walking through how PO, payment (FMS), vendor, BOQ-cost, drawings and the timeline should behave in real use. This document turns that transcript into requirements you can review before we build.

> **Legend:** ✅ already built · ⚠️ exists but needs change · ❌ new · 🔑 major focus (user's words: *"major focus BOQ & Cost mein data kaise fill hoga… aur finance ka, aur FMS"*)

---

## 1. The real lifecycle (as the user described it)

The user worked out the sequence out loud. This is the backbone everything hangs on:

```
BOQ  ──►  Quotation (vendor sends, PDF)  ──►  PO (we raise, from quotation)
   │                                              │
   │  we send our BOQ to the vendor               │  vendor signs & stamps, sends back
   ▼                                              ▼
"give me quotation for these items"        FMS payment entry (Amisha fills)
                                                  │  references the PO, computes what to pay
                                                  ▼
                                           Finance approval chain → payment released
                                                  │
                                                  ▼
                                           GRN (goods received)  ──►  invoicing to client
```

Key correction to our earlier assumption: **the PO description does NOT come from the BOQ.** The BOQ carries *specifications/requirements* ("AC that runs at −25 °C, on the left wall"); the vendor's quotation and the PO carry the *product* ("Blue Star AC, model X"). So the PO line description is authored from the vendor's quotation, not fetched from the BOQ. The BOQ item is only the thing the PO line *maps back to* for the cost view.

New phase we do not have today: **Quotation** — see §3.

---

## 2. What is already built (confirmed good in the meeting)

| Area | Status | The user's words |
|---|---|---|
| Three BOQ views: Master (as-is, immutable) / Progress (% per item) / Cost | ✅ | *"master jaisa hai waisa hi rahega… second BOQ and progress… teesra BOQ and cost"* |
| PO amendment after approval **with a reason**, resubmit-for-approval choice | ✅ | *"edit option chahiye… likhna padega reason kya change kar rahi hai… resubmit for approval yes/no"* |
| T&C: strike-off stays, delete removed | ✅ | *"delete ka option hatana hai, strike ka option rehna chahiye"* |
| PO form **and** document-editor, both ways to edit | ✅ | *"form fill kar sakti hai ya direct document"* |
| Send-for-approval picks recipients, one-by-one email flow | ✅ | *"kis-kis ko bhejna hai… pehle amisha ko phir…"* |
| Gantt per-activity **remark log** (all remarks kept, each timestamped) | ✅ | *"add remark… remark ke andar sare remark rahega… date aur time consider kare"* |
| Large drawing files (80–200 MB) stored durably in Atlas (GridFS) | ✅ | *"200 MB ki rehti hai"* |
| Vendor profile: contacts, plants, billing address, KYC (GST/PAN/cheque compulsory) | ✅ | matches §6 below |
| Delivery promised/actual dates on PO, on-time reporting | ✅ | (built last round) |

These need **no work** beyond the specific changes called out below.

---

## 3. ❌ Quotation — a new phase before the PO

The vendor sends a quotation PDF *before* we raise the PO. Today we jump straight to PO.

**Requirements**
- A **Quotation** record per vendor per item-group, with a **PDF upload**. Multiple quotations per project (machines, refrigerant piping, lights, air curtains, strip curtains — *"har ek ka quotation mangwate hain"*).
- The quotation PDF is the source we build the PO from ("*quotation ke basis pe hum PO banate hain*").
- **Auto-capture is best-effort, not required.** The user is explicit: vendor quotation formats vary, so we cannot reliably parse them — *"tu alag-alag format deke capture nahi kar payega… line alag-alag ho jati hai"*. So: **store the PDF, let the user type the few fields we need** (vendor, item/machine name, model, amount). Auto-capture only where a **standard format** exists (e.g. a tax invoice) — not for free-form quotations.
- Link a PO back to the quotation it came from (we already have an `againstQuotation` text field — upgrade it to a real link/upload).

**Open question OQ-A:** Do quotations need their own approval, or are they just stored references attached to the PO? (Meeting implies just stored.)

---

## 4. 🔑 FMS — the vendor-payment entry (biggest new module)

This is where Amisha records a payment to a vendor against a PO. Today she opens her phone calculator; the system must do the maths.

> Worked example from the meeting: rate 29,750; she must pay 50,000 as advance against the PO; the balance must compute itself — *"formula lag jayega, phone open karne ki zaroorat nahi"*.

### 4.1 The FMS form — fields, in her order

| # | Field | Behaviour |
|---|---|---|
| 1 | **User** | auto — who is filling (name shown) |
| 2 | **Department** | auto — "Cold Room" |
| 3 | **PI number** | manual — Performa Invoice number (❌ **not** "invoice number") |
| 4 | **PI date** | manual |
| 5 | **Vendor** | select (fetches vendor details + KYC) |
| 6 | **PO number** | select → **fetches the PO's payment-terms %** and vendor (§4.2) |
| 7 | **Payment type** | ❌ **exactly three options: Advance / Balance / Full payment.** Remove "on account payment". |
| 8 | **Full amount** | manual — total (billing is per *actual* quantity + freight, so never auto) |
| 9 | **Amount to pay** | manual |
| 10 | **Balance** | ✅ auto = full − paid ("*automatically calculate ho ke aaya… balance kitna pay karna hai*") |
| 11 | **Payment terms %** | ✅ auto-fetched from the PO (advance / before-delivery / running / post-delivery %). *"jo tumne PO mein bhara wahi… PO number dalegi to fetch ho"* |
| 12 | **GST toggle** | ❌ **"Payment includes GST" or "only basic value".** If GST → treat the amount as 100 % GST-inclusive in the calc. |
| 13 | **Remark** | one free-text remark, last — *"kis regarding hai payment"* |

**Removed from the earlier idea:** ~~invoice number~~ (use PI), ~~payment terms 30-day scheduling~~ (FMS is filled at pay-time, payment is immediate), ~~ledger~~ (replaced by the PO attachment), ~~"invoice with supporting"~~ (replaced by KYC).

### 4.2 Attachments on the FMS entry
- **PO** — auto-selected (the PO already exists in the system). Clicking it opens the PO. *"ledger ke badle PO PDF… auto selection"*.
- **PI upload** — the performa invoice PDF (with supporting).
- **KYC** — the vendor's KYC PDF (auto-appears if the vendor is already created; GST + PAN + cancelled cheque). *"invoice with supporting nahi, KYC"*.

### 4.3 FMS approval chain (finance)
Sequential, line-by-line, same mechanism as the PO chain: **Supriya → Shivani → Alok ji → Tarakant → Sir (final payment OK).**

- ⚠️ The exact order is **not yet confirmed** — *"wo flow maine check nahi kiya… accounts se pooch lo unka kya flow hai. Baad mein."* So build it **configurable** (like the PO approval chain), seed the above as the default, and confirm with Accounts.
- The chain is **fixed per document type**, not chosen each time — *"kis-kis ko approval jana hai wo mat rakho… phir se wahi flow"*.

**Open question OQ-B:** confirm the finance approval order + names with Accounts before go-live.

---

## 5. 🔑 BOQ & Cost — how the data fills (major focus)

The Cost view is the finance lens over the BOQ. The user detailed exactly how each row fills.

### 5.1 Columns & behaviour

| Column | Source | Editable? |
|---|---|---|
| Category header (grouped, collapsible) | BOQ category | ✅ just added |
| Description | BOQ item | read-only |
| Room / Zone | BOQ item | read-only |
| **PO Number** | **select** → auto-fetches vendor, PO date, PO amount, payment terms | select |
| Vendor | from PO | auto |
| PO date | from PO | auto |
| **Quantity ordered (till now)** | ⚠️ **manual** — PO may hold multiple quantities; actual manufactured qty differs (e.g. PO 2594 → came in "points") | **manual** |
| Unit | BOQ item | auto |
| **Delivery timeline (as per Gantt)** | ❌ manual — planned delivery per the Gantt | manual |
| **Actual delivery date** | ❌ manual — when it actually arrived | manual |
| **Delivery delay (days)** | ❌ auto = actual − Gantt/dispatch date | auto |
| **PO amount (overall)** | ⚠️ auto-fetched from PO **but overridable** — freight/charges get added later | **manual override** |
| **Qty × Rate** | ❌ auto — ordered-qty × rate, shown beside, so finance instantly sees the billable amount | auto |
| Advance paid / Balance | from payments | auto |
| Payment received / GRN / Invoice | from GRN | auto ✅ |
| **Invoicing done (to client)** | ❌ **finance checkbox** — finance ticks when the client invoice is raised, so none is missed | finance ticks |

- **PO number is clickable** → opens the PO directly (*"PO pe click karungi to PO wale folder mein le jaye"*). ✅ pattern already exists for GRN; extend to the PO-number cell.
- **Category grouping with dropdown headings** (machine, refrigerant piping, installation of cold-room units, PUF panel…) — ✅ just implemented.
- Description is **not** fetched from BOQ into the PO — it is the vendor's wording (§1).

### 5.2 What changes vs today
Today `BOQCostView` derives everything from linked PO lines and is read-only. The meeting wants **per-BOQ-row manual overrides** the finance team edits directly: quantity-ordered-till-now, overall PO amount, Gantt delivery timeline, actual delivery date, and the finance "invoicing done" tick. That means a small **BOQ-cost annotation record** per (BOQ item × PO) holding these editable fields, layered over the derived numbers.

**Open question OQ-C:** should the editable qty/amount here write back to the PO, or stay a finance-only overlay on the cost sheet? (Meeting implies an overlay — the PO is the contract, the cost sheet is the actuals.)

---

## 6. Vendor creation — owned by Finance

Mostly already built; the change is **who owns it**.

- ❌ **Finance creates vendors, not Amisha.** *"vendor creation wo log karenge, main nahi karungi."* Amisha does one initial backend upload; thereafter finance creates, and new vendors appear in Amisha's selection next time. → gate vendor creation to the **finance role**.
- Vendor fields (✅ mostly exist): **primary address** (company) + **billing address** (separate); **contact person(s)** — name, authority level, email, designation, phone (+ second phone, second contact, photo); **factory/plant address**. Nothing compulsory except KYC.
- **KYC compulsory:** GST certificate, PAN card, cancelled cheque. **Optional:** MSME, "Other" (bundle any extra docs). ✅ matches current model.
- **Authority levels** for contacts: Technician/Technical, Commercial, Sales & Marketing, **+ Other (free-type)**. ⚠️ confirm the full list (OQ-D).

---

## 7. Drawings — and the room-wise target quantities (resolves OQ-1!)

- **Kuldeep (designer)** uploads drawings — a **drawing-person role**. ❌ *"kuldeep aayega, drawing upload karega."*
- **Multiple drawings**, section-wise, each visible — not a single drawing. Each named "PO + Panel" (per Sir).
- Drawings are **re-uploadable** (revisions) — client changes → new drawing. ✅ revision chain exists; also allow separate section drawings.
- Heavy files (80–200 MB) — ✅ handled (GridFS).

**The big one — this resolves DPR §7 OQ-1:**
> AI cannot reliably read per-room quantities off a 200 MB drawing. **So the drawing person manually enters the room-wise target quantities.** *"drawing wala person dalega — ambient room mein front wall kitna, left wall, right wall, ceiling… target quantity. Phir chiller room…"*

This is exactly the room-wise target-quantity import the DPR module was blocked on. **The drawing person is the author of `RoomScopeItem.targetQty`** — a per-room, per-activity entry screen attached to the drawing/room, feeding the room-wise DPR rollup.

---

## 8. Project start tracking (order & advance)

- **Order-received date** — when the client's PO for the project arrived (*"project ka PO kab aaya"*).
- **Advance / PI** — we raise a Performa Invoice for the advance; capture **PI raised date** and **payment received date** + the payment receipt. *"PI kab raise kiya aur kab aaya."*
- Project officially starts after advance + all drawing approvals (✅ existing anchor).

---

## 9. Approval chains — confirmed

| Document | Chain | Status |
|---|---|---|
| **PO / WO** | Manish ji → Aakash sir | ✅ confirmed, only these two |
| **GRN** | same mechanism | ✅ |
| **FMS (vendor payment)** | Supriya → Shivani → Alok ji → Tarakant → Sir | ⚠️ order TBD — confirm with Accounts (OQ-B) |

All chains are **fixed per doc type** and value-threshold aware (the approval matrix already built). Amend-then-resubmit re-runs the same chain (✅ built).

---

## 10. Open questions (please confirm before we build)

| # | Question |
|---|---|
| **OQ-A** | Do vendor **quotations** need approval, or just stored & attached to the PO? |
| **OQ-B** | Confirm the **FMS/finance approval order** and names (Supriya → Shivani → Alok → Tarakant → Sir?) with Accounts. |
| **OQ-C** | In BOQ & Cost, do the editable **quantity-ordered / PO-amount** overrides write back to the PO, or stay a finance-only overlay? |
| **OQ-D** | Full list of contact **authority levels** (Technician, Commercial, Sales & Marketing, Other, …)? |
| **OQ-E** | GST toggle on FMS: when "includes GST", is it always 18 %, or per-vendor/per-line? |
| **OQ-F** | Who may see FMS entries — finance only, or Amisha + finance? |
| **OQ-G** | Room-wise target entry: one screen per drawing, or per room? And does it replace/append the DPR scope seeded earlier? |

---

## 11. Suggested phasing (after your review)

| Phase | Scope | Why first |
|---|---|---|
| **P1 — BOQ & Cost fill** 🔑 | PO-select auto-fetch, editable qty-ordered / PO-amount, Gantt-delivery + actual + delay calc, qty×rate, finance "invoicing done" tick, clickable PO | Your stated major focus; unblocks finance |
| **P2 — FMS** 🔑 | Payment entry form (§4), balance auto-calc, PO payment-terms fetch, GST toggle, PI+KYC+PO attachments, finance approval chain | Your stated major focus; the phone-calculator pain |
| **P3 — Quotation** | Quotation PDF upload + link to PO | Precedes PO in the real flow |
| **P4 — Drawings → room targets** | Drawing-person role, multiple/section drawings, per-room target-qty entry → feeds DPR (resolves OQ-1) | Unblocks the room-wise DPR |
| **P5 — Vendor ownership + project-start tracking** | Finance-owned vendor creation, order-received & advance-PI dates | Smaller, mostly gating + fields |

---

## Appendix — items explicitly confirmed "already fine" in the meeting
Gantt remark log (all remarks kept, timestamped) · large-file storage · PO amend-with-reason + resubmit · T&C strike (no delete) · three BOQ views · PO form-and-document editors · approval send-to-recipients. No further work on these.
