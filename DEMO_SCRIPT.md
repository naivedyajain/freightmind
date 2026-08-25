# FreightMind — 2-minute demo (live assistant)

Open the URL. Connect your Anthropic key (top right) — or it's set server-side.

1. **Ask "What did we spend by carrier?"** — live SQL, real chart, trace shows the query. Spend looks normal, no villain yet.
2. **Ask "Which carrier overcharges us most on detention?"** — the model writes a live 3-table join and finds Pacific Ocean Lines: $3,450 across 5 shipments. Not pre-written.
3. **Upload the sample invoice** (or your own PDF/image) — vision reads it into fields. The detention field is low-confidence; fix it inline, then store.
4. **Click a follow-up chip** — suggestions appear under each answer; follow your train of thought without retyping.
5. **Run "invoice check" from the rail** — a saved workflow chains extract → reconcile → pause for human approval → scan → flag. The pause is the point: the harness holds for a person.
6. **Watch the cost meter** in the rail tick up the whole time, with a per-1,000 projection. At scale, cost is the buying decision.

Close: "Freeform question, live model, real SQL, real vision on my own upload — and it catches what I didn't ask. A harness, not a dashboard."
