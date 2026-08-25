# FreightMind — Video Script (~2.5 min)

**Format:** Screen recording of the live app + voiceover.
**Tone:** Confident, plain-spoken, a little wry. You're showing something that works, not selling vapor.
**Pacing:** ~150 words per minute. This runs ~2:30. Pauses marked with (…).

Two columns: **[SCREEN]** = what to show/do. **VO** = what you say.

---

## SCENE 1 — Open on the product (0:00–0:20)

**[SCREEN]** App loads. The welcome screen: "Ask your freight data anything." Cursor hovers, nothing typed yet. Let it breathe for a second.

**VO:**
"This is FreightMind. It's an assistant for logistics teams — the people who move thousands of shipments a month and drown in the data that comes with them. (…) The idea is simple: ask your freight data a question in plain English, and get an answer you can actually trust. Let me show you."

---

## SCENE 2 — Ask the data (live SQL) (0:20–0:50)

**[SCREEN]** Type: *"What did we spend by carrier?"* Hit Ask. The thinking dots, then the answer, chart, and table appear. Click the trace to expand the SQL.

**VO:**
"I'll ask what we spent by carrier. (…) Behind the scenes, a live model just wrote the SQL, ran it against a real database, and gave me back a chart and the numbers. And here's the part that matters — it shows its work. That's the actual query it ran. No black box. (…) Notice the spend looks totally normal. No carrier is screaming 'problem'. Hold that thought."

---

## SCENE 3 — The sharp question (the reveal) (0:50–1:15)

**[SCREEN]** Type: *"Which carrier overcharges us the most on detention?"* Answer comes back — Pacific Ocean Lines, the join runs live. Expand the trace to show the 3-table join.

**VO:**
"Now the real question — which carrier overcharges us the most on detention? (…) The model writes a three-table join, live, from that one sentence. And there it is: Pacific Ocean Lines. Thirty-four hundred dollars in detention charges we were quoted at zero. (…) I didn't pre-write that query. I asked in English, and the agent figured out the rest."

---

## SCENE 4 — Read a document (vision) (1:15–1:50)

**[SCREEN]** Click "upload an invoice" → pick the SMUDGED sample. Vision reads it. Fields appear; detention flagged low-confidence with an editable box. Type the correct value, then Store.

**VO:**
"It's not just data — it reads documents too. I'll drop in a freight invoice. (…) The model extracts every charge on its own. But look — the detention field was smudged on the scan, so instead of guessing, it flags it and asks me to confirm. (…) I fix it, I store it — and now this invoice lives in the same database, ready to be questioned. That's the whole trick: a document I uploaded a second ago is now data I can reconcile."

---

## SCENE 5 — Reconcile + the delighter (1:50–2:15)

**[SCREEN]** Click follow-up chip "Was this overcharged vs quote?" → reconcile table with the gap. Then click "Any similar overcharges?" → the scan reveal, chart of 5 shipments, $3,450.

**VO:**
"So — was this invoice overcharged? One click. (…) Yes — over quote, almost all detention. But here's my favorite part. I only asked about one invoice. Watch. (…) It scanned everything and found the same carrier did this on five shipments — thirty-four fifty in phantom charges I never asked it to look for. (…) That's the difference between a tool that answers, and one that actually watches your back."

---

## SCENE 6 — Trust, cost, and the close (2:15–2:35)

**[SCREEN]** Glance at the cost meter in the rail ticking up. Quick hover over "Run invoice check" workflow — the chain runs, pauses at "human approval." Then rest on the full thread.

**VO:**
"Every answer is traceable. Every call shows what it cost — because at scale, cost is the decision. (…) And these aren't fixed features — they're pieces you can chain into a workflow that even pauses for a human before it acts. (…) Freeform question, live model, real database, real documents — and it catches what you didn't think to ask. That's not a dashboard. That's a harness."

---

## Delivery notes
- Let the reveals land — pause a half-beat after "Pacific Ocean Lines" and after "$3,450".
- The two numbers to hit hard: **$3,450** and **"five shipments."** That's the whole story.
- Don't rush Scene 4 — the "it flags what it can't read" moment is your trust proof; it's worth the seconds.
- If you run long, cut Scene 6's workflow hover — the reconcile+scan is the payload.

## The single-sentence version (if you need a caption/hook)
"Ask your freight data anything, drop in any invoice — and watch it catch the overcharges you didn't know to look for."
