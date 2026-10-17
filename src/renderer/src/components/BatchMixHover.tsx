import { useEffect, useRef, useState } from "react";
import { Beaker, StickyNote } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatNum } from "@/lib/format";
import { cn } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

// One fetch per run per shape: the key carries what an edit would change, so
// an edited batch is read again and an untouched one never is.
const cache = new Map<string, Row>();

// THE SHORT FORMULATION, ON HOVER.
//
// The register says only "Production"; resting on it shows what the run was
// struck on — the recipe's parts (85:15, each with its share) from the version
// the batch pinned, or its own one-off mix — and what it actually drew out of
// the tanks. Read when first hovered, not with the register, so a page of
// forty runs costs nothing until someone asks.
export function BatchMixHover({
  row,
  remarks = "",
  mix: withMix = true,
  children,
}: {
  row: Row;
  /** The run's own remarks, shown first. */
  remarks?: string;
  /** False for a recirculation: it has no mix, only its remarks. */
  mix?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const key = `${row.id}|${row.qty}|${row.formulation_id ?? ""}|${row.formulation_version_id ?? ""}|${row.custom_items_json ?? ""}`;
  const [mix, setMix] = useState<Row | null>(() => cache.get(key) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || !withMix) return;
    const hit = cache.get(key);
    if (hit) {
      setMix(hit);
      return;
    }
    let live = true;
    setErr(null);
    window.api.production
      .mix(Number(row.id))
      .then((m) => {
        cache.set(key, m);
        if (live) setMix(m);
      })
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [open, key, row.id, withMix]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Open on rest, close a beat after the pointer leaves — long enough to
  // cross the gap onto the card itself without it vanishing underneath.
  const show = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 120);
  };
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 160);
  };

  const parts = (mix?.parts as Row[] | undefined) || [];
  const drawn = ((mix?.drawn as Row[] | undefined) || []).filter(
    (d) => n(d.qty) > 0,
  );
  const inputs = drawn.filter((d) => String(d.kind) === "input");
  const other = drawn.filter((d) => String(d.kind) !== "input");
  const uom = String(mix?.uom || row.uom || "MT");
  const lbl =
    "text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#5A6B62]";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className="cursor-help rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[#12855A]/40"
          aria-label={
            withMix ? "Show this run's formulation" : "Show this run's remarks"
          }
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        onMouseEnter={show}
        onMouseLeave={hide}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[300px] rounded-[6px] border-[#D6E2D6] bg-white p-0 shadow-[0_10px_30px_rgba(10,31,23,.16)]"
      >
        {!!remarks.trim() && (
          <div className="flex items-start gap-2 border-b border-[#F0E4C4] bg-[#FFFBF0] px-3.5 py-2.5">
            <StickyNote className="mt-0.5 h-3.5 w-3.5 flex-none text-[#8A5300]" />
            <div className="min-w-0">
              <div className="text-[9.5px] font-extrabold uppercase tracking-[.12em] text-[#8A5300]">
                Remarks
              </div>
              <div className="mt-0.5 whitespace-pre-wrap text-[12px] font-semibold leading-[1.45] text-[#33473E] [overflow-wrap:anywhere]">
                {remarks.trim()}
              </div>
            </div>
          </div>
        )}
        {!withMix ? (
          !remarks.trim() && (
            <div className="px-3.5 py-3 text-[12px] font-semibold text-[#8CA396]">
              No remarks on this run.
            </div>
          )
        ) : (
          <>
            <div className="flex items-start gap-2 border-b border-[#E4ECE3] bg-[#F4FBF6] px-3.5 py-2.5">
              <Beaker className="mt-0.5 h-3.5 w-3.5 flex-none text-[#0B6B45]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-extrabold text-[#0A1F17]">
                  {mix
                    ? String(mix.recipe_name || mix.product_name || "No recipe")
                    : String(row.formulation_name || row.product_name || "")}
                </div>
                <div className="text-[11px] font-semibold text-[#5A6B62]">
                  {formatNum(n(row.qty))} {uom} of{" "}
                  {String(row.product_name || "")}
                  {mix && n(mix.recipe_version) > 0
                    ? ` · v${mix.recipe_version}${n(mix.recipe_latest_version) > n(mix.recipe_version) ? ` of ${mix.recipe_latest_version}` : ""}`
                    : ""}
                </div>
              </div>
              {!!mix?.ratio && parts.length > 1 && (
                <span className="flex-none rounded-[3px] bg-[#0B3D2E] px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums text-[#C7F03F]">
                  {String(mix.ratio)}
                </span>
              )}
            </div>
            {err ? (
              <div className="px-3.5 py-3 text-[12px] font-semibold text-[#B3261E]">
                {err}
              </div>
            ) : !mix ? (
              <div className="px-3.5 py-3 text-[12px] font-semibold text-[#8CA396]">
                Reading the mix…
              </div>
            ) : (
              <div className="grid gap-2.5 px-3.5 py-3">
                {parts.length > 0 ? (
                  <div className="grid gap-1.5">
                    <div className={lbl}>Formulation</div>
                    {parts.map((p) => (
                      <div
                        key={String(p.product_id)}
                        className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5"
                      >
                        <span className="truncate text-[12px] font-bold text-[#0A1F17]">
                          {String(p.name)}
                        </span>
                        <span className="text-[11.5px] font-extrabold tabular-nums text-[#0B6B45]">
                          {formatNum(n(p.pct))}%
                        </span>
                        <div className="col-span-2 h-1 overflow-hidden rounded-full bg-[#EAF0E9]">
                          <div
                            className="h-full rounded-full bg-[#12855A]"
                            style={{ width: `${Math.min(100, n(p.pct))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11.5px] font-semibold text-[#5A6B62]">
                    No recipe on this run
                    {inputs.length ? " — it took from stock as below." : "."}
                  </div>
                )}
                {(inputs.length > 0 || other.length > 0) && (
                  <div
                    className={cn(
                      "grid gap-1",
                      parts.length > 0 &&
                        "border-t border-dashed border-[#E4ECE3] pt-2",
                    )}
                  >
                    <div className={lbl}>Drew from stock</div>
                    {inputs.map((d) => (
                      <div
                        key={`i${d.product_id}`}
                        className="flex items-baseline justify-between gap-2 text-[11.5px]"
                      >
                        <span className="truncate font-semibold text-[#33473E]">
                          {String(d.name)}
                        </span>
                        <span className="flex-none font-bold tabular-nums text-[#0A1F17]">
                          {formatNum(n(d.qty))}{" "}
                          <span className="text-[10px] font-semibold text-[#5A6B62]">
                            {uom}
                          </span>
                        </span>
                      </div>
                    ))}
                    {other.map((d) => (
                      <div
                        key={`${d.kind}${d.product_id}`}
                        className="flex items-baseline justify-between gap-2 text-[11.5px]"
                      >
                        <span className="truncate font-semibold text-[#5A6B62]">
                          {String(d.name)}{" "}
                          <span className="text-[10px] font-extrabold uppercase tracking-[.05em]">
                            ·{" "}
                            {String(d.kind) === "loss" ? "loss" : "by-product"}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "flex-none font-bold tabular-nums",
                            String(d.kind) === "loss"
                              ? "text-[#B3261E]"
                              : "text-[#0B6B45]",
                          )}
                        >
                          {formatNum(n(d.qty))}{" "}
                          <span className="text-[10px] font-semibold text-[#5A6B62]">
                            {uom}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
