/* @ds-bundle: {"format":4,"namespace":"Cherrio","components":[{"name":"Button"},{"name":"StatusChip"},{"name":"Field"},{"name":"Progress"},{"name":"CampaignCard"},{"name":"ProofLink"},{"name":"MilestoneTrack"},{"name":"VoteMeter"},{"name":"TrustScore"},{"name":"LedgerTable"},{"name":"Address"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  function cx() { return Array.prototype.slice.call(arguments).filter(Boolean).join(" "); }
  function omit(o, keys) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k) && keys.indexOf(k) < 0) r[k] = o[k]; } return r; }
  /* Human layer: euros, no decimals. Proof layer: USDC, 2 decimals. */
  function eur(n) { return "€" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  function usdc(n) { return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function money(n, cur) { return cur === "USDC" ? usdc(n) + " USDC" : eur(n); }
  function pct(a, b) { return b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0; }
  function short(a) { a = String(a || ""); return a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a; }

  function Button(p) {
    var v = p.variant || "secondary";
    return h("button", Object.assign({ type: "button" }, omit(p, ["variant", "size", "block", "className"]), {
      className: cx("ch-btn", "ch-btn-" + v, p.size === "lg" && "ch-btn-lg", p.block && "ch-btn-block", p.className)
    }), p.children);
  }

  /* Plain-language labels; the contract state stays in the key. */
  var STATUS = {
    live: ["ch-chip-live", "●", "Raising"],
    voting: ["ch-chip-voting", "◐", "Donors reviewing"],
    succeeded: ["ch-chip-solid", "✓", "Goal reached"],
    completed: ["ch-chip-solid", "✓", "Completed"],
    verified: ["ch-chip-solid", "✓", "Verified"],
    pending: ["ch-chip-outline", "○", "In review"],
    imported: ["ch-chip-outline", "○", "Not on CHERR.IO yet"],
    "needs-review": ["ch-chip-hatch", "!", "Team reviewing"],
    frozen: ["ch-chip-hatch-accent", "‖", "Paused"],
    failed: ["ch-chip-danger", "✕", "Unsuccessful"],
    rejected: ["ch-chip-danger", "✕", "Rejected by donors"]
  };
  function StatusChip(p) {
    var s = STATUS[p.status] || STATUS.pending;
    return h("span", { className: cx("ch-chip", s[0]) },
      h("span", { className: "ch-chip-glyph", "aria-hidden": "true" }, s[1]),
      p.children || s[2]);
  }

  function Field(p) {
    var id = p.id || ("f-" + String(p.label || "field").toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    var inputProps = omit(p, ["label", "hint", "error", "suffix", "mono", "id"]);
    return h("div", { className: cx("ch-field", p.error && "ch-field-error") },
      h("label", { className: "ch-label", htmlFor: id }, p.label),
      h("div", { className: "ch-field-row" },
        h("input", Object.assign({ id: id, className: cx("ch-input", p.mono && "ch-input-mono"), "aria-invalid": p.error ? "true" : undefined }, inputProps)),
        p.suffix ? h("span", { className: "ch-field-suffix" }, p.suffix) : null),
      (p.error || p.hint) ? h("div", { className: "ch-field-hint" }, p.error || p.hint) : null);
  }

  function Progress(p) {
    var cur = p.currency || "EUR", th = p.threshold == null ? 0.1 : p.threshold;
    var w = pct(p.raised, p.target);
    return h("div", { className: "ch-progress" },
      h("div", { className: "ch-progress-figures" },
        h("span", { className: "ch-progress-raised" }, money(p.raised, cur)),
        h("span", { className: "ch-progress-target" }, "raised of ", money(p.target, cur))),
      h("div", { className: "ch-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(w), "aria-label": "Raised " + Math.round(w) + "% of goal" },
        h("div", { className: "ch-bar-fill", style: { width: w + "%" }, "data-full": w >= 100 ? "true" : "false" }),
        h("div", { className: "ch-bar-tick", style: { left: (th * 100) + "%" }, title: "Campaign succeeds from here" })),
      h("div", { className: "ch-progress-meta" },
        h("span", null, Math.floor(w) + "% of goal"),
        h("span", null, w >= th * 100 ? "✓ Campaign will succeed" : "Succeeds at " + Math.round(th * 100) + "% (" + money(p.target * th, cur) + ")"),
        p.meta ? h("span", null, p.meta) : null));
  }

  function CampaignCard(p) {
    return h("article", { className: cx("ch-card", p.featured && "ch-card-featured") },
      h("div", { className: "ch-card-media" },
        p.image ? h("img", { src: p.image, alt: p.imageAlt || "" }) : null,
        h(StatusChip, { status: p.status || "live" })),
      h("div", { className: "ch-card-body" },
        h("div", { className: "ch-card-org" },
          p.verified ? h("span", { className: "ch-verified", title: "Verified organization" }, "✓") : null,
          h("span", null, p.org)),
        h("h3", { className: "ch-card-title" }, p.title),
        h(Progress, { raised: p.raised, target: p.target, currency: p.currency }),
        h("div", { className: "ch-card-foot" },
          h("span", null, (p.donors || 0) + " donors"),
          h("span", null, p.daysLeft != null ? p.daysLeft + " days left" : "Ended"))));
  }

  /* The one bridge from the human layer to the proof layer. */
  function ProofLink(p) {
    return h("a", { className: "ch-proof", href: p.href || "#proof", target: p.external ? "_blank" : undefined, rel: p.external ? "noreferrer" : undefined },
      h("span", { className: "ch-proof-mark", "aria-hidden": "true" }, "✓"),
      h("span", null, p.children || "Verified on blockchain"),
      h("span", { "aria-hidden": "true" }, p.external ? "↗" : "↓"));
  }

  var MS = { released: "✓ Paid out", voting: "◐ Donors reviewing receipts", locked: "□ Locked until approved", rejected: "✕ Returned to donors" };
  function MilestoneTrack(p) {
    var cur = p.currency || "EUR";
    return h("ol", { className: "ch-ms", style: { listStyle: "none", margin: 0, padding: 0 } },
      (p.tranches || []).map(function (t, i) {
        return h("li", { className: "ch-ms-step", "data-state": t.state, key: i },
          h("span", { className: "ch-label" }, t.label || ("Step " + (i + 1))),
          h("span", { className: "ch-ms-amt" }, money(t.amount, cur)),
          h("span", { className: "ch-ms-state" }, MS[t.state] || t.state));
      }));
  }

  function VoteMeter(p) {
    var q = p.quorum == null ? 50 : p.quorum, pass = p.pass == null ? 51 : p.pass;
    var tOk = p.turnout >= q, aOk = p.approval >= pass;
    function line(label, val, need, ok, yes, no) {
      return h("div", { className: "ch-vote-line" },
        h("div", { className: "ch-vote-top" }, h("span", { className: "ch-vote-q" }, label), h("b", null, Math.round(val) + "%")),
        h("div", { className: "ch-bar", style: { height: 20 } },
          h("div", { className: "ch-bar-fill", style: { width: Math.min(100, val) + "%", background: ok ? "var(--ink)" : "var(--accent)" } }),
          h("div", { className: "ch-bar-tick", style: { left: need + "%" } })),
        h("div", { className: "ch-vote-verdict" }, ok ? "✓ " + yes : "✕ " + no + " (needs " + need + "%)"));
    }
    return h("section", { className: "ch-vote", "aria-label": "Donor vote" },
      line("Donors who voted", p.turnout, q, tOk, "Enough donors voted", "Not enough donors yet"),
      line("Votes to approve", p.approval, pass, aOk, "Receipts approved", "Not approved"),
      p.closesIn ? h("div", { className: "ch-vote-verdict" }, "Voting closes in " + p.closesIn) : null);
  }

  function TrustScore(p) {
    return h("section", { className: "ch-trust", "aria-label": "Trust Score" },
      h("div", { className: "ch-trust-head" },
        h("div", null,
          h("div", { className: "ch-label" }, "Trust Score"),
          h("div", { className: "ch-trust-score" }, Math.round(p.score), h("small", null, " /100"))),
        h(StatusChip, { status: p.imported ? "imported" : "verified" })),
      (p.components || []).map(function (c) {
        return h("div", { className: "ch-trust-row", key: c.label },
          h("span", null, c.label),
          h("span", { className: "ch-trust-meter", "aria-hidden": "true" }, h("span", { style: { width: Math.round(c.value * 100) + "%" } })),
          h("span", { className: "ch-trust-val" }, Math.round(c.value * 100)));
      }),
      h("div", { className: "ch-trust-note" }, "Formula " + (p.version || "v1") + (p.imported ? " · capped at 40 until the charity joins" : "") + " · How it’s calculated ↗"));
  }

  function LedgerTable(p) {
    var base = p.explorerBase || "https://polygonscan.com/tx/";
    return h("div", { className: "ch-ledger-wrap" },
      h("table", { className: "ch-ledger" },
        p.caption ? h("caption", { className: "ch-label", style: { textAlign: "left", padding: "8px 12px" } }, p.caption) : null,
        h("thead", null, h("tr", null,
          h("th", null, "Time (UTC)"), h("th", null, "From"), h("th", { className: "ch-num" }, "Amount USDC"), h("th", null, "Tx"))),
        h("tbody", null, (p.rows || []).map(function (r, i) {
          return h("tr", { key: r.tx || i },
            h("td", { className: "ch-ledger-muted" }, r.time),
            h("td", null, r.label || short(r.from)),
            h("td", { className: "ch-num" }, usdc(r.amount)),
            h("td", null, h("a", { href: base + r.tx, target: "_blank", rel: "noreferrer" }, short(r.tx) + " ↗")));
        }))));
  }

  function Address(p) {
    var st = React.useState(false), copied = st[0], setCopied = st[1];
    function copy() {
      try { navigator.clipboard.writeText(p.value).then(function () { setCopied(true); setTimeout(function () { setCopied(false); }, 1200); }, function () {}); } catch (e) {}
    }
    return h("span", { className: "ch-addr", title: p.value },
      h("span", { className: "ch-addr-text" }, p.full ? p.value : short(p.value)),
      h("button", { type: "button", onClick: copy, "aria-label": "Copy address" }, copied ? "Copied" : "Copy"));
  }

  window.Cherrio = Object.assign(window.Cherrio || {}, {
    Button: Button, StatusChip: StatusChip, Field: Field, Progress: Progress, CampaignCard: CampaignCard, ProofLink: ProofLink,
    MilestoneTrack: MilestoneTrack, VoteMeter: VoteMeter, TrustScore: TrustScore, LedgerTable: LedgerTable, Address: Address,
    format: { eur: eur, usdc: usdc, address: short }
  });
})();
