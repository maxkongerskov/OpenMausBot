// A small brand cursor that hangs above Automations. Same face engine as
// the bots. Clicking it turns the arrow into the question — no trash icon.
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";
import { MausAvatar } from "./Avatar";

const ARM_MS = 280;

export function ClearTeamSprite() {
  const { state, dispatch } = useStore();
  const [asking, setAsking] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressing, setPressing] = useState(false);
  const rootRef = useRef<HTMLButtonElement>(null);
  const armedRef = useRef(false);
  const pressTimer = useRef<number | null>(null);

  const bots = state.bots;
  useEffect(() => {
    if (bots.length === 0) setAsking(false);
  }, [bots.length]);

  useEffect(() => {
    if (!asking && !pressing) {
      armedRef.current = false;
      return;
    }
    const arm = asking
      ? window.setTimeout(() => {
          armedRef.current = true;
        }, ARM_MS)
      : null;
    const cancel = () => {
      if (pressTimer.current) window.clearTimeout(pressTimer.current);
      setPressing(false);
      setAsking(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      cancel();
    };
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) cancel();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      if (arm) window.clearTimeout(arm);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [asking, pressing]);

  useEffect(() => {
    return () => {
      if (pressTimer.current) window.clearTimeout(pressTimer.current);
    };
  }, []);

  if (bots.length === 0) return null;

  const face = asking ? "surprised" : hovered ? "curious" : "playful";

  const confirm = () => {
    const ids = bots.map((bot) => bot.id);
    setAsking(false);
    for (const botId of ids) dispatch({ type: "deleteBot", botId });
  };

  return (
    <div className="flex justify-center pb-1 pt-0.5">
      <button
        ref={rootRef}
        type="button"
        aria-label={asking ? "Delete all bots?" : "Clear the team"}
        aria-expanded={asking}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (!asking) {
            setPressing(true);
            if (pressTimer.current) window.clearTimeout(pressTimer.current);
            pressTimer.current = window.setTimeout(() => {
              setPressing(false);
              setAsking(true);
            }, 160);
            return;
          }
          if (armedRef.current) confirm();
        }}
        className="relative flex h-11 w-[9.5rem] items-center justify-center overflow-visible rounded-xl"
      >
        <span
          className={cn(
            "pointer-events-none absolute transition-opacity duration-200 ease-in-out",
            asking ? "opacity-0" : "opacity-100",
            pressing && "animate-mascot-press",
          )}
        >
          <MausAvatar color="green" state={face} size={34} animated />
        </span>
        <span
          className={cn(
            "pointer-events-none whitespace-nowrap text-[13px] font-medium tracking-tight text-ink transition-opacity duration-200 ease-in-out",
            asking ? "opacity-100" : "opacity-0",
          )}
        >
          delete all bots?
        </span>
      </button>
    </div>
  );
}
