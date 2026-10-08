# TASK-060 — Goal currency per campaign (ADR-060)

David 2026-10-08: "zbiralec se sam odloči katero valuto izbere, zbira se pa tk vse v usdc. bo delal potem dropdown za izbiro valute pravilno?"

## Scope
- Schema (expand first, own PR): `campaigns.goal_currency` (`EUR` default) and `goal_amount_minor`; backfill from `target_eur_cents`.
- Campaign form: currency select (EUR, USD) next to the goal; validation per currency.
- Approval: convert the goal to USDC with the day's rate (USD 1:1, EUR via ECB) — same place as today's EUR conversion.
- Display: `GoalAmount` replaces `EurAmount` for goals on cards, campaign page, admin, link preview; the header display currency keeps converting ("≈ converted (original)") from the goal currency.
- Tests: conversion for both currencies, display in a third currency (CHF), E2E creating a USD campaign.

## Order
After TASK-019 (donate widget) and TASK-020 (MCP server), unless David asks to move it up (US launch).
