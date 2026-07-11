# CLAUDE.md — Restaurant ChatBot (odayaam)

This file is the source of truth for how this project is built and *why*. Read this before making structural changes.

## What this is

A number-menu-driven restaurant ordering chatbot. No auth — sessions are tracked per device via a cookie. Customers browse a menu, build a cart, check out, pay via TranZak (mobile money — MTN MoMo, Orange Money), and can optionally schedule an order for later. Built to demonstrate clean backend architecture as much as to satisfy the functional spec.

## Guiding principles

1. **State machine over free-form parsing.** The conversation is an explicit FSM (`MAIN → BROWSE_ITEMS → SELECT_VARIANT → SELECT_ADDONS → ENTER_QUANTITY → CONFIRM_ADD`, plus `SCHEDULE_ORDER`). Every message is interpreted relative to `session.step`, never in isolation. This is the same shape as USSD/IVR menus and WhatsApp Business flows — appropriate since the entire UX is numeric, and it means this backend could later sit behind Africa's Talking SMS/USSD or a WhatsApp webhook with zero changes to `bot.js`.

2. **Server-authoritative state, dumb client.** `session.step` and `session.context` live server-side only, keyed by a session ID cookie. The frontend just renders whatever text/quick-replies the server returns. Validity checking never happens client-side.

3. **Separation of concerns.**
   - `menu.js` — static catalog, pure data
   - `db.js` — persistence, abstracted behind `getSession`/`saveSession` (JSON file today, swappable for Postgres later without touching bot logic)
   - `bot.js` — conversation/business logic, no HTTP or payment-provider knowledge
   - `tranzak.js` — thin payment adapter (`createPaymentRequest`, `verifyTransaction`); a second provider would implement the same two functions and drop in

4. **Cart vs. Order are distinct.** `session.cart` is mutable and unconfirmed. `session.orders[]` entries are immutable snapshots with their own lifecycle (`placed → paid | cancelled`). This is what makes "current order" (97) and "order history" (98) behave sanely instead of conflating in-progress selection with committed orders.

5. **Idempotent, referenceable orders.** Every checked-out order gets a unique `reference`, reused as the TranZak payment request ID. This is the join key between our order records and TranZak's async callbacks/webhooks — necessary because payment confirmation does not happen in the same request lifecycle as checkout.

6. **Fail-soft validation.** Bad input at any step re-renders the *same* step with an error prefix instead of crashing or silently dropping the message. Applied uniformly rather than special-cased per step.

7. **Webhooks are the source of truth; redirects are UX only.** The TranZak browser redirect (`/api/payment/callback`) is for showing the user something immediately. The webhook (`/api/payment/webhook`) is what actually marks an order paid — because the redirect can be closed, skipped, or hit on the wrong device, but the webhook is guaranteed server-to-server.

8. **Push, don't poll, for cross-tab/cross-device confirmation.** If a customer pays from their phone while the chat is open on a laptop, the laptop tab has no HTTP request in flight to receive that news. SSE (Server-Sent Events) solves this: the laptop keeps an open `GET /api/session/stream` connection, and the webhook handler pushes a `payment_confirmed` event to the matching session the moment it's verified.

9. **Background jobs handle anything not triggered by a live request.** Three concrete uses in this project (not hypothetical):
   - **Scheduled orders** — nothing "happens" when a customer schedules an order; something has to wake up and act when the time arrives.
   - **Payment reconciliation** — webhooks can be missed (network blip, deploy timing). A periodic sweep re-verifies any order still stuck in `placed` against TranZak directly, as a safety net.
   - **Stale cleanup** — abandoned carts / old unpaid orders shouldn't accumulate forever in the store.

10. **Scale infra to the problem, not the résumé.** Single process, JSON file store, in-process `node-cron` — no Redis/BullMQ/Postgres until there's an actual multi-instance or reliability requirement that demands it. The upgrade path is documented, not pre-built.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js + Express | Fast to stand up REST + static hosting; matches existing Node/NestJS familiarity |
| Session identity | HTTP cookie (`rc_session`, UUID v4) | No auth required; persists per device across visits |
| Persistence | JSON file (`data/db.json`) via `db.js` | Zero native deps, easy to inspect for a demo; abstracted so it's swappable for Postgres |
| Payments | TranZak REST API, `axios` adapter | Supports MTN MoMo & Orange Money in Cameroon; hosted-checkout redirect flow |
| Payment confirmation (authoritative) | TranZak **webhook** → `POST /api/payment/webhook` | Server-to-server; not dependent on the customer's browser completing a redirect |
| Real-time push to browser | **Server-Sent Events** (`GET /api/session/stream`, `EventSource` client-side) | One-directional server→client push, exactly matches the "webhook happened, tell the open tab" need; no need for WebSockets' bidirectionality |
| Background jobs | `node-cron`, in-process | Scheduled-order sweep + payment reconciliation sweep + stale cleanup; jobs re-derive "what's due" from persisted state so they're safe across restarts |
| Frontend | Vanilla HTML/CSS/JS chat UI | No build step; matches the "don't over-invest in design" note while staying presentable |

## Request/event flow (payment)

```
Browser                Our Server                  TranZak
   │  POST /api/chat "96"   │                          │
   ├───────────────────────▶│  createPaymentRequest()  │
   │                        ├─────────────────────────▶│
   │  ◀── payment_url       │◀─────────────────────────┤
   │  user taps link        │                          │
   ├────────────────────────┼─────────────────────────▶│ (hosted checkout)
   │                        │                          │  user pays via MoMo/Orange
   │                        │◀─── webhook POST ─────────┤ (source of truth)
   │                        │  verify + mark order paid │
   │  ◀══ SSE: payment_confirmed ══│ (push to open tab) │
   │  ◀── browser redirect ─┤◀─────────────────────────┤ (UX confirmation)
```

## Background jobs (planned schedule)

| Job | Frequency | Action |
|---|---|---|
| Scheduled-order sweep | every 1 min | Find orders with `scheduledFor` due within window → mark ready / notify |
| Payment reconciliation | every 5 min | Re-verify any order stuck in `placed` for >X min directly against TranZak |
| Stale cleanup | daily | Expire/archive very old unpaid orders and idle sessions |

## Not yet built / next steps

- Express server + routes (`/api/chat`, `/api/session/stream`, `/api/payment/callback`, `/api/payment/webhook`)
- `node-cron` job definitions
- Frontend chat UI + `EventSource` wiring