"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import {
  QrCode,
  RefreshCw,
  Radio,
  Loader2,
  ShieldCheck,
  Users,
  CheckCircle2,
  Activity,
  AlertTriangle,
  Clock,
  WifiOff,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  useEvents,
  useEventSecret,
  useEventAttendance,
} from "@/lib/api-client";
import {
  generateQrPayload,
  msUntilNextBlock,
  msUntilNextSubFrame,
  TOKEN_WINDOW_MS,
  SUB_FRAME_MS,
} from "@/lib/qr-token-client";
import { useAttendanceSocket } from "@/hooks/use-attendance-socket";

// Rotating check-in code projected on the room screen.
// A fresh signed code appears every 15 seconds so a photo of the screen
// can't be reused by a student who isn't actually in the room.
//
// v16-B additions:
//   - Fullscreen mode (Fullscreen API) for projection on a projector or TV
//   - Larger, more prominent QR code
//   - Responsive layout (mobile/tablet/desktop)
//   - Visible refresh timer + live/connected indicators
export function ProjectQrView() {
  const { data: eventsData } = useEvents();
  const events = eventsData?.events ?? [];

  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const eventId = selectedEventId ?? events[0]?.id ?? null;

  const secretQ = useEventSecret(eventId);
  // Create the socket first so we can use its connected state to control polling.
  const socket = useAttendanceSocket(eventId);
  // Poll only when the socket is disconnected (fallback). When connected,
  // socket.io pushes realtime updates — no polling needed.
  const presenceQ = useEventAttendance(eventId, {
    socketConnected: socket.connected,
  });

  const [token, setToken] = useState<string>("");
  const [block, setBlock] = useState<number>(0);
  const [subFrame, setSubFrame] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());

  // ---- Fullscreen state ----
  // We fullscreen the <main> wrapper ref. The `isFullscreen` flag drives
  // the layout switch (minimal UI vs. full dashboard).
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  // ---- v8: Refresh the QR at 2 FPS (every SUB_FRAME_MS = 500ms) ----
  // Each sub-frame has a unique HMAC, so a single photo captures only
  // 1 sub-frame. The scanner must capture MIN_SUB_FRAMES (3) consecutive
  // sub-frames to prove liveness (Tier 2 anti-screenshot).
  useEffect(() => {
    const secret = secretQ.data?.eventSecret;
    if (!secret || eventId == null) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const t = await generateQrPayload(eventId, secret);
        if (cancelled) return;
        setToken(t.payload);
        setBlock(t.timeBlock);
        setSubFrame(t.subFrame);
      } catch {
        // Web Crypto hiccup — next tick will retry.
      }
    };
    // Initial render immediately
    const initial = setTimeout(tick, 0);
    const cleanup: Array<() => void> = [() => clearTimeout(initial)];

    // Align to the next sub-frame boundary, then tick every SUB_FRAME_MS
    const alignMs = msUntilNextSubFrame() + 10;
    const aligned = setTimeout(() => {
      tick();
      const interval = setInterval(tick, SUB_FRAME_MS);
      cleanup.push(() => clearInterval(interval));
    }, alignMs);
    cleanup.push(() => clearTimeout(aligned));

    return () => {
      cancelled = true;
      cleanup.forEach((fn) => fn());
    };
  }, [secretQ.data?.eventSecret, eventId]);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(i);
  }, []);

  // ---- Fullscreen API wiring ----
  // `requestFullscreen()` returns a Promise that rejects on some browsers
  // (e.g. if the user hasn't interacted with the page yet, or the element
  // is not in the DOM). We swallow those errors and rely on the
  // `fullscreenchange` event to keep our state in sync.
  const enterFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: "hide" });
      } else if (
        (
          el as HTMLDivElement & {
            webkitRequestFullscreen?: () => Promise<void>;
          }
        ).webkitRequestFullscreen
      ) {
        await (
          el as HTMLDivElement & {
            webkitRequestFullscreen?: () => Promise<void>;
          }
        ).webkitRequestFullscreen?.();
      }
    } catch {
      // Browser refused fullscreen (often because of user-activation rules).
      // The user can click again to retry.
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (
        (document as Document & { webkitExitFullscreen?: () => Promise<void> })
          .webkitExitFullscreen
      ) {
        await (
          document as Document & { webkitExitFullscreen?: () => Promise<void> }
        ).webkitExitFullscreen?.();
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    function onFsChange() {
      const active = !!document.fullscreenElement;
      setIsFullscreen(active);
      setViewportSize({
        w: window.innerWidth,
        h: window.innerHeight,
      });
    }
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  // Keep viewport size current while in fullscreen (orientation change, etc.)
  useEffect(() => {
    if (!isFullscreen) return;
    function onResize() {
      setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [isFullscreen]);

  // Exit fullscreen on Escape is handled natively by the browser, but we
  // also expose a visible "Exit fullscreen" button in fullscreen mode.

  const expiresInMs = Math.max(0, msUntilNextBlock(now));
  const pct = (expiresInMs / TOKEN_WINDOW_MS) * 100;
  const presentCount = presenceQ.data?.presentCount ?? 0;
  const eligibleCount = presenceQ.data?.eligibleCount ?? 0;
  const turnoutPct =
    eligibleCount > 0 ? Math.round((presentCount / eligibleCount) * 100) : 0;
  const recentCheckIns = (presenceQ.data?.attendances ?? [])
    .slice(-12)
    .reverse();

  // Compute QR pixel size:
  //   - Normal (non-fullscreen): 320 px (was 280) for a more prominent code
  //   - Fullscreen: 70% of the smaller viewport dimension, capped at 720 px
  //     so it never overflows on small projectors.
  const normalQrSize = 320;
  const fullscreenQrSize = Math.max(
    240,
    Math.min(
      720,
      Math.floor(Math.min(viewportSize.w || 800, viewportSize.h || 600) * 0.7),
    ),
  );
  const qrSize = isFullscreen ? fullscreenQrSize : normalQrSize;

  const eventTitle = secretQ.data?.title;

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? // Fullscreen: black background, centered, no padding
            "fixed inset-0 bg-black text-white flex flex-col items-center justify-center p-4 sm:p-8 overflow-hidden"
          : "grid gap-6 lg:grid-cols-3"
      }
    >
      {/* ============================ FULLSCREEN MODE ============================ */}
      {isFullscreen && (
        <div className="w-full h-full flex flex-col items-center justify-center gap-4 sm:gap-8">
          {/* Top bar: event title + exit button */}
          <div className="absolute top-4 left-4 right-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-xs uppercase tracking-widest text-white/60">
                Projecting check-in code for
              </p>
              <h2 className="text-base sm:text-2xl font-heading font-semibold truncate">
                {eventTitle ?? "Event"}
              </h2>
            </div>
            <Button
              variant="secondary"
              onClick={exitFullscreen}
              className="shrink-0 gap-1.5"
              size="sm"
            >
              <Minimize2 className="h-4 w-4" />
              <span className="hidden sm:inline">Exit fullscreen</span>
              <span className="sm:hidden">Exit</span>
            </Button>
          </div>

          {/* QR code — fills most of the screen */}
          <div className="relative grid place-items-center">
            <svg
              className="absolute inset-0 -rotate-90 pointer-events-none"
              viewBox={`0 0 ${qrSize + 40} ${qrSize + 40}`}
              preserveAspectRatio="xMidYMid meet"
              style={{ width: qrSize + 40, height: qrSize + 40 }}
            >
              <circle
                cx={(qrSize + 40) / 2}
                cy={(qrSize + 40) / 2}
                r={(qrSize + 40) / 2 - 4}
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                className="text-white/15"
              />
              <circle
                cx={(qrSize + 40) / 2}
                cy={(qrSize + 40) / 2}
                r={(qrSize + 40) / 2 - 4}
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                className={pct < 25 ? "text-amber-400" : "text-primary"}
                strokeDasharray={`${2 * Math.PI * ((qrSize + 40) / 2 - 4)}`}
                strokeDashoffset={`${
                  2 * Math.PI * ((qrSize + 40) / 2 - 4) * (1 - pct / 100)
                }`}
                style={{ transition: "stroke-dashoffset 100ms linear" }}
              />
            </svg>
            <div className="p-3 sm:p-4 bg-white rounded-2xl">
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${block}-${subFrame}`}
                  initial={{ opacity: 0.5, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.15 }}
                >
                  <QRCodeCanvas
                    value={token || "pending"}
                    size={qrSize}
                    level="H"
                    marginSize={2}
                    fgColor="#0c1a17"
                    bgColor="#ffffff"
                  />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Timer + live indicator (always visible in fullscreen) */}
          <div className="flex items-center gap-4 sm:gap-6 flex-wrap justify-center">
            <div className="flex items-center gap-2">
              <RefreshCw
                className={`h-5 w-5 sm:h-6 sm:w-6 text-primary ${
                  expiresInMs < 1500 ? "animate-spin" : ""
                }`}
              />
              <span className="text-2xl sm:text-4xl font-bold tabular-nums">
                {Math.ceil(expiresInMs / 1000)}
                <span className="text-base sm:text-xl font-normal text-white/60">
                  s
                </span>
              </span>
              <span className="text-xs sm:text-sm text-white/60">
                until next code
              </span>
            </div>
            <Badge
              variant="outline"
              className="gap-1.5 border-emerald-400/50 text-emerald-300 text-sm sm:text-base px-2.5 py-1"
            >
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              Live
            </Badge>
            <Badge
              variant="outline"
              className="gap-1.5 border-white/30 text-white text-sm sm:text-base px-2.5 py-1"
            >
              <Users className="h-3.5 w-3.5" />
              <span className="tabular-nums">{presentCount}</span>
              <span className="text-white/60">/ {eligibleCount}</span>
            </Badge>
          </div>
          <p className="text-[10px] sm:text-xs text-white/50 text-center max-w-md">
            Hold your camera steady for ~2 seconds to scan. A new code appears
            every 15 seconds — screenshots can&apos;t be reused.
          </p>
        </div>
      )}

      {/* ============================ NORMAL MODE ============================ */}
      {!isFullscreen && (
        <>
          <Card className="lg:col-span-2 relative overflow-hidden">
            <CardHeader className="relative pb-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <QrCode className="h-5 w-5 text-primary" />
                    Show this code to your students
                  </CardTitle>
                  <CardDescription className="mt-1">
                    The code refreshes every 0.5 seconds (anti-screenshot).
                    Students hold their camera steady for ~2 seconds to scan.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {events.length > 0 && (
                    <Select
                      value={eventId ? String(eventId) : ""}
                      onValueChange={(v) => setSelectedEventId(Number(v))}
                    >
                      <SelectTrigger className="w-44 sm:w-64">
                        <SelectValue placeholder="Pick an event…" />
                      </SelectTrigger>
                      <SelectContent>
                        {events.map((e) => (
                          <SelectItem key={e.id} value={String(e.id)}>
                            <span className="flex items-center gap-2">
                              {e.timeStatus === "live" && (
                                <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                              )}
                              {e.timeStatus === "upcoming" && (
                                <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />
                              )}
                              {e.timeStatus === "ended" && (
                                <span className="h-2 w-2 rounded-full bg-muted-foreground inline-block" />
                              )}
                              {e.title}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={enterFullscreen}
                        aria-label="Enter fullscreen"
                        disabled={eventId == null || !secretQ.data}
                        className="h-9 w-9"
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Project fullscreen (hide all controls except the code)
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </CardHeader>
            <CardContent className="relative">
              {events.length === 0 && (
                <div className="text-center py-16">
                  <QrCode className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                  <p className="font-medium">No events yet</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Create an event first, then come back here to show the code.
                  </p>
                </div>
              )}

              {eventId != null && secretQ.isLoading && (
                <div className="text-center py-16">
                  <Loader2 className="h-8 w-8 mx-auto animate-spin text-primary" />
                </div>
              )}

              {eventId != null &&
                secretQ.isError &&
                (() => {
                  const err = secretQ.error as Error & {
                    code?: string;
                    data?: Record<string, unknown>;
                  };
                  const code = err?.code;
                  const opensInMinutes = err?.data?.opensInMinutes as
                    | number
                    | undefined;
                  const opensAt = err?.data?.opensAt as string | undefined;

                  if (code === "UPCOMING") {
                    return (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center gap-4 py-16 text-center"
                      >
                        <div className="grid place-items-center h-16 w-16 rounded-full bg-primary/10 text-primary">
                          <Clock className="h-8 w-8" />
                        </div>
                        <div>
                          <p className="font-heading font-semibold text-lg">
                            Not open yet
                          </p>
                          <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                            This event opens for check-in 2 hours before it
                            starts.
                            {opensAt && (
                              <>
                                {" "}
                                That&apos;s{" "}
                                <strong className="text-foreground">
                                  {new Date(opensAt).toLocaleString("en-PH", {
                                    weekday: "short",
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </strong>
                                .
                              </>
                            )}
                          </p>
                          {opensInMinutes && opensInMinutes > 0 && (
                            <Badge variant="outline" className="mt-3 gap-1.5">
                              <Clock className="h-3 w-3" />
                              Opens in ~{opensInMinutes} min
                            </Badge>
                          )}
                        </div>
                      </motion.div>
                    );
                  }

                  if (code === "ENDED") {
                    return (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center gap-4 py-16 text-center"
                      >
                        <div className="grid place-items-center h-16 w-16 rounded-full bg-muted text-muted-foreground">
                          <AlertTriangle className="h-8 w-8" />
                        </div>
                        <div>
                          <p className="font-heading font-semibold text-lg">
                            Check-in closed
                          </p>
                          <p className="text-sm text-muted-foreground mt-1">
                            This event&apos;s check-in window has ended.
                            Students can no longer scan.
                          </p>
                        </div>
                      </motion.div>
                    );
                  }

                  // Generic error
                  return (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Couldn&apos;t load the event code</AlertTitle>
                      <AlertDescription>
                        {err?.message ||
                          "Try picking a different event or refreshing the page."}
                      </AlertDescription>
                    </Alert>
                  );
                })()}

              {eventId != null && secretQ.data && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="flex flex-col items-center gap-6 py-4 sm:py-6"
                >
                  <div className="relative">
                    <svg
                      className="absolute inset-0 -rotate-90"
                      viewBox={`0 0 ${normalQrSize + 40} ${normalQrSize + 40}`}
                      style={{
                        width: normalQrSize + 40,
                        height: normalQrSize + 40,
                      }}
                    >
                      <circle
                        cx={(normalQrSize + 40) / 2}
                        cy={(normalQrSize + 40) / 2}
                        r={(normalQrSize + 40) / 2 - 4}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="4"
                        className="text-muted/40"
                      />
                      <circle
                        cx={(normalQrSize + 40) / 2}
                        cy={(normalQrSize + 40) / 2}
                        r={(normalQrSize + 40) / 2 - 4}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="4"
                        strokeLinecap="round"
                        className={pct < 25 ? "text-amber-500" : "text-primary"}
                        strokeDasharray={`${
                          2 * Math.PI * ((normalQrSize + 40) / 2 - 4)
                        }`}
                        strokeDashoffset={`${
                          2 *
                          Math.PI *
                          ((normalQrSize + 40) / 2 - 4) *
                          (1 - pct / 100)
                        }`}
                        style={{ transition: "stroke-dashoffset 100ms linear" }}
                      />
                    </svg>
                    <div className="p-4 bg-white rounded-2xl ng-glow">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={`${block}-${subFrame}`}
                          initial={{ opacity: 0.5, scale: 0.97 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.15 }}
                        >
                          <QRCodeCanvas
                            value={token || "pending"}
                            size={normalQrSize}
                            level="H"
                            marginSize={2}
                            fgColor="#0c1a17"
                            bgColor="#ffffff"
                          />
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 sm:gap-4 flex-wrap justify-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-2 cursor-help">
                          <RefreshCw
                            className={`h-4 w-4 text-primary ${
                              expiresInMs < 1500 ? "animate-spin" : ""
                            }`}
                          />
                          <span className="text-xl sm:text-2xl font-bold tabular-nums">
                            Code refreshes in {Math.ceil(expiresInMs / 1000)}
                            <span className="text-sm font-normal text-muted-foreground">
                              s
                            </span>
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        A new code appears every 15 seconds so screenshots
                        can&apos;t be reused.
                      </TooltipContent>
                    </Tooltip>

                    <Badge
                      variant="outline"
                      className="gap-1.5 border-emerald-500/40 text-emerald-600"
                    >
                      <Radio className="h-3 w-3 animate-pulse" />
                      Live
                    </Badge>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="secondary"
                          className="gap-1.5 font-mono text-[11px] cursor-help"
                        >
                          <ShieldCheck className="h-3 w-3" />
                          Secured
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        Each code is signed with the event&apos;s secret so it
                        can&apos;t be faked.
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  <div className="w-full max-w-md">
                    <div className="bg-muted/50 rounded-md p-3 font-mono text-[10px] text-muted-foreground break-all">
                      {token || "generating…"}
                    </div>
                    <p className="text-[11px] text-center text-muted-foreground mt-2 flex items-center justify-center gap-1">
                      <Clock className="h-3 w-3" />A new code appears every 15
                      seconds — old codes stop working right away.
                    </p>
                  </div>

                  {/* Fullscreen CTA — visible below the QR on small screens,
                      gives organizers an obvious "project this" button. */}
                  <Button
                    variant="outline"
                    onClick={enterFullscreen}
                    className="gap-2 mt-2"
                  >
                    <Maximize2 className="h-4 w-4" />
                    Project fullscreen
                  </Button>
                </motion.div>
              )}
            </CardContent>
          </Card>

          {secretQ.data && (
            <Card className="h-fit">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4 text-primary" />
                  Live attendance
                </CardTitle>
                <CardDescription>
                  {socket.connected
                    ? "Updates instantly as students scan"
                    : "Updates every few seconds"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!socket.connected && eventId != null && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md p-2">
                    <WifiOff className="h-3.5 w-3.5" />
                    Realtime link is offline — falling back to polling.
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-emerald-500/10 p-3">
                    <div className="flex items-center gap-1.5 text-emerald-600 text-xs font-medium">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Checked in
                    </div>
                    <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                      {presentCount}
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground text-xs font-medium">
                      <Users className="h-3.5 w-3.5" />
                      Expected
                    </div>
                    <div className="text-2xl font-bold">{eligibleCount}</div>
                  </div>
                </div>

                {eligibleCount > 0 && (
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Turnout</span>
                      <span>{turnoutPct}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className="h-full bg-primary rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, turnoutPct)}%` }}
                        transition={{ duration: 0.4 }}
                      />
                    </div>
                  </div>
                )}

                <Separator />

                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Recent check-ins
                  </p>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto ng-scroll">
                    <AnimatePresence initial={false}>
                      {recentCheckIns.map((a) => (
                        <motion.div
                          key={a.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0 }}
                          className="flex items-center gap-2 text-xs p-2 rounded-md bg-muted/40"
                        >
                          <div className="grid place-items-center h-6 w-6 rounded-full bg-emerald-500/20 text-emerald-600 shrink-0">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">
                              {a.account.fullName}
                            </p>
                            <p className="text-[10px] text-muted-foreground truncate">
                              {a.account.studentId != null
                                ? `ID ${a.account.studentId}`
                                : "No student ID on file"}
                              {a.account.program
                                ? ` · ${a.account.program}`
                                : ""}
                              {a.account.section ? ` ${a.account.section}` : ""}
                            </p>
                          </div>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {new Date(a.scannedAt).toLocaleTimeString("en-PH", {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    {recentCheckIns.length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        No one has checked in yet.
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
