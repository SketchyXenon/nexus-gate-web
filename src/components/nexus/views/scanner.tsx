"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import {
  ScanLine,
  Camera,
  CameraOff,
  CheckCircle2,
  XCircle,
  Loader2,
  HardDrive,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  Send,
  Clock,
  Info,
  AlertCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";
import { useEvents, type Account } from "@/lib/api-client";
import { useScanQueue } from "@/hooks/use-scan-queue";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { toast } from "@/hooks/use-toast";
import {
  signCertificate,
  getOrCreateDeviceKeyPair,
  registerDeviceKeyWithServer,
  getDeviceFingerprint,
} from "@/lib/device-key-client";
import {
  createCertificate,
  type ScanCertificate,
} from "@/lib/scan-certificate";
import { MIN_SUB_FRAMES, SUB_FRAMES_PER_BLOCK } from "@/lib/qr-token-client";

type ScanFeedback =
  | { kind: "success"; name: string; msg: string }
  | { kind: "dup"; name: string; msg: string }
  | { kind: "error"; msg: string }
  | null;

const SELECT_NONE = "NONE";

interface ScannerProps {
  user: Account;
  onNavigate?: (v: "profile") => void;
}

export function ScannerView({ user, onNavigate }: ScannerProps) {
  const { data: eventsData } = useEvents();
  const events = eventsData?.events ?? [];
  const needsProfile = eventsData?.needsProfile ?? false;
  const [selectedEventId, setSelectedEventId] = useState<string>(SELECT_NONE);
  // Derive the active event id from the select, falling back to the first
  // available event so the scanner is usable immediately.
  const eventId: number | null =
    selectedEventId !== SELECT_NONE
      ? Number(selectedEventId)
      : (events[0]?.id ?? null);

  const queue = useScanQueue();
  const online = useOnlineStatus();

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [feedback, setFeedback] = useState<ScanFeedback>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [feedbackKey, setFeedbackKey] = useState(0);
  const scanInFlightRef = useRef<boolean>(false);
  const lastCaptureAtRef = useRef<number>(0);
  // Increased from 1750ms to 3000ms — gives the scanner more time to
  // capture 3 consecutive sub-frames before resetting. The QR refreshes
  // every 500ms, so 3 frames need ~1.5s, but camera lag can cause gaps.
  const captureStaleMs = 3000;
  // Throttle: only run jsQR every ~120ms (≈8 FPS). The QR refreshes at
  // 2 FPS (500ms), so 8 FPS is more than enough to catch each sub-frame
  // while dramatically reducing CPU load on mobile devices.
  const lastScanAtRef = useRef<number>(0);
  const scanIntervalMs = 120;
  // Track the last decoded raw token to skip redundant parsing.
  const lastRawRef = useRef<string>("");

  // ---- v8: Multi-frame sub-frame collection (Tier 2 liveness) ----
  // The scanner collects sub-frame indices + their client-observed HMACs
  // as the QR refreshes at 2 FPS. When MIN_SUB_FRAMES (3) consecutive
  // sub-frames are captured, we create a signed certificate and enqueue it.
  const subFramesRef = useRef<
    Map<number, { subFrame: number; hmac: string; token: string }>
  >(new Map());
  const currentBlockRef = useRef<number>(-1);
  const currentEventIdRef = useRef<number>(0);
  const [scanProgress, setScanProgress] = useState<number>(0);
  // Cooldown lock: after a successful scan, block new scans for 3 seconds
  // to prevent the "stuck after 2-3 scans" bug where sub-frames get
  // re-collected within the same time block.
  const scanningLockedRef = useRef<boolean>(false);

  const resetCaptureState = useCallback(() => {
    subFramesRef.current = new Map();
    currentBlockRef.current = -1;
    currentEventIdRef.current = 0;
    lastCaptureAtRef.current = 0;
    lastRawRef.current = "";
    setScanProgress(0);
  }, []);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    scanInFlightRef.current = false;
    scanningLockedRef.current = false;
    resetCaptureState();
    setCameraOn(false);
  }, [resetCaptureState]);

  // ---- v8: Multi-frame sub-frame collection + signed certificate ----
  // Each decoded QR frame is parsed for its sub-frame index + HMAC.
  // We collect unique sub-frames (with their client-observed HMACs)
  // within the same time block. When MIN_SUB_FRAMES (3) consecutive
  // sub-frames are collected, we create a signed scan certificate and
  // enqueue it for submission.
  //
  // SECURITY: The HMACs are CLIENT-OBSERVED (captured from the real QR
  // frames). The server recomputes the expected HMAC for each sub-frame
  // index and compares it against the client-supplied value. This proves
  // the scanner actually watched the QR change over time — a fabricated
  // set of indices without real HMACs is rejected.
  const handleDecode = useCallback(
    async (raw: string) => {
      // Cooldown lock: ignore scans while a certificate is being created
      // or during the post-scan cooldown.
      if (scanningLockedRef.current || scanInFlightRef.current) return;

      // Skip redundant parsing: if the exact same raw token was just
      // processed (same sub-frame), don't re-parse. This happens because
      // the camera captures the same QR multiple times before it refreshes.
      if (raw === lastRawRef.current) return;
      lastRawRef.current = raw;

      const now = Date.now();
      if (
        lastCaptureAtRef.current &&
        now - lastCaptureAtRef.current > captureStaleMs &&
        subFramesRef.current.size > 0 &&
        subFramesRef.current.size < MIN_SUB_FRAMES
      ) {
        resetCaptureState();
        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "error",
          msg: "The scan took too long to finish. Hold the camera steady and try again.",
        });
      }

      // Parse the v8 token: <eventId>.<timeBlock>.<subFrame>.<subHmac>
      const parts = raw.split(".");
      if (parts.length !== 4) {
        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "error",
          msg: "This QR code doesn't look like a Nexus Gate check-in code.",
        });
        return;
      }
      const tokenEventId = Number(parts[0]);
      const timeBlock = Number(parts[1]);
      const subFrameIdx = Number(parts[2]);
      const subHmac = parts[3];

      if (
        !Number.isFinite(tokenEventId) ||
        tokenEventId <= 0 ||
        !Number.isFinite(timeBlock)
      ) {
        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "error",
          msg: "We couldn't read the event number from this code.",
        });
        return;
      }
      if (
        !Number.isFinite(subFrameIdx) ||
        subFrameIdx < 0 ||
        subFrameIdx >= SUB_FRAMES_PER_BLOCK
      ) {
        setFeedbackKey((k) => k + 1);
        setFeedback({ kind: "error", msg: "Invalid QR code format." });
        return;
      }
      if (!subHmac || subHmac.length !== 64) {
        setFeedbackKey((k) => k + 1);
        setFeedback({ kind: "error", msg: "Invalid QR code signature." });
        return;
      }

      // If the block or event changed, reset the collection
      if (
        currentBlockRef.current !== timeBlock ||
        currentEventIdRef.current !== tokenEventId
      ) {
        resetCaptureState();
        currentBlockRef.current = timeBlock;
        currentEventIdRef.current = tokenEventId;
      }

      // Dedup: only add each sub-frame once
      if (subFramesRef.current.has(subFrameIdx)) return;
      // Store the sub-frame index + its client-observed HMAC
      subFramesRef.current.set(subFrameIdx, {
        subFrame: subFrameIdx,
        hmac: subHmac,
        token: raw,
      });
      lastCaptureAtRef.current = now;

      const collected = subFramesRef.current.size;
      setScanProgress(collected);

      // Check if we have enough consecutive sub-frames
      if (collected < MIN_SUB_FRAMES) {
        // Not enough yet — show progress feedback
        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "success",
          name: user.fullName,
          msg: `Hold steady… ${collected}/${MIN_SUB_FRAMES} frames captured`,
        });
        return;
      }

      // We have enough sub-frames — verify they're consecutive
      const sortedSubFrames = Array.from(subFramesRef.current.values()).sort(
        (a, b) => a.subFrame - b.subFrame,
      );
      let consecutive = true;
      for (let i = 1; i < sortedSubFrames.length; i++) {
        const diff =
          sortedSubFrames[i].subFrame - sortedSubFrames[i - 1].subFrame;
        if (diff < 1 || diff > 2) {
          consecutive = false;
          break;
        }
      }
      if (!consecutive) {
        // Reset and try again
        resetCaptureState();
        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "error",
          msg: "Frames weren't consecutive. Hold the camera steady and try again.",
        });
        return;
      }

      // ---- Create the signed scan certificate ----
      // Ensure the device key is registered before signing
      scanInFlightRef.current = true;
      try {
        await getOrCreateDeviceKeyPair();
        const fingerprint = await getDeviceFingerprint();
        if (!fingerprint) {
          throw new Error(
            "Couldn't access device key. Please refresh the page.",
          );
        }

        // Use the LAST captured frame's raw token as the certificate token
        const lastCapture = sortedSubFrames[sortedSubFrames.length - 1];

        // Build the sub-frame captures (index + client-observed HMAC)
        const subFrameCaptures = sortedSubFrames.map((s) => ({
          subFrame: s.subFrame,
          hmac: s.hmac,
        }));

        const cert = createCertificate({
          eventId: tokenEventId,
          token: lastCapture.token,
          deviceFingerprint: fingerprint,
          subFrames: subFrameCaptures,
        });

        const signed = await signCertificate(cert);

        // Enqueue the signed certificate
        queue.enqueueSigned(tokenEventId, signed);

        // Register the device key in the background (non-blocking)
        registerDeviceKeyWithServer().catch(() => {});

        // Lock scanning for 1.5 seconds to prevent duplicate scans.
        // Reduced from 3s — 1.5s is enough for the QR to rotate to a new
        // sub-frame, and doesn't make the user wait too long between scans.
        scanningLockedRef.current = true;
        scanInFlightRef.current = false;
        setTimeout(() => {
          scanningLockedRef.current = false;
        }, 1500);

        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "success",
          name: user.fullName,
          msg: online
            ? "Scan captured — sending to the server now."
            : "You're offline — your scan is saved and will be sent automatically when you reconnect.",
        });

        // Reset sub-frame collection for the next scan
        resetCaptureState();
      } catch (e) {
        scanInFlightRef.current = false;
        resetCaptureState();
        setFeedbackKey((k) => k + 1);
        setFeedback({
          kind: "error",
          msg:
            e instanceof Error
              ? e.message
              : "Failed to sign the scan certificate.",
        });
      }
    },
    [queue, user.fullName, online, resetCaptureState],
  );

  // Use a ref to break the self-reference cycle (scanLoop references
  // itself via requestAnimationFrame). This avoids the TDZ/immutability
  // lint error while keeping the recursive animation frame loop.
  const scanLoopRef = useRef<() => void>(() => {});

  const scanLoop = useCallback(() => {
    rafRef.current = requestAnimationFrame(() => scanLoopRef.current());
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      return;
    }

    // ---- Throttle: only scan every scanIntervalMs (≈8 FPS) ----
    // The QR refreshes at 2 FPS (500ms), so 8 FPS is more than enough.
    // This dramatically reduces CPU load and prevents frame drops that
    // cause the scanner to miss sub-frames (the "stuck at 2/3" bug).
    const now = performance.now();
    if (now - lastScanAtRef.current < scanIntervalMs) return;
    lastScanAtRef.current = now;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (srcW === 0 || srcH === 0) return;

    // ---- Downscale to max 640px wide for faster jsQR decoding ----
    // jsQR's cost is O(width × height). A 1080p frame is ~2M pixels;
    // at 640×360 it's ~230K pixels — 9x faster. The QR is still
    // decodable at this resolution (it's projected on a screen).
    const MAX_W = 640;
    const scale = srcW > MAX_W ? MAX_W / srcW : 1;
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const code = jsQR(imageData.data, w, h, {
      inversionAttempts: "dontInvert",
    });
    if (code && code.data) handleDecode(code.data);
  }, [handleDecode]);

  // Keep the ref in sync so the rAF callback always invokes the latest scanLoop.
  useEffect(() => {
    scanLoopRef.current = scanLoop;
  }, [scanLoop]);

  const startCamera = useCallback(async () => {
    setStarting(true);
    setFeedbackKey((k) => k + 1);
    setFeedback(null);
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
      rafRef.current = requestAnimationFrame(scanLoop);
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Camera permission was denied.";
      setCameraError(msg);
      toast({
        title: "Couldn't open the camera",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setStarting(false);
    }
  }, [scanLoop]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const pendingItems = queue.queue.filter(
    (s) =>
      s.status === "pending" || s.status === "syncing" || s.status === "failed",
  );
  const syncedItems = queue.queue.filter((s) => s.status === "synced");

  // Surface a failed sync as inline feedback so the student knows the scan
  // didn't go through and can try again.
  const lastFailed = queue.queue.find((s) => s.status === "failed");

  return (
    <div className="grid gap-4 lg:gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2 relative overflow-hidden">
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ScanLine className="h-5 w-5 text-primary" />
                Scan to Check In
              </CardTitle>
              <CardDescription>
                Point your camera at the QR code on the screen.
              </CardDescription>
            </div>
            {events.length > 0 && (
              <Select
                value={
                  selectedEventId === SELECT_NONE
                    ? eventId
                      ? String(eventId)
                      : SELECT_NONE
                    : selectedEventId
                }
                onValueChange={(v) => setSelectedEventId(v)}
              >
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Select event…" />
                </SelectTrigger>
                <SelectContent>
                  {events.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* Profile completion prompt — shown when the student hasn't set
              their course/section yet. Course-specific events are hidden
              until they complete their profile. */}
          {needsProfile && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <p className="font-medium text-amber-700 dark:text-amber-400 flex-1">
                  Complete your profile
                </p>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-amber-600/70 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Only events open to everyone are showing. Set your course
                    and section to see events for your class.
                  </TooltipContent>
                </Tooltip>
                {onNavigate && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                    onClick={() => onNavigate("profile")}
                  >
                    Go to profile
                  </Button>
                )}
              </div>
            </div>
          )}

          {events.length === 0 && (
            <div className="text-center py-16">
              <ScanLine className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
              <p className="font-medium">No events available right now</p>
              <p className="text-sm text-muted-foreground mt-1">
                {needsProfile
                  ? "Fill out your course and section to see events for your classes."
                  : "Check back once an event is scheduled for your section."}
              </p>
            </div>
          )}
          {eventId != null && (
            <div className="space-y-4">
              <div className="relative aspect-square sm:aspect-video bg-black rounded-xl overflow-hidden ng-glow">
                <video
                  ref={videoRef}
                  className={`w-full h-full object-cover ${cameraOn ? "" : "hidden"}`}
                  muted
                  playsInline
                />
                <canvas ref={canvasRef} className="hidden" />
                {!cameraOn && (
                  <div className="absolute inset-0 grid place-items-center text-white/80">
                    <div className="text-center">
                      <CameraOff className="h-10 w-10 mx-auto mb-3 opacity-60" />
                      <p className="text-sm font-medium">Camera is off</p>
                      <p className="text-xs opacity-60 mt-1">
                        Press Start camera to begin scanning.
                      </p>
                    </div>
                  </div>
                )}
                {cameraOn && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-x-4 inset-y-8 sm:inset-x-8 sm:inset-y-12 border-2 border-primary/70 rounded-xl">
                      <div className="absolute -top-1 -left-1 h-5 w-5 border-t-2 border-l-2 border-primary" />
                      <div className="absolute -top-1 -right-1 h-5 w-5 border-t-2 border-r-2 border-primary" />
                      <div className="absolute -bottom-1 -left-1 h-5 w-5 border-b-2 border-l-2 border-primary" />
                      <div className="absolute -bottom-1 -right-1 h-5 w-5 border-b-2 border-r-2 border-primary" />
                      <motion.div
                        className="absolute left-2 right-2 h-0.5 bg-primary/80"
                        animate={{ top: ["8%", "88%", "8%"] }}
                        transition={{
                          duration: 2.2,
                          repeat: Infinity,
                          ease: "easeInOut",
                        }}
                      />
                    </div>
                  </div>
                )}
                <AnimatePresence>
                  {feedback && (
                    <motion.div
                      key={feedbackKey}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className={`absolute inset-x-4 bottom-4 rounded-xl p-4 backdrop-blur ${
                        feedback.kind === "success"
                          ? "bg-primary/90 text-primary-foreground"
                          : feedback.kind === "dup"
                            ? "bg-amber-500/90 text-white"
                            : "bg-destructive/90 text-white"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {feedback.kind === "success" ? (
                          <CheckCircle2 className="h-7 w-7 shrink-0" />
                        ) : (
                          <XCircle className="h-7 w-7 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold">
                            {feedback.kind === "success"
                              ? "Scan saved"
                              : feedback.kind === "dup"
                                ? "Already checked in"
                                : "Couldn't read this code"}
                          </p>
                          <p className="text-xs opacity-90 break-words">
                            {feedback.msg}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {cameraError && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex gap-2">
                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">Camera problem</p>
                    <p className="opacity-90 mt-0.5">{cameraError}</p>
                  </div>
                </div>
              )}

              {lastFailed && !feedback && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive flex gap-2">
                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-medium">A scan couldn't be sent</p>
                    <p className="opacity-90 mt-0.5">
                      We tried a few times but the server didn't accept it.{" "}
                      {lastFailed.error ?? ""}
                    </p>
                    <p className="opacity-90">
                      Tap “Send now” below to try again.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                {!cameraOn ? (
                  <Button onClick={startCamera} disabled={starting}>
                    {starting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Camera className="h-4 w-4" />
                    )}
                    Start camera
                  </Button>
                ) : (
                  <Button variant="outline" onClick={stopCamera}>
                    <CameraOff className="h-4 w-4" />
                    Stop camera
                  </Button>
                )}
                <Badge
                  variant="outline"
                  className={`gap-1.5 ${
                    online
                      ? "border-emerald-500/40 text-emerald-600"
                      : "border-amber-500/40 text-amber-600"
                  }`}
                >
                  {online ? (
                    <Wifi className="h-3 w-3" />
                  ) : (
                    <WifiOff className="h-3 w-3" />
                  )}
                  {online ? "Online" : "Offline — scans saved on this device"}
                </Badge>
                {queue.syncing && (
                  <Badge variant="outline" className="gap-1.5">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Sending…
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-primary cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Offline scans are saved on this device and sent
                    automatically when you reconnect.
                  </TooltipContent>
                </Tooltip>
                <span>Offline scans auto-sync when reconnected.</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-primary" />
            Saved Scans
          </CardTitle>
          <CardDescription>
            {pendingItems.length} waiting · {syncedItems.length} sent
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md bg-amber-500/10 p-2.5 text-center">
              <div className="text-xl font-bold text-amber-600">
                {pendingItems.length}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Waiting
              </div>
            </div>
            <div className="rounded-md bg-emerald-500/10 p-2.5 text-center">
              <div className="text-xl font-bold text-emerald-600">
                {syncedItems.length}
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Sent
              </div>
            </div>
          </div>

          {pendingItems.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => queue.drain()}
                  disabled={!online}
                >
                  <Send className="h-3.5 w-3.5" />
                  Send now
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {online
                  ? "Try sending every waiting scan right now."
                  : "Reconnect to the internet first."}
              </TooltipContent>
            </Tooltip>
          )}

          <Separator />

          <div className="max-h-72 overflow-y-auto ng-scroll space-y-1.5">
            {queue.queue.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">
                No scans yet. Point the camera at the QR code on the screen.
              </p>
            )}
            <AnimatePresence initial={false}>
              {queue.queue.map((item) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-2 p-2 rounded-md bg-muted/40 text-xs"
                >
                  <div
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      item.status === "synced"
                        ? "bg-emerald-500"
                        : item.status === "failed"
                          ? "bg-destructive"
                          : item.status === "syncing"
                            ? "bg-primary animate-pulse"
                            : "bg-amber-500"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {item.status === "synced"
                        ? item.result?.action === "time_out"
                          ? "Time-out recorded"
                          : item.result?.action === "already_complete"
                            ? "Already checked in"
                            : "Time-in recorded"
                        : item.status === "failed"
                          ? "Failed"
                          : item.status === "syncing"
                            ? "Sending…"
                            : "Waiting"}
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        · event #{item.eventId}
                      </span>
                    </p>
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" />
                      {new Date(item.queuedAt).toLocaleTimeString("en-PH", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                      {item.attempts > 0 && ` · tried ${item.attempts}×`}
                    </p>
                  </div>
                  {item.status === "synced" && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => queue.removeItem(item.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Remove this sent scan from the list.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {syncedItems.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  onClick={() => setConfirmClear(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear sent scans
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Remove every sent scan from this list. They're already saved on
                the server.
              </TooltipContent>
            </Tooltip>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all sent scans?"
        description={`This removes ${syncedItems.length} sent scan${syncedItems.length === 1 ? "" : "s"} from this list. They're already saved on the server, so your attendance won't be affected.`}
        confirmLabel="Clear sent scans"
        destructive
        onConfirm={() => {
          queue.clearSynced();
          toast({ title: "Sent scans cleared" });
        }}
      />
    </div>
  );
}
