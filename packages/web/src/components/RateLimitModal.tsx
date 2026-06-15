import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { useAtom } from "rxfy-react";
import { rateLimitEvent$ } from "../lib/atoms";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export function RateLimitModal() {
  const [event, setEvent] = useAtom(rateLimitEvent$);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!event) return;
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, [event]);

  if (!event) return null;

  const msRemaining = Math.max(0, event.resetAt.getTime() - now.getTime());
  const minutesRemaining = Math.floor(msRemaining / 60_000);
  const secondsRemaining = Math.floor((msRemaining % 60_000) / 1_000);
  const usedPct = Math.min(100, (event.used / event.limit) * 100);

  return (
    <Dialog open onOpenChange={(open) => !open && setEvent(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Usage limit reached</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>You&apos;ve used your hourly LLM token allowance.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                <Trans>Tokens used this hour</Trans>
              </span>
              <span>
                {event.used.toLocaleString()} / {event.limit.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-destructive" style={{ width: `${usedPct}%` }} />
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            {msRemaining > 0 ? (
              <Trans>
                Resets in {minutesRemaining}m {secondsRemaining}s
              </Trans>
            ) : (
              <Trans>Tokens restored — you can try again.</Trans>
            )}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setEvent(null)}>
            <Trans>Got it, I&apos;ll wait</Trans>
          </Button>
          <Button disabled>
            <Trans>Upgrade for unlimited access</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
