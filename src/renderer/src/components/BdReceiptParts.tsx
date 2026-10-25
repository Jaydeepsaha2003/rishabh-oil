import { useCallback, useEffect, useState } from "react";
import { SearchSelect } from '@/components/SearchSelect'
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatINR, todayISO } from "@/lib/format";
import { cn } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

// RECEIVED FROM THE NBFC IN PARTS (SID). Every leg the NBFC has released on
// this bill — each with its own internal reference (GB10/R2), its own days to
// maturity and its own interest — and the next one: when it landed, how much,
// into which bank. The first leg is the Payment received itself; only the
// latest later leg can be taken back.
export function BdReceiptParts({
  row,
  banks,
  onClose,
  onChanged,
}: {
  row: Row | null;
  banks: Row[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}): React.JSX.Element {
  const [parts, setParts] = useState<Row[]>([]);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState("");
  const [note, setNote] = useState("");
  // This part's own maturity and rates; blank = the bill's.
  const [due, setDue] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [marginPct, setMarginPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [undoAsk, setUndoAsk] = useState(false);

  const drawn = round2(n(row?.amount));
  const received = round2(parts.reduce((t, p) => t + n(p.amount), 0));
  const left = round2(Math.max(0, drawn - received));
  const interest = round2(parts.reduce((t, p) => t + n(p.interest), 0));
  const last = parts.length
    ? String(parts[parts.length - 1].date || "").slice(0, 10)
    : String(row?.payment_received_date || "").slice(0, 10);
  const billMaturity = String(row?.maturity_date || "").slice(0, 10);
  const maturity = due || billMaturity;
  // A PID paid straight to the supplier: its parts go to them, not our bank.
  const toSupplier = String(row?.disbursement_route || "") === "supplier";
  const partyLabel = String(row?.party_name || "the supplier");
  const closed = String(row?.status || "") === "repaid";
  const deducted =
    !row?.interest_upfront && String(row?.interest_mode || "") !== "serviced";

  const reload = useCallback(async () => {
    if (!row) return;
    const ps =
      ((await window.api.billDiscounting
        .receiptParts(Number(row.id))
        .catch(() => [] as Row[])) as Row[]) || [];
    setParts(ps);
    const got = ps.reduce((t, p) => t + n(p.amount), 0);
    const rest = round2(Math.max(0, n(row.amount) - got));
    setAmount(rest > 0 ? String(rest) : "");
  }, [row]);
  useEffect(() => {
    setErr(null);
    setUndoAsk(false);
    setDate(todayISO());
    setNote("");
    setDue(String(row?.maturity_date || "").slice(0, 10));
    setRatePct(row?.interest_pct == null ? "" : String(row.interest_pct));
    setMarginPct(row?.margin_pct == null ? "" : String(row.margin_pct));
    setAccount(String(row?.disbursement_account || ""));
    void reload();
  }, [reload, row]);

  // This leg's interest, the way the server works it: its own days to maturity.
  const amt = round2(n(amount));
  const days =
    date && maturity
      ? Math.max(
          0,
          Math.round(
            (new Date(`${maturity}T00:00:00`).getTime() -
              new Date(`${date}T00:00:00`).getTime()) /
              86400000,
          ) + (row?.days_incl_start ? 1 : 0),
        )
      : 0;
  const legInterest = round2(
    (amt * (ratePct.trim() === "" ? n(row?.interest_pct) : n(ratePct)) * days) /
      (100 * (n(row?.days_year) || 360)),
  );
  const nextNo = (parts.length ? n(parts[parts.length - 1].part_no) : 1) + 1;
  const nextRef = `${String(row?.bd_no || `BD${n(row?.id)}`)}/R${nextNo}`;

  async function save(): Promise<void> {
    if (!row) return;
    if (amt <= 0) return setErr("Enter the amount the NBFC released");
    if (amt > left + 0.005)
      return setErr(`Only ${formatINR(left)} is still to come on this bill`);
    if (!date) return setErr("Pick the date the money landed");
    if (date > todayISO())
      return setErr("The receipt date cannot be in the future");
    if (last && date < last)
      return setErr(
        `The last part landed on ${formatDate(last)} — this one cannot be dated before it`,
      );
    if (maturity && date > maturity)
      return setErr("A part cannot be received after its maturity date");
    if (!toSupplier && !account) return setErr("Pick the bank the money landed in");
    setBusy(true);
    setErr(null);
    try {
      const r = await window.api.billDiscounting.receivePart(Number(row.id), {
        date,
        amount: amt,
        account: toSupplier ? null : account,
        note,
        maturity: due || null,
        interest_pct: ratePct,
        margin_pct: marginPct,
      });
      toast.success(
        `${r.ref}: ${formatINR(amt)} received${deducted ? ` · interest ${formatINR(r.interest)}` : ""}`,
      );
      setNote("");
      await onChanged();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function undoLast(): Promise<void> {
    if (!row) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await window.api.billDiscounting.removeReceiptPart(
        Number(row.id),
      );
      toast.success(`${r.ref} taken back — its voucher is removed`);
      setUndoAsk(false);
      await onChanged();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pct =
    drawn > 0 ? Math.min(100, Math.round((received / drawn) * 100)) : 0;
  const lbl =
    "text-[10.5px] font-extrabold uppercase tracking-[.1em] text-[#5A6B62]";
  const lastPart = parts[parts.length - 1];
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#D6E2D6] bg-[#F2F6F1] p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-0 bg-[#0B3D2E] px-5 py-4 text-left">
          <div className="text-[11px] font-extrabold uppercase tracking-[.14em] text-[#8FBFA8]">
            {toSupplier ? "Paid to the supplier" : "Received from the NBFC"}
          </div>
          <DialogTitle className="mt-1 text-[18px] font-bold text-white">
            Parts — BD {String(row?.bd_no || "")}
          </DialogTitle>
          <p className="mt-1 text-[12px] font-semibold text-[#8FBFA8]">
            What {String(row?.nbfc_name || "the NBFC")} has{" "}
            {toSupplier ? `paid ${partyLabel}` : "released"} on this bill,
            part by part. Each part runs its own interest to its own maturity.
          </p>
        </DialogHeader>
        <div className="grid gap-3.5 p-4">
          <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
            <div className="grid grid-cols-2 divide-x divide-y divide-[#E4ECE3] sm:grid-cols-4 sm:divide-y-0">
              {[
                { k: "Drawn on the bill", v: drawn, tone: "text-[#0A1F17]" },
                {
                  k: `Received · ${parts.length} ${parts.length === 1 ? "part" : "parts"}`,
                  v: received,
                  tone: "text-[#0B6B45]",
                },
                {
                  k: "Still to come",
                  v: left,
                  tone: left > 0.005 ? "text-[#8A5300]" : "text-[#8CA396]",
                },
                { k: "Interest so far", v: interest, tone: "text-[#B3261E]" },
                ...(parts.some((p) => p.margin_pct != null)
                  ? [
                      {
                        k: "Margin on the parts",
                        v: round2(parts.reduce((t, p) => t + n(p.margin), 0)),
                        tone: "text-[#0A1F17]",
                      },
                    ]
                  : []),
              ].map((c) => (
                <div key={c.k} className="px-4 py-3">
                  <div className={lbl}>{c.k}</div>
                  <div
                    className={cn(
                      "mt-1 text-[16px] font-bold tabular-nums",
                      c.tone,
                    )}
                  >
                    {formatINR(c.v)}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-[#E4ECE3] px-4 py-2.5">
              <div className="h-2 overflow-hidden rounded-full bg-[#EAF0E9]">
                <div
                  className="h-full rounded-full bg-[#12855A]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1 text-[11.5px] font-semibold text-[#5A6B62]">
                {left > 0.005 ? `${pct}% received` : "Received in full"}
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-[6px] border border-[#D6E2D6] bg-white">
            {/* Sideways inside the card on a narrow screen, never cut off. */}
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                <div
                  className="grid items-center gap-2 border-b border-[#E4ECE3] bg-[#F7FAF6] px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.1em] text-[#33473E]"
                  style={{
                    gridTemplateColumns:
                      "84px 88px 88px minmax(100px,1fr) 44px 104px 110px 104px",
                  }}
                >
                  <span>Reference</span>
                  <span>Landed</span>
                  <span>Matures</span>
                  <span>{toSupplier ? "Paid to" : "Bank"}</span>
                  <span className="text-right">Days</span>
                  <span className="text-right">Received</span>
                  <span className="text-right">Interest</span>
                  <span className="text-right">{toSupplier ? "To the supplier" : "To the bank"}</span>
                </div>
                <div className="divide-y divide-[#EEF3ED]">
                  {parts.map((p) => (
                    <div
                      key={String(p.part_no)}
                      className="grid items-center gap-2 px-4 py-2.5 text-[12.5px]"
                      style={{
                        gridTemplateColumns:
                          "84px 88px 88px minmax(100px,1fr) 44px 104px 110px 104px",
                      }}
                    >
                      <span className="font-extrabold tabular-nums text-[#0A1F17]">
                        {String(p.ref)}
                      </span>
                      <span className="tabular-nums text-[#33473E]">
                        {formatDate(String(p.date || ""))}
                      </span>
                      <span className="tabular-nums text-[#33473E]">
                        {formatDate(String(p.maturity || ""))}
                      </span>
                      <span
                        className="truncate text-[11.5px] font-semibold text-[#5A6B62]"
                        title={String(p.account || "")}
                      >
                        {String(p.account || "—")}
                      </span>
                      <span className="text-right tabular-nums text-[#33473E]">
                        {n(p.days)}
                      </span>
                      <span className="text-right font-bold tabular-nums">
                        {formatINR(n(p.amount))}
                      </span>
                      <span className="text-right tabular-nums text-[#B3261E]">
                        {formatINR(n(p.interest))}
                        <span className="block text-[10px] font-semibold text-[#5A6B62]">
                          @ {n(p.interest_pct)}%
                          {p.margin_pct != null ? ` · margin ${n(p.margin_pct)}%` : ""}
                        </span>
                      </span>
                      <span className="text-right font-bold tabular-nums text-[#0B6B45]">
                        {formatINR(n(p.net))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {!closed && lastPart && n(lastPart.part_no) > 1 && !undoAsk && (
              <div className="border-t border-[#EEF3ED] px-4 py-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setUndoAsk(true)}
                  className="h-8 gap-1 px-2 text-[11px] font-bold text-[#B3261E]"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Take back{" "}
                  {String(lastPart.ref)}
                </Button>
              </div>
            )}
            {undoAsk && lastPart && (
              <div className="flex flex-wrap items-center gap-2 border-t border-[#F0D6D4] bg-[#FDF3F2] px-4 py-2.5">
                <span className="min-w-0 flex-1 text-[12px] font-bold text-[#8C2F26]">
                  Take back {String(lastPart.ref)} (
                  {formatINR(n(lastPart.amount))})? Its receipt voucher is
                  deleted and the interest falls back.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setUndoAsk(false)}
                  className="h-8 px-3 text-[11px] font-bold"
                >
                  Keep it
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void undoLast()}
                  className="h-8 bg-[#B3261E] px-3 text-[11px] font-bold text-white hover:bg-[#9A1F18]"
                >
                  Take back
                </Button>
              </div>
            )}
          </section>

          {left > 0.005 && !closed && (
            <section className="overflow-hidden rounded-[6px] border border-[#BFE3CB] bg-white">
              <div className="flex items-center border-b border-[#BFE3CB] bg-[#F4FBF6] px-4 py-2.5 text-[10.5px] font-extrabold uppercase tracking-[.13em] text-[#0B6B45]">
                {toSupplier ? "Pay the supplier the next part" : "Receive the next part"}
                <span className="ml-auto rounded-[3px] bg-[#EAF6EC] px-2 py-0.5 text-[11px] font-bold normal-case tracking-normal">
                  {nextRef}
                </span>
              </div>
              <div className="grid gap-3.5 p-4 sm:grid-cols-2">
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>{toSupplier ? "Paid on *" : "Landed on *"}</span>
                  <DatePicker
                    value={date}
                    onChange={setDate}
                    min={last || undefined}
                    max={todayISO()}
                  />
                  <span className="text-[11.5px] font-semibold text-[#5A6B62]">
                    {days > 0
                      ? `${days} days to maturity`
                      : "On or after the last part, up to today."}
                  </span>
                </div>
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>Part's amount (₹) *</span>
                  <div className="relative">
                    <Input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="h-11 pr-[120px] text-[14px] font-bold"
                    />
                    {Math.abs(amt - left) > 0.005 && (
                      <button
                        type="button"
                        onClick={() => setAmount(String(left))}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[3px] border border-[#BFE3CB] bg-[#F4FBF6] px-2 py-1 text-[10.5px] font-extrabold text-[#0B6B45]"
                      >
                        The rest
                      </button>
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[11.5px] font-semibold",
                      amt > left + 0.005 ? "text-[#B3261E]" : "text-[#5A6B62]",
                    )}
                  >
                    {amt > left + 0.005
                      ? `More than the ${formatINR(left)} still to come`
                      : deducted
                        ? `Interest ${formatINR(legInterest)} · ${formatINR(round2(amt - legInterest))} reaches ${toSupplier ? partyLabel : "the bank"}`
                        : `The whole amount reaches ${toSupplier ? partyLabel : "the bank"} — interest is settled separately`}
                  </span>
                </div>
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>Matures on *</span>
                  <DatePicker value={due} onChange={setDue} min={date || undefined} />
                </div>
                <div className="grid grid-cols-2 content-start gap-2">
                  <div className="grid gap-1.5">
                    <span className={lbl}>Interest % p.a.</span>
                    <Input
                      type="number"
                      value={ratePct}
                      placeholder={String(row?.interest_pct ?? "")}
                      onChange={(e) => setRatePct(e.target.value)}
                      className="h-10"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <span className={lbl}>Margin %</span>
                    <Input
                      type="number"
                      value={marginPct}
                      placeholder={String(row?.margin_pct ?? "")}
                      onChange={(e) => setMarginPct(e.target.value)}
                      className="h-10"
                    />
                  </div>
                </div>
                {!toSupplier && (
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>Into the bank *</span>
                  <SearchSelect value={account} options={banks.map((a) => String(a.name))} onChange={setAccount} placeholder="Pick the bank" className="h-10 w-full rounded-md border-input text-sm" />
                </div>
                )}
                <div className="grid content-start gap-1.5">
                  <span className={lbl}>Note</span>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="NBFC advice no., UTR"
                    className="h-10"
                  />
                </div>
              </div>
              <div className="border-t border-[#E4ECE3] bg-[#FBFCFA] px-4 py-2 text-[11.5px] font-semibold text-[#5A6B62]">
                Posts {toSupplier ? "a Journal" : "a Receipt"} {nextRef} on that date: Dr{" "}
                {toSupplier ? partyLabel : account || "the bank"}
                {deducted ? " + Dr Interest on bill discounting" : ""} · Cr
                Bills discounted — {String(row?.nbfc_name || "NBFC")}.
              </div>
            </section>
          )}
          {err && (
            <div className="rounded-[4px] border border-[#F0D6D4] bg-[#FDF3F2] px-3.5 py-2.5 text-[12.5px] font-bold text-[#B3261E]">
              {err}
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-[#D6E2D6] bg-white px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {left > 0.005 && !closed && (
            <Button
              className="bg-[#0B3D2E] text-[#C7F03F] hover:bg-[#0F4A38]"
              onClick={() => void save()}
              disabled={busy}
            >
              {busy ? "Saving…" : `Receive ${nextRef}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
