"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  QrCode,
  ScanLine,
  ClipboardList,
  AlertTriangle,
  ShieldCheck,
  LogOut,
  Wifi,
  WifiOff,
  ShieldAlert,
  ScrollText,
  HelpCircle,
  FileText,
  LayoutGrid,
  Bug,
  UserCircle,
  CalendarRange,
  History,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useLogout, trackVisit, type Account } from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/rbac";
import { toast } from "@/hooks/use-toast";
import { ThemeToggle } from "./theme-toggle";
import { CookieConsent } from "./cookie-consent";
import { InfoModals, openInfoModal } from "./info-modals";
import { CommandPalette } from "./command-palette";
import { DiceBearAvatar } from "./dicebear-avatar";
import { NexusLogo } from "./nexus-logo";
import { NotificationBell } from "./notification-bell";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useSessionTimeout } from "@/hooks/use-session-timeout";
import dynamic from "next/dynamic";
import { CardErrorBoundary } from "./error-boundary";

// Code-split each view into its own chunk so the initial compile/load only
// pulls the active view. Keeps the dev compile memory bounded and shrinks
// the production initial bundle (views are auth-gated, so unauthenticated
// visitors never download them).
const viewLoading = () => (
  <div className="flex items-center justify-center py-16">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);
const dyn = <T,>(loader: () => Promise<T>) =>
  dynamic(loader as never, { loading: viewLoading }) as T;

const DashboardView = dyn(() =>
  import("./views/dashboard").then((m) => m.DashboardView),
);
const WhitelistView = dyn(() =>
  import("./views/whitelist").then((m) => m.WhitelistView),
);
const EventsView = dyn(() =>
  import("./views/events").then((m) => m.EventsView),
);
const ProjectQrView = dyn(() =>
  import("./views/project-qr").then((m) => m.ProjectQrView),
);
const ScannerView = dyn(() =>
  import("./views/scanner").then((m) => m.ScannerView),
);
const AttendanceView = dyn(() =>
  import("./views/attendance").then((m) => m.AttendanceView),
);
const OverridesView = dyn(() =>
  import("./views/overrides").then((m) => m.OverridesView),
);
const AccountsView = dyn(() =>
  import("./views/accounts").then((m) => m.AccountsView),
);
const AuditLogsView = dyn(() =>
  import("./views/audit-logs").then((m) => m.AuditLogsView),
);
const ProfileView = dyn(() =>
  import("./views/profile").then((m) => m.ProfileView),
);
const CalendarView = dyn(() =>
  import("./views/calendar").then((m) => m.CalendarView),
);
const MyAttendanceView = dyn(() =>
  import("./views/my-attendance").then((m) => m.MyAttendanceView),
);

type ViewId =
  | "dashboard"
  | "whitelist"
  | "events"
  | "project-qr"
  | "scanner"
  | "attendance"
  | "overrides"
  | "accounts"
  | "audit-logs"
  | "profile"
  | "calendar"
  | "my-attendance";

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Array<Account["role"]>;
  description: string;
}

const NAV: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: ["ADMIN", "ORGANIZER", "USER"],
    description: "Overview",
  },
  {
    id: "whitelist",
    label: "Students",
    icon: Users,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Approved students",
  },
  {
    id: "events",
    label: "Events",
    icon: CalendarDays,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Classes and events",
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarRange,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Monthly view",
  },
  {
    id: "project-qr",
    label: "Project QR",
    icon: QrCode,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Show QR code",
  },
  {
    id: "scanner",
    label: "Scanner",
    icon: ScanLine,
    roles: ["USER"],
    description: "Check in",
  },
  {
    id: "my-attendance",
    label: "My Attendance",
    icon: History,
    roles: ["USER"],
    description: "Your history",
  },
  {
    id: "attendance",
    label: "Attendance",
    icon: ClipboardList,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Who's present",
  },
  {
    id: "overrides",
    label: "Overrides",
    icon: AlertTriangle,
    // v16: offline-first signed overrides - organizers can now create
    // them for their own events (server enforces ownership).
    roles: ["ADMIN", "ORGANIZER"],
    description: "Add manually",
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: ShieldAlert,
    roles: ["ADMIN"],
    description: "Manage users",
  },
  {
    id: "audit-logs",
    label: "Activity Log",
    icon: ScrollText,
    roles: ["ADMIN"],
    description: "All actions",
  },
  {
    id: "profile",
    label: "Profile",
    icon: UserCircle,
    roles: ["ADMIN", "ORGANIZER", "USER"],
    description: "Your account",
  },
];

