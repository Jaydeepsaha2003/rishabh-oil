// THE GST RATES THAT APPLY TO A PARTY ("5, 18" on its master) as quick picks
// under a GST % box — the one in use lit. Any rate can still be typed.
export function GstRateChips({ rates, value, onPick }: { rates: unknown; value: unknown; onPick: (v: string) => void }): React.JSX.Element | null {
  const list = [...new Set(String(rates || '').split(/[\s,;/]+/).map((x) => x.replace('%', '').trim()).filter((x) => x !== '' && Number.isFinite(Number(x))))]
  if (list.length < 2) return null
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((r) => {
        const on = Number(r) === Number(value)
        return (
          <button
            key={r}
            type="button"
            onClick={() => onPick(r)}
            className={
              'rounded-full border px-2 py-0.5 text-[10.5px] font-bold tabular-nums ' +
              (on ? 'border-[#0B3D2E] bg-[#0B3D2E] text-white' : 'border-[#C3D2C6] bg-white text-[#33473E] hover:bg-[#EDF3EC]')
            }
          >
            {r}%
          </button>
        )
      })}
    </div>
  )
}
