import { useEffect, useRef, useState } from 'react'
import { AlarmClock, ClipboardCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { todayISO, formatDateShort } from '@/lib/format'
import type { AppUser } from '@/lib/session'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/**
 * A DAILY NUDGE, ASKED ONCE AND FOLLOWED UP ONCE.
 *
 * Work Assignments has no submit button — a login just ticks its own tasks
 * off through the day — so nothing on the screen itself says "you have not
 * looked at this today". Somebody who opens the app and goes straight to
 * Sales can go the whole day never seeing their own checklist.
 *
 * This is the two moments that fix that:
 *   1. The first time the app is opened today, ask outright, with a straight
 *      way in and a straight way to put it off.
 *   2. Half an hour before the deadline this login is judged against, if
 *      anything is still pending, say so again and make a sound of it — the
 *      one point in the day where "later" has run out.
 *
 * Both are asked at most once a day per login (kept in localStorage, so a
 * refresh mid-morning does not ask twice), and neither fires at all for a
 * login with no tasks on today's board — an admin with nothing assigned is
 * not nagged about a checklist that is not theirs.
 */
export function DailyWorkPopup({
  user,
  onOpen
}: {
  user: AppUser
  /** Take the user to Work Assignments and dismiss whichever popup is open. */
  onOpen: () => void
}): React.JSX.Element | null {
  const [stage, setStage] = useState<'none' | 'ask' | 'reminder'>('none')
  const [pending, setPending] = useState(0)
  const [deadlineLabel, setDeadlineLabel] = useState('')
  // The live value tick() reads. Reacting to `stage` in the effect's own
  // state would either restart the poll on every open/close or read a stage
  // frozen at mount — a ref is what a periodic callback needs to see the
  // CURRENT stage without either.
  const stageRef = useRef<'none' | 'ask' | 'reminder'>('none')

  useEffect(() => {
    let stop = false
    const uid = Number(user.id)
    if (!uid) return

    const askKey = `wp_ask_${uid}_${todayISO()}`
    const reminderKey = `wp_reminder_${uid}_${todayISO()}`

    async function tick(): Promise<void> {
      let board: Row
      try {
        board = await window.api.work.board(todayISO(), uid)
      } catch {
        return
      }
      if (stop) return
      const mine = (board.tasks || []).filter((t: Row) => Number(t.user_id) === uid)
      // No checklist today — nothing to ask about.
      if (!mine.length) return
      const outstanding = mine.filter((t: Row) => t.state === 'pending' || t.state === 'fixes').length
      setPending(outstanding)

      const me = (board.users || []).find((u: Row) => Number(u.id) === uid)
      const cutoff = String(me?.cutoff || board.cutoff || '18:30')
      const cutoffDay = me?.cutoff_day === 'next' || board.cutoff_day === 'next' ? 'next' : 'same'
      const [hh, mm] = cutoff.split(':').map((x: string) => Number(x) || 0)
      const deadline = new Date()
      if (cutoffDay === 'next') deadline.setDate(deadline.getDate() + 1)
      deadline.setHours(hh, mm, 0, 0)
      // Built off the deadline itself, not today's date — a next-day cut-off
      // falls on tomorrow, and the label has to say so.
      setDeadlineLabel(
        `${formatDateShort(
          `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}-${String(deadline.getDate()).padStart(2, '0')}`
        )} ${cutoff}`
      )

      const now = new Date()
      const reminderFrom = new Date(deadline.getTime() - 30 * 60 * 1000)

      // Asked once, the first time the app is open today — whichever popup
      // gets there first wins; they never show on top of one another.
      if (stageRef.current === 'none' && localStorage.getItem(askKey) !== '1') {
        localStorage.setItem(askKey, '1')
        stageRef.current = 'ask'
        setStage('ask')
        return
      }
      if (
        stageRef.current === 'none' &&
        outstanding > 0 &&
        now >= reminderFrom &&
        now < deadline &&
        localStorage.getItem(reminderKey) !== '1'
      ) {
        localStorage.setItem(reminderKey, '1')
        stageRef.current = 'reminder'
        setStage('reminder')
        playChime()
      }
    }

    // Once right away — this is what makes it "the first time the system is
    // opened today" rather than something waiting on the first poll — and
    // then every couple of minutes, so a login left open all day still gets
    // the reminder window instead of only ever seeing the ask.
    void tick()
    const id = window.setInterval(() => void tick(), 120000)
    return () => {
      stop = true
      window.clearInterval(id)
    }
    // Deliberately once per login session: re-running this on every render
    // would re-arm the "first open" check against a state that has already
    // decided it for today.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id])

  function dismiss(): void {
    stageRef.current = 'none'
    setStage('none')
  }

  function openNow(): void {
    stageRef.current = 'none'
    setStage('none')
    onOpen()
  }

  return (
    <Dialog open={stage !== 'none'} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {stage === 'reminder' ? (
              <AlarmClock className="h-5 w-5 text-amber-600" />
            ) : (
              <ClipboardCheck className="h-5 w-5 text-emerald-600" />
            )}
            {stage === 'reminder' ? "Cut-off's coming up" : 'Work assignments'}
          </DialogTitle>
        </DialogHeader>
        <div className="text-[13.5px] leading-[1.5] text-muted-foreground">
          {stage === 'reminder' ? (
            <>
              {pending} task{pending === 1 ? '' : 's'} still open on today&apos;s checklist, and the cut-off is at{' '}
              <span className="font-semibold text-foreground">{deadlineLabel}</span> — half an hour from now.
            </>
          ) : (
            <>Have you gone through today&apos;s work assignments yet?</>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={dismiss}>
            {stage === 'reminder' ? 'Later' : "I'll do it later"}
          </Button>
          <Button onClick={openNow} className="bg-emerald-600 hover:bg-emerald-700">
            Open work assignments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A short two-tone chime via the Web Audio API — no sound file to bundle or
// fail to load, and it plays whether the tab is showing Sales, Treasury, or
// anything else when the half-hour mark arrives. Browsers that block audio
// with no prior user gesture will simply skip it; every login here has
// already clicked something before this can ever fire.
function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const notes = [880, 660]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = ctx.currentTime + i * 0.22
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.4)
    })
    window.setTimeout(() => void ctx.close(), 1200)
  } catch {
    // Sound is a courtesy, not the point of the reminder — the dialog itself
    // still opens either way.
  }
}