// Most-used bottom tabs per role (mobile); leftovers live in the More sheet.
const BOTTOM_TABS: Record<Account["role"], ViewId[]> = {
  USER: ["dashboard", "scanner", "my-attendance", "profile"],
  ORGANIZER: ["dashboard", "events", "attendance", "whitelist"],
  ADMIN: ["dashboard", "events", "attendance", "accounts"],
};

export function AppShell({
  user,
  initialView,
}: {
  user: Account;
  initialView?: ViewId;
}) {
  const [view, setView] = useState<ViewId>(initialView ?? "dashboard");
  const logout = useLogout();
  const online = useOnlineStatus();
  // Auto-logout after 30 min of inactivity (warning at 25 min).
  useSessionTimeout(true);

  // Offline-first identity + analytics: record each view change as a
  // privacy-preserving page-view ping (server hashes the public IP daily,
  // never stores it raw). Fire-and-forget - never blocks the UI.
  useEffect(() => {
    trackVisit(`/app/${view}`);
  }, [view]);

  const allowedNav = useMemo(
    () => NAV.filter((n) => n.roles.includes(user.role)),
    [user.role],
  );
  const activeView: ViewId = allowedNav.some((n) => n.id === view)
    ? view
    : "dashboard";

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Signed out" });
        // Force a full page reload to clear all in-memory state and ensure
        // the login screen shows. Without this, React Query cache clearing
        // may not fully reset the NextAuth session on Google OAuth users.
        setTimeout(() => window.location.replace("/"), 500);
      },
    });
  }

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
          <div className="p-4 flex items-center gap-3">
            <NexusLogo size={40} />
            <div className="min-w-0">
              <p className="font-semibold tracking-tight leading-tight truncate">
                Nexus Gate
              </p>
              <p className="text-[11px] text-sidebar-foreground/60 truncate">
                Attendance System
              </p>
            </div>
          </div>
          <Separator className="bg-sidebar-border" />
          <nav className="flex-1 p-3 space-y-1 overflow-y-auto ng-scroll">
            {allowedNav.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.id;
              return (
                <TooltipProvider key={item.id}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setView(item.id)}
                        className={`w-full group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-sidebar-foreground/60 group-hover:text-primary"}`}
                        />
                        <span className="flex-1 text-left font-medium">
                          {item.label}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {item.description}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </nav>
          <Separator className="bg-sidebar-border" />
          <div className="p-3 space-y-2">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-sidebar-accent/40">
              <DiceBearAvatar fullName={user.fullName} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{user.fullName}</p>
                <p className="text-[10px] text-sidebar-foreground/60 truncate">
                  {ROLE_LABELS[user.role]}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInfoModal("bug")}
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
            >
              <Bug className="h-4 w-4" /> Report a bug
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-20 h-14 border-b bg-background/80 backdrop-blur px-4 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold truncate">
                {NAV.find((n) => n.id === activeView)?.label}
              </h2>
              <p className="hidden sm:block text-[11px] text-muted-foreground truncate">
                {NAV.find((n) => n.id === activeView)?.description}
              </p>
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={`gap-1.5 ${online ? "border-emerald-500/40 text-emerald-600" : "border-amber-500/40 text-amber-600"}`}
                  >
                    {online ? (
                      <Wifi className="h-3 w-3" />
                    ) : (
                      <WifiOff className="h-3 w-3" />
                    )}
                    <span className="hidden sm:inline">
                      {online ? "Online" : "Offline"}
                    </span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {online
                    ? "Connected"
                    : "Offline - scans are saved and sent later"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {/* Desktop: search button with kbd hint */}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 px-2.5 hidden sm:flex"
              onClick={() =>
                window.dispatchEvent(new Event("nexus-open-command-palette"))
              }
            >
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <kbd className="text-[10px] font-mono text-muted-foreground">
                ⌘K
              </kbd>
            </Button>
            {/* Mobile: icon-only search button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 sm:hidden"
              onClick={() =>
                window.dispatchEvent(new Event("nexus-open-command-palette"))
              }
              aria-label="Search"
            >
              <Search className="h-4 w-4" />
            </Button>
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 lg:hidden"
              onClick={() => openInfoModal("faq")}
              aria-label="Help"
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
            <ThemeToggle />
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {ROLE_LABELS[user.role]}
            </Badge>
          </header>

          <main className="flex-1 overflow-y-auto ng-scroll">
            <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full">
              <CardErrorBoundary>
                {activeView === "dashboard" && (
                  <DashboardView user={user} onNavigate={setView} />
                )}
                {activeView === "whitelist" && <WhitelistView />}
                {activeView === "events" && <EventsView />}
                {activeView === "calendar" && <CalendarView />}
                {activeView === "project-qr" && <ProjectQrView />}
                {activeView === "scanner" && (
                  <ScannerView user={user} onNavigate={setView} />
                )}
                {activeView === "my-attendance" && <MyAttendanceView />}
                {activeView === "attendance" && <AttendanceView />}
                {activeView === "overrides" && (
                  <OverridesView currentUser={user} />
                )}
                {activeView === "accounts" && (
                  <AccountsView currentUser={user} />
                )}
                {activeView === "audit-logs" && <AuditLogsView />}
                {activeView === "profile" && <ProfileView />}
              </CardErrorBoundary>
            </div>
          </main>
          <BottomTabBar
            allowedNav={allowedNav}
            activeView={activeView}
            onSelect={setView}
            role={user.role}
            onLogout={handleLogout}
          />
        </div>
      </div>
      <CookieConsent />
      <InfoModals />
      <CommandPalette user={user} onNavigate={setView} />
    </div>
  );
}

// Mobile-only bottom tab bar (below md): role tabs plus a vaul More sheet.
function BottomTabBar({
  allowedNav,
  activeView,
  onSelect,
  role,
  onLogout,
}: {
  allowedNav: NavItem[];
  activeView: ViewId;
  onSelect: (v: ViewId) => void;
  role: Account["role"];
  onLogout: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs = BOTTOM_TABS[role]
    .map((id) => allowedNav.find((n) => n.id === id))
    .filter((n): n is NavItem => n !== undefined);
  const hasMore = tabs.length < allowedNav.length;
  // More carries the active state when the current view is not a tab.
  const moreActive = hasMore && !tabs.some((t) => t.id === activeView);

  return (
    <>
      <nav
        aria-label="Primary"
        className="md:hidden border-t bg-background/95 backdrop-blur flex px-1 pb-safe"
      >
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              aria-current={active ? "page" : undefined}
              className={`flex-1 flex flex-col items-center justify-center gap-1 min-h-[52px] px-1 text-muted-foreground transition-colors ${
                active ? "text-primary" : "hover:text-foreground"
              }`}
            >
              <Icon className="size-5" />
              <span className="text-[10px] font-medium leading-none max-w-[64px] truncate">
                {item.label}
              </span>
            </button>
          );
        })}
        {hasMore && (
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="More navigation"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={moreActive ? "page" : undefined}
            className={`flex-1 flex flex-col items-center justify-center gap-1 min-h-[52px] px-1 text-muted-foreground transition-colors ${
              moreActive ? "text-primary" : "hover:text-foreground"
            }`}
          >
            <LayoutGrid className="size-5" />
            <span className="text-[10px] font-medium leading-none max-w-[64px] truncate">
              More
            </span>
          </button>
        )}
      </nav>
      <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
        <DrawerContent className="max-h-[70vh]">
          <DrawerHeader>
            <DrawerTitle>More</DrawerTitle>
          </DrawerHeader>
          {/* All role nav items; picking one switches view and closes. */}
          <div className="overflow-y-auto ng-scroll min-h-0 p-3 pt-0 space-y-1">
            {allowedNav.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelect(item.id);
                    setMoreOpen(false);
                  }}
                  className={`flex items-center gap-3 w-full px-4 py-3 min-h-[48px] rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
          {/* Sign out lives here on mobile: the sidebar button is desktop-only. */}
          <div className="p-3 pt-0">
            <Separator className="mb-2" />
            <button
              onClick={onLogout}
              className="flex items-center gap-3 w-full px-4 py-3 min-h-[48px] rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="size-4 shrink-0" />
              <span>Sign out</span>
            </button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
